import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { addWorkspaceMember } from '../src/membership.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

interface Login {
  cookie: string;
  user: { id: string; handle: string; displayName: string };
}

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

describe('/api/activity', () => {
  it('returns mentions, DMs, and spawned-session events newest first', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    const dm = await createDm(alice.cookie, bob.user.id);
    const mention = await post(alice.cookie, fx.channelId, 'hello @bob from the public channel');
    const direct = await post(alice.cookie, dm.id, 'direct hello');
    const question = await insertSessionEvent(bob.user.id, 'session.question_requested', {
      questions: [{ id: 'q1', header: 'Decision', question: 'Deploy now?' }],
    });
    const completed = await insertSessionEvent(bob.user.id, 'session.completed', {
      status: 'completed',
      resultExcerpt: 'Finished the requested change.',
    });

    const body = await activity(bob.cookie);

    expect(body.items.map((item: any) => [item.kind, Number(item.eventId)])).toEqual([
      ['session_completed', completed],
      ['agent_question', question],
      ['dm', direct.id],
      ['mention', mention.id],
    ]);
    expect(body.items[0]).toMatchObject({
      channelId: fx.channelId,
      channelName: 'general',
      actorId: bob.user.id,
      actorName: 'Bob',
      snippet: 'Finished the requested change.',
    });
    expect(body.items.find((item: any) => item.kind === 'agent_question')).toMatchObject({
      snippet: 'Deploy now?',
    });
    expect(body.items.find((item: any) => item.kind === 'mention')).toMatchObject({
      actorId: alice.user.id,
      actorName: 'Alice',
      snippet: 'hello @bob from the public channel',
    });

    const older = await activity(bob.cookie, String(question));
    expect(older.items.map((item: any) => item.kind)).toEqual(['dm', 'mention']);
    expect(body.nextCursor).toBeNull();
  });

  it('does not leak stale private-channel mentions after membership changes', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    const secret = await createPrivate(alice.cookie, 'secret');
    await addMember(alice.cookie, secret.id, bob.user.id);
    const mention = await post(alice.cookie, secret.id, 'private ping @bob');

    expect((await activity(bob.cookie)).items.map((item: any) => Number(item.eventId))).toContain(mention.id);

    await leaveChannel(bob.cookie, secret.id);
    expect((await activity(bob.cookie)).items.map((item: any) => Number(item.eventId))).not.toContain(mention.id);
  });
});

async function login(handle: string, displayName: string): Promise<Login> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  expect(res.statusCode).toBe(200);
  const user = res.json().user;
  await addWorkspaceMember(pool, fx.workspaceId, user.id);
  return { cookie: res.headers['set-cookie'] as string, user };
}

async function activity(cookie: string, cursor?: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/activity${cursor ? `?cursor=${cursor}` : ''}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function createDm(cookie: string, userId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/dms',
    headers: { cookie },
    payload: { userId },
  });
  expect(res.statusCode).toBe(201);
  return res.json().channel;
}

async function createPrivate(cookie: string, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/channels',
    headers: { cookie },
    payload: { name, private: true },
  });
  expect(res.statusCode).toBe(201);
  return res.json().channel;
}

async function addMember(cookie: string, channelId: string, userId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/channels/${channelId}/members`,
    headers: { cookie },
    payload: { userId },
  });
  expect(res.statusCode).toBe(201);
}

async function leaveChannel(cookie: string, channelId: string) {
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/channels/${channelId}/members/me`,
    headers: { cookie },
    payload: { opId: randomUUID() },
  });
  expect(res.statusCode).toBe(200);
}

async function post(cookie: string, channelId: string, text: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { cookie },
    payload: { channelId, text, clientMsgId: randomUUID() },
  });
  expect(res.statusCode).toBe(201);
  return res.json().event as { id: number; channelId: string };
}

async function insertSessionEvent(
  userId: string,
  type: 'session.question_requested' | 'session.completed',
  payload: Record<string, unknown>,
): Promise<number> {
  const session = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by, driver_id)
     VALUES ($1, $2, $3, 'activity test', 'running', $4, $4)
     RETURNING id`,
    [fx.workspaceId, fx.channelId, `test:${randomUUID()}`, userId],
  );
  const sessionId = session.rows[0]!.id;
  const event = await pool.query<{ id: number }>(
    `INSERT INTO events (workspace_id, channel_id, type, actor_id, payload)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [fx.workspaceId, fx.channelId, type, userId, JSON.stringify({ sessionId, ...payload })],
  );
  return event.rows[0]!.id;
}
