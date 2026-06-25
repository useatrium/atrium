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

/** Create the bucket on first use; cheap no-op afterwards. */
export async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.s3Bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: config.s3Bucket }));
  }
  bucketReady = true;
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
 * Content-Length without buffering a stream itself. */
export async function uploadObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<void> {
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
