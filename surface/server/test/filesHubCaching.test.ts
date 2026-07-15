import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { ArtifactLedger, casBlobKey } from '../src/artifact-ledger.js';
import { addWorkspaceMember } from '../src/membership.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

const mockedS3 = vi.hoisted(() => ({
  getObjectStream: vi.fn(),
  presignGet: vi.fn(),
}));

vi.mock('../src/s3.js', () => ({
  copyObject: async () => {},
  deleteObject: async () => {},
  downloadObject: async () => {},
  ensureBucket: async () => {},
  getObjectBytes: async () => Buffer.alloc(0),
  getObjectStream: mockedS3.getObjectStream,
  headObject: async () => null,
  presignGet: mockedS3.presignGet,
  presignPut: async () => 'https://storage.local/put',
  uploadObject: async () => {},
  uploadObjectStream: async () => {},
}));

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;
let ledger: ArtifactLedger;

beforeAll(async () => {
  pool = await createTestPool();
  ledger = new ArtifactLedger(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  mockedS3.getObjectStream.mockReset();
  mockedS3.presignGet.mockReset();
  mockedS3.getObjectStream.mockImplementation(async () => ({
    stream: Readable.from(['artifact bytes']),
    contentLength: 14,
    contentRange: null,
    contentType: 'text/plain',
  }));
  mockedS3.presignGet.mockResolvedValue('https://storage.local/get');
  await pool.query(
    'TRUNCATE artifact_changes, artifact_sync_state, cas_blobs, artifact_pointers, artifact_versions, artifacts CASCADE',
  );
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({
    pool,
    rateLimit: false,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function loginCookie(): Promise<{ cookie: string; userId: string }> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
  const userId = login.json().user.id;
  await addWorkspaceMember(pool, fx.workspaceId, userId);
  return { cookie: login.headers['set-cookie'] as string, userId };
}

async function seedArtifact(userId: string): Promise<{ artifactId: string; seq: number; sha: string }> {
  const body = Buffer.from('artifact bytes');
  const sha = createHash('sha256').update(body).digest('hex');
  await pool.query(
    `INSERT INTO cas_blobs (sha256, s3_key, size_bytes, mime, media_kind)
     VALUES ($1, $2, $3, 'text/plain', 'text')`,
    [sha, casBlobKey(sha), body.byteLength],
  );
  const committed = await ledger.commitUpload({
    workspaceId: fx.workspaceId,
    channelId: fx.channelId,
    path: `shared/channels/${fx.channelId}/uploads/cache-${randomUUID()}.txt`,
    blobSha: sha,
    sizeBytes: body.byteLength,
    mime: 'text/plain',
    author: `human:${userId}`,
  });
  return { artifactId: committed.artifactId, seq: committed.seq, sha };
}

async function attachThumbnail(sourceSha: string): Promise<void> {
  const thumbnailSha = createHash('sha256').update('thumbnail bytes').digest('hex');
  await pool.query(
    `INSERT INTO cas_blobs (sha256, s3_key, size_bytes, mime, media_kind)
     VALUES ($1, $2, 15, 'image/webp', 'image')`,
    [thumbnailSha, casBlobKey(thumbnailSha)],
  );
  await pool.query('UPDATE cas_blobs SET thumbnail_sha = $1 WHERE sha256 = $2', [thumbnailSha, sourceSha]);
}

describe('Files Hub media caching', () => {
  it('caches and conditionally revalidates latest content redirects', async () => {
    const { cookie, userId } = await loginCookie();
    const file = await seedArtifact(userId);

    const initial = await app.inject({
      method: 'GET',
      url: `/api/files/artifact/${file.artifactId}/content`,
      headers: { cookie },
    });
    expect(initial.statusCode).toBe(302);
    expect(initial.headers.etag).toBe(`"${file.sha}"`);
    expect(initial.headers['cache-control']).toBe('private, no-cache');
    expect(initial.headers.location).toBe('https://storage.local/get');

    mockedS3.presignGet.mockClear();
    const notModified = await app.inject({
      method: 'GET',
      url: `/api/files/artifact/${file.artifactId}/content`,
      headers: { cookie, 'if-none-match': `"${file.sha}"` },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe('');
    expect(notModified.headers.location).toBeUndefined();
    expect(mockedS3.presignGet).not.toHaveBeenCalled();

    const stale = await app.inject({
      method: 'GET',
      url: `/api/files/artifact/${file.artifactId}/content`,
      headers: { cookie, 'if-none-match': '"stale-sha"' },
    });
    expect(stale.statusCode).toBe(302);
    expect(stale.headers.location).toBe('https://storage.local/get');
    expect(mockedS3.presignGet).toHaveBeenCalledOnce();
  });

  it('uses immutable caching for a specific version and skips object reads on a match', async () => {
    const { cookie, userId } = await loginCookie();
    const file = await seedArtifact(userId);
    const url = `/api/files/artifact/${file.artifactId}/content?at=${file.seq}`;

    const initial = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(initial.statusCode).toBe(200);
    expect(initial.headers.etag).toBe(`"${file.sha}"`);
    expect(initial.headers['cache-control']).toBe('private, max-age=31536000, immutable');

    mockedS3.getObjectStream.mockClear();
    const notModified = await app.inject({
      method: 'GET',
      url,
      headers: { cookie, 'if-none-match': `"${file.sha}"` },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe('');
    expect(notModified.headers.location).toBeUndefined();
    expect(mockedS3.getObjectStream).not.toHaveBeenCalled();

    const stale = await app.inject({
      method: 'GET',
      url,
      headers: { cookie, 'if-none-match': '"stale-sha"' },
    });
    expect(stale.statusCode).toBe(200);
    expect(mockedS3.getObjectStream).toHaveBeenCalledOnce();
  });

  it('caches thumbnail redirects against the source version SHA', async () => {
    const { cookie, userId } = await loginCookie();
    const file = await seedArtifact(userId);
    await attachThumbnail(file.sha);
    const url = `/api/files/artifact/${file.artifactId}/thumbnail`;

    const initial = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(initial.statusCode).toBe(302);
    expect(initial.headers.etag).toBe(`"${file.sha}"`);
    expect(initial.headers['cache-control']).toBe('private, no-cache');

    mockedS3.presignGet.mockClear();
    const notModified = await app.inject({
      method: 'GET',
      url,
      headers: { cookie, 'if-none-match': `"${file.sha}"` },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe('');
    expect(notModified.headers.location).toBeUndefined();
    expect(mockedS3.presignGet).not.toHaveBeenCalled();

    const stale = await app.inject({
      method: 'GET',
      url,
      headers: { cookie, 'if-none-match': '"stale-sha"' },
    });
    expect(stale.statusCode).toBe(302);
    expect(mockedS3.presignGet).toHaveBeenCalledOnce();
  });

  it('runs authentication before a matching conditional request', async () => {
    const { userId } = await loginCookie();
    const file = await seedArtifact(userId);

    const res = await app.inject({
      method: 'GET',
      url: `/api/files/artifact/${file.artifactId}/content`,
      headers: { 'if-none-match': `"${file.sha}"` },
    });
    expect(res.statusCode).toBe(401);
    expect(mockedS3.presignGet).not.toHaveBeenCalled();
  });

  it('keeps deleted artifacts gone even when the validator matches', async () => {
    const { cookie, userId } = await loginCookie();
    const file = await seedArtifact(userId);
    await pool.query('UPDATE artifacts SET tombstoned_at = now() WHERE id = $1', [file.artifactId]);

    const res = await app.inject({
      method: 'GET',
      url: `/api/files/artifact/${file.artifactId}/content`,
      headers: { cookie, 'if-none-match': `"${file.sha}"` },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: 'artifact_deleted', message: 'artifact was deleted' });
    expect(mockedS3.presignGet).not.toHaveBeenCalled();
  });
});
