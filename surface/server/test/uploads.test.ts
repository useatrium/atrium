import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;
let putCounter = 0;

const fileStorage = {
  ensureBucket: async () => {},
  deleteObject: async () => {},
  presignPut: async (key: string, contentType: string) =>
    `https://storage.local/put/${encodeURIComponent(key)}?contentType=${encodeURIComponent(
      contentType,
    )}&n=${++putCounter}`,
  presignGet: async (key: string) => `https://storage.local/get/${encodeURIComponent(key)}`,
};

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  putCounter = 0;
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({
    pool,
    fileStorage,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function login(handle: string, displayName = handle) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  expect(res.statusCode).toBe(200);
  return { cookie: res.headers['set-cookie'] as string, user: res.json().user };
}

describe('POST /api/uploads', () => {
  it('dedupes same uploader, content hash, and size to one file row', async () => {
    const { cookie, user } = await login('alice', 'Alice');
    const contentHash = 'a'.repeat(64);
    const first = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { cookie },
      payload: {
        filename: 'shot.png',
        contentType: 'image/png',
        size: 12345,
        contentHash,
      },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().existing).toBe(false);

    const second = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { cookie },
      payload: {
        filename: 'shot-copy.png',
        contentType: 'image/png',
        size: 12345,
        contentHash: contentHash.toUpperCase(),
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().existing).toBe(true);
    expect(second.json().fileId).toBe(first.json().fileId);
    expect(second.json().uploadUrl).not.toBe(first.json().uploadUrl);

    const rows = await pool.query<{ count: string }>(
      'SELECT count(*) FROM files WHERE uploader_id = $1 AND content_hash = $2 AND size_bytes = $3',
      [user.id, contentHash, 12345],
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);

    const differentSize = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { cookie },
      payload: {
        filename: 'shot-large.png',
        contentType: 'image/png',
        size: 54321,
        contentHash,
      },
    });
    expect(differentSize.statusCode).toBe(201);
    expect(differentSize.json().fileId).not.toBe(first.json().fileId);
  });
});

describe('POST /api/uploads/:fileId/refresh', () => {
  it('returns a fresh upload URL only to the uploader and 404s otherwise', async () => {
    const { cookie: aliceCookie } = await login('alice', 'Alice');
    const { cookie: bobCookie } = await login('bob', 'Bob');
    const upload = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { cookie: aliceCookie },
      payload: {
        filename: 'doc.txt',
        contentType: 'text/plain',
        size: 22,
        contentHash: 'b'.repeat(64),
      },
    });
    expect(upload.statusCode).toBe(201);
    const fileId = upload.json().fileId;

    const refreshed = await app.inject({
      method: 'POST',
      url: `/api/uploads/${fileId}/refresh`,
      headers: { cookie: aliceCookie },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().uploadUrl).toContain('/put/');
    expect(refreshed.json().uploadUrl).not.toBe(upload.json().uploadUrl);

    const foreign = await app.inject({
      method: 'POST',
      url: `/api/uploads/${fileId}/refresh`,
      headers: { cookie: bobCookie },
    });
    expect(foreign.statusCode).toBe(404);

    const missing = await app.inject({
      method: 'POST',
      url: `/api/uploads/${fx.workspaceId}/refresh`,
      headers: { cookie: aliceCookie },
    });
    expect(missing.statusCode).toBe(404);
  });
});
