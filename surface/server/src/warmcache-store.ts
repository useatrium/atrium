import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { withTx } from './db.js';
import { loadCasBlob, persistCasBlob, type CasStorage } from './cas-storage.js';
import { DomainError } from './events.js';

// A single warm-cache blob is one file from an installed dependency set (a file
// under node_modules/, cargo registry/, ...). Bounded by the shared CAS ceiling.
export const MAX_WARMCACHE_BLOB_BYTES = 16 * 1024 * 1024;
// A dependency set is large but bounded; cap manifest size to keep the bulk
// insert + hydration response from going unbounded.
export const MAX_WARMCACHE_MANIFEST_ENTRIES = 100_000;

export interface WarmcacheEntry {
  path: string;
  sha256: string;
  size_bytes: number;
}

/** Upload one warm-cache blob into the shared content-addressed store. Mirrors
 * the profile-bundle blob path: dedup on the durable CAS, verify the body hash. */
export async function storeWarmcacheBlob(
  pool: Db,
  storage: Pick<CasStorage, 'uploadObject' | 'headObject'>,
  args: { sha256: string; bytes: Buffer },
): Promise<{ sha256: string; size_bytes: number }> {
  const sha256 = normalizeWarmcacheSha(args.sha256);
  if (args.bytes.length > MAX_WARMCACHE_BLOB_BYTES) {
    throw new DomainError(413, 'warmcache_blob_too_large', 'warm-cache blob is too large');
  }
  const actualSha = createHash('sha256').update(args.bytes).digest('hex');
  if (actualSha !== sha256) {
    throw new DomainError(400, 'sha256_mismatch', 'sha256 does not match body');
  }

  const key = warmcacheCasKey(sha256);
  await persistCasBlob(pool, storage, { sha256, key, bytes: args.bytes });

  return { sha256, size_bytes: args.bytes.length };
}

export async function loadWarmcacheBlob(
  pool: Db,
  storage: Pick<CasStorage, 'getObjectBytes'>,
  sha256: string,
): Promise<Buffer | null> {
  const normalized = normalizeWarmcacheSha(sha256);
  return loadCasBlob(pool, storage, normalized);
}

/** Replace the manifest for one (workspace, lockfile-hash, kind) dependency set.
 * Atomic: the set is wholly replaced so a re-publish never leaves stale paths. */
export async function registerWarmcacheManifest(
  pool: Db,
  args: {
    workspaceId: string;
    lockfileHash: string;
    kind: string;
    entries: WarmcacheEntry[];
  },
): Promise<{ count: number }> {
  const lockfileHash = normalizeLockfileHash(args.lockfileHash);
  const kind = normalizeKind(args.kind);
  // Dedupe by path (last wins) so the bulk insert can't hit the unique key twice.
  const byPath = new Map<string, WarmcacheEntry>();
  for (const e of args.entries) {
    byPath.set(normalizeCachePath(e.path), {
      path: normalizeCachePath(e.path),
      sha256: normalizeWarmcacheSha(e.sha256),
      size_bytes: Number.isFinite(e.size_bytes) && e.size_bytes >= 0 ? Math.floor(e.size_bytes) : 0,
    });
  }
  const entries = [...byPath.values()];

  await withTx(pool, async (client) => {
    await client.query(`DELETE FROM warmcache_blobs WHERE workspace_id = $1 AND lockfile_hash = $2 AND kind = $3`, [
      args.workspaceId,
      lockfileHash,
      kind,
    ]);
    if (entries.length > 0) {
      // Single round-trip bulk insert — a full node_modules manifest is tens of
      // thousands of rows, so per-row INSERTs would be a long-held transaction.
      await client.query(
        `INSERT INTO warmcache_blobs (workspace_id, lockfile_hash, kind, path, sha256, size_bytes)
         SELECT $1, $2, $3, unnest($4::text[]), unnest($5::text[]), unnest($6::bigint[])`,
        [
          args.workspaceId,
          lockfileHash,
          kind,
          entries.map((e) => e.path),
          entries.map((e) => e.sha256),
          entries.map((e) => e.size_bytes),
        ],
      );
    }
  });
  return { count: entries.length };
}

export async function loadWarmcacheManifest(
  pool: Db,
  args: { workspaceId: string; lockfileHash: string; kind: string },
): Promise<WarmcacheEntry[]> {
  const rows = await pool.query<{ path: string; sha256: string; size_bytes: string | number }>(
    `SELECT path, sha256, size_bytes
       FROM warmcache_blobs
      WHERE workspace_id = $1 AND lockfile_hash = $2 AND kind = $3
      ORDER BY path
      LIMIT ${MAX_WARMCACHE_MANIFEST_ENTRIES}`,
    [args.workspaceId, normalizeLockfileHash(args.lockfileHash), normalizeKind(args.kind)],
  );
  return rows.rows.map((r) => ({
    path: r.path,
    sha256: r.sha256,
    size_bytes: typeof r.size_bytes === 'string' ? Number(r.size_bytes) : r.size_bytes,
  }));
}

