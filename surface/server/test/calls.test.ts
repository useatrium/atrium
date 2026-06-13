import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { WsHub, type HubSocket } from '../src/hub.js';
import { createTestPool, seedFixture, seedMember, truncateAll, type Fixture } from './helpers.js';
import type { CallTokenService } from '../src/livekit.js';

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let hub: WsHub;

const callService: CallTokenService = {
  url: 'ws://livekit.test',
  mintToken: async (room, identity) => `token:${room}:${identity}`,
};

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
});

afterEach(async () => {
  await app?.close();
  app = null;
});

async function startApp(calls: CallTokenService | false = callService) {
  app = await buildApp({
    pool,
    hub,
    calls,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
  return app;
}

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

async function login(handle: string, displayName = handle) {
  const current = app!;
  const res = await current.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  expect(res.statusCode).toBe(200);
  return { cookie: res.headers['set-cookie'] as string, user: res.json().user };
}

describe('call routes', () => {
  it('runs start -> accept -> leave lifecycle and persists call state', async () => {
    const current = await startApp();
    const benId = await seedMember(pool, fx.workspaceId, 'ben', 'Ben');
    const { cookie: aliceCookie, user: alice } = await login('alice', 'Alice');
    const { cookie: benCookie, user: ben } = await login('ben', 'Ben');
    expect(ben.id).toBe(benId);

    const dmRes = await current.inject({
      method: 'POST',
      url: '/api/dms',
      headers: { cookie: aliceCookie },
      payload: { userId: ben.id },
    });
    expect(dmRes.statusCode).toBe(201);
    const channelId = dmRes.json().channel.id as string;

    const aliceSocket = fakeSocket();
    const benSocket = fakeSocket();
    hub.addClient(aliceSocket, alice);
    hub.addClient(benSocket, ben);

    const start = await current.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { cookie: aliceCookie },
      payload: { channelId, opId: randomUUID() },
    });
    expect(start.statusCode).toBe(200);
    const started = start.json();
    expect(started.url).toBe(callService.url);
    expect(started.token).toBe(`token:call:${started.call.id}:${alice.id}`);
    expect(started.call).toMatchObject({
      channelId,
      initiatorId: alice.id,
      status: 'active',
    });
    expect(started.call.participants.map((p: any) => p.id)).toEqual([alice.id]);
    expect(aliceSocket.received.some((m) => m.type === 'call.ringing')).toBe(false);
    expect(benSocket.received).toContainEqual(
      expect.objectContaining({
        type: 'call.ringing',
        call: expect.objectContaining({ id: started.call.id, channelId }),
      }),
    );

    const accept = await current.inject({
      method: 'POST',
      url: `/api/calls/${started.call.id}/accept`,
      headers: { cookie: benCookie },
    });
    expect(accept.statusCode).toBe(200);
    const accepted = accept.json();
    expect(accepted.token).toBe(`token:call:${started.call.id}:${ben.id}`);
    expect(accepted.call.participants.map((p: any) => p.id).sort()).toEqual(
      [alice.id, ben.id].sort(),
    );
    for (const socket of [aliceSocket, benSocket]) {
      expect(socket.received).toContainEqual(
        expect.objectContaining({ type: 'call.accepted', callId: started.call.id, user: ben }),
      );
      expect(socket.received).toContainEqual(
        expect.objectContaining({
          type: 'call.participant_joined',
          callId: started.call.id,
          user: ben,
        }),
      );
    }

    const leaveAlice = await current.inject({
      method: 'POST',
      url: `/api/calls/${started.call.id}/leave`,
      headers: { cookie: aliceCookie },
    });
    expect(leaveAlice.statusCode).toBe(200);
    let state = await pool.query<{
      status: string;
      ended_at: Date | null;
      joined: string;
      left: string;
    }>(
      `SELECT c.status, c.ended_at,
              COUNT(*) FILTER (WHERE cp.left_at IS NULL) AS joined,
              COUNT(*) FILTER (WHERE cp.left_at IS NOT NULL) AS left
       FROM calls c JOIN call_participants cp ON cp.call_id = c.id
       WHERE c.id = $1
       GROUP BY c.id`,
      [started.call.id],
    );
    expect(state.rows[0]).toMatchObject({ status: 'active', ended_at: null, joined: 1, left: 1 });

    const leaveBen = await current.inject({
      method: 'POST',
      url: `/api/calls/${started.call.id}/leave`,
      headers: { cookie: benCookie },
    });
    expect(leaveBen.statusCode).toBe(200);
    state = await pool.query(
      `SELECT c.status, c.ended_at,
              COUNT(*) FILTER (WHERE cp.left_at IS NULL) AS joined,
              COUNT(*) FILTER (WHERE cp.left_at IS NOT NULL) AS left
       FROM calls c JOIN call_participants cp ON cp.call_id = c.id
       WHERE c.id = $1
      GROUP BY c.id`,
      [started.call.id],
    );
    const finalState = state.rows[0]!;
    expect(finalState.status).toBe('ended');
    expect(finalState.ended_at).toBeTruthy();
    expect(finalState.joined).toBe(0);
    expect(finalState.left).toBe(2);
    expect(benSocket.received).toContainEqual(
      expect.objectContaining({ type: 'call.ended', callId: started.call.id }),
    );
  });

  it('rejects non-members starting or accepting private-channel calls', async () => {
    const current = await startApp();
    const { cookie: aliceCookie } = await login('alice', 'Alice');
    await seedMember(pool, fx.workspaceId, 'carol', 'Carol');
    const { cookie: carolCookie } = await login('carol', 'Carol');

    const privateRes = await current.inject({
      method: 'POST',
      url: '/api/channels',
      headers: { cookie: aliceCookie },
      payload: { name: 'secret', private: true },
    });
    expect(privateRes.statusCode).toBe(201);
    const channelId = privateRes.json().channel.id as string;

    const rejectedStart = await current.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { cookie: carolCookie },
      payload: { channelId },
    });
    expect(rejectedStart.statusCode).toBe(404);

    const start = await current.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { cookie: aliceCookie },
      payload: { channelId },
    });
    expect(start.statusCode).toBe(200);

    const rejectedAccept = await current.inject({
      method: 'POST',
      url: `/api/calls/${start.json().call.id}/accept`,
      headers: { cookie: carolCookie },
    });
    expect(rejectedAccept.statusCode).toBe(404);
  });

  it('returns calls_unconfigured when LiveKit settings are absent', async () => {
    const current = await startApp(false);
    const { cookie } = await login('alice', 'Alice');

    const res = await current.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { cookie },
      payload: { channelId: fx.channelId },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'calls_unconfigured' });
  });
});
