// Short-lived signed file URLs: minting requires auth; the signed URL works
// with no session; tampering/expiry are rejected; session tokens never appear
// in file URLs.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { fileSignature, verifyFileSignature } from '../src/filesign.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

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
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({
    pool,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

async function loginToken(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
  return res.json().token as string;
}

async function insertFile(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO files (workspace_id, uploader_id, filename, content_type, size_bytes, s3_key)
     VALUES ($1, $2, 'pic.png', 'image/png', 123, 'k/pic.png') RETURNING id`,
    [fx.workspaceId, fx.userId],
  );
  return r.rows[0]!.id;
}

describe('signature primitives', () => {
  it('verifies a fresh signature and rejects tamper/expiry/cross-file', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const sig = fileSignature('file-a', exp, 's3cret');
    expect(verifyFileSignature('file-a', exp, sig, 's3cret')).toBe(true);
    expect(verifyFileSignature('file-b', exp, sig, 's3cret')).toBe(false);
    expect(verifyFileSignature('file-a', exp + 1, sig, 's3cret')).toBe(false);
    expect(verifyFileSignature('file-a', exp, sig, 'other')).toBe(false);
    const past = Math.floor(Date.now() / 1000) - 1;
    expect(verifyFileSignature('file-a', past, fileSignature('file-a', past, 's3cret'), 's3cret')).toBe(false);
  });
});

describe('signed file URLs', () => {
  it('minted URL redirects to storage with no session attached', async () => {
    const token = await loginToken();
    const fileId = await insertFile();
    const mint = await app.inject({
      method: 'GET',
      url: `/api/files/${fileId}/url`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mint.statusCode).toBe(200);
    const { url } = mint.json() as { url: string };
    expect(url).not.toContain(token); // the whole point

    const fetchIt = await app.inject({ method: 'GET', url }); // NO auth
    expect(fetchIt.statusCode).toBe(302);
    expect(fetchIt.headers.location).toBeTruthy();
  });

  it('rejects tampered or missing signatures without auth', async () => {
    const token = await loginToken();
    const fileId = await insertFile();
    const mint = await app.inject({
      method: 'GET',
      url: `/api/files/${fileId}/url`,
      headers: { authorization: `Bearer ${token}` },
    });
    const { url } = mint.json() as { url: string };
    const tampered = url.replace(/sig=...../, 'sig=AAAAA'); // mangle start of sig

    const bad = await app.inject({ method: 'GET', url: tampered });
    expect(bad.statusCode).toBe(401);

    const bare = await app.inject({ method: 'GET', url: `/api/files/${fileId}` });
    expect(bare.statusCode).toBe(401);
  });

  it('minting requires auth; bearer auth still works directly on the file', async () => {
    const fileId = await insertFile();
    const anon = await app.inject({ method: 'GET', url: `/api/files/${fileId}/url` });
    expect(anon.statusCode).toBe(401);

    const token = await loginToken();
    const direct = await app.inject({
      method: 'GET',
      url: `/api/files/${fileId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(direct.statusCode).toBe(302);
  });
});