export async function bumpWarmcacheLastHydrated(
  pool: Db,
  args: { workspaceId: string; lockfileHash: string; kind: string },
): Promise<{ updated: number }> {
  const result = await pool.query(
    `UPDATE warmcache_blobs
        SET last_hydrated_at = now()
      WHERE workspace_id = $1
        AND lockfile_hash = $2
        AND kind = $3`,
    [args.workspaceId, normalizeLockfileHash(args.lockfileHash), normalizeKind(args.kind)],
  );
  return { updated: result.rowCount ?? 0 };
}

export async function sweepStaleWarmcacheManifests(
  pool: Db,
  args: { ttlMs: number; sizeCapBytes: number; batchLimit: number },
): Promise<{ evicted: number }> {
  const batchLimit = Math.max(0, Math.floor(args.batchLimit));
  if (batchLimit === 0) return { evicted: 0 };

  return withTx(pool, async (client) => {
    const ttl = await client.query<{ evicted: number }>(
      `WITH candidates AS (
         SELECT workspace_id, lockfile_hash, kind
           FROM warmcache_blobs
          GROUP BY workspace_id, lockfile_hash, kind
         HAVING max(last_hydrated_at) < now() - ($1::double precision * interval '1 millisecond')
          ORDER BY max(last_hydrated_at) ASC, workspace_id ASC, lockfile_hash ASC, kind ASC
          LIMIT $2
       ),
       deleted AS (
         DELETE FROM warmcache_blobs w
          USING candidates c
          WHERE w.workspace_id = c.workspace_id
            AND w.lockfile_hash = c.lockfile_hash
            AND w.kind = c.kind
          RETURNING w.workspace_id, w.lockfile_hash, w.kind
       )
       SELECT count(*)::int AS evicted
         FROM (SELECT DISTINCT workspace_id, lockfile_hash, kind FROM deleted) d`,
      [Math.max(0, args.ttlMs), batchLimit],
    );
    const ttlEvicted = Number(ttl.rows[0]?.evicted ?? 0);
    const remainingLimit = batchLimit - ttlEvicted;
    if (remainingLimit <= 0) return { evicted: ttlEvicted };

    const cap = await client.query<{ evicted: number }>(
      `WITH group_sizes AS (
         SELECT workspace_id,
                lockfile_hash,
                kind,
                min(last_hydrated_at) AS last_hydrated_at,
                sum(size_bytes)::bigint AS group_bytes
           FROM warmcache_blobs
          GROUP BY workspace_id, lockfile_hash, kind
       ),
       workspace_totals AS (
         SELECT workspace_id, sum(group_bytes)::bigint AS total_bytes
           FROM group_sizes
          GROUP BY workspace_id
         HAVING sum(group_bytes) > $1::bigint
       ),
       ranked AS (
         SELECT gs.workspace_id,
                gs.lockfile_hash,
                gs.kind,
                sum(gs.group_bytes) OVER (
                  PARTITION BY gs.workspace_id
                  ORDER BY gs.last_hydrated_at ASC, gs.lockfile_hash ASC, gs.kind ASC
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS cumulative_evicted_bytes,
                gs.group_bytes,
                wt.total_bytes - $1::bigint AS excess_bytes
           FROM group_sizes gs
           JOIN workspace_totals wt ON wt.workspace_id = gs.workspace_id
       ),
       candidates AS (
         SELECT workspace_id, lockfile_hash, kind
           FROM ranked
          WHERE cumulative_evicted_bytes - group_bytes < excess_bytes
          ORDER BY workspace_id ASC, cumulative_evicted_bytes ASC, lockfile_hash ASC, kind ASC
          LIMIT $2
       ),
       deleted AS (
         DELETE FROM warmcache_blobs w
          USING candidates c
          WHERE w.workspace_id = c.workspace_id
            AND w.lockfile_hash = c.lockfile_hash
            AND w.kind = c.kind
          RETURNING w.workspace_id, w.lockfile_hash, w.kind
       )
       SELECT count(*)::int AS evicted
         FROM (SELECT DISTINCT workspace_id, lockfile_hash, kind FROM deleted) d`,
      [Math.max(0, Math.floor(args.sizeCapBytes)), remainingLimit],
    );
    return { evicted: ttlEvicted + Number(cap.rows[0]?.evicted ?? 0) };
  });
}

export function normalizeWarmcacheSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new DomainError(400, 'bad_query', 'valid sha256 is required');
  }
  return value.toLowerCase();
}

function normalizeLockfileHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-zA-Z._-]{1,128}$/.test(value)) {
    throw new DomainError(400, 'bad_query', 'valid lockfile_hash is required');
  }
  return value;
}

function normalizeKind(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(value)) {
    throw new DomainError(400, 'bad_query', 'valid kind is required');
  }
  return value;
}

function normalizeCachePath(value: unknown): string {
  if (typeof value !== 'string') {
    throw new DomainError(400, 'bad_query', 'cache path must be a string');
  }
  const trimmed = value.replace(/^\/+/, '').trim();
  // Reject traversal + NUL (PG rejects NUL in text → would surface as a 500).
  if (!trimmed || trimmed.length > 1024 || trimmed.includes('..') || trimmed.includes('\0')) {
    throw new DomainError(400, 'bad_query', 'invalid cache path');
  }
  return trimmed;
}

// Warm-cache blobs share the CAS namespace with everything else (content keyed),
// matching the profile-bundle layout.
function warmcacheCasKey(sha256: string): string {
  return `cas/${sha256}`;
}
