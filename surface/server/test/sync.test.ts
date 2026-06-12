import { randomUUID } from 'node:crypto';
import { DEFAULT_PREFS } from '@atrium/surface-client/prefs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';
import { chaosSeed, SeededPrng } from './chaosHarness.js';

interface Login {
  cookie: string;
  user: { id: string; handle: string; displayName: string };
}

const SYNC_EVENT_TYPES = [
  'message.posted',
  'message.edited',
  'message.deleted',
  'reaction.added',
  'reaction.removed',
  'session.spawned',
  'session.status_changed',
  'session.completed',
  'session.seat_requested',
  'session.seat_changed',
  'session.question_requested',
  'session.question_answered',
  'session.question_resolved',
  'channel.created',
  'channel.member_joined',
  'channel.member_left',
];

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

describe('/api/sync', () => {
  it('preserves event continuity across random disconnect windows', async () => {
    const rng = new SeededPrng(chaosSeed() ^ 0x5eed_d00d);
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    const privateChannel = await createPrivate(alice.cookie, 'sync-secret');
    const posted: PostedMessage[] = [];
    let cursor = 0;
    const applied: number[] = [];
    const appliedSet = new Set<number>();

    const syncClient = async () => {
      for (;;) {
        const body = await sync(alice.cookie, cursor, 1000);
        expect(body.limited).toBe(false);
        for (const event of body.events) {
          expect(appliedSet.has(event.id)).toBe(false);
          appliedSet.add(event.id);
          applied.push(event.id);
        }
        cursor = Math.max(cursor, body.nextCursor);
        if (body.events.length < 1000) return;
      }
    };

    await syncClient();
    for (let round = 0; round < 30; round += 1) {
      const writes = 1 + rng.int(4);
      for (let i = 0; i < writes; i += 1) {
        const result = await randomVisibleMutation(rng, {
          alice,
          bob,
          privateChannelId: privateChannel.id,
          posted,
        });
        if (result) posted.push(result);
      }
      if (rng.int(3) === 0) await syncClient();
    }
    await syncClient();

    expect(applied).toHaveLength(appliedSet.size);
    expect([...appliedSet].sort((a, b) => a - b)).toEqual(await visibleEventIds(alice.user.id));
  });

  it('returns limited=true with no arbitrary event window, then resumes from nextCursor', async () => {
    const alice = await login('alice', 'Alice');
    const initial = await sync(alice.cookie, 0, 1000);
    let cursor = initial.nextCursor;

    for (let i = 0; i < 4; i += 1) {
      await post(alice.cookie, fx.channelId, `limited ${i}`);
    }
    const limited = await sync(alice.cookie, cursor, 3);
    expect(limited.limited).toBe(true);
    expect(limited.events).toEqual([]);
    expect(limited.nextCursor).toBeGreaterThan(cursor);

    cursor = limited.nextCursor;
    const subsequent = await post(alice.cookie, fx.channelId, 'after limited');
    const resumed = await sync(alice.cookie, cursor, 3);
    expect(resumed.limited).toBe(false);
    expect(resumed.events.map((event: any) => event.id)).toEqual([subsequent.id]);
  });

  it('applies channel visibility: private from join onward, public to all workspace users', async () => {
    const alice = await login('alice', 'Alice');
    const bob = await login('bob', 'Bob');
    const privateChannel = await createPrivate(alice.cookie, 'members-only');
    const beforeJoin = await post(alice.cookie, privateChannel.id, 'before join');
    const publicEvent = await post(alice.cookie, fx.channelId, 'public hello');

    let bobSync = await sync(bob.cookie, 0, 1000);
    expect(bobSync.events.map((event: any) => event.id)).toContain(publicEvent.id);
    expect(bobSync.events.map((event: any) => event.id)).not.toContain(beforeJoin.id);
    expect(bobSync.events.some((event: any) => event.type === 'channel.created' && event.channelId === privateChannel.id)).toBe(false);

    await addMember(alice.cookie, privateChannel.id, bob.user.id);
    const afterJoin = await post(alice.cookie, privateChannel.id, 'after join');
    bobSync = await sync(bob.cookie, 0, 1000);
    const privateEvents = bobSync.events.filter((event: any) => event.channelId === privateChannel.id);
    expect(privateEvents.map((event: any) => event.id)).not.toContain(beforeJoin.id);
    expect(privateEvents.map((event: any) => event.id)).toContain(afterJoin.id);
    expect(privateEvents.some((event: any) => event.type === 'channel.member_joined')).toBe(true);
    expect(privateEvents.some((event: any) => event.type === 'channel.created')).toBe(false);
  });

  it('ships read cursor, mutes, prefs, drafts, and channels in the state snapshot', async () => {
    const alice = await login('alice', 'Alice');
    const initial = await sync(alice.cookie, 0, 1000);
    const message = await post(alice.cookie, fx.channelId, 'read me');
    await markRead(alice.cookie, fx.channelId, message.id);
    await setMute(alice.cookie, fx.otherChannelId, true);
    await patchPrefs(alice.cookie, { theme: 'dark', accent: 'teal' });
    await putDraft(alice.cookie, `channel:${fx.channelId}`, 'draft text');
    await putDraft(alice.cookie, `channel:${fx.otherChannelId}`, 'stale draft');
    await putDraft(alice.cookie, `channel:${fx.otherChannelId}`, '');

    const healed = await sync(alice.cookie, initial.nextCursor, 1000);
    expect(healed.state.readCursors[fx.channelId]).toBe(message.id);
    expect(healed.state.mutes).toContain(fx.otherChannelId);
    expect(healed.state.prefs).toEqual({ ...DEFAULT_PREFS, theme: 'dark', accent: 'teal' });
    expect(healed.state.drafts[`channel:${fx.channelId}`]).toMatchObject({ text: 'draft text' });
    expect(healed.state.drafts).not.toHaveProperty(`channel:${fx.otherChannelId}`);
    expect(Date.parse(healed.state.draftDeletions[`channel:${fx.otherChannelId}`])).toBeGreaterThan(
      0,
    );
    expect(healed.state.channels.find((channel: any) => channel.id === fx.channelId)).toMatchObject({
      lastReadEventId: message.id,
    });
    expect(healed.state.channels.find((channel: any) => channel.id === fx.otherChannelId)).toMatchObject({
      muted: true,
    });
  });
});

