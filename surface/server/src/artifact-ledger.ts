// CAS-ledger foundation (notes/cas-ledger-build-plan.md). The shared, content-
// addressed version-chain core that both ingestion paths build on:
//   - the capture-bridge (Lane 1) calls `commitVersion` per `artifact.captured`
//     frame — single ordered writer per session, so base is implicit/safe;
//   - the human write-back (Lane 3) uses the lower-level primitives to run its
//     own conflict-state transaction (3-way merge on a stale base).
// Keeping the write core here (not duplicated in each lane) is what lets the two
// ingestion paths share one definition of "append a version + advance latest".

import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';

export type MergeClass = 'immutable-data' | 'mergeable-doc' | 'derived-output';
export type VersionKind = 'created' | 'modified' | 'deleted';
export type VersionStatus = 'normal' | 'conflict';

/** Which version to resolve on the read path: a pointer name (`latest` /
 * `official` / a pin) or an explicit seq. */
export type VersionRef = { pointer: string } | { seq: number };

export interface LatestVersion {
  seq: number;
  blobSha: string | null;
  kind: VersionKind;
}

export interface ResolvedVersion {
  artifactId: string;
  seq: number;
  blobSha: string | null;
  kind: VersionKind;
  status: VersionStatus;
  /** mime/size/s3Key come from the blob; all null for a delete tombstone. */
  mime: string | null;
  sizeBytes: number | null;
  s3Key: string | null;
}

export interface ChangedArtifact {
  path: string;
  seq: number;
  sha: string | null;
  kind: VersionKind;
}

/** Gap-free change-feed cursor: (inserting-txn-id, row-id) in commit order.
 * Both are stringified — `xid8` and `bigint id` can exceed JS's safe integer. */
export interface ChangeCursor {
  xid: string;
  id: string;
}

export const CHANGE_CURSOR_ZERO: ChangeCursor = { xid: '0', id: '0' };

/** One row of the egress-pollable change-feed (`artifact_changes`). */
export interface ChangeRow {
  id: string;
  path: string;
  seq: number;
  baseSeq: number | null;
  sha: string | null;
  status: VersionStatus;
  kind: VersionKind;
  author: string;
  /** agent | human | node-merge — node-merge is the echo gate (§8B #2). */
  origin: string;
}

export interface ChangeFeedPage {
  rows: ChangeRow[];
  nextCursor: ChangeCursor;
}

/** Per-path sync-state — current base + byte-origin for one container's working
 * copy of one path (the "one root" record, §8A takeaway #1 / §8B #2). */
export interface SyncState {
  baseSeq: number;
  baseSha: string | null;
  upperSha: string | null;
  appliedRemoteSeq: number | null;
}

export interface CommitVersionParams {
  sessionId: string;
  channelId: string;
  path: string;
  /** null only for a delete tombstone (kind='deleted'). */
  blobSha: string | null;
  sizeBytes: number;
  mime: string;
  author: string;
  kind: VersionKind;
  /** Set when the artifact is first created; ignored afterwards. */
  mergeClass?: MergeClass;
  /** OCC: the version the writer edited against. Omitted ⇒ implicit current
   * latest (safe only for a single ordered writer, i.e. the capture stream). */
  baseSeq?: number;
  /** Conflict lane passes 'conflict' + a payload; defaults to a normal version. */
  status?: VersionStatus;
  conflict?: unknown;
}

export type CommitVersionResult =
  | { ok: true; artifactId: string; seq: number; idempotent: boolean }
  | { ok: false; reason: 'stale_base'; artifactId: string; latestSeq: number; baseSeq: number };

/** Content-addressed S3 key for a blob. Sharded by the first byte so the
 * keyspace spreads across S3 prefixes (write-throughput + Merkle locality). */
export function casBlobKey(sha256: string): string {
  return `cas/${sha256.slice(0, 2)}/${sha256}`;
}

interface VersionRow {
  artifactId: string;
  seq: number;
  blobSha: string | null;
  baseSeq: number | null;
  author: string;
  kind: VersionKind;
  status?: VersionStatus;
  conflict?: unknown;
}

export class ArtifactLedger {
  constructor(private readonly pool: Db) {}

  // === blob primitives (Lane 1 CAS re-key + offload) =======================

