import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { getOrCreateDm } from '../src/events.js';
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

function fakeSocket(): HubSocket & { received: unknown[] } {
  const received: unknown[] = [];
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

describe('channel mutes', () => {
  it('toggles mute state and fans out to the user sockets', async () => {
    const { cookie, user } = await login('alice', 'Alice');
    const socket = fakeSocket();
    hub.addClient(socket, user);

    const muted = await app.inject({
      method: 'POST',
      url: `/api/channels/${fx.channelId}/mute`,
      headers: { cookie },
      payload: { muted: true },
    });
    expect(muted.statusCode).toBe(200);
    expect(muted.json()).toEqual({ muted: true });
    expect(socket.received).toContainEqual(
      expect.objectContaining({
        type: 'muted',
        channelId: fx.channelId,
        muted: true,
      }),
    );

    const channels = await app.inject({
      method: 'GET',
      url: '/api/channels',
      headers: { cookie },
    });
    expect(channels.statusCode).toBe(200);
    expect(channels.json().channels.find((c: any) => c.id === fx.channelId).muted).toBe(true);

    const unmuted = await app.inject({
      method: 'POST',
      url: `/api/channels/${fx.channelId}/mute`,
      headers: { cookie },
      payload: { muted: false },
    });
    expect(unmuted.statusCode).toBe(200);
    expect(unmuted.json()).toEqual({ muted: false });
  });

  it('returns 404 when muting a foreign DM', async () => {
    const { user: alice } = await login('alice', 'Alice');
    const { user: ben } = await login('ben', 'Ben');
    const { cookie: carol } = await login('carol', 'Carol');
    const { channel } = await getOrCreateDm(pool, {
      workspaceId: fx.workspaceId,
      userIdA: alice.id,
      userIdB: ben.id,
    });

    const denied = await app.inject({
      method: 'POST',
      url: `/api/channels/${channel.id}/mute`,
      headers: { cookie: carol },
      payload: { muted: true },
    });
    expect(denied.statusCode).toBe(404);
  });
});
