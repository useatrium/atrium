import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { casBlobKey } from '../src/artifact-ledger.js';
import type { AppDeps } from '../src/app.js';
import type { Fixture } from './helpers.js';

const mockedS3 = vi.hoisted(() => {
  class FakeStorage {
    readonly objects = new Map<string, { body: Buffer; contentType: string }>();

    reset(): void {
      this.objects.clear();
    }

    uploadObject = async (key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> => {
      this.objects.set(key, { body: Buffer.from(body), contentType });
    };

    uploadObjectStream = async (key: string, stream: NodeJS.ReadableStream, contentType: string): Promise<void> => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      this.objects.set(key, { body: Buffer.concat(chunks), contentType });
    };

    copyObject = async (srcKey: string, destKey: string): Promise<void> => {
      const object = this.objects.get(srcKey);
      if (!object) throw new Error(`missing object: ${srcKey}`);
      this.objects.set(destKey, { body: Buffer.from(object.body), contentType: object.contentType });
    };

    deleteObject = async (key: string): Promise<void> => {
      this.objects.delete(key);
    };

    getObjectBytes = async (key: string): Promise<Buffer> => {
      const object = this.objects.get(key);
      if (!object) throw new Error(`missing object: ${key}`);
      return Buffer.from(object.body);
    };

    headObject = async (key: string): Promise<{ contentLength: number } | null> => {
      const object = this.objects.get(key);
      return object ? { contentLength: object.body.byteLength } : null;
    };
  }

  return { storage: new FakeStorage() };
});

vi.mock('../src/s3.js', () => ({
  copyObject: mockedS3.storage.copyObject,
  deleteObject: mockedS3.storage.deleteObject,
  downloadObject: async () => {},
  ensureBucket: async () => {},
  getObjectBytes: mockedS3.storage.getObjectBytes,
  headObject: mockedS3.storage.headObject,
  presignGet: async () => 'https://storage.local/get',
  presignPut: async () => 'https://storage.local/put',
  uploadObject: mockedS3.storage.uploadObject,
  uploadObjectStream: mockedS3.storage.uploadObjectStream,
}));

const KEY = 'stream-capture-test-key';
const oldKey = process.env.ARTIFACT_CAPTURE_API_KEY;

let pool: pg.Pool;
let fx: Fixture;
let app: FastifyInstance;
let buildApp: (deps: AppDeps) => Promise<FastifyInstance>;
let createTestPool: typeof import('./helpers.js').createTestPool;
let seedFixture: typeof import('./helpers.js').seedFixture;
let truncateAll: typeof import('./helpers.js').truncateAll;

beforeAll(async () => {
  process.env.ARTIFACT_CAPTURE_API_KEY = KEY;
  ({ createTestPool, seedFixture, truncateAll } = await import('./helpers.js'));
  ({ buildApp } = await import('../src/app.js'));
  pool = await createTestPool();
});

afterAll(async () => {
  if (pool) await pool.end();
  if (oldKey == null) {
    delete process.env.ARTIFACT_CAPTURE_API_KEY;
  } else {
    process.env.ARTIFACT_CAPTURE_API_KEY = oldKey;
  }
});

