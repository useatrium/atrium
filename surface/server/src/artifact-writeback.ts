import { createHash } from 'node:crypto';
import { mergeDiff3 } from 'node-diff3';
import {
  ArtifactLedger,
  casBlobKey,
  type MergeClass,
  type VersionKind,
  type VersionStatus,
} from './artifact-ledger.js';
import { canonicalizeSessionArtifactPath } from './artifact-path.js';
import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';
import { classifyMedia, type MediaClassification } from './media-classifier.js';
import { enqueueThumbnailGeneration } from './thumbnails.js';

export interface ArtifactWritebackStorage {
  uploadObject(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void>;
  getObjectBytes(key: string): Promise<Buffer>;
  /** Optional durability check (#9): verify a PUT landed before we stamp the
   * blob's s3_key (the "version is servable" signal). When absent, verify is
   * skipped (back-compat for callers/tests that don't provide it). */
  headObject?(key: string): Promise<{ contentLength: number } | null>;
}

export type WriteBackArtifactResult =
  | { ok: true; seq: number; status: VersionStatus; idempotent: boolean }
  | {
      ok: false;
      reason: 'base_required' | 'stale_base' | 'base_not_found' | 'blob_unavailable';
      baseSeq?: number;
      latestSeq?: number;
    };

export type WriteBackArtifactByIdResult =
  | WriteBackArtifactResult
  | { ok: false; reason: 'gone' }
  | { ok: false; reason: 'binary_not_editable'; mediaKind: MediaClassification['mediaKind'] };

export interface WriteBackArtifactParams {
  pool: Db;
  storage: ArtifactWritebackStorage;
  channelId: string;
  sessionId: string;
  path: string;
  bytes: Buffer;
  mime: string;
  author: string;
  baseSeq?: number;
}

export interface WriteBackArtifactByIdParams {
  pool: Db;
  storage: ArtifactWritebackStorage;
  artifactId: string;
  bytes: Buffer;
  mime: string;
  author: string;
  baseSeq?: number;
}

interface ArtifactRow {
  id: string;
  merge_class: MergeClass;
}

interface ArtifactByIdWritebackRow {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  path: string;
  merge_class: MergeClass;
  tombstoned_at: Date | string | null;
}

interface VersionBlobRow {
  seq: number;
  blob_sha: string | null;
  author: string;
  kind: VersionKind;
  status: VersionStatus;
  s3_key: string | null;
  mime: string | null;
  size_bytes: number | null;
}

type DeferredThumbnail = {
  sourceSha: string;
  bytes: Buffer;
  mime: string;
  mediaKind: MediaClassification['mediaKind'];
};

export async function writeBackArtifact(params: WriteBackArtifactParams): Promise<WriteBackArtifactResult> {
  const ledger = new ArtifactLedger(params.pool);
  const existing = await findArtifact(params.pool, params.sessionId, params.path);
  if (existing && params.baseSeq == null) {
    return { ok: false, reason: 'base_required' };
  }
  if (!existing && params.baseSeq != null) {
    return { ok: false, reason: 'base_not_found', baseSeq: params.baseSeq };
  }

  const sha = sha256(params.bytes);
  const classification = classifyMedia(params.bytes, { declaredMime: params.mime, filename: params.path });
  await ensureCasBlobStored({
    pool: params.pool,
    ledger,
    storage: params.storage,
    sha,
    bytes: params.bytes,
    mime: params.mime,
    classification,
  });

  const committed = await ledger.commitVersion({
    sessionId: params.sessionId,
    channelId: params.channelId,
    path: params.path,
    blobSha: sha,
    sizeBytes: params.bytes.byteLength,
    mime: params.mime,
    author: params.author,
    kind: existing ? 'modified' : 'created',
    baseSeq: params.baseSeq,
  });

  if (committed.ok) {
    enqueueThumbnailGeneration({
      pool: params.pool,
      sourceSha: sha,
      bytes: params.bytes,
      mime: classification.detectedMime,
      mediaKind: classification.mediaKind,
    });
    return { ok: true, seq: committed.seq, status: 'normal', idempotent: committed.idempotent };
  }

  // Delete-vs-edit (hand-compute #5): the write is stale because another actor
  // DELETED the file (latest is a tombstone). Per the product decision this is
  // recorded as a conflict and never auto-picked — regardless of merge_class —
  // resurrecting the edit's bytes as a `status=conflict` version that carries
  // both sides. Resolution (stay-deleted vs keep-edit) is a later explicit write.
  const latestRow0 = await latestVersionRow(params.pool, committed.artifactId);
  if (latestRow0 && (latestRow0.kind === 'deleted' || latestRow0.blob_sha == null)) {
    const result = await recordDeleteVsEditConflict({
      ...params,
      ledger,
      incomingSha: sha,
      deletedSeq: latestRow0.seq,
      deletedAuthor: latestRow0.author,
    });
    if (result.ok) {
      enqueueThumbnailGeneration({
        pool: params.pool,
        sourceSha: sha,
        bytes: params.bytes,
        mime: classification.detectedMime,
        mediaKind: classification.mediaKind,
      });
    }
    return result;
  }

  const artifact = await findArtifactById(params.pool, committed.artifactId);
  if (!artifact || artifact.merge_class !== 'mergeable-doc') {
    return {
      ok: false,
      reason: 'stale_base',
      baseSeq: committed.baseSeq,
      latestSeq: committed.latestSeq,
    };
  }

  return mergeStaleWrite({
    ...params,
    ledger,
    incomingSha: sha,
    incomingBytes: params.bytes,
    baseSeq: committed.baseSeq,
  });
}

export async function writeBackArtifactById(
  params: WriteBackArtifactByIdParams,
): Promise<WriteBackArtifactByIdResult> {
  if (params.baseSeq == null) {
    return { ok: false, reason: 'base_required' };
  }
  const baseSeq = params.baseSeq;

  const ledger = new ArtifactLedger(params.pool);
  const artifact = await findArtifactForWritebackById(params.pool, params.artifactId);
  if (!artifact) {
    return { ok: false, reason: 'base_not_found', baseSeq };
  }
  if (artifact.tombstoned_at != null) {
    return { ok: false, reason: 'gone' };
  }

  const classification = classifyMedia(params.bytes, { declaredMime: params.mime, filename: artifact.path });
  if (!classification.isText) {
    return { ok: false, reason: 'binary_not_editable', mediaKind: classification.mediaKind };
  }

  const sha = sha256(params.bytes);
  await ensureCasBlobStored({
    pool: params.pool,
    ledger,
    storage: params.storage,
    sha,
    bytes: params.bytes,
    mime: params.mime,
    classification,
  });

  const tx = await withTx(params.pool, async (client): Promise<{
    result: WriteBackArtifactByIdResult;
    thumbnail?: DeferredThumbnail;
  }> => {
    const locked = await client.query<ArtifactByIdWritebackRow>(
      `SELECT id, workspace_id, channel_id, path, merge_class, tombstoned_at
         FROM artifacts
        WHERE id = $1
        FOR UPDATE`,
      [params.artifactId],
    );
    const row = locked.rows[0];
    if (!row) {
      return { result: { ok: false, reason: 'base_not_found', baseSeq } };
    }
    if (row.tombstoned_at != null) {
      return { result: { ok: false, reason: 'gone' } };
    }

    const latest = await ledger.latestVersion(client, params.artifactId);
    if (!latest) {
      return { result: { ok: false, reason: 'base_not_found', baseSeq } };
    }

    if (baseSeq === latest.seq) {
      if (latest.kind !== 'deleted' && latest.blobSha === sha) {
        return { result: { ok: true, seq: latest.seq, status: 'normal', idempotent: true } };
      }
      const seq = latest.seq + 1;
      await ledger.insertVersion(client, {
        artifactId: params.artifactId,
        seq,
        blobSha: sha,
        baseSeq: latest.seq,
        author: params.author,
        kind: latest.kind === 'deleted' ? 'created' : 'modified',
        status: 'normal',
      });
      await ledger.advancePointer(client, params.artifactId, 'latest', seq);
      await client.query('UPDATE artifacts SET tombstoned_at = NULL WHERE id = $1', [params.artifactId]);
      return {
        result: { ok: true, seq, status: 'normal', idempotent: false },
        thumbnail: {
          sourceSha: sha,
          bytes: params.bytes,
          mime: classification.detectedMime,
          mediaKind: classification.mediaKind,
        },
      };
    }

    const baseRow = await versionBlob(client, params.artifactId, baseSeq);
    if (!baseRow) {
      return {
        result: { ok: false, reason: 'base_not_found', baseSeq, latestSeq: latest.seq },
      };
    }

    if (latest.kind === 'deleted' || latest.blobSha == null) {
      return {
        result: await recordDeleteVsEditConflictById({
          client,
          ledger,
          artifactId: params.artifactId,
          incomingSha: sha,
          author: params.author,
          baseSeq,
          deletedSeq: latest.seq,
          deletedAuthor: 'latest',
        }),
        thumbnail: {
          sourceSha: sha,
          bytes: params.bytes,
          mime: classification.detectedMime,
          mediaKind: classification.mediaKind,
        },
      };
    }

    if (row.merge_class !== 'mergeable-doc') {
      return {
        result: { ok: false, reason: 'stale_base', baseSeq, latestSeq: latest.seq },
      };
    }

    return applyThreeWayMerge({
      pool: params.pool,
      client,
      ledger,
      storage: params.storage,
      artifactId: params.artifactId,
      baseSeq,
      latestSeq: latest.seq,
      incomingBytes: params.bytes,
      incomingSha: sha,
      mime: params.mime,
      author: params.author,
      path: row.path,
    });
  });

  if (tx.result.ok && tx.thumbnail) {
    enqueueThumbnailGeneration({
      pool: params.pool,
      sourceSha: tx.thumbnail.sourceSha,
      bytes: tx.thumbnail.bytes,
      mime: tx.thumbnail.mime,
      mediaKind: tx.thumbnail.mediaKind,
    });
  }
  return tx.result;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function findArtifact(pool: Db, sessionId: string, path: string): Promise<ArtifactRow | null> {
  const session = await pool.query<{ workspace_id: string; channel_id: string }>(
    `SELECT workspace_id, channel_id FROM sessions WHERE id = $1`,
    [sessionId],
  );
  const row = session.rows[0];
  if (!row) return null;
  const canonicalPath = canonicalizeSessionArtifactPath(path, { sessionId, channelId: row.channel_id });
  const res = await pool.query<ArtifactRow>(
    `SELECT id, merge_class FROM artifacts WHERE workspace_id = $1 AND path = $2`,
    [row.workspace_id, canonicalPath],
  );
  return res.rows[0] ?? null;
}

async function findArtifactById(pool: Db, artifactId: string): Promise<ArtifactRow | null> {
  const res = await pool.query<ArtifactRow>(
    `SELECT id, merge_class FROM artifacts WHERE id = $1`,
    [artifactId],
  );
  return res.rows[0] ?? null;
}

async function findArtifactForWritebackById(pool: Db, artifactId: string): Promise<ArtifactByIdWritebackRow | null> {
  const res = await pool.query<ArtifactByIdWritebackRow>(
    `SELECT id, workspace_id, channel_id, path, merge_class, tombstoned_at
       FROM artifacts
      WHERE id = $1`,
    [artifactId],
  );
  return res.rows[0] ?? null;
}

async function ensureCasBlobStored(args: {
  pool: Db;
  ledger: ArtifactLedger;
  storage: ArtifactWritebackStorage;
  sha: string;
  bytes: Buffer;
  mime: string;
  classification?: MediaClassification;
  client?: DbClient;
}): Promise<void> {
  const key = casBlobKey(args.sha);
  if (!(await args.ledger.blobIsDurable(args.sha))) {
    await args.storage.uploadObject(key, args.bytes, args.mime);
    // #9: verify the PUT actually landed (right size) BEFORE we stamp s3_key —
    // so a committed version never references a blob that isn't durable in S3.
    if (args.storage.headObject) {
      const head = await args.storage.headObject(key);
      if (!head || head.contentLength !== args.bytes.byteLength) {
        throw new Error(
          `blob durability check failed for ${args.sha} (head=${head ? head.contentLength : 'missing'}, want ${args.bytes.byteLength})`,
        );
      }
    }
  }
  if (args.client) {
    await args.ledger.upsertBlob(args.client, {
      sha256: args.sha,
      sizeBytes: args.bytes.byteLength,
      mime: args.mime,
      s3Key: key,
      classification: args.classification ?? classifyMedia(args.bytes, { declaredMime: args.mime }),
    });
    return;
  }
  await withTx(args.pool, async (client) => {
    await args.ledger.upsertBlob(client, {
      sha256: args.sha,
      sizeBytes: args.bytes.byteLength,
      mime: args.mime,
      s3Key: key,
      classification: args.classification ?? classifyMedia(args.bytes, { declaredMime: args.mime }),
    });
  });
}

async function mergeStaleWrite(args: WriteBackArtifactParams & {
  ledger: ArtifactLedger;
  incomingSha: string;
  incomingBytes: Buffer;
  baseSeq: number;
}): Promise<WriteBackArtifactResult> {
  const tx = await withTx(args.pool, async (client): Promise<{
    result: WriteBackArtifactResult;
    thumbnail?: DeferredThumbnail;
  }> => {
    const artifactId = await args.ledger.resolveOrCreateArtifactLocked(client, {
      sessionId: args.sessionId,
      channelId: args.channelId,
      path: args.path,
    });
    const artifact = await client.query<{ merge_class: MergeClass }>(
      `SELECT merge_class FROM artifacts WHERE id = $1`,
      [artifactId],
    );
    if (artifact.rows[0]?.merge_class !== 'mergeable-doc') {
      const latest = await args.ledger.latestVersion(client, artifactId);
      return {
        result: { ok: false, reason: 'stale_base', baseSeq: args.baseSeq, latestSeq: latest?.seq },
      };
    }

    const latest = await args.ledger.latestVersion(client, artifactId);
    if (!latest) {
      return { result: { ok: false, reason: 'base_not_found', baseSeq: args.baseSeq } };
    }
    return applyThreeWayMerge({
      pool: args.pool,
      client,
      ledger: args.ledger,
      storage: args.storage,
      artifactId,
      baseSeq: args.baseSeq,
      latestSeq: latest.seq,
      incomingBytes: args.incomingBytes,
      incomingSha: args.incomingSha,
      mime: args.mime,
      author: args.author,
      path: args.path,
    });
  });
  if (tx.result.ok && tx.thumbnail) {
    enqueueThumbnailGeneration({
      pool: args.pool,
      sourceSha: tx.thumbnail.sourceSha,
      bytes: tx.thumbnail.bytes,
      mime: tx.thumbnail.mime,
      mediaKind: tx.thumbnail.mediaKind,
    });
  }
  return tx.result;
}

async function applyThreeWayMerge(args: {
  pool: Db;
  client: DbClient;
  ledger: ArtifactLedger;
  storage: ArtifactWritebackStorage;
  artifactId: string;
  baseSeq: number;
  latestSeq: number;
  incomingBytes: Buffer;
  incomingSha: string;
  mime: string;
  author: string;
  path: string;
}): Promise<{ result: WriteBackArtifactResult; thumbnail?: DeferredThumbnail }> {
  const baseRow = await versionBlob(args.client, args.artifactId, args.baseSeq);
  const latestRow = await versionBlob(args.client, args.artifactId, args.latestSeq);
  if (!baseRow) {
    return {
      result: { ok: false, reason: 'base_not_found', baseSeq: args.baseSeq, latestSeq: args.latestSeq },
    };
  }
  if (!latestRow?.s3_key || !baseRow.s3_key || latestRow.blob_sha == null || baseRow.blob_sha == null) {
    return {
      result: { ok: false, reason: 'blob_unavailable', baseSeq: args.baseSeq, latestSeq: args.latestSeq },
    };
  }

  const [baseBytes, latestBytes] = await Promise.all([
    args.storage.getObjectBytes(baseRow.s3_key),
    args.storage.getObjectBytes(latestRow.s3_key),
  ]);
  const merged = mergeDiff3(
    splitLines(latestBytes),
    splitLines(baseBytes),
    splitLines(args.incomingBytes),
    { label: { a: `latest:${args.latestSeq}`, o: `base:${args.baseSeq}`, b: 'incoming' } },
  );
  const mergedBytes = Buffer.from(merged.result.join('\n'), 'utf8');
  const mergedSha = sha256(mergedBytes);
  const mergedClassification = classifyMedia(mergedBytes, { declaredMime: args.mime, filename: args.path });
  await ensureCasBlobStored({
    pool: args.pool,
    ledger: args.ledger,
    storage: args.storage,
    sha: mergedSha,
    bytes: mergedBytes,
    mime: args.mime,
    classification: mergedClassification,
    client: args.client,
  });
  const thumbnail: DeferredThumbnail = {
    sourceSha: mergedSha,
    bytes: mergedBytes,
    mime: mergedClassification.detectedMime,
    mediaKind: mergedClassification.mediaKind,
  };

  const seq = args.latestSeq + 1;
  if (!merged.conflict) {
    await args.ledger.insertVersion(args.client, {
      artifactId: args.artifactId,
      seq,
      blobSha: mergedSha,
      baseSeq: args.latestSeq,
      author: args.author,
      kind: 'modified',
      status: 'normal',
    });
    await args.ledger.advancePointer(args.client, args.artifactId, 'latest', seq);
    return {
      result: { ok: true, seq, status: 'normal', idempotent: false },
      thumbnail,
    };
  }

  await args.ledger.insertVersion(args.client, {
    artifactId: args.artifactId,
    seq,
    blobSha: mergedSha,
    baseSeq: args.latestSeq,
    author: args.author,
    kind: 'modified',
    status: 'conflict',
    conflict: {
      base_seq: args.baseSeq,
      left: { seq: args.latestSeq, author: latestRow.author, sha: latestRow.blob_sha },
      right: { author: args.author, sha: args.incomingSha },
    },
  });
  await args.ledger.advancePointer(args.client, args.artifactId, 'latest', seq);
  return {
    result: { ok: true, seq, status: 'conflict', idempotent: false },
    thumbnail,
  };
}

interface LatestRow {
  seq: number;
  kind: VersionKind;
  blob_sha: string | null;
  author: string;
}

async function latestVersionRow(pool: Db, artifactId: string): Promise<LatestRow | null> {
  const res = await pool.query<LatestRow>(
    `SELECT v.seq, v.kind, v.blob_sha, v.author
       FROM artifact_pointers p
       JOIN artifact_versions v ON v.artifact_id = p.artifact_id AND v.seq = p.seq
      WHERE p.artifact_id = $1 AND p.name = 'latest'`,
    [artifactId],
  );
  return res.rows[0] ?? null;
}

/** Record a delete-vs-edit conflict: the incoming edit lands as a
 * `status=conflict` version (bytes preserved = resurrect-as-conflict) noting the
 * competing delete. Never auto-picks a side (Gary's decision). */
async function recordDeleteVsEditConflict(args: WriteBackArtifactParams & {
  ledger: ArtifactLedger;
  incomingSha: string;
  deletedSeq: number;
  deletedAuthor: string;
}): Promise<WriteBackArtifactResult> {
  return withTx(args.pool, async (client) => {
    const artifactId = await args.ledger.resolveOrCreateArtifactLocked(client, {
      sessionId: args.sessionId,
      channelId: args.channelId,
      path: args.path,
    });
    const latest = await args.ledger.latestVersion(client, artifactId);
    if (!latest) return { ok: false, reason: 'base_not_found', baseSeq: args.baseSeq };
    // Re-check under the lock: only conflict if the latest is still a delete.
    if (latest.kind !== 'deleted' && latest.blobSha != null) {
      return { ok: false, reason: 'stale_base', baseSeq: args.baseSeq, latestSeq: latest.seq };
    }
    const seq = latest.seq + 1;
    await args.ledger.insertVersion(client, {
      artifactId,
      seq,
      blobSha: args.incomingSha,
      baseSeq: latest.seq,
      author: args.author,
      kind: 'modified',
      status: 'conflict',
      conflict: {
        kind: 'delete_vs_edit',
        base_seq: args.baseSeq ?? null,
        deleted: { seq: args.deletedSeq, author: args.deletedAuthor },
        edited: { author: args.author, sha: args.incomingSha },
      },
    });
    await args.ledger.advancePointer(client, artifactId, 'latest', seq);
    return { ok: true, seq, status: 'conflict', idempotent: false };
  });
}

async function recordDeleteVsEditConflictById(args: {
  client: DbClient;
  ledger: ArtifactLedger;
  artifactId: string;
  incomingSha: string;
  author: string;
  baseSeq: number;
  deletedSeq: number;
  deletedAuthor: string;
}): Promise<WriteBackArtifactResult> {
  const latest = await args.ledger.latestVersion(args.client, args.artifactId);
  if (!latest) return { ok: false, reason: 'base_not_found', baseSeq: args.baseSeq };
  if (latest.kind !== 'deleted' && latest.blobSha != null) {
    return { ok: false, reason: 'stale_base', baseSeq: args.baseSeq, latestSeq: latest.seq };
  }
  const seq = latest.seq + 1;
  await args.ledger.insertVersion(args.client, {
    artifactId: args.artifactId,
    seq,
    blobSha: args.incomingSha,
    baseSeq: latest.seq,
    author: args.author,
    kind: 'modified',
    status: 'conflict',
    conflict: {
      kind: 'delete_vs_edit',
      base_seq: args.baseSeq,
      deleted: { seq: args.deletedSeq, author: args.deletedAuthor },
      edited: { author: args.author, sha: args.incomingSha },
    },
  });
  await args.ledger.advancePointer(args.client, args.artifactId, 'latest', seq);
  return { ok: true, seq, status: 'conflict', idempotent: false };
}

/** Write-back a DELETE against a base (capture of an agent delete, or a
 * "stay-deleted" resolution). Clean → a delete tombstone; stale where the latest
 * is a normal edit → an edit-vs-delete conflict (symmetric to the above). */
export async function writeBackDelete(params: {
  pool: Db;
  channelId: string;
  sessionId: string;
  path: string;
  author: string;
  baseSeq?: number;
}): Promise<WriteBackArtifactResult> {
  const ledger = new ArtifactLedger(params.pool);
  return withTx(params.pool, async (client) => {
    const artifactId = await ledger.resolveOrCreateArtifactLocked(client, {
      sessionId: params.sessionId,
      channelId: params.channelId,
      path: params.path,
    });
    const latest = await ledger.latestVersion(client, artifactId);
    if (!latest) return { ok: false, reason: 'base_not_found', baseSeq: params.baseSeq };

    const effectiveBase = params.baseSeq ?? latest.seq;
    if (effectiveBase === latest.seq) {
      if (latest.kind === 'deleted') {
        return { ok: true, seq: latest.seq, status: 'normal', idempotent: true };
      }
      const seq = latest.seq + 1;
      await ledger.insertVersion(client, {
        artifactId, seq, blobSha: null, baseSeq: latest.seq,
        author: params.author, kind: 'deleted', status: 'normal',
      });
      await ledger.advancePointer(client, artifactId, 'latest', seq);
      return { ok: true, seq, status: 'normal', idempotent: false };
    }

    // Stale: the latest is a competing edit → edit-vs-delete conflict (preserve it).
    const seq = latest.seq + 1;
    await ledger.insertVersion(client, {
      artifactId, seq, blobSha: latest.blobSha, baseSeq: latest.seq,
      author: params.author, kind: 'modified', status: 'conflict',
      conflict: {
        kind: 'edit_vs_delete',
        base_seq: params.baseSeq ?? null,
        edited: { seq: latest.seq, author: 'latest', sha: latest.blobSha },
        deleted: { author: params.author },
      },
    });
    await ledger.advancePointer(client, artifactId, 'latest', seq);
    return { ok: true, seq, status: 'conflict', idempotent: false };
  });
}

export async function writeBackDeleteById(params: {
  pool: Db;
  artifactId: string;
  author: string;
  baseSeq?: number;
}): Promise<WriteBackArtifactResult> {
  const ledger = new ArtifactLedger(params.pool);
  return withTx(params.pool, async (client) => {
    const locked = await client.query<{ id: string; tombstoned_at: Date | string | null }>(
      'SELECT id, tombstoned_at FROM artifacts WHERE id = $1 FOR UPDATE',
      [params.artifactId],
    );
    if (!locked.rows[0]) return { ok: false, reason: 'base_not_found', baseSeq: params.baseSeq };
    const latest = await ledger.latestVersion(client, params.artifactId);
    if (!latest) return { ok: false, reason: 'base_not_found', baseSeq: params.baseSeq };
    const effectiveBase = params.baseSeq ?? latest.seq;
    if (effectiveBase === latest.seq) {
      if (latest.kind === 'deleted') {
        await client.query('UPDATE artifacts SET tombstoned_at = COALESCE(tombstoned_at, now()) WHERE id = $1', [
          params.artifactId,
        ]);
        return { ok: true, seq: latest.seq, status: 'normal', idempotent: true };
      }
      const seq = latest.seq + 1;
      await ledger.insertVersion(client, {
        artifactId: params.artifactId, seq, blobSha: null, baseSeq: latest.seq,
        author: params.author, kind: 'deleted', status: 'normal',
      });
      await ledger.advancePointer(client, params.artifactId, 'latest', seq);
      await client.query('UPDATE artifacts SET tombstoned_at = COALESCE(tombstoned_at, now()) WHERE id = $1', [
        params.artifactId,
      ]);
      return { ok: true, seq, status: 'normal', idempotent: false };
    }

    const seq = latest.seq + 1;
    await ledger.insertVersion(client, {
      artifactId: params.artifactId, seq, blobSha: latest.blobSha, baseSeq: latest.seq,
      author: params.author, kind: 'modified', status: 'conflict',
      conflict: {
        kind: 'edit_vs_delete',
        base_seq: params.baseSeq ?? null,
        edited: { seq: latest.seq, author: 'latest', sha: latest.blobSha },
        deleted: { author: params.author },
      },
    });
    await ledger.advancePointer(client, params.artifactId, 'latest', seq);
    return { ok: true, seq, status: 'conflict', idempotent: false };
  });
}

async function versionBlob(
  client: DbClient,
  artifactId: string,
  seq: number,
): Promise<VersionBlobRow | null> {
  const res = await client.query<VersionBlobRow>(
    `SELECT v.seq, v.blob_sha, v.author, v.kind, v.status, b.s3_key, b.mime, b.size_bytes
       FROM artifact_versions v
       LEFT JOIN cas_blobs b ON b.sha256 = v.blob_sha
      WHERE v.artifact_id = $1 AND v.seq = $2`,
    [artifactId, seq],
  );
  return res.rows[0] ?? null;
}

function splitLines(bytes: Buffer): string[] {
  return bytes.toString('utf8').split('\n');
}
