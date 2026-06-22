import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from './app.js';
import { createChannel } from './events.js';
import { WsHub } from './hub.js';
import { searchSessionRecords } from './session-search.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from '../test/helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>> | null = null;

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  fx = await seedFixture(pool);
});

afterEach(async () => {
  await app?.close();
  app = null;
});

async function startApp() {
  app = await buildApp({
    pool,
    hub: new WsHub(),
    calls: false,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
  return app;
}

async function login(handle: string, displayName = handle): Promise<string> {
  const res = await app!.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  expect(res.statusCode).toBe(200);
  return res.headers['set-cookie'] as string;
}

async function insertUser(handle: string, displayName = handle): Promise<string> {
  const res = await pool.query<{ id: string }>(
    'INSERT INTO users (handle, display_name) VALUES ($1, $2) RETURNING id',
    [handle, displayName],
  );
  return res.rows[0]!.id;
}

async function insertSession(args: {
  channelId?: string;
  workspaceId?: string;
  spawnedBy?: string;
  title?: string;
}): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sessions
       (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by)
     VALUES ($1, $2, $3, 'codex', $4, 'completed', $5)
     RETURNING id`,
    [
      args.workspaceId ?? fx.workspaceId,
      args.channelId ?? fx.channelId,
      `test:${randomUUID()}`,
      args.title ?? 'Sprocket session',
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
  ts: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO session_records
       (session_id, event_id, seq, kind, actor, driver, view_tier, text, meta, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}', $9)`,
    [
      args.sessionId,
      args.eventId ?? args.seq + 1,
      args.seq,
      args.kind,
      args.actor ?? 'agent',
      args.driver ?? 'codex',
      args.viewTier,
      args.text,
      args.ts,
    ],
  );
}

async function seedSprocketSession(): Promise<string> {
  const sessionId = await insertSession({ title: 'Repair sprocket index' });
  await insertRecord({
    sessionId,
    seq: 0,
    kind: 'message',
    actor: 'user',
    viewTier: 'lean',
    text: 'Older sprocket note from the user.',
    ts: '2026-01-01T00:00:00.000Z',
  });
  await insertRecord({
    sessionId,
    seq: 1,
    kind: 'reasoning',
    viewTier: 'full',
    text: 'Hidden sprocket reasoning for full transcript search.',
    ts: '2026-01-02T00:00:00.000Z',
  });
  await insertRecord({
    sessionId,
    seq: 2,
    kind: 'command',
    viewTier: 'lean',
    text: 'Newest sprocket command output.',
    ts: '2026-01-03T00:00:00.000Z',
  });
  return sessionId;
}

describe('searchSessionRecords', () => {
  it('returns matching lean session records newest first with session and channel metadata', async () => {
    const sessionId = await seedSprocketSession();

    const results = await searchSessionRecords(pool, {
      query: 'sprocket',
      userId: fx.userId,
    });

    expect(results.map((hit) => hit.kind)).toEqual(['command', 'message']);
    expect(results[0]).toMatchObject({
      sessionId,
      sessionTitle: 'Repair sprocket index',
      channelId: fx.channelId,
      channelName: 'general',
      eventId: 3,
      seq: 2,
      kind: 'command',
      actor: 'agent',
      driver: 'codex',
      viewTier: 'lean',
      excerpt: 'Newest sprocket command output.',
      ts: '2026-01-03T00:00:00.000Z',
    });
  });

  it('includes full-only records when requested', async () => {
    await seedSprocketSession();

    const results = await searchSessionRecords(pool, {
      query: 'sprocket',
      userId: fx.userId,
      full: true,
    });

    expect(results.map((hit) => hit.kind)).toEqual(['command', 'reasoning', 'message']);
  });

  it('filters matches by record kind', async () => {
    await seedSprocketSession();

    const results = await searchSessionRecords(pool, {
      query: 'sprocket',
      userId: fx.userId,
      kinds: ['message'],
      full: true,
    });

    expect(results.map((hit) => hit.kind)).toEqual(['message']);
  });

  it('does not show private session records to a non-owner', async () => {
    const { channel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: 'secret',
      actorId: fx.userId,
      private: true,
    });
    const sessionId = await insertSession({
      channelId: channel.id,
      workspaceId: fx.workspaceId,
      spawnedBy: fx.userId,
      title: 'Private sprocket session',
    });
    await insertRecord({
      sessionId,
      seq: 0,
      kind: 'message',
      actor: 'user',
      viewTier: 'lean',
      text: 'Private sprocket finding.',
      ts: '2026-01-04T00:00:00.000Z',
    });
    const bobId = await insertUser('bob', 'Bob');

    await expect(
      searchSessionRecords(pool, { query: 'sprocket', userId: bobId }),
    ).resolves.toEqual([]);
    await expect(
      searchSessionRecords(pool, { query: 'sprocket', userId: fx.userId }),
    ).resolves.toHaveLength(1);
  });
});

describe('GET /api/search/sessions', () => {
  it('rejects short queries with bad_query', async () => {
    const current = await startApp();
    const cookie = await login('alice', 'Alice');

    const res = await current.inject({
      method: 'GET',
      url: '/api/search/sessions?q=a',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'bad_query',
      message: 'query must be at least 2 chars',
    });
  });
});
