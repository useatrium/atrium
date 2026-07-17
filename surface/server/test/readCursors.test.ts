import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { postMessage } from '../src/events.js';
import { WsHub, type HubSocket } from '../src/hub.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;
let hub: WsHub;

beforeAll(async () => {
  pool = await createTestPool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  fx = await seedFixture(pool);
  hub = new WsHub();
  app = await buildApp({
    pool,
    hub,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

function fakeSocket(): HubSocket & { received: any[] } {
  const received: any[] = [];
  return {
    readyState: 1,
    received,
    send(data: string) {
      received.push(JSON.parse(data));
    },
  };
}

async function login(handle: string, displayName?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: displayName === undefined ? { handle } : { handle, displayName },
  });
  expect(res.statusCode).toBe(200);
  return { cookie: res.headers['set-cookie'] as string, user: res.json().user };
}

async function post(cookie: string, channelId: string, text: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { cookie },
    payload: { channelId, text, clientMsgId: `cm-${Math.random()}` },
  });
  expect(res.statusCode).toBe(201);
  return res.json().event;
}

describe('read cursors', () => {
  it('includes the caller read cursor in raw and folded channel history', async () => {
    const { cookie } = await login('alice', 'Alice');
    const message = await post(cookie, fx.channelId, 'one');

    const neverRead = await app.inject({
      method: 'GET',
      url: `/api/channels/${fx.channelId}/messages`,
      headers: { cookie },
    });
    expect(neverRead.statusCode).toBe(200);
    expect(neverRead.json().readCursor).toBe(0);

    const marked = await app.inject({
      method: 'POST',
      url: `/api/channels/${fx.channelId}/read`,
      headers: { cookie },
      payload: { lastReadEventId: message.id },
    });
    expect(marked.statusCode).toBe(200);

    const raw = await app.inject({
      method: 'GET',
      url: `/api/channels/${fx.channelId}/messages`,
      headers: { cookie },
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.json().readCursor).toBe(message.id);

    const folded = await app.inject({
      method: 'GET',
      url: `/api/channels/${fx.channelId}/messages?wire=folded`,
      headers: { cookie },
    });
    expect(folded.statusCode).toBe(200);
    expect(folded.json().readCursor).toBe(message.id);
  });

  it('advances but never regresses and notifies the user sockets only', async () => {
    const { cookie, user } = await login('alice', 'Alice');
    const { user: other } = await login('ben', 'Ben');
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    const s3 = fakeSocket();
    hub.addClient(s1, user);
    hub.addClient(s2, user);
    hub.addClient(s3, other);

    const first = await app.inject({
      method: 'POST',
      url: `/api/channels/${fx.channelId}/read`,
      headers: { cookie },
      payload: { lastReadEventId: 10 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ lastReadEventId: 10 });
    expect(s1.received).toContainEqual(
      expect.objectContaining({
        type: 'read',
        channelId: fx.channelId,
        lastReadEventId: 10,
      }),
    );
    expect(s2.received).toContainEqual(
      expect.objectContaining({
        type: 'read',
        channelId: fx.channelId,
        lastReadEventId: 10,
      }),
    );
    expect(s3.received).toEqual([]);

    s1.received.length = 0;
    s2.received.length = 0;
    const regression = await app.inject({
      method: 'POST',
      url: `/api/channels/${fx.channelId}/read`,
      headers: { cookie },
      payload: { lastReadEventId: 3 },
    });
    expect(regression.statusCode).toBe(200);
    expect(regression.json()).toEqual({ lastReadEventId: 10 });
    expect(s1.received).toEqual([]);
    expect(s2.received).toEqual([]);
  });

  it('returns 404 for foreign DM access', async () => {
    const { cookie: alice, user: aliceUser } = await login('alice', 'Alice');
    const { cookie: ben, user: benUser } = await login('ben', 'Ben');
    const { cookie: carol } = await login('carol', 'Carol');
    const dmRes = await app.inject({
      method: 'POST',
      url: '/api/dms',
      headers: { cookie: alice },
      payload: { userId: benUser.id },
    });
    expect(dmRes.statusCode).toBe(201);
    expect(
      dmRes
        .json()
        .channel.members.map((m: any) => m.id)
        .sort(),
    ).toEqual([aliceUser.id, benUser.id].sort());

    const denied = await app.inject({
      method: 'POST',
      url: `/api/channels/${dmRes.json().channel.id}/read`,
      headers: { cookie: carol },
      payload: { lastReadEventId: 1 },
    });
    expect(denied.statusCode).toBe(404);
  });

  it('includes lastReadEventId and latestEventId in channel payloads', async () => {
    const { cookie } = await login('alice', 'Alice');
    const one = await post(cookie, fx.channelId, 'one');
    const two = await post(cookie, fx.channelId, 'two');
    await app.inject({
      method: 'POST',
      url: `/api/channels/${fx.channelId}/read`,
      headers: { cookie },
      payload: { lastReadEventId: one.id },
    });

    const channels = await app.inject({
      method: 'GET',
      url: '/api/channels',
      headers: { cookie },
    });
    expect(channels.statusCode).toBe(200);
    const channel = channels.json().channels.find((c: any) => c.id === fx.channelId);
    expect(channel.lastReadEventId).toBe(one.id);
    expect(channel.latestEventId).toBe(two.id);
  });

  // A deleted message renders no row, so no client can scroll to it to mark it
  // read. Counting one strands the channel unread forever — every id this
  // counter reports has to be an id a reader can actually reach.
  it('does not count a deleted message toward latestEventId', async () => {
    const { cookie } = await login('alice', 'Alice');
    const kept = await post(cookie, fx.channelId, 'kept');
    const doomed = await post(cookie, fx.channelId, 'doomed');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/messages/${doomed.id}`,
      headers: { cookie },
      payload: { opId: randomUUID() },
    });
    expect(removed.statusCode).toBe(200);

    const channels = await app.inject({ method: 'GET', url: '/api/channels', headers: { cookie } });
    expect(channels.statusCode).toBe(200);
    const channel = channels.json().channels.find((c: any) => c.id === fx.channelId);
    expect(channel.latestEventId).toBe(kept.id);

    // The whole point: reading the newest surviving message clears the channel.
    await app.inject({
      method: 'POST',
      url: `/api/channels/${fx.channelId}/read`,
      headers: { cookie },
      payload: { lastReadEventId: kept.id },
    });
    const settled = await app.inject({ method: 'GET', url: '/api/channels', headers: { cookie } });
    const after = settled.json().channels.find((c: any) => c.id === fx.channelId);
    expect(after.latestEventId).toBeLessThanOrEqual(after.lastReadEventId);
  });

  it('computes latestEventId from main-timeline-visible events only', async () => {
    const { cookie } = await login('alice', 'Alice');
    const root = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'root',
    });
    await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'thread only',
      threadRootEventId: root.id,
    });

    const afterThreadOnly = await app.inject({
      method: 'GET',
      url: '/api/channels',
      headers: { cookie },
    });
    expect(afterThreadOnly.statusCode).toBe(200);
    const channelAfterThreadOnly = afterThreadOnly.json().channels.find((c: any) => c.id === fx.channelId);
    expect(channelAfterThreadOnly.latestEventId).toBe(root.id);

    const broadcast = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'broadcast reply',
      threadRootEventId: root.id,
      broadcast: true,
    });

    const afterBroadcast = await app.inject({
      method: 'GET',
      url: '/api/channels',
      headers: { cookie },
    });
    expect(afterBroadcast.statusCode).toBe(200);
    const channelAfterBroadcast = afterBroadcast.json().channels.find((c: any) => c.id === fx.channelId);
    expect(channelAfterBroadcast.latestEventId).toBe(broadcast.id);
  });
});
