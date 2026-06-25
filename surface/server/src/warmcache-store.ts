import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { withTx } from './db.js';
import { ArtifactLedger } from './artifact-ledger.js';
import { DomainError } from './events.js';

// A single warm-cache blob is one file from an installed dependency set (a file
// under node_modules/, cargo registry/, ...). Bounded by the shared CAS ceiling.
export const MAX_WARMCACHE_BLOB_BYTES = 16 * 1024 * 1024;
// A dependency set is large but bounded; cap manifest size to keep the bulk
// insert + hydration response from going unbounded.
export const MAX_WARMCACHE_MANIFEST_ENTRIES = 100_000;

interface BlobStorage {
  uploadObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  getObjectBytes: (key: string) => Promise<Buffer>;
  headObject?: (key: string) => Promise<{ contentLength: number } | null>;
}

export interface WarmcacheEntry {
  path: string;
  sha256: string;
  size_bytes: number;
}

/** Upload one warm-cache blob into the shared content-addressed store. Mirrors
 * the profile-bundle blob path: dedup on the durable CAS, verify the body hash. */
export async function storeWarmcacheBlob(
  pool: Db,
  storage: Pick<BlobStorage, 'uploadObject' | 'headObject'>,
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
  const ledger = new ArtifactLedger(pool);
  const durable = await ledger.blobIsDurable(sha256);
  if (!durable) {
    const exists = storage.headObject ? await storage.headObject(key) : null;
    if (!exists) await storage.uploadObject(key, args.bytes, 'application/octet-stream');
    await pool.query(
      `INSERT INTO cas_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ($1, $2, $3, 'application/octet-stream')
       ON CONFLICT (sha256) DO UPDATE SET
         s3_key = COALESCE(cas_blobs.s3_key, EXCLUDED.s3_key),
         size_bytes = GREATEST(cas_blobs.size_bytes, EXCLUDED.size_bytes)`,
      [sha256, key, args.bytes.length],
    );
  }

  return { sha256, size_bytes: args.bytes.length };
}

export async function loadWarmcacheBlob(
  pool: Db,
  storage: Pick<BlobStorage, 'getObjectBytes'>,
  sha256: string,
): Promise<Buffer | null> {
  const normalized = normalizeWarmcacheSha(sha256);
  const row = await pool.query<{ s3_key: string | null }>(
    'SELECT s3_key FROM cas_blobs WHERE sha256 = $1',
    [normalized],
  );
  const key = row.rows[0]?.s3_key;
  if (!key) return null;
  try {
    return await storage.getObjectBytes(key);
  } catch {
    return null;
  }
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
    await client.query(
      `DELETE FROM warmcache_blobs WHERE workspace_id = $1 AND lockfile_hash = $2 AND kind = $3`,
      [args.workspaceId, lockfileHash, kind],
    );
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
