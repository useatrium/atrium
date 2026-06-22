import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppDeps } from './app.js';
import type { Fixture } from '../test/helpers.js';

const KEY = 'atrium-internal-test-key';
const oldKey = process.env.ARTIFACT_CAPTURE_API_KEY;

let pool: pg.Pool;
let fx: Fixture;
let app: FastifyInstance;
let buildApp: (deps: AppDeps) => Promise<FastifyInstance>;
let createTestPool: typeof import('../test/helpers.js').createTestPool;
let seedFixture: typeof import('../test/helpers.js').seedFixture;
let truncateAll: typeof import('../test/helpers.js').truncateAll;
let createChannel: typeof import('./events.js').createChannel;
let emitSessionRecordChange: typeof import('./session-record-changefeed.js').emitSessionRecordChange;

beforeAll(async () => {
  process.env.ARTIFACT_CAPTURE_API_KEY = KEY;
  vi.resetModules();
  ({ createTestPool, seedFixture, truncateAll } = await import('../test/helpers.js'));
  ({ buildApp } = await import('./app.js'));
  ({ createChannel } = await import('./events.js'));
  ({ emitSessionRecordChange } = await import('./session-record-changefeed.js'));
  pool = await createTestPool();
});

afterAll(async () => {
  if (pool) await pool.end();
  if (oldKey == null) {
    delete process.env.ARTIFACT_CAPTURE_API_KEY;
  } else {
    process.env.ARTIFACT_CAPTURE_API_KEY = oldKey;
  }
});

beforeEach(async () => {
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({
    pool,
    calls: false,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function insertUser(handle: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    'INSERT INTO users (handle, display_name) VALUES ($1, $2) RETURNING id',
    [handle, handle],
  );
  return res.rows[0]!.id;
}

async function insertSession(args: {
  channelId?: string;
  workspaceId?: string;
  spawnedBy?: string;
  title?: string;
} = {}): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sessions
       (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by)
     VALUES ($1, $2, $3, 'codex', $4, 'completed', $5)
     RETURNING id`,
    [
      args.workspaceId ?? fx.workspaceId,
      args.channelId ?? fx.channelId,
      `atrium-internal:${randomUUID()}`,
      args.title ?? 'Atrium internal session',
      args.spawnedBy ?? fx.userId,
    ],
  );
  return res.rows[0]!.id;
}

async function insertRecord(args: {
  sessionId: string;
  seq: number;
  eventId?: number;
  kind: string;
  actor?: string;
  driver?: string | null;
  viewTier: 'lean' | 'full';
  text: string;
  meta?: Record<string, unknown>;
  ts?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO session_records
       (session_id, event_id, seq, kind, actor, driver, view_tier, text, meta, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz)`,
    [
      args.sessionId,
      args.eventId ?? args.seq + 1,
      args.seq,
      args.kind,
      args.actor ?? 'agent',
      args.driver ?? 'codex',
      args.viewTier,
      args.text,
      JSON.stringify(args.meta ?? {}),
      args.ts ?? `2026-01-01T00:00:0${args.seq}.000Z`,
    ],
  );
}

async function seedViewerAndTarget(): Promise<{ viewerId: string; targetId: string }> {
  const viewerId = await insertSession({ title: 'Viewer node session' });
  const targetId = await insertSession({ title: 'Target projected session' });
  await insertRecord({
    sessionId: targetId,
    seq: 0,
    kind: 'message',
    actor: 'user',
    viewTier: 'lean',
    text: 'Please repair the sprocket index.',
  });
  await insertRecord({
    sessionId: targetId,
    seq: 1,
    kind: 'reasoning',
    actor: 'agent',
    viewTier: 'full',
    text: 'Full-tier reasoning detail for node projection.',
  });
  await insertRecord({
    sessionId: targetId,
    seq: 2,
    kind: 'command',
    actor: 'agent',
    viewTier: 'lean',
    text: '$ pnpm test\nall good',
  });
  return { viewerId, targetId };
}

describe('internal /atrium node-facing routes', () => {
  it('requires x-api-key', async () => {
    const { viewerId, targetId } = await seedViewerAndTarget();

    const missing = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/changes`,
    });
    expect(missing.statusCode).toBe(401);

    const wrong = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/transcript`,
      headers: { 'x-api-key': 'wrong-key' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('returns session-record changes scoped to the viewer user and resumes by cursor', async () => {
    const { viewerId, targetId } = await seedViewerAndTarget();
    await emitSessionRecordChange(pool, targetId, 3);

    const first = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/changes?limit=1`,
      headers: { 'x-api-key': KEY },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{
      rows: { sessionId: string; cursor: { xid: string; id: string } }[];
      next_cursor: string;
    }>();
    expect(firstBody.rows).toHaveLength(1);
    expect(firstBody.rows[0]!.sessionId).toBe(targetId);
    expect(firstBody.next_cursor).toBe(
      `${firstBody.rows[0]!.cursor.xid}.${firstBody.rows[0]!.cursor.id}`,
    );

    const second = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/changes?since=${firstBody.next_cursor}&limit=1`,
      headers: { 'x-api-key': KEY },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ rows: [], next_cursor: firstBody.next_cursor });
  });

  it('serves lean transcript and full transcript with the P3 renderers', async () => {
    const { viewerId, targetId } = await seedViewerAndTarget();

    const transcript = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/transcript`,
      headers: { 'x-api-key': KEY },
    });
    expect(transcript.statusCode).toBe(200);
    expect(transcript.headers['content-type']).toContain('text/markdown');
    expect(transcript.body).toContain('# Transcript');
    expect(transcript.body).toContain('Please repair the sprocket index.');
    expect(transcript.body).not.toContain('Full-tier reasoning detail');

    const full = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/full`,
      headers: { 'x-api-key': KEY },
    });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toContain('text/markdown');
    expect(full.body).toContain('# Full Transcript');
    expect(full.body).toContain('Full-tier reasoning detail for node projection.');
  });

  it('404s for a private target the viewer user cannot access', async () => {
    const viewerId = await insertSession({ title: 'Viewer node session' });
    const ownerId = await insertUser('private-owner');
    const { channel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: 'private-node-projection',
      actorId: ownerId,
      private: true,
    });
    const targetId = await insertSession({
      channelId: channel.id,
      workspaceId: fx.workspaceId,
      spawnedBy: ownerId,
      title: 'Private target',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewerId}/atrium/sessions/${targetId}/transcript`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'session_not_found' });
  });
});
