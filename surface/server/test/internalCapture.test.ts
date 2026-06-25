// Internal node-ingestion endpoints (x-api-key): auth gating + a real
// capture→changes→raw round-trip against PG + object storage (the node daemon's contract).
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

const mockedS3 = vi.hoisted(() => {
  class FakeStorage {
    readonly objects = new Map<string, { body: Buffer; contentType: string }>();

    reset(): void {
      this.objects.clear();
    }

    uploadObject = async (key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> => {
      this.objects.set(key, { body: Buffer.from(body), contentType });
    };

    uploadObjectStream = async (
      key: string,
      stream: NodeJS.ReadableStream,
      contentType: string,
    ): Promise<void> => {
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

const KEY = 'internal-capture-test-key';

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  pool = await createTestPool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  mockedS3.storage.reset();
  await pool.query(
    'TRUNCATE artifact_changes, artifact_sync_state, cas_blobs, artifact_pointers, artifact_versions, artifacts CASCADE',
  );
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({
    pool,
    artifactCaptureApiKey: KEY,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

async function session(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1,$2,$3,'int','running',$4) RETURNING id`,
    [fx.workspaceId, fx.channelId, `tk-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

describe('internal node-ingestion auth', () => {
  it('rejects capture/raw/changes without the api key', async () => {
    const sid = await session();
    for (const url of [
      `/api/internal/sessions/${sid}/artifacts/changes`,
      `/api/internal/sessions/${sid}/artifacts/raw?path=a.md`,
      `/api/internal/sessions/${sid}/hydration-scope`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
    const cap = await app.inject({
      method: 'POST',
      url: `/api/internal/sessions/${sid}/artifacts/capture?path=a.md`,
      headers: { 'content-type': 'text/markdown' },
      payload: 'x',
    });
    expect(cap.statusCode).toBe(401);
  });

  it('rejects a wrong api key', async () => {
    const sid = await session();
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/artifacts/changes`,
      headers: { 'x-api-key': 'nope' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('internal capture round-trip (PG + object storage)', () => {
  it('captures a version, surfaces it in the feed, and serves it back raw', async () => {
    const sid = await session();
    const path = `shared/channels/${fx.channelId}/a.md`;
    const cap = await app.inject({
      method: 'POST',
      url: `/api/internal/sessions/${sid}/artifacts/capture?path=${encodeURIComponent(path)}`,
      headers: { 'x-api-key': KEY, 'content-type': 'text/markdown' },
      payload: 'node captured this',
    });
    expect(cap.statusCode).toBe(200);
    expect(cap.json()).toMatchObject({ seq: 1, status: 'normal' });

    const feed = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/artifacts/changes`,
      headers: { 'x-api-key': KEY },
    });
    expect(feed.statusCode).toBe(200);
    expect(feed.json().rows.map((r: { path: string }) => r.path)).toContain(path);

    const raw = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/artifacts/raw?path=${encodeURIComponent(path)}`,
      headers: { 'x-api-key': KEY },
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.body).toBe('node captured this');
  });

  it('canonicalizes active-channel aliases to one artifact chain', async () => {
    const sid = await session();
    const explicit = `shared/channels/${fx.channelId}/report.md`;
    const first = await app.inject({
      method: 'POST',
      url: `/api/internal/sessions/${sid}/artifacts/capture?path=report.md`,
      headers: { 'x-api-key': KEY, 'content-type': 'text/markdown' },
      payload: 'first',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ seq: 1, status: 'normal' });

    const second = await app.inject({
      method: 'POST',
      url: `/api/internal/sessions/${sid}/artifacts/capture?path=${encodeURIComponent(explicit)}`,
      headers: {
        'x-api-key': KEY,
        'content-type': 'text/markdown',
        'x-artifact-base-seq': '1',
      },
      payload: 'second',
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ seq: 2, status: 'normal' });

    const rows = await pool.query<{ path: string; versions: number }>(
      `SELECT a.path, count(v.*)::int AS versions
         FROM artifacts a
         JOIN artifact_versions v ON v.artifact_id = a.id
        WHERE a.workspace_id = $1
        GROUP BY a.path
        ORDER BY a.path`,
      [fx.workspaceId],
    );
    expect(rows.rows).toEqual([{ path: explicit, versions: 2 }]);

    const raw = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/artifacts/raw?path=report.md`,
      headers: { 'x-api-key': KEY },
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.body).toBe('second');
  });

  it('raw 404s for an unknown path', async () => {
    const sid = await session();
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/artifacts/raw?path=missing.md`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(404);
  });

  it('hydration-scope returns the subscription set (own scratch + shared)', async () => {
    const sid = await session();
    const sharedPath = `shared/channels/${fx.channelId}/note.md`;
    const scratchPath = `scratch/${sid}/local.md`;
    for (const path of [sharedPath, scratchPath]) {
      const cap = await app.inject({
        method: 'POST',
        url: `/api/internal/sessions/${sid}/artifacts/capture?path=${encodeURIComponent(path)}`,
        headers: { 'x-api-key': KEY, 'content-type': 'text/markdown' },
        payload: 'x',
      });
      expect(cap.statusCode).toBe(200);
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/hydration-scope`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(200);
    const entries = res.json().paths as Array<{ path: string; sha: string | null }>;
    const paths = entries.map((p) => p.path);
    expect(paths).toContain(sharedPath);
    expect(paths).toContain(scratchPath);
    // the node needs the blob sha to CAS-key the lower (5B-3 materialize_cached)
    expect(entries.find((e) => e.path === sharedPath)?.sha).toMatch(/^[0-9a-f]{64}$/);
  });
});
