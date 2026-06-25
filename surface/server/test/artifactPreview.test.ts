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
     VALUES ($1, $2, $3, 'claude-code', 'preview-route-test', 'running', $4, $4, 'exec-1') RETURNING id`,
    [fx.workspaceId, channelId, `thread-${randomUUID()}`, spawnedBy],
  );
  return r.rows[0]!.id;
}

async function commitArtifact(sessionId: string, path: string, bytes: string, mime: string, channelId = fx.channelId) {
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
    channelId,
    path,
    blobSha: sha,
    sizeBytes: payload.byteLength,
    mime,
    author: `agent:${sessionId}`,
    kind: 'created',
  });
}

describe('artifact preview route', () => {
  it('returns 400 when path is missing', async () => {
    const cookie = await loginCookie();
    const sid = await session();

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/preview`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'bad_query', message: 'path is required' });
  });

  it('returns an html artifact inline with preview security headers', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    const source = '<!doctype html><html><body><h1>Preview</h1></body></html>';
    await commitArtifact(sid, 'shared/global/preview.html', source, 'text/html');

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/preview?path=${encodeURIComponent('shared/global/preview.html')}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe('inline; filename="preview.html"');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(res.body).toBe(source);
  });

  it('wraps a jsx artifact in the react preview scaffold', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    const source = 'export default function App() { return <main>JSX Preview</main>; }';
    await commitArtifact(sid, 'shared/global/widget.jsx', source, 'text/plain');

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/preview?path=${encodeURIComponent('shared/global/widget.jsx')}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html; charset=utf-8');
    expect(res.body).toContain('ReactDOM');
    expect(res.body).toContain('Babel.transform');
    expect(res.body).toContain('JSX Preview');
    // The scaffold runs Babel inside `new Function`, so it MUST use the classic
    // JSX runtime (React.createElement). The automatic runtime injects an
    // `import` statement that throws there — verified broken in a real browser.
    expect(res.body).toContain("runtime: 'classic'");
  });

  it('returns 404 for an artifact path outside readable roots', async () => {
    const cookie = await loginCookie();
    const sid = await session();
    const bobId = await seedMember(pool, fx.workspaceId, `bob-${randomUUID().slice(0, 8)}`, 'Bob');
    const { channel: privateChannel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: `private-${randomUUID().slice(0, 8)}`,
      actorId: bobId,
      private: true,
    });
    const path = `shared/channels/${privateChannel.id}/secret.html`;

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sid}/artifacts/preview?path=${encodeURIComponent(path)}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'artifact_not_found', message: 'artifact not found' });
  });
});
