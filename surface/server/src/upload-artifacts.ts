import { basename } from 'node:path';
import { ArtifactLedger, type CommitUploadResult } from './artifact-ledger.js';
import type { Db } from './db.js';
import { classifyMediaFromMime } from './media-classifier.js';
import { sanitizeFilename } from './safe-filename.js';
import { enqueueThumbnailGeneration } from './thumbnails.js';

export interface UploadAttachmentFileRow {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number | string;
  width?: number | null;
  height?: number | null;
  s3_key: string;
  content_hash: string | null;
}

export interface LandedUploadArtifact extends CommitUploadResult {
  path: string;
  blobSha: string;
  sizeBytes: number;
  mime: string;
}

function uploadArtifactFilename(filename: string): string {
  const base = basename(filename.replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..') return 'file';
  const cleaned = sanitizeFilename(base);
  return cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
}

function uploadArtifactPath(channelId: string, filename: string, suffix: number): string {
  if (suffix <= 1) return `shared/channels/${channelId}/uploads/${filename}`;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  return `shared/channels/${channelId}/uploads/${stem} (${suffix})${ext}`;
}

async function latestArtifactBlobByWorkspacePath(
  pool: Db,
  workspaceId: string,
  path: string,
): Promise<{ artifactId: string; blobSha: string | null } | null> {
  const res = await pool.query<{ id: string; blob_sha: string | null }>(
    `SELECT a.id, v.blob_sha
       FROM artifacts a
       LEFT JOIN artifact_pointers p ON p.artifact_id = a.id AND p.name = 'latest'
       LEFT JOIN artifact_versions v ON v.artifact_id = a.id AND v.seq = p.seq
      WHERE a.workspace_id = $1 AND a.path = $2`,
    [workspaceId, path],
  );
  const row = res.rows[0];
  return row ? { artifactId: row.id, blobSha: row.blob_sha } : null;
}

async function landingPathForUpload(
  pool: Db,
  params: { workspaceId: string; channelId: string; filename: string; blobSha: string },
): Promise<string> {
  const filename = uploadArtifactFilename(params.filename);
  for (let suffix = 1; suffix <= 1000; suffix += 1) {
    const path = uploadArtifactPath(params.channelId, filename, suffix);
    const existing = await latestArtifactBlobByWorkspacePath(pool, params.workspaceId, path);
    if (!existing || existing.blobSha === params.blobSha) return path;
  }
  throw new Error(`could not allocate upload artifact path for ${filename}`);
}

export async function landUploadAttachmentAsArtifact(
  pool: Db,
  params: {
    channelId: string;
    userId: string;
    file: UploadAttachmentFileRow;
    sourceMessageId?: string | null;
    logger?: { warn(obj: unknown, msg?: string): void };
  },
): Promise<LandedUploadArtifact> {
  const channel = await pool.query<{ workspace_id: string }>('SELECT workspace_id FROM channels WHERE id = $1', [
    params.channelId,
  ]);
  const channelRow = channel.rows[0];
  if (!channelRow) throw new Error(`channel not found: ${params.channelId}`);

  const blobSha = params.file.content_hash;
  if (blobSha == null) throw new Error(`content_hash missing for file ${params.file.id}`);
  const sizeBytes = Number(params.file.size_bytes);
  const classification = classifyMediaFromMime(params.file.content_type);
  await pool.query(
    `INSERT INTO cas_blobs
       (sha256, s3_key, size_bytes, mime, detected_mime, media_kind, is_text, text_encoding, classification_meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (sha256) DO UPDATE
           SET s3_key = COALESCE(cas_blobs.s3_key, EXCLUDED.s3_key),
               detected_mime = COALESCE(cas_blobs.detected_mime, EXCLUDED.detected_mime),
               media_kind = COALESCE(cas_blobs.media_kind, EXCLUDED.media_kind),
               is_text = COALESCE(cas_blobs.is_text, EXCLUDED.is_text),
               text_encoding = COALESCE(cas_blobs.text_encoding, EXCLUDED.text_encoding)`,
    [
      blobSha,
      params.file.s3_key,
      sizeBytes,
      params.file.content_type,
      classification.detectedMime,
      classification.mediaKind,
      classification.isText,
      classification.textEncoding,
      JSON.stringify(classification.meta),
    ],
  );

  const path = await landingPathForUpload(pool, {
    workspaceId: channelRow.workspace_id,
    channelId: params.channelId,
    filename: params.file.filename,
    blobSha,
  });
  const result = await new ArtifactLedger(pool).commitUpload({
    workspaceId: channelRow.workspace_id,
    channelId: params.channelId,
    path,
    blobSha,
    sizeBytes,
    mime: params.file.content_type,
    author: `human:${params.userId}`,
    sourceMessageId: params.sourceMessageId ?? null,
  });
  enqueueThumbnailGeneration({
    pool,
    sourceSha: blobSha,
    mime: params.file.content_type,
    mediaKind: classification.mediaKind,
    s3Key: params.file.s3_key,
    logger: params.logger,
  });
  return { ...result, path, blobSha, sizeBytes, mime: params.file.content_type };
}
