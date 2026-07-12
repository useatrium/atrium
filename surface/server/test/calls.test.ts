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

type ActiveCallJson = {
  id: string;
  channelId: string;
  initiatorId: string;
  status: string;
  participants: Array<{ id: string; handle: string; displayName: string }>;
};

function activeCallsUrl(channelId?: string): string {
  return `/api/calls/active${channelId ? `?channelId=${encodeURIComponent(channelId)}` : ''}`;
}

async function activeCalls(cookie: string, channelId?: string): Promise<ActiveCallJson[]> {
  const current = app!;
  const res = await current.inject({
    method: 'GET',
    url: activeCallsUrl(channelId),
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json().calls as ActiveCallJson[];
}

function expectParticipantIds(call: ActiveCallJson | undefined, userIds: string[]) {
  expect(call?.participants.map((participant) => participant.id).sort()).toEqual([...userIds].sort());
}

describe('call routes', () => {
  it('returns visible ringing and active snapshots with participants and channel filters', async () => {
    const current = await startApp();
    const benId = await seedMember(pool, fx.workspaceId, 'ben', 'Ben');
    const { cookie: aliceCookie, user: alice } = await login('alice', 'Alice');
    const { cookie: benCookie, user: ben } = await login('ben', 'Ben');
    expect(ben.id).toBe(benId);

    const startGeneral = await current.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { cookie: aliceCookie },
      payload: { channelId: fx.channelId },
    });
    expect(startGeneral.statusCode).toBe(200);
    const generalCall = startGeneral.json().call as ActiveCallJson;

    const benRinging = await activeCalls(benCookie);
    expect(benRinging).toHaveLength(1);
    expect(benRinging[0]).toMatchObject({
      id: generalCall.id,
      channelId: fx.channelId,
      initiatorId: alice.id,
      status: 'ringing',
    });
    expectParticipantIds(benRinging[0], [alice.id]);

    const accept = await current.inject({
      method: 'POST',
      url: `/api/calls/${generalCall.id}/accept`,
      headers: { cookie: benCookie },
    });
    expect(accept.statusCode).toBe(200);

    const startRandom = await current.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { cookie: aliceCookie },
      payload: { channelId: fx.otherChannelId },
    });
    expect(startRandom.statusCode).toBe(200);
    const randomCall = startRandom.json().call as ActiveCallJson;

    const allVisible = await activeCalls(aliceCookie);
    expect(allVisible.map((call) => call.id).sort()).toEqual([generalCall.id, randomCall.id].sort());

    const generalOnly = await activeCalls(aliceCookie, fx.channelId);
    expect(generalOnly.map((call) => call.id)).toEqual([generalCall.id]);
    expect(generalOnly[0]).toMatchObject({
      id: generalCall.id,
      channelId: fx.channelId,
      status: 'active',
    });
    expectParticipantIds(generalOnly[0], [alice.id, ben.id]);

    const randomOnly = await activeCalls(aliceCookie, fx.otherChannelId);
    expect(randomOnly.map((call) => call.id)).toEqual([randomCall.id]);
    expect(randomOnly[0]).toMatchObject({
      id: randomCall.id,
      channelId: fx.otherChannelId,
      status: 'ringing',
    });
    expectParticipantIds(randomOnly[0], [alice.id]);
  });

  it('does not leak private, DM, or group-DM snapshots to non-members', async () => {
    const current = await startApp();
    const benId = await seedMember(pool, fx.workspaceId, 'ben', 'Ben');
    const doraId = await seedMember(pool, fx.workspaceId, 'dora', 'Dora');
    await seedMember(pool, fx.workspaceId, 'carol', 'Carol');
    const { cookie: aliceCookie, user: alice } = await login('alice', 'Alice');
    const { cookie: carolCookie } = await login('carol', 'Carol');

    const privateRes = await current.inject({
      method: 'POST',
      url: '/api/channels',
      headers: { cookie: aliceCookie },
      payload: { name: 'secret-snapshots', private: true },
    });
    expect(privateRes.statusCode).toBe(201);
    const privateChannelId = privateRes.json().channel.id as string;

    const dmRes = await current.inject({
      method: 'POST',
      url: '/api/dms',
      headers: { cookie: aliceCookie },
      payload: { userId: benId },
    });
    expect(dmRes.statusCode).toBe(201);
    const dmChannelId = dmRes.json().channel.id as string;

    const gdmRes = await current.inject({
      method: 'POST',
      url: '/api/dms',
      headers: { cookie: aliceCookie },
      payload: { userIds: [benId, doraId] },
    });
    expect(gdmRes.statusCode).toBe(201);
    const gdmChannelId = gdmRes.json().channel.id as string;

    const privateStart = await current.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { cookie: aliceCookie },
      payload: { channelId: privateChannelId },
    });
    expect(privateStart.statusCode).toBe(200);
    const dmStart = await current.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { cookie: aliceCookie },
      payload: { channelId: dmChannelId },
    });
    expect(dmStart.statusCode).toBe(200);
    const gdmStart = await current.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { cookie: aliceCookie },
      payload: { channelId: gdmChannelId },
    });
    expect(gdmStart.statusCode).toBe(200);
    const privateCallId = privateStart.json().call.id as string;
    const dmCallId = dmStart.json().call.id as string;
    const gdmCallId = gdmStart.json().call.id as string;

    const aliceVisible = await activeCalls(aliceCookie);
    expect(aliceVisible.map((call) => call.id).sort()).toEqual([privateCallId, dmCallId, gdmCallId].sort());
    for (const call of aliceVisible) {
      expectParticipantIds(call, [alice.id]);
    }

    const carolVisible = await activeCalls(carolCookie);
    expect(carolVisible.map((call) => call.id)).toEqual([]);

    for (const channelId of [privateChannelId, dmChannelId, gdmChannelId]) {
      const res = await current.inject({
        method: 'GET',
        url: activeCallsUrl(channelId),
        headers: { cookie: carolCookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'channel_not_found' });
    }
  });

  it('omits ended calls after the last participant leaves and after a DM decline', async () => {
    const current = await startApp();
    const benId = await seedMember(pool, fx.workspaceId, 'ben', 'Ben');
    const { cookie: aliceCookie } = await login('alice', 'Alice');
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

    const start = await current.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { cookie: aliceCookie },
      payload: { channelId },
    });
    expect(start.statusCode).toBe(200);
    const activeCallId = start.json().call.id as string;
    const accept = await current.inject({
      method: 'POST',
      url: `/api/calls/${activeCallId}/accept`,
      headers: { cookie: benCookie },
    });
    expect(accept.statusCode).toBe(200);
    expect((await activeCalls(aliceCookie, channelId)).map((call) => call.id)).toEqual([activeCallId]);

    const leaveAlice = await current.inject({
      method: 'POST',
      url: `/api/calls/${activeCallId}/leave`,
      headers: { cookie: aliceCookie },
    });
    expect(leaveAlice.statusCode).toBe(200);
    expect((await activeCalls(aliceCookie, channelId)).map((call) => call.id)).toEqual([activeCallId]);

    const leaveBen = await current.inject({
      method: 'POST',
      url: `/api/calls/${activeCallId}/leave`,
      headers: { cookie: benCookie },
    });
    expect(leaveBen.statusCode).toBe(200);
    expect(await activeCalls(aliceCookie, channelId)).toEqual([]);
    expect(await activeCalls(benCookie, channelId)).toEqual([]);

    const ringing = await current.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { cookie: aliceCookie },
      payload: { channelId },
    });
    expect(ringing.statusCode).toBe(200);
    const ringingCallId = ringing.json().call.id as string;
    expect((await activeCalls(benCookie, channelId)).map((call) => call.id)).toEqual([ringingCallId]);

    const declined = await current.inject({
      method: 'POST',
      url: `/api/calls/${ringingCallId}/decline`,
      headers: { cookie: benCookie },
    });
    expect(declined.statusCode).toBe(200);
    expect(await activeCalls(aliceCookie, channelId)).toEqual([]);
    expect(await activeCalls(benCookie, channelId)).toEqual([]);
  });

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
      // A freshly started call stays 'ringing' until a callee accepts, so the
      // call.ringing frame carries an honest status (flips to 'active' on accept).
      status: 'ringing',
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
    expect(accepted.call.status).toBe('active'); // ringing → active on first accept
    expect(accepted.call.participants.map((p: any) => p.id).sort()).toEqual([alice.id, ben.id].sort());
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
    expect(benSocket.received).toContainEqual(expect.objectContaining({ type: 'call.ended', callId: started.call.id }));
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

  it('ends a ringing DM call when the callee declines', async () => {
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

    const aliceSocket = fakeSocket();
    const benSocket = fakeSocket();
    hub.addClient(aliceSocket, alice);
    hub.addClient(benSocket, ben);

    const start = await current.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { cookie: aliceCookie },
      payload: { channelId: dmRes.json().channel.id },
    });
    expect(start.statusCode).toBe(200);
    const callId = start.json().call.id as string;

    const declined = await current.inject({
      method: 'POST',
      url: `/api/calls/${callId}/decline`,
      headers: { cookie: benCookie },
    });
    expect(declined.statusCode).toBe(200);
    expect(declined.json()).toEqual({ ok: true });

    for (const socket of [aliceSocket, benSocket]) {
      expect(socket.received).toContainEqual(
        expect.objectContaining({ type: 'call.declined', callId, userId: ben.id }),
      );
      expect(socket.received).toContainEqual(expect.objectContaining({ type: 'call.ended', callId }));
    }
    const state = await pool.query<{ status: string; ended_at: Date | null }>(
      'SELECT status, ended_at FROM calls WHERE id = $1',
      [callId],
    );
    expect(state.rows[0]).toMatchObject({ status: 'ended' });
    expect(state.rows[0]?.ended_at).toBeTruthy();
  });

  it('returns active snapshots when LiveKit settings are absent but rejects call mutations', async () => {
    const current = await startApp(false);
    const { cookie, user } = await login('alice', 'Alice');
    const callId = randomUUID();
    await pool.query(
      `INSERT INTO calls (id, workspace_id, channel_id, initiator_id, room, status)
       VALUES ($1, $2, $3, $4, $5, 'active')`,
      [callId, fx.workspaceId, fx.channelId, user.id, `call:${callId}`],
    );
    await pool.query('INSERT INTO call_participants (call_id, user_id, joined_at) VALUES ($1, $2, now())', [
      callId,
      user.id,
    ]);

    const active = await activeCalls(cookie);
    expect(active.map((call) => call.id)).toEqual([callId]);
    expect(active[0]).toMatchObject({
      id: callId,
      channelId: fx.channelId,
      initiatorId: user.id,
      status: 'active',
    });
    expectParticipantIds(active[0], [user.id]);

    const res = await current.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { cookie },
      payload: { channelId: fx.channelId },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'calls_unconfigured' });
  });

  it('preserves route-specific call boundary errors', async () => {
    const current = await startApp();
    const { cookie } = await login('alice', 'Alice');

    const badQuery = await current.inject({
      method: 'GET',
      url: '/api/calls/active?channelId=one&channelId=two',
      headers: { cookie },
    });
    expect(badQuery.statusCode).toBe(400);
    expect(badQuery.json()).toMatchObject({
      error: 'bad_request',
      message: 'channelId must be a string',
    });

    const badBody = await current.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { cookie },
      payload: { channelId: 123 },
    });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json()).toMatchObject({ error: 'bad_request', message: 'channelId required' });

    const badParam = await current.inject({
      method: 'POST',
      url: '/api/calls/not-a-uuid/accept',
      headers: { cookie },
    });
    expect(badParam.statusCode).toBe(404);
    expect(badParam.json()).toMatchObject({
      error: 'call_not_found',
      message: 'call not found',
    });
  });
});
