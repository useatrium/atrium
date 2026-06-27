import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { addWorkspaceMember } from '../src/membership.js';
import { createTestPool, seedFixture, type Fixture, truncateAll } from './helpers.js';

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
  copyObject: async () => {},
  deleteObject: async () => {},
  downloadObject: async () => {},
  ensureBucket: async () => {},
  getObjectBytes: mockedS3.storage.getObjectBytes,
  headObject: mockedS3.storage.headObject,
  presignGet: async () => 'https://storage.local/get',
  presignPut: async () => 'https://storage.local/put',
  uploadObject: mockedS3.storage.uploadObject,
  uploadObjectStream: async () => {},
}));

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
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
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
  expect(login.statusCode).toBe(200);
  await addWorkspaceMember(pool, fx.workspaceId, login.json().user.id);
  return login.headers['set-cookie'] as string;
}

async function insertSession(channelId = fx.channelId): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by, driver_id)
     VALUES ($1, $2, $3, 'claude-code', 'channel-writeback', 'running', $4, $4) RETURNING id`,
    [fx.workspaceId, channelId, `thread-${randomUUID()}`, fx.userId],
  );
  return res.rows[0]!.id;
}

async function artifactPathFor(sessionId: string): Promise<string | null> {
  const row = await pool.query<{ path: string }>('SELECT path FROM artifacts WHERE session_id = $1', [sessionId]);
  return row.rows[0]?.path ?? null;
}

describe('PUT /api/channels/:channelId/artifacts', () => {
  it('writes a channel artifact using query path before X-Artifact-Path', async () => {
    const cookie = await loginCookie();
    const sessionId = await insertSession();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/channels/${fx.channelId}/artifacts?session=${sessionId}&path=notes/query.md`,
      headers: {
        cookie,
        'content-type': 'text/markdown',
        'x-artifact-path': 'notes/header.md',
      },
      payload: 'from query path\n',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ seq: 1, status: 'normal' });
    expect(await artifactPathFor(sessionId)).toBe(`shared/channels/${fx.channelId}/notes/query.md`);
  });

  it('rejects a session from another channel before writing', async () => {
    const cookie = await loginCookie();
    const otherChannelSession = await insertSession(fx.otherChannelId);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/channels/${fx.channelId}/artifacts?session=${otherChannelSession}&path=notes/plan.md`,
      headers: { cookie, 'content-type': 'text/markdown' },
      payload: 'wrong channel\n',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'session_not_found', message: 'session not found' });
    expect(await artifactPathFor(otherChannelSession)).toBeNull();
  });

  it('rejects malformed base seq headers', async () => {
    const cookie = await loginCookie();
    const sessionId = await insertSession();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/channels/${fx.channelId}/artifacts?session=${sessionId}&path=notes/plan.md`,
      headers: {
        cookie,
        'content-type': 'text/markdown',
        'x-artifact-base-seq': 'not-a-number',
      },
      payload: 'bad base seq\n',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'bad_request',
      message: 'X-Artifact-Base-Seq must be a positive integer',
    });
    expect(await artifactPathFor(sessionId)).toBeNull();
  });

  it('returns the stale_base conflict envelope', async () => {
    const cookie = await loginCookie();
    const sessionId = await insertSession();
    const url = `/api/channels/${fx.channelId}/artifacts?session=${sessionId}&path=notes/plan.md`;

    const first = await app.inject({
      method: 'PUT',
      url,
      headers: { cookie, 'content-type': 'text/markdown' },
      payload: 'v1\n',
    });
    expect(first.statusCode).toBe(200);

    const stale = await app.inject({
      method: 'PUT',
      url,
      headers: {
        cookie,
        'content-type': 'text/markdown',
        'x-artifact-base-seq': '99',
      },
      payload: 'v2\n',
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'stale_base', baseSeq: 99, latestSeq: 1 });
  });
});