  /** Register a blob (idempotent). `s3_key` stays NULL until the offload worker
   * uploads the bytes; `ON CONFLICT DO NOTHING` makes concurrent first-writes of
   * the same sha safe (the hand-compute race). */
  async upsertBlob(
    client: DbClient,
    blob: { sha256: string; sizeBytes: number; mime: string },
  ): Promise<void> {
    await client.query(
      `INSERT INTO cas_blobs (sha256, size_bytes, mime)
       VALUES ($1, $2, $3)
       ON CONFLICT (sha256) DO NOTHING`,
      [blob.sha256, blob.sizeBytes, blob.mime],
    );
  }

  /** True if the blob's bytes are already durable in S3 (offload dedup skip). */
  async blobIsOffloaded(sha256: string): Promise<boolean> {
    const res = await this.pool.query<{ s3_key: string | null }>(
      `SELECT s3_key FROM cas_blobs WHERE sha256 = $1`,
      [sha256],
    );
    return res.rows[0]?.s3_key != null;
  }

  /** Stamp the S3 key once bytes are durable (only if not already stamped). */
  async stampBlobS3Key(sha256: string, s3Key: string): Promise<void> {
    await this.pool.query(
      `UPDATE cas_blobs SET s3_key = $2 WHERE sha256 = $1 AND s3_key IS NULL`,
      [sha256, s3Key],
    );
  }

  // === chain primitives (used directly by the conflict lane) ===============