beforeEach(async () => {
  mockedS3.storage.reset();
  await pool.query(
    'TRUNCATE artifact_changes, artifact_sync_state, cas_blobs, artifact_pointers, artifact_versions, artifacts CASCADE',
  );
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({ pool, sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false } });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function session(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1,$2,$3,'stream','running',$4) RETURNING id`,
    [fx.workspaceId, fx.channelId, `tk-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function patternedBuffer(size: number): Buffer {
  const pattern = Buffer.from('atrium-stream-capture-pattern\n');
  const bytes = Buffer.allocUnsafe(size);
  for (let offset = 0; offset < bytes.length; offset += pattern.length) {
    pattern.copy(bytes, offset, 0, Math.min(pattern.length, bytes.length - offset));
  }
  return bytes;
}

function activePath(path: string): string {
  return `shared/channels/${fx.channelId}/${path}`;
}

describe('internal streaming artifact capture', () => {
  it('captures a multi-MB body into CAS and serves back identical bytes', async () => {
    const sid = await session();
    const body = patternedBuffer(3 * 1024 * 1024 + 17);
    const sha = sha256(body);

    const cap = await app.inject({
      method: 'POST',
      url: `/api/internal/sessions/${sid}/artifacts/capture-stream?path=large/blob.bin`,
      headers: {
        'x-api-key': KEY,
        'content-type': 'application/octet-stream',
        'x-artifact-stream': '1',
        'x-artifact-size': String(body.byteLength),
      },
      payload: body,
    });
    expect(cap.statusCode).toBe(200);
    expect(cap.json()).toEqual({ seq: 1, status: 'normal' });

    const version = await pool.query<{ blob_sha: string; size_bytes: number; s3_key: string | null; kind: string }>(
      `SELECT v.blob_sha, v.kind, b.size_bytes, b.s3_key
         FROM artifacts a
        JOIN artifact_versions v ON v.artifact_id = a.id
        JOIN cas_blobs b ON b.sha256 = v.blob_sha
       WHERE a.workspace_id = $1 AND a.path = $2`,
      [fx.workspaceId, activePath('large/blob.bin')],
    );
    expect(version.rows[0]).toEqual({
      blob_sha: sha,
      size_bytes: body.byteLength,
      s3_key: casBlobKey(sha),
      kind: 'created', // first version of this path is 'created', not 'modified'
    });
    const stored = mockedS3.storage.objects.get(casBlobKey(sha))?.body;
    expect(stored?.byteLength).toBe(body.byteLength);
    expect(stored?.equals(body)).toBe(true);

    const raw = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/artifacts/raw?path=large/blob.bin`,
      headers: { 'x-api-key': KEY },
    });
    expect(raw.statusCode).toBe(200);
    const rawBody = Buffer.from(raw.rawPayload);
    expect(rawBody.byteLength).toBe(body.byteLength);
    expect(rawBody.equals(body)).toBe(true);
  });

  it('accepts a body larger than maxUploadBytes', async () => {
    const sid = await session();
    const body = patternedBuffer(25 * 1024 * 1024 + 4096);
    const sha = sha256(body);

    const cap = await app.inject({
      method: 'POST',
      url: `/api/internal/sessions/${sid}/artifacts/capture-stream?path=large/over-limit.bin`,
      headers: {
        'x-api-key': KEY,
        'content-type': 'application/octet-stream',
        'x-artifact-stream': '1',
        'x-artifact-size': String(body.byteLength),
      },
      payload: body,
    });
    expect(cap.statusCode).toBe(200);
    expect(cap.json()).toEqual({ seq: 1, status: 'normal' });
    expect(mockedS3.storage.objects.get(casBlobKey(sha))?.body.byteLength).toBe(body.byteLength);
  });

  it('returns stale_base when base_seq is behind latest', async () => {
    const sid = await session();
    const first = await app.inject({
      method: 'POST',
      url: `/api/internal/sessions/${sid}/artifacts/capture-stream?path=large/stale.bin`,
      headers: { 'x-api-key': KEY, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('first'),
    });
    expect(first.statusCode).toBe(200);

    const stale = await app.inject({
      method: 'POST',
      url: `/api/internal/sessions/${sid}/artifacts/capture-stream?path=large/stale.bin`,
      headers: {
        'x-api-key': KEY,
        'content-type': 'application/octet-stream',
        'x-artifact-base-seq': '99',
      },
      payload: Buffer.from('second'),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'stale_base', latestSeq: 1, baseSeq: 99 });
  });

  it('requires x-api-key', async () => {
    const sid = await session();
    const res = await app.inject({
      method: 'POST',
      url: `/api/internal/sessions/${sid}/artifacts/capture-stream?path=large/no-key.bin`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('nope'),
    });
    expect(res.statusCode).toBe(401);
  });
});
