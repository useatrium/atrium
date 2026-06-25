import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { ArtifactLedger, casBlobKey } from '../src/artifact-ledger.js';
import { ensureBucket } from '../src/s3.js';
import { addWorkspaceMember } from '../src/membership.js';
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

const KEY = 'artifact-scope-route-test-key';

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
  mockedS3.storage.reset();
  await pool.query(
    'TRUNCATE artifact_changes, artifact_sync_state, cas_blobs, artifact_pointers, artifact_versions, artifacts CASCADE',
  );
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({
    pool,
    artifactCaptureApiKey: KEY,
    sessionRuns: {
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'test',
      autoResume: false,
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function loginCookie(): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
  await addWorkspaceMember(pool, fx.workspaceId, login.json().user.id);
  return login.headers['set-cookie'] as string;
}

async function session(channelId = fx.channelId): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by, driver_id, current_execution_id)
     VALUES ($1, $2, $3, 'claude-code', 'acl-route-test', 'running', $4, $4, 'exec-1') RETURNING id`,
    [fx.workspaceId, channelId, `thread-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

async function commit(sessionId: string, path: string, bytes: string) {
  const payload = Buffer.from(bytes);
  const sha = createHash('sha256').update(payload).digest('hex');
  const s3Key = casBlobKey(sha);
  mockedS3.storage.objects.set(s3Key, { body: payload, contentType: 'text/markdown' });
  await pool.query(
    `INSERT INTO cas_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ($1, $2, $3, 'text/markdown')
     ON CONFLICT (sha256) DO UPDATE
           SET s3_key = COALESCE(cas_blobs.s3_key, EXCLUDED.s3_key)`,
    [sha, s3Key, payload.byteLength],
  );
  await ledger.commitVersion({
    sessionId,
    channelId: fx.channelId,
    path,
    blobSha: sha,
    sizeBytes: payload.byteLength,
    mime: 'text/markdown',
    author: `agent:${sessionId}`,
    kind: 'created',
  });
}

describe('artifact scope route enforcement', () => {
  it('allows a user read of this session scratch artifact', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    const path = `scratch/${sid}/secret.md`;
    await commit(sid, path, 'private notes');

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/by-path?path=${encodeURIComponent(path)}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers['x-artifact-scope']).toBe('private');
    expect(res.headers.location).toBe('https://storage.local/get');
  });

  it('allows a user read of a shared artifact and exposes its scope', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    await commit(sid, 'shared/global/report.md', 'shared report body');

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/by-path?path=${encodeURIComponent('shared/global/report.md')}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers['x-artifact-scope']).toBe('workspace');
    expect(res.headers.location).toBe('https://storage.local/get');
  });

  it('shows session scratch and shared artifacts in the user-facing files listing', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    await commit(sid, `scratch/${sid}/secret.md`, 'private notes');
    await commit(sid, 'shared/global/report.md', 'shared report body');
    await commit(sid, 'report.md', 'active channel body');
    const otherChannel = await pool.query<{ id: string }>(
      `INSERT INTO channels (workspace_id, name, kind, created_by)
       VALUES ($1, 'other-channel', 'public', $2) RETURNING id`,
      [fx.workspaceId, fx.userId],
    );
    const otherSid = await session(otherChannel.rows[0]!.id);
    await commit(otherSid, 'other-channel.md', 'other channel body');

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/files?dir=`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      activePrefix: string;
      rows: Array<{ path: string; canonicalPath?: string; displayPath?: string; scope?: string }>;
    };
    expect(body.activePrefix).toBe(`shared/channels/${fx.channelId}`);
    expect(body.rows.map((row) => row.path)).toEqual(['report.md', 'scratch', 'shared']);
    expect(body.rows.find((row) => row.path === 'report.md')).toMatchObject({
      canonicalPath: `shared/channels/${fx.channelId}/report.md`,
      displayPath: 'report.md',
      scope: 'workspace',
    });
    expect(body.rows.find((row) => row.path === 'scratch')?.scope).toBe('private');
  });

  it('lists and serves artifacts from readable non-active public channels', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    const otherPath = `shared/channels/${fx.otherChannelId}/other.md`;
    await commit(sid, otherPath, 'other channel body');

    const listing = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/files?dir=${encodeURIComponent('shared/channels')}`,
      headers: { cookie },
    });

    expect(listing.statusCode).toBe(200);
    const listBody = listing.json() as {
      activePrefix: string;
      readableRoots: Array<{ prefix: string; writable: boolean }>;
      rows: Array<{ path: string; canonicalPath?: string; displayPath?: string; scope?: string }>;
    };
    expect(listBody.activePrefix).toBe(`shared/channels/${fx.channelId}`);
    expect(listBody.readableRoots.map((root) => root.prefix)).toContain(`shared/channels/${fx.otherChannelId}`);
    expect(listBody.rows.map((row) => row.path)).toContain(`shared/channels/${fx.otherChannelId}`);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/by-path?path=${encodeURIComponent(otherPath)}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers['x-artifact-canonical-path']).toBe(otherPath);
    expect(res.headers['x-artifact-display-path']).toBe(otherPath);
  });

  it('keeps the internal raw path able to read a scratch artifact', async () => {
    await ensureBucket();
    const sid = await session();
    const path = `scratch/${sid}/secret.md`;
    const cap = await app.inject({
      method: 'POST',
      url: `/api/internal/sessions/${sid}/artifacts/capture?path=${encodeURIComponent(path)}`,
      headers: { 'x-api-key': KEY, 'content-type': 'text/markdown' },
      payload: 'private notes',
    });
    expect(cap.statusCode).toBe(200);

    const raw = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/artifacts/raw?path=${encodeURIComponent(path)}`,
      headers: { 'x-api-key': KEY },
    });

    expect(raw.statusCode).toBe(200);
    expect(raw.body).toBe('private notes');
  });
});