async function login(handle: string, displayName: string): Promise<Login> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  expect(res.statusCode).toBe(200);
  return { cookie: res.headers['set-cookie'] as string, user: res.json().user };
}

async function sync(cookie: string, after: number, limit: number) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/sync?after=${after}&limit=${limit}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
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
  return res.json().member;
}

async function post(cookie: string, channelId: string, text: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { cookie },
    payload: { channelId, text, clientMsgId: randomUUID() },
  });
  expect(res.statusCode).toBe(201);
  return res.json().event as {
    id: number;
    type: string;
    channelId: string;
    author: { id: string; handle: string; displayName: string };
  };
}

async function edit(cookie: string, eventId: number, text: string) {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/messages/${eventId}`,
    headers: { cookie },
    payload: { text, opId: randomUUID() },
  });
  expect(res.statusCode).toBe(200);
  return res.json().event;
}

async function react(cookie: string, eventId: number) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/messages/${eventId}/reactions`,
    headers: { cookie },
    payload: { emoji: '👍', action: 'add', opId: randomUUID() },
  });
  expect(res.statusCode).toBe(200);
  return res.json().event;
}

async function markRead(cookie: string, channelId: string, lastReadEventId: number) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/channels/${channelId}/read`,
    headers: { cookie },
    payload: { lastReadEventId, opId: randomUUID() },
  });
  expect(res.statusCode).toBe(200);
}

async function setMute(cookie: string, channelId: string, muted: boolean) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/channels/${channelId}/mute`,
    headers: { cookie },
    payload: { muted, opId: randomUUID() },
  });
  expect(res.statusCode).toBe(200);
}

async function patchPrefs(cookie: string, patch: Record<string, unknown>) {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/me/prefs',
    headers: { cookie },
    payload: { ...patch, opId: randomUUID() },
  });
  expect(res.statusCode).toBe(200);
}

async function putDraft(cookie: string, draftKey: string, text: string) {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/me/drafts/${encodeURIComponent(draftKey)}`,
    headers: { cookie },
    payload: { text, opId: randomUUID() },
  });
  expect(res.statusCode).toBe(200);
}

async function randomVisibleMutation(
  rng: SeededPrng,
  ctx: {
    alice: Login;
    bob: Login;
    privateChannelId: string;
    posted: PostedMessage[];
  },
): Promise<PostedMessage | null> {
  const target = ctx.posted.length > 0 ? ctx.posted[rng.int(ctx.posted.length)] : null;
  switch (rng.int(target ? 5 : 3)) {
    case 0: {
      const event = await post(ctx.alice.cookie, fx.channelId, `alice public ${randomUUID()}`);
      return { id: event.id, channelId: event.channelId, author: ctx.alice };
    }
    case 1: {
      const event = await post(ctx.bob.cookie, fx.otherChannelId, `bob public ${randomUUID()}`);
      return { id: event.id, channelId: event.channelId, author: ctx.bob };
    }
    case 2: {
      const event = await post(ctx.alice.cookie, ctx.privateChannelId, `alice private ${randomUUID()}`);
      return { id: event.id, channelId: event.channelId, author: ctx.alice };
    }
    case 3:
      await edit(target!.author.cookie, target!.id, `edited ${randomUUID()}`);
      return null;
    default:
      await react(ctx.alice.cookie, target!.id);
      return null;
  }
}

interface PostedMessage {
  id: number;
  channelId: string;
  author: Login;
}

async function visibleEventIds(userId: string): Promise<number[]> {
  const res = await pool.query<{ id: number }>(
    `SELECT e.id
     FROM events e
     LEFT JOIN channels c ON c.id = e.channel_id
     LEFT JOIN channel_members cm
       ON cm.channel_id = e.channel_id AND cm.user_id = $1
     LEFT JOIN LATERAL (
       SELECT MAX(j.id) AS join_event_id
       FROM events j
       WHERE j.channel_id = e.channel_id
         AND j.type = 'channel.member_joined'
         AND j.payload->>'userId' = $2
     ) latest_join ON true
     WHERE e.type = ANY($3::text[])
       AND (
         c.kind = 'public'
         OR (
           c.kind IN ('private', 'dm', 'gdm')
           AND cm.user_id IS NOT NULL
           AND e.id >= COALESCE(latest_join.join_event_id, 0)
         )
         OR (
           e.type = 'channel.member_left'
           AND e.payload->>'userId' = $2
         )
       )
     ORDER BY e.id ASC`,
    [userId, userId, SYNC_EVENT_TYPES],
  );
  return res.rows.map((row) => row.id);
}
