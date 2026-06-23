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
  await pool.query(
    'TRUNCATE artifact_changes, artifact_sync_state, artifact_pointers, artifact_versions, artifacts, cas_blobs, files CASCADE',
  );
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

async function login(handle = 'alice', displayName = 'Alice'): Promise<{ cookie: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  expect(res.statusCode).toBe(200);
  return { cookie: res.headers['set-cookie'] as string, userId: res.json().user.id };
}

async function upload(
  cookie: string,
  args: { filename: string; contentType: string; size: number; contentHash?: string },
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { cookie },
    payload: args,
  });
  expect([200, 201]).toContain(res.statusCode);
  return res.json().fileId as string;
}

async function sendAttachment(cookie: string, fileId: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { cookie },
    payload: { channelId: fx.channelId, text: 'attached', attachments: [fileId] },
  });
  expect(res.statusCode).toBe(201);
}

async function latestArtifact(path: string): Promise<{
  artifact_id: string;
  seq: number;
  blob_sha: string;
  author: string;
  kind: string;
  s3_key: string;
} | null> {
  const res = await pool.query<{
    artifact_id: string;
    seq: number;
    blob_sha: string;
    author: string;
    kind: string;
    s3_key: string;
  }>(
    `SELECT a.id AS artifact_id, v.seq, v.blob_sha, v.author, v.kind, b.s3_key
       FROM artifacts a
       JOIN artifact_pointers p ON p.artifact_id = a.id AND p.name = 'latest'
       JOIN artifact_versions v ON v.artifact_id = a.id AND v.seq = p.seq
       JOIN cas_blobs b ON b.sha256 = v.blob_sha
      WHERE a.workspace_id = $1 AND a.path = $2`,
    [fx.workspaceId, path],
  );
  return res.rows[0] ?? null;
}

async function versionCount(path: string): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `SELECT count(*)::int
       FROM artifacts a
       JOIN artifact_versions v ON v.artifact_id = a.id
      WHERE a.workspace_id = $1 AND a.path = $2`,
    [fx.workspaceId, path],
  );
  return Number(res.rows[0]!.count);
}

async function fileS3Key(fileId: string): Promise<string> {
  const res = await pool.query<{ s3_key: string }>('SELECT s3_key FROM files WHERE id = $1', [fileId]);
  return res.rows[0]!.s3_key;
}

describe('human upload artifact on-ramp', () => {
  it('lands a hashed upload attachment as a shared workspace artifact', async () => {
    const { cookie, userId } = await login();
    const contentHash = '1'.repeat(64);
    const fileId = await upload(cookie, {
      filename: 'plan.txt',
      contentType: 'text/plain',
      size: 42,
      contentHash,
    });
    await sendAttachment(cookie, fileId);

    const path = 'shared/general/uploads/plan.txt';
    const artifact = await latestArtifact(path);
    expect(artifact).toMatchObject({
      seq: 1,
      blob_sha: contentHash,
      author: `human:${userId}`,
      kind: 'created',
      s3_key: await fileS3Key(fileId),
    });

    const blob = await pool.query<{ s3_key: string }>('SELECT s3_key FROM cas_blobs WHERE sha256 = $1', [
      contentHash,
    ]);
    expect(blob.rows[0]?.s3_key).toBe(await fileS3Key(fileId));
  });

  it('is idempotent when the same file is attached again', async () => {
    const { cookie } = await login();
    const contentHash = '2'.repeat(64);
    const fileId = await upload(cookie, {
      filename: 'again.md',
      contentType: 'text/markdown',
      size: 20,
      contentHash,
    });

    await sendAttachment(cookie, fileId);
    await sendAttachment(cookie, fileId);

    const path = 'shared/general/uploads/again.md';
    expect(await versionCount(path)).toBe(1);
    expect(await latestArtifact(path)).toMatchObject({ seq: 1, blob_sha: contentHash });
  });

  it('disambiguates a different upload with the same filename', async () => {
    const { cookie } = await login();
    const firstHash = '3'.repeat(64);
    const secondHash = '4'.repeat(64);
    const firstId = await upload(cookie, {
      filename: 'diagram.png',
      contentType: 'image/png',
      size: 100,
      contentHash: firstHash,
    });
    const secondId = await upload(cookie, {
      filename: 'diagram.png',
      contentType: 'image/png',
      size: 101,
      contentHash: secondHash,
    });

    await sendAttachment(cookie, firstId);
    await sendAttachment(cookie, secondId);

    expect(await latestArtifact('shared/general/uploads/diagram.png')).toMatchObject({
      seq: 1,
      blob_sha: firstHash,
    });
    expect(await latestArtifact('shared/general/uploads/diagram (2).png')).toMatchObject({
      seq: 1,
      blob_sha: secondHash,
    });
  });

  it('leaves null content_hash attachments as plain message attachments', async () => {
    const { cookie } = await login();
    const fileId = await upload(cookie, {
      filename: 'unhashed.txt',
      contentType: 'text/plain',
      size: 12,
    });

    await sendAttachment(cookie, fileId);

    expect(await latestArtifact('shared/general/uploads/unhashed.txt')).toBeNull();
    const artifacts = await pool.query<{ count: string }>('SELECT count(*)::int FROM artifacts');
    expect(Number(artifacts.rows[0]!.count)).toBe(0);
  });
});
