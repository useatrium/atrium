// CAS-ledger foundation (docs/archive/notes/cas-ledger-build-plan.md). Direct capture,
// upload auto-land, and human write-back all commit versions through this
// content-addressed chain. Non-delete versions are expected to reference a
// cas_blobs row whose s3_key is already durable.

import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';
import {
  canonicalizeSessionArtifactPath,
  canonicalizeWorkspaceArtifactPath,
} from './artifact-path.js';
import { readableArtifactRootsForSession, type ArtifactScopeRoot } from './artifact-scope.js';
import {
  classifyMediaFromMime,
  type MediaClassification,
  type MediaKind,
} from './media-classifier.js';

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
  detectedMime: string | null;
  mediaKind: MediaKind | null;
  isText: boolean | null;
  textEncoding: string | null;
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

export interface CommitUploadParams {
  workspaceId: string;
  channelId: string;
  path: string;
  blobSha: string;
  sizeBytes: number;
  mime: string;
  author: string;
}

export type CommitVersionResult =
  | { ok: true; artifactId: string; seq: number; idempotent: boolean }
  | { ok: false; reason: 'stale_base'; artifactId: string; latestSeq: number; baseSeq: number };

export interface CommitUploadResult {
  artifactId: string;
  seq: number;
}

export interface CommitVersionGroupFile {
  path: string;
  /** null only for a delete tombstone (kind='deleted'). */
  blobSha: string | null;
  sizeBytes: number;
  mime: string;
  baseSeq?: number | null;
  kind: VersionKind;
  /** Set when the artifact is first created; ignored afterwards. */
  mergeClass?: MergeClass;
}

export interface CommitVersionGroupParams {
  sessionId: string;
  channelId: string;
  groupId: string;
  author: string;
  files: CommitVersionGroupFile[];
}

export interface CommitGroupFileResult {
  path: string;
  seq: number;
}

export interface CommitGroupStaleFile {
  path: string;
  latest_seq: number | null;
  base_seq: number | null;
}

export type CommitGroupResult =
  | { ok: true; group_id: string; results: CommitGroupFileResult[] }
  | { ok: false; reason: 'stale_base'; stale: CommitGroupStaleFile[] };

class CommitGroupStaleBaseError extends Error {
  constructor(readonly stale: CommitGroupStaleFile[]) {
    super('stale_base');
  }
}

/** Content-addressed S3 key for a blob. Sharded by the first byte so the
 * keyspace spreads across S3 prefixes (write-throughput + Merkle locality). */
export function casBlobKey(sha256: string): string {
  return `cas/${sha256.slice(0, 2)}/${sha256}`;
}

