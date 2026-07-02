// S3/MinIO client for file uploads. Presigning is pure crypto (no network),
// so everything except ensureBucket works even when the store is down.

import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { config } from './config.js';

const client = new S3Client({
  endpoint: config.s3Endpoint,
  region: 'us-east-1',
  forcePathStyle: true, // MinIO uses path-style addressing
  credentials: {
    accessKeyId: config.s3AccessKey,
    secretAccessKey: config.s3SecretKey,
  },
});

let bucketReady = false;

/**
 * Storage-readiness for /healthz (#215): `null` until startStorageBootstrap runs
 * (test/dev app builds that never start it stay ungated), then false → true once
 * the bucket check has succeeded. Sticky: a transient store outage after boot
 * does not flip health back — the gate exists to catch never-provisioned
 * storage (which otherwise fails silently for days), not to track liveness.
 */
let storageReadyState: boolean | null = null;

export function storageReady(): boolean | null {
  return storageReadyState;
}

/** Definitive bucket-not-found — the only error CreateBucket should answer.
 * Creating on transient/auth errors masks the real failure (and scoped AWS
 * credentials may not be allowed to create buckets at all). */
export function isNoSuchBucketError(err: unknown): boolean {
  const e = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchBucket' ||
    e?.Code === 'NoSuchBucket' ||
    e?.$metadata?.httpStatusCode === 404
  );
}

/** Create the bucket on first use; cheap no-op afterwards. */
export async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.s3Bucket }));
  } catch (err) {
    if (!isNoSuchBucketError(err)) throw err;
    await client.send(new CreateBucketCommand({ Bucket: config.s3Bucket }));
  }
  bucketReady = true;
  storageReadyState = true;
}

export interface StorageBootstrapHandle {
  stop(): void;
}

/**
 * Boot-time storage bootstrap (#215): retry the bucket check until it succeeds,
 * logging loudly on each failure. The OVH box ran for days with the bucket
 * missing — every capture 500ed while /healthz stayed green; this plus the
 * healthz gate makes that misconfiguration fail a health-gated deploy instead.
 */
export function startStorageBootstrap(
  log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void },
  opts: { retryMs?: number; ensure?: () => Promise<void> } = {},
): StorageBootstrapHandle {
  const retryMs = opts.retryMs ?? 15_000;
  const ensure = opts.ensure ?? ensureBucket;
  storageReadyState = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = async (): Promise<void> => {
    try {
      await ensure();
      storageReadyState = true;
      log.info({ bucket: config.s3Bucket }, 'storage bootstrap: bucket ready');
    } catch (err) {
      log.error(
        { err, bucket: config.s3Bucket, retryMs },
        'storage bootstrap: bucket unavailable; captures and uploads will fail — retrying',
      );
      if (!stopped) {
        timer = setTimeout(() => void attempt(), retryMs);
        timer.unref?.();
      }
    }
  };
  void attempt();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function presignPut(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, ContentType: contentType }),
    { expiresIn: 600 },
  );
}

export function presignGet(key: string, filename: string, inline: boolean): Promise<string> {
  const disposition = `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/"/g, '')}"`;
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      ResponseContentDisposition: disposition,
    }),
    { expiresIn: 600 },
  );
}

export async function deleteObject(key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: key }));
}

/** Upload object bytes. The body is a Buffer/Uint8Array so the SDK can set
 * Content-Length without buffering a stream itself. Ensures the bucket first
 * (memoized no-op after the first success): the CAS capture path reaches here
 * without going through the upload routes' ensureBucket (#215). */
export async function uploadObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<void> {
  await ensureBucket();
  await client.send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function uploadObjectStream(
  key: string,
  stream: Readable,
  contentType: string,
): Promise<void> {
  await ensureBucket();
  await new Upload({
    client,
    params: {
      Bucket: config.s3Bucket,
      Key: key,
      Body: stream,
      ContentType: contentType,
    },
  }).done();
}

export async function copyObject(srcKey: string, destKey: string): Promise<void> {
  await client.send(
    new CopyObjectCommand({
      Bucket: config.s3Bucket,
      Key: destKey,
      CopySource: `${config.s3Bucket}/${encodeCopySourceKey(srcKey)}`,
    }),
  );
}

function encodeCopySourceKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

// === voice additions ===
export async function downloadObject(key: string, destinationPath: string): Promise<void> {
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const res = await client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }));
  if (!res.Body) throw new Error(`S3 object has no body: ${key}`);
  await pipeline(res.Body as NodeJS.ReadableStream, createWriteStream(destinationPath));
}

// === writeback additions ===
/** Verify an object is durable: HEAD it and return its size, or null if absent.
 * Used by the write-back path to confirm a PUT actually landed BEFORE stamping
 * the blob's s3_key (which is the ledger's "this version is servable" signal). */
export async function headObject(key: string): Promise<{ contentLength: number } | null> {
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }));
    return { contentLength: Number(res.ContentLength ?? 0) };
  } catch (err) {
    const code = (err as { name?: string; $metadata?: { httpStatusCode?: number } });
    if (code.name === 'NotFound' || code.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

export async function getObjectBytes(key: string): Promise<Buffer> {
  const res = await client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }));
  if (!res.Body) throw new Error(`S3 object has no body: ${key}`);
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function getObjectStream(
  key: string,
  range?: string,
): Promise<{
  stream: NodeJS.ReadableStream;
  contentLength: number | null;
  contentRange: string | null;
  contentType: string | null;
}> {
  const res = await client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key, Range: range }));
  if (!res.Body) throw new Error(`S3 object has no body: ${key}`);
  return {
    stream: res.Body as NodeJS.ReadableStream,
    contentLength: res.ContentLength == null ? null : Number(res.ContentLength),
    contentRange: res.ContentRange ?? null,
    contentType: res.ContentType ?? null,
  };
}
