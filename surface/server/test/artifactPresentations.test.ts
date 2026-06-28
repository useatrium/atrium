import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { ArtifactLedger, casBlobKey } from '../src/artifact-ledger.js';
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

async function loginCookie(): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
  await addWorkspaceMember(pool, fx.workspaceId, login.json().user.id);
  return login.headers['set-cookie'] as string;
}

async function session(channelId = fx.channelId, spawnedBy = fx.userId): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by, driver_id, current_execution_id)
     VALUES ($1, $2, $3, 'claude-code', 'presentations-route-test', 'running', $4, $4, 'exec-1') RETURNING id`,
    [fx.workspaceId, channelId, `thread-${randomUUID()}`, spawnedBy],
  );
  return r.rows[0]!.id;
}

async function commitArtifact(sessionId: string, path: string, bytes: string, mime = 'text/html') {
  const sessionRow = await pool.query<{ channel_id: string }>('SELECT channel_id FROM sessions WHERE id = $1', [sessionId]);
  const payload = Buffer.from(bytes);
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
  await ledger.commitVersion({
    sessionId,
    channelId: sessionRow.rows[0]!.channel_id,
    path,
    blobSha: sha,
    sizeBytes: payload.byteLength,
    mime,
    author: `agent:${sessionId}`,
    kind: 'created',
  });
}

async function deleteArtifact(sessionId: string, path: string) {
  const sessionRow = await pool.query<{ channel_id: string }>('SELECT channel_id FROM sessions WHERE id = $1', [sessionId]);
  await ledger.commitVersion({
    sessionId,
    channelId: sessionRow.rows[0]!.channel_id,
    path,
    blobSha: null,
    sizeBytes: 0,
    mime: 'text/html',
    author: `agent:${sessionId}`,
    kind: 'deleted',
  });
}

describe('artifact presentations route', () => {
  it('returns presentations from shared app manifests', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    await commitArtifact(sid, 'shared/apps/demo/index.html', '<h1>Demo</h1>');
    await commitArtifact(
      sid,
      'shared/apps/demo/atrium.app.json',
      JSON.stringify({
        title: 'Demo',
        entry: 'index.html',
        renderer: 'html-app',
        description: 'Demo app',
      }),
      'application/json',
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/presentations`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      presentations: [
        {
          id: 'artifact-presented:shared/apps/demo/index.html',
          presentationId: expect.any(String),
          version: 1,
          appSlug: 'demo',
          path: 'shared/apps/demo/index.html',
          title: 'Demo',
          renderer: 'html-app',
          description: 'Demo app',
          previewUrl: 'index.html?preview=1',
          previewSizePolicy: expect.objectContaining({ enabled: true, defaultSize: 'card' }),
          statePolicy: { mode: 'isolated' },
          executionId: null,
          sourceEventIds: [],
        },
      ],
    });
    const persisted = await pool.query<{ version: number; app_slug: string }>(
      'SELECT version, app_slug FROM app_presentations WHERE session_id = $1',
      [sid],
    );
    expect(persisted.rows).toEqual([{ version: 1, app_slug: 'demo' }]);

    const preview = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/preview?path=${encodeURIComponent('shared/apps/demo/index.html')}`,
      headers: { cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['x-artifact-scope']).toBe('workspace');
    expect(preview.body).toBe('<h1>Demo</h1>');
  });

  it('auto-detects an app dir with no manifest (defaults: title=slug, renderer by extension)', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    await commitArtifact(sid, 'shared/apps/plain/index.html', '<h1>Plain</h1>');

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/presentations`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      presentations: [
        {
          id: 'artifact-presented:shared/apps/plain/index.html',
          presentationId: expect.any(String),
          version: 1,
          appSlug: 'plain',
          path: 'shared/apps/plain/index.html',
          title: 'plain',
          renderer: 'html-app',
          description: null,
          previewUrl: 'index.html?preview=1',
          previewSizePolicy: expect.objectContaining({ enabled: true }),
          statePolicy: { mode: 'isolated' },
          executionId: null,
          sourceEventIds: [],
        },
      ],
    });
  });

  it('still presents an app dir whose manifest is malformed (falls back to defaults)', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    await commitArtifact(sid, 'shared/apps/bad/index.html', '<h1>Bad</h1>');
    await commitArtifact(sid, 'shared/apps/bad/atrium.app.json', '{bad json', 'application/json');

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/presentations`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      presentations: [
        {
          id: 'artifact-presented:shared/apps/bad/index.html',
          presentationId: expect.any(String),
          version: 1,
          appSlug: 'bad',
          path: 'shared/apps/bad/index.html',
          title: 'bad',
          renderer: 'html-app',
          description: null,
          previewUrl: 'index.html?preview=1',
          previewSizePolicy: expect.objectContaining({ enabled: true }),
          statePolicy: { mode: 'isolated' },
          executionId: null,
          sourceEventIds: [],
        },
      ],
    });
  });

  it('does not present an app dir with no entry file (manifest only)', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    // a manifest but no index.html (or other entry) → nothing to preview, skip.
    await commitArtifact(sid, 'shared/apps/empty/atrium.app.json', JSON.stringify({ title: 'Empty' }), 'application/json');

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/presentations`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ presentations: [] });
  });

  it('does not return app manifests from unreadable channels', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    const bobId = await seedMember(pool, fx.workspaceId, `bob-${randomUUID().slice(0, 8)}`, 'Bob');
    const { channel: privateChannel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: `private-${randomUUID().slice(0, 8)}`,
      actorId: bobId,
      private: true,
    });
    const privateSid = await session(privateChannel.id, bobId);
    await commitArtifact(privateSid, `shared/channels/${privateChannel.id}/apps/demo/index.html`, '<h1>Secret</h1>');
    await commitArtifact(
      privateSid,
      `shared/channels/${privateChannel.id}/apps/demo/atrium.app.json`,
      JSON.stringify({ title: 'Secret' }),
      'application/json',
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/presentations`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ presentations: [] });
  });

  it('defaults manifest entry to index.html', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    await commitArtifact(sid, 'shared/apps/defaulted/index.html', '<h1>Default</h1>');
    await commitArtifact(sid, 'shared/apps/defaulted/atrium.app.json', JSON.stringify({ title: 'Default' }), 'application/json');

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/presentations`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      presentations: [
        {
          id: 'artifact-presented:shared/apps/defaulted/index.html',
          presentationId: expect.any(String),
          version: 1,
          appSlug: 'defaulted',
          path: 'shared/apps/defaulted/index.html',
          title: 'Default',
          renderer: 'html-app',
          description: null,
          previewUrl: 'index.html?preview=1',
          previewSizePolicy: expect.objectContaining({ enabled: true }),
          statePolicy: { mode: 'isolated' },
          executionId: null,
          sourceEventIds: [],
        },
      ],
    });
  });

  it('creates a new presentation version when the entry snapshot changes', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    await commitArtifact(sid, 'shared/apps/versioned/index.html', '<h1>v1</h1>');

    const first = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/presentations`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().presentations[0]).toMatchObject({ appSlug: 'versioned', version: 1 });

    const secondRead = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/presentations`,
      headers: { cookie },
    });
    expect(secondRead.json().presentations[0]).toMatchObject({ appSlug: 'versioned', version: 1 });

    await commitArtifact(sid, 'shared/apps/versioned/index.html', '<h1>v2</h1>');
    const secondVersion = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/presentations`,
      headers: { cookie },
    });

    expect(secondVersion.statusCode).toBe(200);
    expect(secondVersion.json().presentations[0]).toMatchObject({ appSlug: 'versioned', version: 2 });
    const persisted = await pool.query<{ version: number }>(
      'SELECT version FROM app_presentations WHERE session_id = $1 ORDER BY version',
      [sid],
    );
    expect(persisted.rows).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('honors a manifest preview url that points to a captured sibling file', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    await commitArtifact(sid, 'shared/apps/custom/index.html', '<h1>Full app</h1>');
    await commitArtifact(sid, 'shared/apps/custom/preview.html', '<h1>Preview app</h1>');
    await commitArtifact(
      sid,
      'shared/apps/custom/atrium.app.json',
      JSON.stringify({
        title: 'Custom Preview',
        preview: { url: 'preview.html?preview=1' },
      }),
      'application/json',
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/presentations`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().presentations[0]).toMatchObject({
      path: 'shared/apps/custom/index.html',
      previewUrl: 'preview.html?preview=1',
    });

    const preview = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/preview?path=${encodeURIComponent('shared/apps/custom/preview.html')}&preview=1`,
      headers: { cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toBe('<h1>Preview app</h1>');
  });

  it('deactivates a presentation when the entry file is deleted', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    await commitArtifact(sid, 'shared/apps/gone/index.html', '<h1>Gone</h1>');

    const first = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/presentations`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().presentations).toHaveLength(1);

    await deleteArtifact(sid, 'shared/apps/gone/index.html');
    const afterDelete = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/presentations`,
      headers: { cookie },
    });

    expect(afterDelete.statusCode).toBe(200);
    expect(afterDelete.json()).toEqual({ presentations: [] });
    const rows = await pool.query<{ status: string }>(
      'SELECT status FROM app_presentations WHERE session_id = $1 AND app_slug = $2',
      [sid, 'gone'],
    );
    expect(rows.rows).toEqual([{ status: 'inactive' }]);
  });
});
