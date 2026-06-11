import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
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

async function createPrivate(cookie: string, name = 'secret') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/channels',
    headers: { cookie },
    payload: { name, private: true },
  });
  expect(res.statusCode).toBe(201);
  return res.json().channel;
}

describe('private channel access', () => {
  it('lists only members and returns 404 for non-member messages/read/mute', async () => {
    const { cookie: alice } = await login('alice', 'Alice');
    const { cookie: ben } = await login('ben', 'Ben');
    const channel = await createPrivate(alice);

    expect(channel.kind).toBe('private');
    expect(channel.memberCount).toBe(1);
    expect(channel.members).toBeUndefined();

    const benChannels = await app.inject({ method: 'GET', url: '/api/channels', headers: { cookie: ben } });
    expect(benChannels.json().channels.some((c: any) => c.id === channel.id)).toBe(false);

    for (const req of [
      { method: 'GET', url: `/api/channels/${channel.id}/messages` },
      { method: 'POST', url: `/api/channels/${channel.id}/read`, payload: { lastReadEventId: 1 } },
      { method: 'POST', url: `/api/channels/${channel.id}/mute`, payload: { muted: true } },
    ] as const) {
      const res = await app.inject({ ...req, headers: { cookie: ben } });
      expect(res.statusCode).toBe(404);
    }
  });

  it('invites privately and fans member_joined only to the channel', async () => {
    const { cookie: alice, user: aliceUser } = await login('alice', 'Alice');
    const { user: benUser } = await login('ben', 'Ben');
    const { user: carolUser } = await login('carol', 'Carol');
    const aliceSocket = fakeSocket();
    const benSocket = fakeSocket();
    const carolSocket = fakeSocket();
    const aliceClient = hub.addClient(aliceSocket, aliceUser);
    hub.addClient(benSocket, benUser);
    hub.addClient(carolSocket, carolUser);

    const channel = await createPrivate(alice);
    expect(aliceSocket.received.filter((m) => m.event?.type === 'channel.created')).toHaveLength(1);
    expect(benSocket.received.filter((m) => m.event?.type === 'channel.created')).toHaveLength(0);
    expect(carolSocket.received.filter((m) => m.event?.type === 'channel.created')).toHaveLength(0);
    hub.subscribe(aliceClient, [channel.id]);
    aliceSocket.received.length = 0;
    benSocket.received.length = 0;
    carolSocket.received.length = 0;

    const invited = await app.inject({
      method: 'POST',
      url: `/api/channels/${channel.id}/members`,
      headers: { cookie: alice },
      payload: { userId: benUser.id },
    });
    expect(invited.statusCode).toBe(201);
    expect(benSocket.received.some((m) => m.event?.type === 'channel.created')).toBe(true);
    expect(aliceSocket.received.some((m) => m.event?.type === 'channel.member_joined')).toBe(true);
    expect(carolSocket.received).toEqual([]);
  });

  it('rejects invites from non-members with the 404 pattern', async () => {
    const { cookie: alice } = await login('alice', 'Alice');
    const { cookie: ben } = await login('ben', 'Ben');
    const { user: carolUser } = await login('carol', 'Carol');
    const channel = await createPrivate(alice);

    const res = await app.inject({
      method: 'POST',
      url: `/api/channels/${channel.id}/members`,
      headers: { cookie: ben },
      payload: { userId: carolUser.id },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('group DMs', () => {
  it('dedupes by exact member set regardless of order', async () => {
    const { cookie: alice, user: aliceUser } = await login('alice', 'Alice');
    const { user: benUser } = await login('ben', 'Ben');
    const { user: carolUser } = await login('carol', 'Carol');

    const first = await app.inject({
      method: 'POST',
      url: '/api/dms',
      headers: { cookie: alice },
      payload: { userIds: [benUser.id, carolUser.id] },
    });
    expect(first.statusCode).toBe(201);
    const channel = first.json().channel;
    expect(channel.kind).toBe('gdm');
    expect(channel.members.map((m: any) => m.id).sort()).toEqual(
      [aliceUser.id, benUser.id, carolUser.id].sort(),
    );

    const again = await app.inject({
      method: 'POST',
      url: '/api/dms',
      headers: { cookie: alice },
      payload: { userIds: [carolUser.id, benUser.id] },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().channel.id).toBe(channel.id);
  });

  it('allows leaving private/gdm channels, rejects leaving a 1:1 DM', async () => {
    const { cookie: alice, user: aliceUser } = await login('alice', 'Alice');
    const { cookie: ben, user: benUser } = await login('ben', 'Ben');
    const { user: carolUser } = await login('carol', 'Carol');
    const benSocket = fakeSocket();
    hub.addClient(benSocket, benUser);
    const gdm = (
      await app.inject({
        method: 'POST',
        url: '/api/dms',
        headers: { cookie: alice },
        payload: { userIds: [benUser.id, carolUser.id] },
      })
    ).json().channel;

    const left = await app.inject({
      method: 'DELETE',
      url: `/api/channels/${gdm.id}/members/me`,
      headers: { cookie: ben },
    });
    expect(left.statusCode).toBe(200);
    expect(benSocket.received).toContainEqual({ type: 'channel-left', channelId: gdm.id });
    const members = await app.inject({
      method: 'GET',
      url: `/api/channels/${gdm.id}/members`,
      headers: { cookie: alice },
    });
    expect(members.json().members.map((m: any) => m.id).sort()).toEqual(
      [aliceUser.id, carolUser.id].sort(),
    );

    const dm = (
      await app.inject({
        method: 'POST',
        url: '/api/dms',
        headers: { cookie: alice },
        payload: { userId: benUser.id },
      })
    ).json().channel;
    const refused = await app.inject({
      method: 'DELETE',
      url: `/api/channels/${dm.id}/members/me`,
      headers: { cookie: alice },
    });
    expect(refused.statusCode).toBe(400);
  });
});
