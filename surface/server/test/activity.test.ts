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
      sessionTitle: 'activity test',
      sessionStatus: 'running',
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

  it('classifies failed completion and crash rows without duplicating terminal failures', async () => {
    const bob = await login('bob', 'Bob');
    const terminalSessionId = await createActivitySession(bob.user.id, 'terminal failure', 'failed');
    const duplicateStatus = await insertSessionEventFor(terminalSessionId, bob.user.id, 'session.status_changed', {
      status: 'failed',
    });
    const terminalCompleted = await insertSessionEventFor(terminalSessionId, bob.user.id, 'session.completed', {
      status: 'failed',
      resultExcerpt: '',
    });
    const excerptSessionId = await createActivitySession(bob.user.id, 'failure with excerpt', 'failed');
    const failedWithExcerpt = await insertSessionEventFor(excerptSessionId, bob.user.id, 'session.completed', {
      status: 'failed',
      resultExcerpt: 'The provider timed out.',
    });
    const crashedSessionId = await createActivitySession(bob.user.id, 'crashed run', 'failed');
    const crash = await insertSessionEventFor(crashedSessionId, bob.user.id, 'session.status_changed', {
      status: 'failed',
    });

    const body = await activity(bob.cookie);

    expect(body.items.map((item: any) => [item.kind, Number(item.eventId)])).toEqual([
      ['session_failed', crash],
      ['session_failed', failedWithExcerpt],
      ['session_failed', terminalCompleted],
    ]);
    expect(body.items.map((item: any) => Number(item.eventId))).not.toContain(duplicateStatus);
    expect(body.items.find((item: any) => Number(item.eventId) === terminalCompleted)).toMatchObject({
      snippet: 'No result — the run ended with an error.',
      sessionTitle: 'terminal failure',
      sessionStatus: 'failed',
    });
    expect(body.items.find((item: any) => Number(item.eventId) === crash)).toMatchObject({
      snippet: 'The run crashed before finishing.',
      sessionTitle: 'crashed run',
      sessionStatus: 'failed',
    });
    expect(body.items.find((item: any) => Number(item.eventId) === failedWithExcerpt)).toMatchObject({
      snippet: 'The provider timed out.',
    });
  });

  it('returns auth blocks and marks truncated snippets with an ellipsis', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    const authSessionId = await createActivitySession(bob.user.id, 'provider reconnect', 'queued');
    const auth = await insertSessionEventFor(authSessionId, bob.user.id, 'session.provider_auth_required', {
      provider: 'claude',
      reason: 'invalid_token',
    });
    const longText = `@bob ${'x'.repeat(160)}`;
    const mention = await post(alice.cookie, fx.channelId, longText);

    const body = await activity(bob.cookie);

    expect(body.items.find((item: any) => Number(item.eventId) === auth)).toMatchObject({
      kind: 'agent_auth',
      snippet: 'Blocked until you reconnect claude.',
      sessionTitle: 'provider reconnect',
      sessionStatus: 'queued',
    });
    expect(body.items.find((item: any) => Number(item.eventId) === mention.id)).toMatchObject({
      kind: 'mention',
      snippet: `${longText.slice(0, 139)}…`,
    });
  });

  it('returns thread replies to thread participants and leaves mentioned replies to the mention feed', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    const cara = await login('cara', 'Cara');
    const dave = await login('dave', 'Dave');
    const root = await post(alice.cookie, fx.channelId, 'thread root');
    await post(bob.cookie, fx.channelId, 'earlier reply', root.id);
    const reply = await post(cara.cookie, fx.channelId, 'ordinary thread reply', root.id);
    const mentionedReply = await post(cara.cookie, fx.channelId, 'thread ping @bob', root.id);
    const dm = await createDm(alice.cookie, bob.user.id);
    const dmRoot = await post(alice.cookie, dm.id, 'DM thread root');
    const dmReply = await post(bob.cookie, dm.id, 'DM thread reply', dmRoot.id);

    const aliceItems = (await activity(alice.cookie)).items;
    const bobItems = (await activity(bob.cookie)).items;
    const daveItems = (await activity(dave.cookie)).items;

    expect(aliceItems.find((item: any) => Number(item.eventId) === reply.id)).toMatchObject({
      kind: 'thread_reply',
      snippet: 'ordinary thread reply',
      actorId: cara.user.id,
    });
    expect(bobItems.find((item: any) => Number(item.eventId) === reply.id)).toMatchObject({
      kind: 'thread_reply',
    });
    expect(bobItems.filter((item: any) => Number(item.eventId) === mentionedReply.id)).toEqual([
      expect.objectContaining({ kind: 'mention' }),
    ]);
    expect(aliceItems.filter((item: any) => Number(item.eventId) === dmReply.id)).toEqual([
      expect.objectContaining({ kind: 'thread_reply' }),
    ]);
    expect(daveItems.map((item: any) => Number(item.eventId))).not.toContain(reply.id);
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

async function post(cookie: string, channelId: string, text: string, threadRootEventId?: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { cookie },
    payload: { channelId, text, clientMsgId: randomUUID(), ...(threadRootEventId ? { threadRootEventId } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return res.json().event as { id: number; channelId: string };
}

async function insertSessionEvent(userId: string, type: string, payload: Record<string, unknown>): Promise<number> {
  const sessionId = await createActivitySession(userId);
  return insertSessionEventFor(sessionId, userId, type, payload);
}

async function createActivitySession(userId: string, title = 'activity test', status = 'running'): Promise<string> {
  const session = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by, driver_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING id`,
    [fx.workspaceId, fx.channelId, `test:${randomUUID()}`, title, status, userId],
  );
  return session.rows[0]!.id;
}

async function insertSessionEventFor(
  sessionId: string,
  userId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const event = await pool.query<{ id: number }>(
    `INSERT INTO events (workspace_id, channel_id, type, actor_id, payload)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [fx.workspaceId, fx.channelId, type, userId, JSON.stringify({ ...payload, sessionId })],
  );
  return event.rows[0]!.id;
}
