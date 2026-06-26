// Warm-cache internal endpoints (x-api-key): blob CAS round-trip, per-(workspace,
// lockfile-hash, kind) manifest hydration, and GC-root protection. Machine state
// kept out of the artifact ledger — these routes are the Phase 2 contract the
// Centaur node daemon uses to populate + hydrate the overlay warm-cache lower.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { sweepUnreferencedBlobs } from '../src/artifact-ledger-gc.js';
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
    getObjectBytes = async (key: string): Promise<Buffer> => {
      const o = this.objects.get(key);
      if (!o) throw new Error(`missing object: ${key}`);
      return Buffer.from(o.body);
    };
    deleteObject = async (key: string): Promise<void> => {
      this.objects.delete(key);
    };
  }
  return { storage: new FakeStorage() };
});

vi.mock('../src/s3.js', () => ({
  copyObject: async () => {},
  deleteObject: mockedS3.storage.deleteObject,
  downloadObject: async () => {},
  ensureBucket: async () => {},
  getObjectBytes: mockedS3.storage.getObjectBytes,
  headObject: async () => null,
  presignGet: async () => 'https://storage.local/get',
  presignPut: async () => 'https://storage.local/put',
  uploadObject: mockedS3.storage.uploadObject,
  uploadObjectStream: async () => {},
}));

const KEY = 'warmcache-test-key';

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
  // cas_blobs + warmcache_blobs are not in truncateAll's list; clear them so a
  // durable-blob row from a prior test can't outlive the reset FakeStorage.
  await pool.query('TRUNCATE cas_blobs, warmcache_blobs CASCADE');
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

function sha(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

async function putBlob(bytes: Buffer): Promise<string> {
  const s = sha(bytes);
  const res = await app.inject({
    method: 'PUT',
    url: `/api/internal/cache/blob?sha256=${s}`,
    headers: { 'x-api-key': KEY, 'content-type': 'application/octet-stream' },
    payload: bytes,
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ sha256: s, size_bytes: bytes.length });
  return s;
}

describe('warm-cache internal endpoints', () => {
  it('requires the capture api key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/cache/hydration?workspace_id=${fx.workspaceId}&lockfile_hash=abc&kind=npm`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('blob round-trips through CAS and the manifest hydrates', async () => {
    const a = Buffer.from('react package json contents');
    const b = Buffer.from('lodash index js contents');
    const shaA = await putBlob(a);
    const shaB = await putBlob(b);

    const reg = await app.inject({
      method: 'PUT',
      url: '/api/internal/cache/manifest',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: {
        workspace_id: fx.workspaceId,
        lockfile_hash: 'lock123',
        kind: 'npm',
        entries: [
          { path: 'node_modules/react/package.json', sha256: shaA, size_bytes: a.length },
          { path: 'node_modules/lodash/index.js', sha256: shaB, size_bytes: b.length },
        ],
      },
    });
    expect(reg.statusCode).toBe(200);
    expect(reg.json()).toMatchObject({ count: 2 });

    const hyd = await app.inject({
      method: 'GET',
      url: `/api/internal/cache/hydration?workspace_id=${fx.workspaceId}&lockfile_hash=lock123&kind=npm`,
      headers: { 'x-api-key': KEY },
    });
    expect(hyd.statusCode).toBe(200);
    const body = hyd.json();
    expect(body.scope).toBe('warmcache');
    expect(body.entries).toHaveLength(2);
    expect(body.entries).toContainEqual({
      path: 'node_modules/react/package.json',
      sha256: shaA,
      size_bytes: a.length,
    });

    const blob = await app.inject({
      method: 'GET',
      url: `/api/internal/cache/blob?sha256=${shaA}`,
      headers: { 'x-api-key': KEY },
    });
    expect(blob.statusCode).toBe(200);
    expect(blob.rawPayload).toEqual(a);
  });

  it('re-registering a manifest replaces the prior entry set', async () => {
    const a = Buffer.from('one');
    const shaA = await putBlob(a);
    const reg = (entries: unknown[]) =>
      app.inject({
        method: 'PUT',
        url: '/api/internal/cache/manifest',
        headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
        payload: { workspace_id: fx.workspaceId, lockfile_hash: 'l', kind: 'npm', entries },
      });
    await reg([
      { path: 'a', sha256: shaA, size_bytes: 3 },
      { path: 'b', sha256: shaA, size_bytes: 3 },
    ]);
    await reg([{ path: 'a', sha256: shaA, size_bytes: 3 }]);
    const hyd = await app.inject({
      method: 'GET',
      url: `/api/internal/cache/hydration?workspace_id=${fx.workspaceId}&lockfile_hash=l&kind=npm`,
      headers: { 'x-api-key': KEY },
    });
    expect(hyd.json().entries).toHaveLength(1);
  });

  it('rejects a sha256 that does not match the body (400)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/internal/cache/blob?sha256=${'0'.repeat(64)}`,
      headers: { 'x-api-key': KEY, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('mismatched'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('an unknown workspace is 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/cache/hydration?workspace_id=${randomUUID()}&lockfile_hash=l&kind=npm`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GC does not collect a blob referenced by a warm-cache manifest', async () => {
    const a = Buffer.from('protected by warmcache manifest');
    const shaA = await putBlob(a);
    // Age the blob past the grace window so it would otherwise be swept.
    await pool.query(`UPDATE cas_blobs SET created_at = now() - interval '2 days' WHERE sha256 = $1`, [shaA]);
    await app.inject({
      method: 'PUT',
      url: '/api/internal/cache/manifest',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: {
        workspace_id: fx.workspaceId,
        lockfile_hash: 'lockgc',
        kind: 'npm',
        entries: [{ path: 'node_modules/x/y.js', sha256: shaA, size_bytes: a.length }],
      },
    });

    const storage = { deleteObject: vi.fn(async (_key: string) => {}) };
    const result = await sweepUnreferencedBlobs(pool, storage, { graceMs: 24 * 60 * 60 * 1000, limit: 100 });
    expect(result.swept).toBe(0);
    expect(storage.deleteObject).not.toHaveBeenCalled();
    const still = await pool.query('SELECT 1 FROM cas_blobs WHERE sha256 = $1', [shaA]);
    expect(still.rows).toHaveLength(1);
  });

  it('session-scoped routes resolve the workspace and round-trip', async () => {
    const sess = await pool.query<{ id: string }>(
      `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
       VALUES ($1,$2,$3,'wc','running',$4) RETURNING id`,
      [fx.workspaceId, fx.channelId, `tk-${randomUUID()}`, fx.userId],
    );
    const sid = sess.rows[0]!.id;
    const a = Buffer.from('session-scoped blob');
    const shaA = await putBlob(a);

    const reg = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/cache/manifest`,
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: {
        lockfile_hash: 'slock',
        kind: 'pnpm',
        entries: [{ path: 'p/a', sha256: shaA, size_bytes: a.length }],
      },
    });
    expect(reg.statusCode).toBe(200);
    expect(reg.json()).toMatchObject({ count: 1 });

    const hyd = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/cache/hydration?lockfile_hash=slock&kind=pnpm`,
      headers: { 'x-api-key': KEY },
    });
    expect(hyd.statusCode).toBe(200);
    const body = hyd.json();
    expect(body.workspaceId).toBe(fx.workspaceId);
    expect(body.entries).toEqual([{ path: 'p/a', sha256: shaA, size_bytes: a.length }]);

    const miss = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${randomUUID()}/cache/hydration?lockfile_hash=slock&kind=pnpm`,
      headers: { 'x-api-key': KEY },
    });
    expect(miss.statusCode).toBe(404);
  });
});
