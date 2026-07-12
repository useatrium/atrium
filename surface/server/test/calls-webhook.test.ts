import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { AccessToken } from 'livekit-server-sdk';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CallTokenService } from '../src/livekit.js';
import { registerCallRoutes } from '../src/routes/calls.js';
import { WsHub, type HubSocket } from '../src/hub.js';
import { noopVoipSender } from '../src/voip.js';
import { createTestPool, seedFixture, seedMember, truncateAll, type Fixture } from './helpers.js';

const livekitApiKey = 'testkey';
const livekitApiSecret = 'testsecret_testsecret_testsecret_01';

let pool: pg.Pool;
let fx: Fixture;
let app: FastifyInstance | null = null;
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

async function startApp(
  creds: { apiKey: string; apiSecret: string } | null = {
    apiKey: livekitApiKey,
    apiSecret: livekitApiSecret,
  },
) {
  app = Fastify({ logger: false });
  registerCallRoutes(app, {
    pool,
    hub,
    calls: callService,
    livekitApiKey: creds?.apiKey ?? '',
    livekitApiSecret: creds?.apiSecret ?? '',
    voip: noopVoipSender,
    requireUser: () => null,
    optionalOpId: () => undefined,
    runMutation: async <T>() => {
      throw new Error('unexpected call mutation');
    },
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

async function signWebhook(body: string): Promise<string> {
  const token = new AccessToken(livekitApiKey, livekitApiSecret);
  token.sha256 = createHash('sha256').update(body).digest('base64');
  return token.toJwt();
}

function webhookRoom(callId: string) {
  return {
    sid: `RM_${callId.replace(/-/g, '').slice(0, 16)}`,
    name: `call:${callId}`,
    emptyTimeout: 300,
    creationTime: '1',
    enabledCodecs: [],
  };
}

async function postWebhook(
  current: FastifyInstance,
  body: string,
  authorization: string | Promise<string> = signWebhook(body),
) {
  return current.inject({
    method: 'POST',
    url: '/api/calls/webhook',
    headers: {
      authorization: await authorization,
      'content-type': 'application/webhook+json',
    },
    payload: body,
  });
}

async function seedCall(userIds: string[], status: 'ringing' | 'active' = 'active'): Promise<string> {
  const callId = randomUUID();
  await pool.query(
    `INSERT INTO calls (id, workspace_id, channel_id, initiator_id, room, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [callId, fx.workspaceId, fx.channelId, userIds[0]!, `call:${callId}`, status],
  );
  for (const userId of userIds) {
    await pool.query(
      'INSERT INTO call_participants (call_id, user_id, joined_at, left_at) VALUES ($1, $2, now(), NULL)',
      [callId, userId],
    );
  }
  return callId;
}

async function loadCallState(callId: string): Promise<{
  status: string;
  endedAt: Date | null;
  joined: number;
  left: number;
}> {
  const state = await pool.query<{
    status: string;
    ended_at: Date | null;
    joined: string;
    left: string;
  }>(
    `SELECT c.status, c.ended_at,
            COUNT(*) FILTER (WHERE cp.left_at IS NULL) AS joined,
            COUNT(*) FILTER (WHERE cp.left_at IS NOT NULL) AS left
     FROM calls c
     LEFT JOIN call_participants cp ON cp.call_id = c.id
     WHERE c.id = $1
     GROUP BY c.id`,
    [callId],
  );
  const row = state.rows[0]!;
  return {
    status: row.status,
    endedAt: row.ended_at,
    joined: Number(row.joined),
    left: Number(row.left),
  };
}

function frames(socket: { received: any[] }, type: string, callId: string) {
  return socket.received.filter((frame) => frame.type === type && frame.callId === callId);
}

describe('LiveKit call webhook', () => {
  it('accepts a signed room_finished webhook, ends a ringing call, and is idempotent', async () => {
    const current = await startApp();
    const benId = await seedMember(pool, fx.workspaceId, 'ben', 'Ben');
    const aliceSocket = fakeSocket();
    const benSocket = fakeSocket();
    hub.addClient(aliceSocket, { id: fx.userId, handle: 'alice', displayName: 'Alice' });
    hub.addClient(benSocket, { id: benId, handle: 'ben', displayName: 'Ben' });
    const callId = await seedCall([fx.userId], 'ringing');
    const body = JSON.stringify({ event: 'room_finished', room: webhookRoom(callId) });

    const res = await postWebhook(current, body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await loadCallState(callId)).toMatchObject({
      status: 'ended',
      joined: 0,
      left: 1,
    });
    expect((await loadCallState(callId)).endedAt).toBeTruthy();
    expect(frames(aliceSocket, 'call.ended', callId)).toHaveLength(1);
    expect(frames(benSocket, 'call.ended', callId)).toHaveLength(1);

    const retry = await postWebhook(current, body);
    expect(retry.statusCode).toBe(200);
    expect(frames(aliceSocket, 'call.ended', callId)).toHaveLength(1);
    expect(frames(benSocket, 'call.ended', callId)).toHaveLength(1);
  });

  it('accepts signed participant_left webhooks and ends the call when none remain', async () => {
    const current = await startApp();
    const benId = await seedMember(pool, fx.workspaceId, 'ben', 'Ben');
    const aliceSocket = fakeSocket();
    const benSocket = fakeSocket();
    hub.addClient(aliceSocket, { id: fx.userId, handle: 'alice', displayName: 'Alice' });
    hub.addClient(benSocket, { id: benId, handle: 'ben', displayName: 'Ben' });
    const callId = await seedCall([fx.userId, benId]);

    const aliceLeftBody = JSON.stringify({
      event: 'participant_left',
      room: webhookRoom(callId),
      participant: { sid: 'PA_alice', identity: fx.userId },
    });
    const aliceLeft = await postWebhook(current, aliceLeftBody);
    expect(aliceLeft.statusCode).toBe(200);
    expect(await loadCallState(callId)).toMatchObject({
      status: 'active',
      joined: 1,
      left: 1,
    });
    expect(frames(aliceSocket, 'call.participant_left', callId)).toHaveLength(1);
    expect(frames(benSocket, 'call.participant_left', callId)).toHaveLength(1);
    expect(frames(aliceSocket, 'call.ended', callId)).toHaveLength(0);

    const benLeftBody = JSON.stringify({
      event: 'participant_left',
      room: webhookRoom(callId),
      participant: { sid: 'PA_ben', identity: benId },
    });
    const benLeft = await postWebhook(current, benLeftBody);
    expect(benLeft.statusCode).toBe(200);
    expect(await loadCallState(callId)).toMatchObject({
      status: 'ended',
      joined: 0,
      left: 2,
    });
    expect((await loadCallState(callId)).endedAt).toBeTruthy();
    expect(frames(aliceSocket, 'call.ended', callId)).toHaveLength(1);
    expect(frames(benSocket, 'call.ended', callId)).toHaveLength(1);

    const retry = await postWebhook(current, benLeftBody);
    expect(retry.statusCode).toBe(200);
    expect(frames(aliceSocket, 'call.participant_left', callId)).toHaveLength(2);
    expect(frames(aliceSocket, 'call.ended', callId)).toHaveLength(1);
  });

  it('rejects invalid signatures without touching call state', async () => {
    const current = await startApp();
    const callId = await seedCall([fx.userId], 'ringing');
    const body = JSON.stringify({ event: 'room_finished', room: webhookRoom(callId) });
    const badToken = await signWebhook(JSON.stringify({ event: 'room_finished', room: webhookRoom(randomUUID()) }));

    const res = await postWebhook(current, body, badToken);
    expect(res.statusCode).toBe(401);
    expect(await loadCallState(callId)).toMatchObject({
      status: 'ringing',
      joined: 1,
      left: 0,
    });
  });

  it('does not register the webhook route without LiveKit webhook credentials', async () => {
    const current = await startApp(null);
    const body = JSON.stringify({ event: 'room_finished', room: webhookRoom(randomUUID()) });

    const res = await postWebhook(current, body);
    expect(res.statusCode).toBe(404);
  });
});
