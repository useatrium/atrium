import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import type { WsHub } from '../src/hub.js';
import { emitSessionRecordChange } from '../src/session-record-changefeed.js';
import { registerInternalChangesRoutes } from '../src/routes/internal-changes.js';
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

const KEY = 'internal-changes-test-key';
const SHA = 'a'.repeat(64);

type TestApp = Awaited<ReturnType<typeof buildApp>>;
type TestSession = { id: string; key: string };
type SseFrame = { event?: string; data?: string; comment?: string };

let pool: pg.Pool;
let fx: Fixture;
let app: TestApp;

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
    artifactCaptureApiKey: KEY,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function session(harness = 'codex'): Promise<TestSession> {
  const key = `tk-${randomUUID()}`;
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by)
     VALUES ($1, $2, $3, $4, 'internal changes test', 'running', $5)
     RETURNING id`,
    [fx.workspaceId, fx.channelId, key, harness, fx.userId],
  );
  return { id: res.rows[0]!.id, key };
}

async function captureArtifact(s: TestSession, name = 'a.md'): Promise<void> {
  const path = `shared/channels/${fx.channelId}/${name}`;
  const res = await app.inject({
    method: 'POST',
    url: `/api/internal/sessions/${s.key}/artifacts/capture?path=${encodeURIComponent(path)}`,
    headers: { 'x-api-key': KEY, 'content-type': 'text/markdown' },
    payload: `content for ${name}`,
  });
  expect(res.statusCode).toBe(200);
}

async function loginCookie(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.headers['set-cookie'];
  return Array.isArray(cookie) ? cookie[0]! : String(cookie);
}

async function bindProfileWithBundle(s: TestSession): Promise<void> {
  const ingest = await app.inject({
    method: 'PUT',
    url: `/api/internal/sessions/${s.key}/profile-candidates?harness=codex`,
    headers: { 'x-api-key': KEY },
    payload: codexProposal(),
  });
  expect(ingest.statusCode).toBe(200);

  const save = await app.inject({
    method: 'POST',
    url: `/api/sessions/${s.id}/profile-change-proposals/${ingest.json().proposal.id}/save-new-profile`,
    headers: { cookie: await loginCookie() },
    payload: { name: `Team Codex ${randomUUID()}` },
  });
  expect(save.statusCode).toBe(200);
}

function codexProposal() {
  return {
    provider: 'codex',
    adapterVersion: 'centaur-test',
    sourceHashes: [{ path: '.codex/config.toml', sha256: SHA, sizeBytes: 100 }],
    manifest: {
      settings: { model: 'gpt-5' },
      bundles: [{ path: 'skills/review/SKILL.md', role: 'skill', sha256: SHA, sizeBytes: 44 }],
    },
  };
}

async function perSessionFeeds(s: TestSession) {
  const artifacts = await app.inject({
    method: 'GET',
    url: `/api/internal/sessions/${s.key}/artifacts/changes?since=0.0`,
    headers: { 'x-api-key': KEY },
  });
  const atrium = await app.inject({
    method: 'GET',
    url: `/api/internal/sessions/${s.key}/atrium/changes?since=0.0`,
    headers: { 'x-api-key': KEY },
  });
  const profileBundles = await app.inject({
    method: 'GET',
    url: `/api/internal/sessions/${s.key}/profile-bundles?harness=codex`,
    headers: { 'x-api-key': KEY },
  });
  expect(artifacts.statusCode).toBe(200);
  expect(atrium.statusCode).toBe(200);
  expect(profileBundles.statusCode).toBe(200);
  return {
    artifacts: artifacts.json(),
    atrium: atrium.json(),
    profileBundles: profileBundles.json(),
  };
}

describe('POST /api/internal/sessions/changes/batch', () => {
  it('fans in mixed known and unknown sessions with per-feed payload parity', async () => {
    const known = await session();
    await captureArtifact(known);
    await emitSessionRecordChange(pool, known.id, 1);
    await bindProfileWithBundle(known);
    const expected = await perSessionFeeds(known);

    const batch = await app.inject({
      method: 'POST',
      url: '/api/internal/sessions/changes/batch',
      headers: { 'x-api-key': KEY },
      payload: {
        sessions: [
          {
            key: known.key,
            artifactsSince: '0.0',
            atriumSince: '0.0',
            profileHarness: 'codex',
          },
          {
            key: 'cli:dead',
            artifactsSince: '0.0',
            atriumSince: '0.0',
            profileHarness: 'codex',
          },
        ],
      },
    });

    expect(batch.statusCode).toBe(200);
    expect(batch.json()).toEqual({
      sessions: [
        { key: known.key, found: true, ...expected },
        { key: 'cli:dead', found: false },
      ],
    });
  });

  it('requires internal auth and rejects oversized or empty batch bodies', async () => {
    const missingAuth = await app.inject({
      method: 'POST',
      url: '/api/internal/sessions/changes/batch',
      payload: { sessions: [] },
    });
    expect(missingAuth.statusCode).toBe(401);

    const empty = await app.inject({
      method: 'POST',
      url: '/api/internal/sessions/changes/batch',
      headers: { 'x-api-key': KEY },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/internal/sessions/changes/batch',
      headers: { 'x-api-key': KEY },
      payload: {
        sessions: Array.from({ length: 201 }, (_, index) => ({
          key: `cli:${index}`,
          artifactsSince: '0.0',
          atriumSince: '0.0',
          profileHarness: 'codex',
        })),
      },
    });
    expect(tooMany.statusCode).toBe(400);
  });
});

describe('GET /api/internal/changes/stream', () => {
  it('pushes artifact, atrium, and profile changed events with thread keys', async () => {
    const known = await session();
    const stream = await openSse(app);
    try {
      const hello = await stream.waitFor((frame) => frame.event === 'hello');
      expect(JSON.parse(hello.data!)).toEqual({ protocol: 1 });

      await captureArtifact(known, 'stream-artifact.md');
      const artifacts = await stream.waitForChanged('artifacts', known.key);

      await emitSessionRecordChange(pool, known.id, 1);
      const atrium = await stream.waitForChanged('atrium', known.key);

      await bindProfileWithBundle(known);
      const profile = await stream.waitForChanged('profile', known.key);

      expect(artifacts.workspaceId).toBe(fx.workspaceId);
      expect(atrium.workspaceId).toBe(fx.workspaceId);
      expect(profile.workspaceId).toBe(fx.workspaceId);
      expect([artifacts.seq, atrium.seq, profile.seq]).toEqual([
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
      ]);
      expect(artifacts.seq).toBeLessThan(atrium.seq);
      expect(atrium.seq).toBeLessThan(profile.seq);
    } finally {
      await stream.close();
    }
  });

  it('publishes debounced files.changed nudges for artifact notifications only', async () => {
    const known = await session();
    const publishToUsers = vi.fn();
    const hub = { publishToUsers } as unknown as WsHub;
    const streamApp = await buildStreamOnlyApp(15_000, hub);
    const stream = await openSse(streamApp);
    try {
      await stream.waitFor((frame) => frame.event === 'hello');

      await captureArtifact(known, 'hub-nudge.md');
      await stream.waitForChanged('artifacts', known.key);
      await vi.waitFor(() => expect(publishToUsers).toHaveBeenCalledTimes(1), { timeout: 3000 });

      const [userIds, event] = publishToUsers.mock.calls[0]!;
      expect(userIds).toContain(fx.userId);
      expect(event).toMatchObject({
        type: 'files.changed',
        workspaceId: fx.workspaceId,
        channelId: null,
        payload: { workspaceId: fx.workspaceId },
      });

      await bindProfileWithBundle(known);
      await stream.waitForChanged('profile', known.key);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(publishToUsers).toHaveBeenCalledTimes(1);
    } finally {
      await stream.close();
      await streamApp.close();
    }
  });

  it('emits heartbeat comments and closes subscriptions cleanly', async () => {
    const streamApp = await buildStreamOnlyApp(25);
    const stream = await openSse(streamApp);
    try {
      await stream.waitFor((frame) => frame.event === 'hello');
      const heartbeat = await stream.waitFor((frame) => frame.comment === 'keep-alive', 1000);
      expect(heartbeat.comment).toBe('keep-alive');
    } finally {
      await stream.close();
      await streamApp.close();
    }
  });
});

async function buildStreamOnlyApp(heartbeatMs: number, hub?: WsHub): Promise<FastifyInstance> {
  const streamApp = Fastify({ logger: { level: 'error' } });
  registerInternalChangesRoutes(streamApp, {
    pool,
    hub,
    heartbeatMs,
    requireCaptureKey(req, reply) {
      if (req.headers['x-api-key'] !== KEY) {
        reply.code(401).send({ error: 'unauthorized', message: 'x-api-key required' });
        return false;
      }
      return true;
    },
    async resolveInternalSessionRef(sessionRef) {
      const row = await pool.query<{ id: string; channel_id: string; workspace_id: string }>(
        `SELECT id, channel_id, workspace_id
           FROM sessions
          WHERE id::text = $1 OR centaur_thread_key = $1
          LIMIT 1`,
        [sessionRef],
      );
      const session = row.rows[0];
      return session
        ? { id: session.id, channelId: session.channel_id, workspaceId: session.workspace_id }
        : null;
    },
  });
  await streamApp.ready();
  return streamApp;
}

async function openSse(appToListen: FastifyInstance) {
  const address = await appToListen.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${address}/api/internal/changes/stream`, {
    headers: { 'x-api-key': KEY },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  if (!response.body) throw new Error('missing SSE body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = '';
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary < 0) break;
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseSseFrame(rawFrame);
        if (frame) frames.push(frame);
      }
    }
  })().catch(() => {});

  const waitFor = async (predicate: (frame: SseFrame) => boolean, timeoutMs = 3000): Promise<SseFrame> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = frames.find(predicate);
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for SSE frame; saw ${JSON.stringify(frames)}`);
  };

  return {
    waitFor,
    async waitForChanged(
      feed: string,
      key: string,
    ): Promise<{ feed: string; key: string; workspaceId?: string; seq: number }> {
      const frame = await waitFor((candidate) => {
        if (candidate.event !== 'changed' || !candidate.data) return false;
        const data = JSON.parse(candidate.data) as { feed?: string; key?: string };
        return data.feed === feed && data.key === key;
      });
      return JSON.parse(frame.data!) as { feed: string; key: string; workspaceId?: string; seq: number };
    },
    async close(): Promise<void> {
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

function parseSseFrame(rawFrame: string): SseFrame | null {
  if (rawFrame.length === 0) return null;
  const lines = rawFrame.split('\n');
  const comments: string[] = [];
  let event: string | undefined;
  const data: string[] = [];

  for (const line of lines) {
    if (line.startsWith(':')) {
      comments.push(line.slice(1).trimStart());
    } else if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trimStart();
    } else if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart());
    }
  }

  if (comments.length > 0 && !event && data.length === 0) return { comment: comments.join('\n') };
  return { event: event ?? 'message', data: data.join('\n') };
}
