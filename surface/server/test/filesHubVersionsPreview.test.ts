import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { ArtifactLedger, casBlobKey, type VersionKind } from '../src/artifact-ledger.js';
import { createChannel } from '../src/events.js';
import { addWorkspaceMember } from '../src/membership.js';
import { createTestPool, seedFixture, seedMember, truncateAll, type Fixture } from './helpers.js';

const mockedS3 = vi.hoisted(() => {
  class FakeStorage {
    readonly objects = new Map<string, { body: Buffer; contentType: string }>();

    reset(): void {
      this.objects.clear();
    }

    getObjectBytes = async (key: string): Promise<Buffer> => {
      const object = this.objects.get(key);
      if (!object) throw new Error(`missing object: ${key}`);
      return Buffer.from(object.body);
    };
  }

  return { storage: new FakeStorage() };
});

vi.mock('../src/s3.js', () => ({
  copyObject: async () => {},
  deleteObject: async () => {},
  downloadObject: async () => {},
  ensureBucket: async () => {},
  getObjectBytes: mockedS3.storage.getObjectBytes,
  getObjectStream: async () => {
    throw new Error('getObjectStream not implemented in this test');
  },
  headObject: async () => null,
  presignGet: async () => 'https://storage.local/get',
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
  mockedS3.storage.reset();
  await pool.query(
    'TRUNCATE artifact_changes, artifact_sync_state, cas_blobs, artifact_pointers, artifact_versions, artifacts CASCADE',
  );
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({
    pool,
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

async function loginCookie(handle = 'alice', displayName = 'Alice'): Promise<{ cookie: string; userId: string }> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  const userId = login.json().user.id;
  await addWorkspaceMember(pool, fx.workspaceId, userId);
  return { cookie: login.headers['set-cookie'] as string, userId };
}

async function session(channelId = fx.channelId, spawnedBy = fx.userId): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by, driver_id, current_execution_id)
     VALUES ($1, $2, $3, 'claude-code', 'files-hub-route-test', 'running', $4, $4, 'exec-1') RETURNING id`,
    [fx.workspaceId, channelId, `thread-${randomUUID()}`, spawnedBy],
  );
  return r.rows[0]!.id;
}

async function commitArtifact(params: {
  sessionId: string;
  channelId?: string;
  path: string;
  bytes: string;
  mime?: string;
  kind?: VersionKind;
  author?: string;
}): Promise<{ artifactId: string; seq: number; sizeBytes: number }> {
  const mime = params.mime ?? 'text/html';
  const payload = Buffer.from(params.bytes);
  const sha = createHash('sha256').update(payload).digest('hex');
  const s3Key = casBlobKey(sha);
  mockedS3.storage.objects.set(s3Key, { body: payload, contentType: mime });
  await pool.query(
    `INSERT INTO cas_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (sha256) DO UPDATE
           SET s3_key = COALESCE(cas_blobs.s3_key, EXCLUDED.s3_key)`,
    [sha, s3Key, payload.byteLength, mime],
  );
  const committed = await ledger.commitVersion({
    sessionId: params.sessionId,
    channelId: params.channelId ?? fx.channelId,
    path: params.path,
    blobSha: sha,
    sizeBytes: payload.byteLength,
    mime,
    author: params.author ?? `agent:${params.sessionId}`,
    kind: params.kind ?? 'created',
  });
  if (!committed.ok) throw new Error('unexpected stale commit');
  return { artifactId: committed.artifactId, seq: committed.seq, sizeBytes: payload.byteLength };
}

describe('Files Hub artifact versions and preview routes', () => {
  it('returns artifact versions newest-first for a reader', async () => {
    const { cookie } = await loginCookie();
    const sid = await session();
    const first = await commitArtifact({
      sessionId: sid,
      path: 'shared/global/versioned.html',
      bytes: '<h1>First</h1>',
      mime: 'text/html',
    });
    const second = await commitArtifact({
      sessionId: sid,
      path: 'shared/global/versioned.html',
      bytes: '<h1>Second</h1>',
      mime: 'text/html',
      kind: 'modified',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/files/${first.artifactId}/versions`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      versions: [
        {
          seq: second.seq,
          author: `agent:${sid}`,
          kind: 'modified',
          status: 'normal',
          createdAt: expect.any(String),
          sizeBytes: second.sizeBytes,
          mime: 'text/html',
          isLatest: true,
        },
        {
          seq: first.seq,
          author: `agent:${sid}`,
          kind: 'created',
          status: 'normal',
          createdAt: expect.any(String),
          sizeBytes: first.sizeBytes,
          mime: 'text/html',
          isLatest: false,
        },
      ],
    });
  });

  it('returns 404 for versions when the user cannot read the artifact', async () => {
    const { cookie } = await loginCookie();
    const bobId = await seedMember(pool, fx.workspaceId, `bob-${randomUUID().slice(0, 8)}`, 'Bob');
    const { channel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: `private-${randomUUID().slice(0, 8)}`,
      actorId: bobId,
      private: true,
    });
    const sid = await session(channel.id, bobId);
    const committed = await commitArtifact({
      sessionId: sid,
      channelId: channel.id,
      path: `shared/channels/${channel.id}/secret.html`,
      bytes: '<h1>Secret</h1>',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/files/${committed.artifactId}/versions`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'file_not_found', message: 'file not found' });
  });

  it('serves an artifactId preview with the shared preview security headers', async () => {
    const { cookie } = await loginCookie();
    const sid = await session();
    const source = '<!doctype html><html><body><h1>Hub Preview</h1></body></html>';
    const committed = await commitArtifact({
      sessionId: sid,
      path: 'shared/global/hub-preview.html',
      bytes: source,
      mime: 'text/html',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/files/${committed.artifactId}/preview`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe('inline; filename="hub-preview.html"');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(res.headers['x-artifact-scope']).toBe('workspace');
    expect(res.headers['x-artifact-canonical-path']).toBe('shared/global/hub-preview.html');
    expect(res.body).toBe(source);
  });
});