  /** Resolve `(session, path)` to an artifact id, creating it if new, and hold a
   * row lock for the rest of the transaction so concurrent writers to the same
   * artifact serialize (monotonic seq, no gaps/dups — the hand-compute case). */
  async resolveOrCreateArtifactLocked(
    client: DbClient,
    params: { sessionId: string; channelId: string; path: string; mergeClass?: MergeClass },
  ): Promise<string> {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO artifacts (session_id, channel_id, path, merge_class)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, path) DO NOTHING
       RETURNING id`,
      [params.sessionId, params.channelId, params.path, params.mergeClass ?? 'immutable-data'],
    );
    if (inserted.rows[0]) return inserted.rows[0].id; // fresh row, locked by this tx
    const locked = await client.query<{ id: string }>(
      `SELECT id FROM artifacts WHERE session_id = $1 AND path = $2 FOR UPDATE`,
      [params.sessionId, params.path],
    );
    return locked.rows[0]!.id; // exists: the INSERT conflicted, so the row is there
  }

  /** The current `latest` for an artifact (or null if it has no versions).
   * Authoritative via the pointer; falls back to max(seq) defensively. */
  async latestVersion(client: DbClient, artifactId: string): Promise<LatestVersion | null> {
    const viaPointer = await client.query<{ seq: number; blob_sha: string | null; kind: VersionKind }>(
      `SELECT v.seq, v.blob_sha, v.kind
         FROM artifact_pointers p
         JOIN artifact_versions v ON v.artifact_id = p.artifact_id AND v.seq = p.seq
        WHERE p.artifact_id = $1 AND p.name = 'latest'`,
      [artifactId],
    );
    const row = viaPointer.rows[0]
      ?? (
        await client.query<{ seq: number; blob_sha: string | null; kind: VersionKind }>(
          `SELECT seq, blob_sha, kind FROM artifact_versions
            WHERE artifact_id = $1 ORDER BY seq DESC LIMIT 1`,
          [artifactId],
        )
      ).rows[0];
    if (!row) return null;
    return { seq: row.seq, blobSha: row.blob_sha, kind: row.kind };
  }

  /** Insert one version row. Caller owns the transaction + artifact lock. */
  async insertVersion(client: DbClient, v: VersionRow): Promise<void> {
    await client.query(
      `INSERT INTO artifact_versions
         (artifact_id, seq, blob_sha, base_seq, author, kind, status, conflict)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        v.artifactId,
        v.seq,
        v.blobSha,
        v.baseSeq,
        v.author,
        v.kind,
        v.status ?? 'normal',
        v.conflict != null ? JSON.stringify(v.conflict) : null,
      ],
    );
  }

  /** Move a pointer (`latest`/`official`/pin) to a seq. */
  async advancePointer(
    client: DbClient,
    artifactId: string,
    name: string,
    seq: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO artifact_pointers (artifact_id, name, seq)
       VALUES ($1, $2, $3)
       ON CONFLICT (artifact_id, name) DO UPDATE SET seq = EXCLUDED.seq, updated_at = now()`,
      [artifactId, name, seq],
    );
    await client.query("SELECT pg_notify('artifact_advanced', $1)", [
      JSON.stringify({ artifactId, name, seq }),
    ]);
  }

  // === gc additions ===

  /** C1 change-feed source: latest changed version per path after a watermark. */
  async changedSince(sessionId: string, sinceIso: string): Promise<ChangedArtifact[]> {
    const res = await this.pool.query<{
      path: string;
      seq: number;
      sha: string | null;
      kind: VersionKind;
    }>(
      `WITH changed AS (
         SELECT a.path, v.seq, v.blob_sha AS sha, v.kind, v.created_at,
                row_number() OVER (
                  PARTITION BY a.path
                  ORDER BY v.created_at DESC, v.seq DESC
                ) AS rn
           FROM artifacts a
           JOIN artifact_versions v ON v.artifact_id = a.id
          WHERE a.session_id = $1
            AND v.created_at > $2::timestamptz
       )
       SELECT path, seq, sha, kind
         FROM changed
        WHERE rn = 1
        ORDER BY created_at ASC, path ASC`,
      [sessionId, sinceIso],
    );
    return res.rows;
  }

  // === gap-free change-feed (C1 inbound source; §8B #7) ====================

  /**
   * Egress-pollable, resumable, GAP-FREE feed of version commits for a session,
   * in commit order, after `cursor`. See migration 034 for why the cursor is
   * (xid, id) watermarked below the snapshot xmin horizon rather than max(id):
   * a slow concurrent txn can make a lower id visible after a higher one, which a
   * max(id) cursor drops forever. Only rows whose inserting txn has fully drained
   * (xid < xmin horizon) are returned, ordered by (xid, id), so nothing is ever
   * skipped. `nextCursor` is the last row's (xid, id), or the input cursor when
   * the page is empty.
   */
  async changesSince(
    sessionId: string,
    cursor: ChangeCursor = CHANGE_CURSOR_ZERO,
    limit = 500,
  ): Promise<ChangeFeedPage> {
    const res = await this.pool.query<{
      id: string;
      xid: string;
      path: string;
      seq: number;
      base_seq: number | null;
      sha: string | null;
      status: VersionStatus;
      kind: VersionKind;
      author: string;
      origin: string;
    }>(
      `SELECT id::text AS id, xid::text AS xid, path, seq, base_seq, sha, status, kind, author, origin
         FROM artifact_changes
        WHERE session_id = $1
          AND xid < pg_snapshot_xmin(pg_current_snapshot())
          AND (xid, id) > ($2::xid8, $3::bigint)
        ORDER BY xid, id
        LIMIT $4`,
      [sessionId, cursor.xid, cursor.id, limit],
    );
    const rows: ChangeRow[] = res.rows.map((r) => ({
      id: r.id,
      path: r.path,
      seq: r.seq,
      baseSeq: r.base_seq,
      sha: r.sha,
      status: r.status,
      kind: r.kind,
      author: r.author,
      origin: r.origin,
    }));
    const last = res.rows[res.rows.length - 1];
    const nextCursor: ChangeCursor = last ? { xid: last.xid, id: last.id } : cursor;
    return { rows, nextCursor };
  }

  // === per-path sync-state (§8B #2; node mirrors, server is authoritative) ==

  async getSyncState(sessionId: string, path: string): Promise<SyncState | null> {
    const res = await this.pool.query<{
      base_seq: number;
      base_sha: string | null;
      upper_sha: string | null;
      applied_remote_seq: number | null;
    }>(
      `SELECT base_seq, base_sha, upper_sha, applied_remote_seq
         FROM artifact_sync_state WHERE session_id = $1 AND path = $2`,
      [sessionId, path],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      baseSeq: row.base_seq,
      baseSha: row.base_sha,
      upperSha: row.upper_sha,
      appliedRemoteSeq: row.applied_remote_seq,
    };
  }

  /** Upsert the per-path sync-state. Used at hydration (base_seq), on capture
   * (upper_sha), and after a node-side adopt (applied_remote_seq + advance base). */
  async upsertSyncState(sessionId: string, path: string, state: SyncState): Promise<void> {
    await this.pool.query(
      `INSERT INTO artifact_sync_state
         (session_id, path, base_seq, base_sha, upper_sha, applied_remote_seq, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (session_id, path) DO UPDATE
         SET base_seq = EXCLUDED.base_seq,
             base_sha = EXCLUDED.base_sha,
             upper_sha = EXCLUDED.upper_sha,
             applied_remote_seq = EXCLUDED.applied_remote_seq,
             updated_at = now()`,
      [sessionId, path, state.baseSeq, state.baseSha, state.upperSha, state.appliedRemoteSeq],
    );
  }

  // === the orchestrated write (capture-bridge + clean write-back) ==========

  /**
   * Commit one new version of `(session, path)` and advance `latest`, in a
   * single transaction. Handles blob registration, resolve-or-create (locked),
   * OCC stale-base detection, and content-dedup.
   *
   * - `latest == null` → seq 1.
   * - `baseSeq` mismatch vs latest → `{ ok:false, reason:'stale_base' }` (no
   *   write); the bridge never passes a base so never trips this, the write-back
   *   lane catches it and runs the 3-way merge.
   * - identical bytes as latest (normal, non-delete) → idempotent no-op.
   */
  async commitVersion(params: CommitVersionParams): Promise<CommitVersionResult> {
    const status = params.status ?? 'normal';
    return withTx(this.pool, async (client) => {
      if (params.blobSha != null) {
        await this.upsertBlob(client, {
          sha256: params.blobSha,
          sizeBytes: params.sizeBytes,
          mime: params.mime,
        });
      }
      const artifactId = await this.resolveOrCreateArtifactLocked(client, {
        sessionId: params.sessionId,
        channelId: params.channelId,
        path: params.path,
        mergeClass: params.mergeClass,
      });
      const latest = await this.latestVersion(client, artifactId);

      if (latest == null) {
        await this.insertVersion(client, {
          artifactId, seq: 1, blobSha: params.blobSha, baseSeq: null,
          author: params.author, kind: params.kind, status, conflict: params.conflict,
        });
        await this.advancePointer(client, artifactId, 'latest', 1);
        return { ok: true, artifactId, seq: 1, idempotent: false };
      }

      const effectiveBase = params.baseSeq ?? latest.seq;
      if (effectiveBase !== latest.seq) {
        return { ok: false, reason: 'stale_base', artifactId, latestSeq: latest.seq, baseSeq: effectiveBase };
      }
      if (
        status === 'normal' &&
        params.kind !== 'deleted' &&
        params.blobSha != null &&
        params.blobSha === latest.blobSha
      ) {
        return { ok: true, artifactId, seq: latest.seq, idempotent: true };
      }

      const seq = latest.seq + 1;
      await this.insertVersion(client, {
        artifactId, seq, blobSha: params.blobSha, baseSeq: latest.seq,
        author: params.author, kind: params.kind, status, conflict: params.conflict,
      });
      await this.advancePointer(client, artifactId, 'latest', seq);
      return { ok: true, artifactId, seq, idempotent: false };
    });
  }

  // === the read path (Lane 2 serve) ========================================

  /** Resolve `(session, path)` + a ref to a concrete version joined with its
   * blob. Returns null when the artifact, pointer, or version is missing. */
  async resolveVersion(
    sessionId: string,
    path: string,
    ref: VersionRef,
  ): Promise<ResolvedVersion | null> {
    const art = await this.pool.query<{ id: string }>(
      `SELECT id FROM artifacts WHERE session_id = $1 AND path = $2`,
      [sessionId, path],
    );
    const artifactId = art.rows[0]?.id;
    if (!artifactId) return null;

    let seq: number | undefined;
    if ('seq' in ref) {
      seq = ref.seq;
    } else {
      const p = await this.pool.query<{ seq: number }>(
        `SELECT seq FROM artifact_pointers WHERE artifact_id = $1 AND name = $2`,
        [artifactId, ref.pointer],
      );
      seq = p.rows[0]?.seq;
    }
    if (seq == null) return null;

    const v = await this.pool.query<{
      seq: number;
      blob_sha: string | null;
      kind: VersionKind;
      status: VersionStatus;
      mime: string | null;
      size_bytes: number | null;
      s3_key: string | null;
    }>(
      `SELECT v.seq, v.blob_sha, v.kind, v.status, b.mime, b.size_bytes, b.s3_key
         FROM artifact_versions v
         LEFT JOIN cas_blobs b ON b.sha256 = v.blob_sha
        WHERE v.artifact_id = $1 AND v.seq = $2`,
      [artifactId, seq],
    );
    const row = v.rows[0];
    if (!row) return null;
    return {
      artifactId,
      seq: row.seq,
      blobSha: row.blob_sha,
      kind: row.kind,
      status: row.status,
      mime: row.mime,
      sizeBytes: row.size_bytes,
      s3Key: row.s3_key,
    };
  }
}
