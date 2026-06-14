import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { buildApp } from './app.js';
import { getVoipSender, type IncomingCallVoipPayload, type VoipPushSender, type VoipPushToken } from './voip.js';
import { WsHub } from './hub.js';
import type { CallTokenService } from './livekit.js';
import { createTestPool, seedFixture, seedMember, truncateAll, type Fixture } from '../test/helpers.js';

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

function fakeVoipSender(records: Array<{ token: VoipPushToken; payload: IncomingCallVoipPayload }>): VoipPushSender {
  return {
    name: 'fake',
    async send(token, payload) {
      records.push({ token, payload });
      return { status: 'sent' };
    },
  };
}

async function startApp(voip?: VoipPushSender) {
  app = await buildApp({
    pool,
    hub,
    calls: callService,
    voip,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
  return app;
}

async function login(handle: string, displayName = handle) {
  const res = await app!.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  expect(res.statusCode).toBe(200);
  return { cookie: res.headers['set-cookie'] as string, user: res.json().user };
}

async function registerToken(
  userId: string,
  token: string,
  platform: 'ios' | 'android',
  kind: 'expo' | 'voip',
) {
  await pool.query(
    `INSERT INTO push_tokens (token, user_id, platform, kind)
     VALUES ($1, $2, $3, $4)`,
    [token, userId, platform, kind],
  );
}

describe('VoIP push registration and call fanout', () => {
  it('stores push token kind on register and defaults to expo', async () => {
    const current = await startApp();
    const { cookie } = await login('alice', 'Alice');

    const voip = await current.inject({
      method: 'POST',
      url: '/api/push/register',
      headers: { cookie },
      payload: { token: 'voip-token-1', platform: 'ios', kind: 'voip' },
    });
    expect(voip.statusCode).toBe(200);

    const expo = await current.inject({
      method: 'POST',
      url: '/api/push/register',
      headers: { cookie },
      payload: { token: 'expo-token-1', platform: 'android' },
    });
    expect(expo.statusCode).toBe(200);

    const bad = await current.inject({
      method: 'POST',
      url: '/api/push/register',
      headers: { cookie },
      payload: { token: 'bad-token-1', platform: 'ios', kind: 'pushkit' },
    });
    expect(bad.statusCode).toBe(400);

    const rows = await pool.query<{ token: string; platform: string; kind: string }>(
      'SELECT token, platform, kind FROM push_tokens ORDER BY token ASC',
    );
    expect(rows.rows).toEqual([
      { token: 'expo-token-1', platform: 'android', kind: 'expo' },
      { token: 'voip-token-1', platform: 'ios', kind: 'voip' },
    ]);
  });

  it('sends incoming-call VoIP payloads to callee voip tokens only', async () => {
    const records: Array<{ token: VoipPushToken; payload: IncomingCallVoipPayload }> = [];
    const current = await startApp(fakeVoipSender(records));
    const benId = await seedMember(pool, fx.workspaceId, 'ben', 'Ben');
    const caraId = await seedMember(pool, fx.workspaceId, 'cara', 'Cara');
    const { cookie: aliceCookie, user: alice } = await login('alice', 'Alice');
    const { user: ben } = await login('ben', 'Ben');

    const dmRes = await current.inject({
      method: 'POST',
      url: '/api/dms',
      headers: { cookie: aliceCookie },
      payload: { userId: ben.id },
    });
    expect(dmRes.statusCode).toBe(201);
    const channelId = dmRes.json().channel.id as string;

    await registerToken(benId, 'ben-voip-ios', 'ios', 'voip');
    await registerToken(benId, 'ben-expo-ios', 'ios', 'expo');
    await registerToken(fx.userId, 'alice-voip-ios', 'ios', 'voip');
    await registerToken(caraId, 'cara-voip-android', 'android', 'voip');

    const start = await current.inject({
      method: 'POST',
      url: '/api/calls',
      headers: { cookie: aliceCookie },
      payload: { channelId, opId: randomUUID() },
    });
    expect(start.statusCode).toBe(200);
    const started = start.json();

    await waitFor(() => records.length === 1);
    expect(records[0]!.token).toMatchObject({
      token: 'ben-voip-ios',
      userId: benId,
      platform: 'ios',
    });
    expect(records[0]!.payload).toEqual({
      type: 'incoming_call',
      callId: started.call.id,
      callerId: alice.id,
      callerName: 'Alice',
      channelId,
      channelName: 'Alice',
      room: `call:${started.call.id}`,
    });
  });

  it('uses noop when VoIP push credentials are absent', async () => {
    const sender = getVoipSender({
      apnsTeamId: '',
      apnsKeyId: '',
      apnsAuthKeyP8: '',
      apnsBundleId: '',
      apnsSandbox: false,
      fcmProjectId: '',
      fcmServiceAccountJson: '',
    });
    expect(sender.name).toBe('noop');
    await expect(
      sender.send(
        { token: 'token', userId: fx.userId, platform: 'ios' },
        {
          type: 'incoming_call',
          callId: randomUUID(),
          callerId: randomUUID(),
          callerName: 'Alice',
          channelId: randomUUID(),
          channelName: 'Alice',
          room: 'call:test',
        },
      ),
    ).resolves.toEqual({ status: 'skipped' });
  });
});

async function waitFor(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition was not met before timeout');
}