function mergeClassForMime(mime: string): MergeClass {
  const normalized = (mime.split(';', 1)[0] ?? '').trim().toLowerCase();
  return normalized.startsWith('text/') ? 'mergeable-doc' : 'immutable-data';
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

  private rootLikePatterns(roots: readonly ArtifactScopeRoot[]): string[] {
    return roots.map((root) => `${root.prefix}/%`);
  }

  private async workspaceForSession(
    client: Db | DbClient,
    sessionId: string,
  ): Promise<{ workspaceId: string; channelId: string }> {
    const res = await client.query<{ workspace_id: string; channel_id: string }>(
      `SELECT workspace_id, channel_id FROM sessions WHERE id = $1`,
      [sessionId],
    );
    const row = res.rows[0];
    if (!row) throw new Error(`session not found: ${sessionId}`);
    return { workspaceId: row.workspace_id, channelId: row.channel_id };
  }

  // === blob primitives ======================================================

  /** Register a blob (idempotent). Normal artifact writes pass `s3Key` only
   * after bytes are durable in S3/CAS; legacy NULL rows are repair-only. */
  async upsertBlob(
    client: DbClient,
    blob: {
      sha256: string;
      sizeBytes: number;
      mime: string;
      s3Key?: string | null;
      classification?: MediaClassification;
    },
  ): Promise<void> {
    const classification = blob.classification ?? classifyMediaFromMime(blob.mime);
    await client.query(
      `INSERT INTO cas_blobs
         (sha256, s3_key, size_bytes, mime, detected_mime, media_kind, is_text, text_encoding, classification_meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (sha256) DO UPDATE
             SET s3_key = COALESCE(cas_blobs.s3_key, EXCLUDED.s3_key),
                 detected_mime = COALESCE(cas_blobs.detected_mime, EXCLUDED.detected_mime),
                 media_kind = COALESCE(cas_blobs.media_kind, EXCLUDED.media_kind),
                 is_text = COALESCE(cas_blobs.is_text, EXCLUDED.is_text),
                 text_encoding = COALESCE(cas_blobs.text_encoding, EXCLUDED.text_encoding),
                 classification_meta = CASE
                   WHEN cas_blobs.classification_meta = '{}'::jsonb THEN EXCLUDED.classification_meta
                   ELSE cas_blobs.classification_meta
                 END`,
      [
        blob.sha256,
        blob.s3Key ?? null,
        blob.sizeBytes,
        blob.mime,
        classification.detectedMime,
        classification.mediaKind,
        classification.isText,
        classification.textEncoding,
        JSON.stringify(classification.meta),
      ],
    );
  }

  /** True if the blob's bytes are already durable in S3/CAS. */
  async blobIsDurable(sha256: string): Promise<boolean> {
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

  /** Resolve `(workspace, path)` to an artifact id, creating it if new, and hold a
   * row lock for the rest of the transaction so concurrent writers to the same
   * artifact serialize (monotonic seq, no gaps/dups — the hand-compute case). */
  async resolveOrCreateArtifactLocked(
    client: DbClient,
    params: { sessionId: string; channelId: string; path: string; mergeClass?: MergeClass },
  ): Promise<string> {
    const { workspaceId, channelId } = await this.workspaceForSession(client, params.sessionId);
    const path = canonicalizeSessionArtifactPath(params.path, { sessionId: params.sessionId, channelId });
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO artifacts (workspace_id, session_id, channel_id, path, merge_class)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, path) DO NOTHING
       RETURNING id`,
      [workspaceId, params.sessionId, channelId, path, params.mergeClass ?? 'immutable-data'],
    );
    if (inserted.rows[0]) return inserted.rows[0].id; // fresh row, locked by this tx
    const locked = await client.query<{ id: string }>(
      `SELECT id FROM artifacts WHERE workspace_id = $1 AND path = $2 FOR UPDATE`,
      [workspaceId, path],
    );
    return locked.rows[0]!.id; // exists: the INSERT conflicted, so the row is there
  }

  /** Sessionless sibling for human-upload artifacts. Identity is still
   * `(workspace_id, path)`; `session_id` stays NULL because no agent session
   * authored the bytes. */
  async resolveOrCreateArtifactByWorkspaceLocked(
    client: DbClient,
    params: { workspaceId: string; channelId: string; path: string; mergeClass: MergeClass },
  ): Promise<string> {
    const path = canonicalizeWorkspaceArtifactPath(params.path, { channelId: params.channelId });
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO artifacts (workspace_id, session_id, channel_id, path, merge_class)
       VALUES ($1, NULL, $2, $3, $4)
       ON CONFLICT (workspace_id, path) DO NOTHING
       RETURNING id`,
      [params.workspaceId, params.channelId, path, params.mergeClass],
    );
    if (inserted.rows[0]) return inserted.rows[0].id; // fresh row, locked by this tx
    const locked = await client.query<{ id: string }>(
      `SELECT id FROM artifacts WHERE workspace_id = $1 AND path = $2 FOR UPDATE`,
      [params.workspaceId, path],
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
    const scope = await readableArtifactRootsForSession(this.pool, sessionId);
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
          WHERE a.workspace_id = $1
            AND a.path LIKE ANY($2::text[])
            AND v.created_at > $3::timestamptz
       )
       SELECT path, seq, sha, kind
         FROM changed
        WHERE rn = 1
        ORDER BY created_at ASC, path ASC`,
      [scope.workspaceId, this.rootLikePatterns(scope.readableRoots), sinceIso],
    );
    return res.rows;
  }

  // === gap-free change-feed (C1 inbound source; §8B #7) ====================

  /**
   * Egress-pollable, resumable, GAP-FREE feed of version commits for a session,
   * in commit order, after `cursor`. The cursor is (xid, id): bigserial id alone
   * is unsafe because it is assigned at INSERT but visible at COMMIT, so a slow
   * concurrent txn can make a lower id visible after a higher one — a max(id)
   * cursor drops that row forever (§8B #7).
   *
   * Gap-freeness needs to withhold a committed row while a SAME-SESSION writer
   * with a possibly-lower (xid, id) is still in flight. We get that with a
   * per-session advisory lock (migration 035): writers hold it SHARED for their
   * txn; here we try to take it EXCLUSIVE, non-blocking. If a writer is mid-flight
   * the try fails and we withhold the whole page (cursor unchanged — nothing is
   * skipped). On success no writer can interleave for the read, so the snapshot
   * sees every committed row in (xid, id) order. Unlike the old cluster-global
   * `xid < pg_snapshot_xmin(...)` horizon, unrelated transactions take no lock and
   * never stall the feed. `nextCursor` is the last row's (xid, id), or the input
   * cursor when the page is empty (or withheld).
   */
  async changesSince(
    sessionId: string,
    cursor: ChangeCursor = CHANGE_CURSOR_ZERO,
    limit = 500,
  ): Promise<ChangeFeedPage> {
    return withTx(this.pool, async (client) => {
      const scope = await readableArtifactRootsForSession(client, sessionId);
      // Per-WORKSPACE exclusive try-lock, matching the writer's shared lock
      // (migration 043). Artifacts are workspace-shared, so gap-freeness must
      // stall on any in-flight writer of THIS WORKSPACE's feed, not just this
      // session's (§8B #7).
      const lock = await client.query<{ got: boolean }>(
        `SELECT pg_try_advisory_xact_lock(
                  hashtextextended('artifact_changes:' || $1::text, 0)) AS got`,
        [scope.workspaceId],
      );
      if (!lock.rows[0]?.got) {
        // A same-workspace writer is mid-flight; withhold so nothing is skipped.
        return { rows: [], nextCursor: cursor };
      }
      const res = await client.query<{
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
         WHERE workspace_id = $1
            AND path LIKE ANY($2::text[])
            AND (xid, id) > ($3::xid8, $4::bigint)
          ORDER BY xid, id
          LIMIT $5`,
        [scope.workspaceId, this.rootLikePatterns(scope.readableRoots), cursor.xid, cursor.id, limit],
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
    });
  }

  // === conflict-aware serve resolution (§8B #5) ===========================

  /**
   * Decide which version to SERVE for `(session, path)` and whether the true
   * latest is an unresolved conflict. We never serve conflict-marker bytes by
   * default: the served version is the newest `status='normal'` one, while
   * `conflicted`/`conflictSeq` flag that a later conflict version is awaiting
   * resolution (so the UI can show a banner and the read stays clean). Returns
   * null when the artifact has no versions at all.
   */
  async serveResolution(
    sessionId: string,
    path: string,
    options: { readableChannelIds?: readonly string[] } = {},
  ): Promise<{
    servedSeq: number | null;
    servedKind: VersionKind | null;
    conflicted: boolean;
    conflictSeq: number | null;
    latestSeq: number | null;
  } | null> {
    const { workspaceId, channelId } = await this.workspaceForSession(this.pool, sessionId);
    const canonicalPath = canonicalizeSessionArtifactPath(path, {
      sessionId,
      channelId,
      readableChannelIds: options.readableChannelIds,
    });
    const art = await this.pool.query<{ id: string }>(
      `SELECT id FROM artifacts WHERE workspace_id = $1 AND path = $2`,
      [workspaceId, canonicalPath],
    );
    const artifactId = art.rows[0]?.id;
    if (!artifactId) return null;

    const latest = await this.pool.query<{ seq: number; status: VersionStatus }>(
      `SELECT v.seq, v.status
         FROM artifact_pointers p
         JOIN artifact_versions v ON v.artifact_id = p.artifact_id AND v.seq = p.seq
        WHERE p.artifact_id = $1 AND p.name = 'latest'`,
      [artifactId],
    );
    const latestRow = latest.rows[0] ?? null;

    const normal = await this.pool.query<{ seq: number; kind: VersionKind }>(
      `SELECT seq, kind FROM artifact_versions
        WHERE artifact_id = $1 AND status = 'normal'
        ORDER BY seq DESC LIMIT 1`,
      [artifactId],
    );
    const normalRow = normal.rows[0] ?? null;

    const conflicted = latestRow?.status === 'conflict';
    return {
      servedSeq: normalRow?.seq ?? null,
      servedKind: normalRow?.kind ?? null,
      conflicted,
      conflictSeq: conflicted ? latestRow!.seq : null,
      latestSeq: latestRow?.seq ?? null,
    };
  }

  /** The full conflict payload for one path (for the resolution UI): the
   * `status=conflict` version's jsonb + the seq/path needed to resolve. Returns
   * null when the path's latest is not a conflict. */
  async getConflict(
    sessionId: string,
    path: string,
    options: { readableChannelIds?: readonly string[] } = {},
  ): Promise<{ artifactId: string; conflictSeq: number; conflict: unknown; markerSha: string | null } | null> {
    const { workspaceId, channelId } = await this.workspaceForSession(this.pool, sessionId);
    const canonicalPath = canonicalizeSessionArtifactPath(path, {
      sessionId,
      channelId,
      readableChannelIds: options.readableChannelIds,
    });
    const res = await this.pool.query<{
      artifact_id: string;
      seq: number;
      conflict: unknown;
      blob_sha: string | null;
    }>(
      `SELECT v.artifact_id, v.seq, v.conflict, v.blob_sha
         FROM artifacts a
        JOIN artifact_pointers p ON p.artifact_id = a.id AND p.name = 'latest'
        JOIN artifact_versions v ON v.artifact_id = a.id AND v.seq = p.seq
        WHERE a.workspace_id = $1 AND a.path = $2 AND v.status = 'conflict'`,
      [workspaceId, canonicalPath],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      artifactId: row.artifact_id,
      conflictSeq: row.seq,
      conflict: row.conflict,
      markerSha: row.blob_sha,
    };
  }

  /** The S3 key for a blob sha (or null if unknown/unstamped). */
  async blobS3Key(sha: string): Promise<string | null> {
    const res = await this.pool.query<{ s3_key: string | null }>(
      `SELECT s3_key FROM cas_blobs WHERE sha256 = $1`,
      [sha],
    );
    return res.rows[0]?.s3_key ?? null;
  }

  /** Resolve `(session, path)` to an artifact id (no create). */
  async artifactIdByPath(
    sessionId: string,
    path: string,
    options: { readableChannelIds?: readonly string[] } = {},
  ): Promise<string | null> {
    const { workspaceId, channelId } = await this.workspaceForSession(this.pool, sessionId);
    const canonicalPath = canonicalizeSessionArtifactPath(path, {
      sessionId,
      channelId,
      readableChannelIds: options.readableChannelIds,
    });
    const res = await this.pool.query<{ id: string; path: string }>(
      `SELECT id, path FROM artifacts WHERE workspace_id = $1 AND path = $2`,
      [workspaceId, canonicalPath],
    );
    return res.rows[0]?.id ?? null;
  }

  /** Resolve an artifact id back to its workspace/provenance/path — for the
   * by-id resolve endpoint. */
  async artifactById(
    artifactId: string,
  ): Promise<{ workspaceId: string; sessionId: string | null; channelId: string | null; path: string } | null> {
    const res = await this.pool.query<{
      workspace_id: string;
      session_id: string;
      channel_id: string;
      path: string;
    }>(
      `SELECT workspace_id, session_id, channel_id, path FROM artifacts WHERE id = $1`,
      [artifactId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      channelId: row.channel_id,
      path: row.path,
    };
  }

  /** Scope query (A4): the artifact paths a session subscribes, with their
   * current latest seq — the node's hydration/subscription set seed (§10.1). */
  async sessionScope(
    sessionId: string,
  ): Promise<Array<{
    path: string;
    latestSeq: number;
    kind: VersionKind;
    sha: string | null;
    mime: string | null;
    detectedMime: string | null;
    mediaKind: MediaKind | null;
    isText: boolean | null;
    sizeBytes: number | null;
  }>> {
    const scope = await readableArtifactRootsForSession(this.pool, sessionId);
    const res = await this.pool.query<{
      path: string;
      seq: number;
      kind: VersionKind;
      sha: string | null;
      mime: string | null;
      detected_mime: string | null;
      media_kind: MediaKind | null;
      is_text: boolean | null;
      size_bytes: number | null;
    }>(
      `SELECT a.path, p.seq, v.kind, v.blob_sha AS sha,
              b.mime, b.detected_mime, b.media_kind, b.is_text, b.size_bytes
         FROM artifacts a
         JOIN artifact_pointers p ON p.artifact_id = a.id AND p.name = 'latest'
         JOIN artifact_versions v ON v.artifact_id = a.id AND v.seq = p.seq
         LEFT JOIN cas_blobs b ON b.sha256 = v.blob_sha
        WHERE a.workspace_id = $1
          AND a.path LIKE ANY($2::text[])
        ORDER BY a.path ASC`,
      [scope.workspaceId, this.rootLikePatterns(scope.readableRoots)],
    );
    return res.rows.map((r) => ({
      path: r.path,
      latestSeq: r.seq,
      kind: r.kind,
      sha: r.sha,
      mime: r.mime,
      detectedMime: r.detected_mime,
      mediaKind: r.media_kind,
      isText: r.is_text,
      sizeBytes: r.size_bytes,
    }));
  }

  // === per-path sync-state (§8B #2; node mirrors, server is authoritative) ==

  async getSyncState(sessionId: string, path: string): Promise<SyncState | null> {
    const { channelId } = await this.workspaceForSession(this.pool, sessionId);
    const canonicalPath = canonicalizeSessionArtifactPath(path, { sessionId, channelId });
    const res = await this.pool.query<{
      base_seq: number;
      base_sha: string | null;
      upper_sha: string | null;
      applied_remote_seq: number | null;
    }>(
      `SELECT base_seq, base_sha, upper_sha, applied_remote_seq
         FROM artifact_sync_state WHERE session_id = $1 AND path = $2`,
      [sessionId, canonicalPath],
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
    const { channelId } = await this.workspaceForSession(this.pool, sessionId);
    const canonicalPath = canonicalizeSessionArtifactPath(path, { sessionId, channelId });
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
      [sessionId, canonicalPath, state.baseSeq, state.baseSha, state.upperSha, state.appliedRemoteSeq],
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

  /**
   * Commit a human upload directly into the workspace-scoped artifact ledger.
   * Uploads have no session, so this resolves by `(workspace_id, path)`, writes
   * a normal created/modified version, and treats identical latest bytes as an
   * idempotent re-send.
   */
  async commitUpload(params: CommitUploadParams): Promise<CommitUploadResult> {
    return withTx(this.pool, async (client) => {
      await this.upsertBlob(client, {
        sha256: params.blobSha,
        sizeBytes: params.sizeBytes,
        mime: params.mime,
      });
      const artifactId = await this.resolveOrCreateArtifactByWorkspaceLocked(client, {
        workspaceId: params.workspaceId,
        channelId: params.channelId,
        path: params.path,
        mergeClass: mergeClassForMime(params.mime),
      });
      const latest = await this.latestVersion(client, artifactId);
      if (latest != null && latest.blobSha === params.blobSha) {
        return { artifactId, seq: latest.seq };
      }

      const seq = latest == null ? 1 : latest.seq + 1;
      await this.insertVersion(client, {
        artifactId,
        seq,
        blobSha: params.blobSha,
        baseSeq: latest?.seq ?? null,
        author: params.author,
        kind: latest == null ? 'created' : 'modified',
      });
      await this.advancePointer(client, artifactId, 'latest', seq);
      return { artifactId, seq };
    });
  }

  /**
   * Commit a tree manifest as one atomic version set. The whole group lands or
   * rolls back together; stale-base detection is performed across every file
   * before any version row is inserted.
   */
  async commitVersionGroup(params: CommitVersionGroupParams): Promise<CommitGroupResult> {
    try {
      return await withTx(this.pool, async (client) => {
        const { channelId } = await this.workspaceForSession(client, params.sessionId);
        const files = params.files.map((file) => ({
          ...file,
          path: canonicalizeSessionArtifactPath(file.path, { sessionId: params.sessionId, channelId }),
        }));
        const seenCanonicalPaths = new Set<string>();
        for (const file of files) {
          if (seenCanonicalPaths.has(file.path)) {
            throw new Error(`duplicate artifact path after canonicalization: ${file.path}`);
          }
          seenCanonicalPaths.add(file.path);
        }
        const insertedGroup = await client.query<{ group_id: string }>(
          `INSERT INTO artifact_commit_groups (group_id, session_id)
           VALUES ($1, $2)
           ON CONFLICT (group_id) DO NOTHING
           RETURNING group_id`,
          [params.groupId, params.sessionId],
        );
        if (!insertedGroup.rows[0]) {
          const existing = await client.query<{ result: CommitGroupResult | null }>(
            `SELECT result FROM artifact_commit_groups WHERE group_id = $1 FOR UPDATE`,
            [params.groupId],
          );
          const cached = existing.rows[0]?.result;
          if (cached != null) return cached;
          throw new Error(`commit group ${params.groupId} exists without a committed result`);
        }

        const locked: Array<{
          file: CommitVersionGroupFile;
          index: number;
          artifactId: string;
          latest: LatestVersion | null;
        }> = [];
        for (const { file, index } of files
          .map((file, index) => ({ file, index }))
          .sort((a, b) => a.file.path.localeCompare(b.file.path))) {
          const artifactId = await this.resolveOrCreateArtifactLocked(client, {
            sessionId: params.sessionId,
            channelId: params.channelId,
            path: file.path,
            mergeClass: file.mergeClass,
          });
          const latest = await this.latestVersion(client, artifactId);
          locked.push({ file, index, artifactId, latest });
        }

        const stale: CommitGroupStaleFile[] = [];
        for (const item of locked) {
          if (item.latest == null) {
            if (item.file.baseSeq != null) {
              stale.push({ path: item.file.path, latest_seq: null, base_seq: item.file.baseSeq });
            }
            continue;
          }
          const effectiveBase = item.file.baseSeq ?? item.latest.seq;
          if (effectiveBase !== item.latest.seq) {
            stale.push({ path: item.file.path, latest_seq: item.latest.seq, base_seq: effectiveBase });
          }
        }
        if (stale.length > 0) throw new CommitGroupStaleBaseError(stale);

        const blobs = new Map<string, { sizeBytes: number; mime: string }>();
        for (const file of files) {
          if (file.blobSha != null && !blobs.has(file.blobSha)) {
            blobs.set(file.blobSha, { sizeBytes: file.sizeBytes, mime: file.mime });
          }
        }
        for (const [sha256, blob] of blobs) {
          await this.upsertBlob(client, { sha256, sizeBytes: blob.sizeBytes, mime: blob.mime });
        }

        const results: CommitGroupFileResult[] = new Array(files.length);
        for (const item of locked.sort((a, b) => a.index - b.index)) {
          if (
            item.latest != null &&
            item.file.kind !== 'deleted' &&
            item.file.blobSha != null &&
            item.file.blobSha === item.latest.blobSha
          ) {
            results[item.index] = { path: item.file.path, seq: item.latest.seq };
            continue;
          }

          const seq = item.latest == null ? 1 : item.latest.seq + 1;
          await this.insertVersion(client, {
            artifactId: item.artifactId,
            seq,
            blobSha: item.file.blobSha,
            baseSeq: item.latest?.seq ?? null,
            author: params.author,
            kind: item.file.kind,
          });
          await client.query(
            `UPDATE artifact_changes
                SET group_id = $3
              WHERE artifact_id = $1 AND seq = $2`,
            [item.artifactId, seq, params.groupId],
          );
          await this.advancePointer(client, item.artifactId, 'latest', seq);
          results[item.index] = { path: item.file.path, seq };
        }

        const result: CommitGroupResult = { ok: true, group_id: params.groupId, results };
        await client.query(
          `UPDATE artifact_commit_groups
              SET result = $2, committed_at = now()
            WHERE group_id = $1`,
          [params.groupId, JSON.stringify(result)],
        );
        return result;
      });
    } catch (err) {
      if (err instanceof CommitGroupStaleBaseError) {
        return { ok: false, reason: 'stale_base', stale: err.stale };
      }
      throw err;
    }
  }

  // === the read path (Lane 2 serve) ========================================

  /** Resolve `(session, path)` + a ref to a concrete version joined with its
   * blob. Returns null when the artifact, pointer, or version is missing. */
  async resolveVersion(
    sessionId: string,
    path: string,
    ref: VersionRef,
    options: { readableChannelIds?: readonly string[] } = {},
  ): Promise<ResolvedVersion | null> {
    const { workspaceId, channelId } = await this.workspaceForSession(this.pool, sessionId);
    const canonicalPath = canonicalizeSessionArtifactPath(path, {
      sessionId,
      channelId,
      readableChannelIds: options.readableChannelIds,
    });
    const art = await this.pool.query<{ id: string }>(
      `SELECT id FROM artifacts WHERE workspace_id = $1 AND path = $2`,
      [workspaceId, canonicalPath],
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
      detected_mime: string | null;
      media_kind: MediaKind | null;
      is_text: boolean | null;
      text_encoding: string | null;
      size_bytes: number | null;
      s3_key: string | null;
    }>(
      `SELECT v.seq, v.blob_sha, v.kind, v.status,
              b.mime, b.detected_mime, b.media_kind, b.is_text, b.text_encoding, b.size_bytes, b.s3_key
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
      detectedMime: row.detected_mime,
      mediaKind: row.media_kind,
      isText: row.is_text,
      textEncoding: row.text_encoding,
      sizeBytes: row.size_bytes,
      s3Key: row.s3_key,
    };
  }
}
