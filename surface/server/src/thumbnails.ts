import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactLedger, casBlobKey } from './artifact-ledger.js';
import type { Db } from './db.js';
import { withTx } from './db.js';
import { classifyMediaFromMime, type MediaKind } from './media-classifier.js';
import { getObjectBytes, uploadObject } from './s3.js';

const IMAGE_THUMBNAIL_MIME = 'image/webp';
const VIDEO_THUMBNAIL_MIME = 'image/jpeg';
const THUMBNAIL_WIDTH = 320;

type ThumbnailLogger = {
  warn(obj: unknown, msg?: string): void;
};

export interface ThumbnailJob {
  pool: Db;
  sourceSha: string;
  mime: string | null;
  mediaKind: MediaKind | string | null;
  bytes?: Buffer;
  s3Key?: string | null;
  logger?: ThumbnailLogger;
}

export interface GeneratedThumbnail {
  bytes: Buffer;
  mime: string;
}

const pending = new Map<string, ThumbnailJob>();
let draining = false;

export function enqueueThumbnailGeneration(job: ThumbnailJob): void {
  const existing = pending.get(job.sourceSha);
  pending.set(job.sourceSha, {
    ...existing,
    ...job,
    bytes: existing?.bytes ?? job.bytes,
    s3Key: existing?.s3Key ?? job.s3Key,
    logger: job.logger ?? existing?.logger,
  });
  void drainThumbnailQueue();
}

async function drainThumbnailQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending.size > 0) {
      const [sourceSha, job] = pending.entries().next().value as [string, ThumbnailJob];
      pending.delete(sourceSha);
      try {
        await ensureThumbnailForBlob(job);
      } catch (err) {
        job.logger?.warn({ err, sourceSha }, 'thumbnail generation failed');
      }
    }
  } finally {
    draining = false;
    if (pending.size > 0) void drainThumbnailQueue();
  }
}

export async function ensureThumbnailForBlob(job: ThumbnailJob): Promise<string | null> {
  const source = await job.pool.query<{
    sha256: string;
    s3_key: string | null;
    mime: string;
    media_kind: MediaKind;
    thumbnail_sha: string | null;
  }>(
    `SELECT sha256, s3_key, mime, media_kind, thumbnail_sha
       FROM cas_blobs
      WHERE sha256 = $1`,
    [job.sourceSha],
  );
  const row = source.rows[0];
  if (!row || row.thumbnail_sha) return row?.thumbnail_sha ?? null;

  const mediaKind = job.mediaKind ?? row.media_kind;
  const mime = job.mime ?? row.mime;
  if (mediaKind !== 'image' && mediaKind !== 'video' && mediaKind !== 'pdf') return null;
  const sourceBytes = job.bytes ?? (job.s3Key || row.s3_key ? await getObjectBytes((job.s3Key ?? row.s3_key)!) : null);
  if (!sourceBytes) return null;

  const generated = await generateThumbnail({
    bytes: sourceBytes,
    mediaKind,
    mime,
  });
  if (!generated) return null;

  const thumbnailSha = sha256(generated.bytes);
  const thumbnailKey = casBlobKey(thumbnailSha);
  const ledger = new ArtifactLedger(job.pool);
  if (!(await ledger.blobIsDurable(thumbnailSha))) {
    await uploadObject(thumbnailKey, generated.bytes, generated.mime);
  }

  await withTx(job.pool, async (client) => {
    await ledger.upsertBlob(client, {
      sha256: thumbnailSha,
      sizeBytes: generated.bytes.byteLength,
      mime: generated.mime,
      s3Key: thumbnailKey,
      classification: classifyMediaFromMime(generated.mime),
    });
    await client.query(
      `UPDATE cas_blobs
          SET thumbnail_sha = $2
        WHERE sha256 = $1
          AND thumbnail_sha IS NULL`,
      [job.sourceSha, thumbnailSha],
    );
  });

  return thumbnailSha;
}

export async function generateThumbnail(input: {
  bytes: Buffer;
  mediaKind: MediaKind | string | null;
  mime: string | null;
}): Promise<GeneratedThumbnail | null> {
  if (input.mediaKind === 'image') {
    return imageThumbnail(input.bytes);
  }
  if (input.mediaKind === 'video') {
    return videoThumbnail(input.bytes);
  }
  if (input.mediaKind === 'pdf') {
    return pdfThumbnail(input.bytes);
  }
  return null;
}

async function imageThumbnail(bytes: Buffer): Promise<GeneratedThumbnail | null> {
  return webpImageThumbnail(bytes);
}

async function webpImageThumbnail(bytes: Buffer): Promise<GeneratedThumbnail | null> {
  let sharp: typeof import('sharp');
  try {
    sharp = await import('sharp');
  } catch {
    return null;
  }
  const output = await sharp.default(bytes, { animated: false })
    .rotate()
    .resize({
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_WIDTH,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 78 })
    .toBuffer();
  return output.byteLength > 0 ? { bytes: output, mime: IMAGE_THUMBNAIL_MIME } : null;
}

async function pdfThumbnail(bytes: Buffer): Promise<GeneratedThumbnail | null> {
  let document: Awaited<ReturnType<typeof import('pdf-to-img').pdf>> | null = null;
  try {
    const { pdf } = await import('pdf-to-img');
    document = await pdf(bytes, { scale: 2 });
    for await (const pagePng of document) {
      return await webpImageThumbnail(pagePng);
    }
    return null;
  } catch {
    return null;
  } finally {
    await document?.destroy().catch(() => undefined);
  }
}

async function videoThumbnail(bytes: Buffer): Promise<GeneratedThumbnail | null> {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-thumb-'));
  const sourcePath = join(dir, 'source-video');
  const outputPath = join(dir, 'poster.jpg');
  try {
    await writeFile(sourcePath, bytes);
    const result = await runProcess('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      sourcePath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${THUMBNAIL_WIDTH}:-2`,
      outputPath,
    ]);
    if (!result) return null;
    const output = await readFile(outputPath).catch(() => null);
    return output && output.byteLength > 0 ? { bytes: output, mime: VIDEO_THUMBNAIL_MIME } : null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runProcess(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        resolve(false);
        return;
      }
      reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }
      const err = Buffer.concat(stderr).toString('utf8');
      reject(new Error(`${command} exited ${code}: ${err}`.slice(0, 2000)));
    });
  });
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
