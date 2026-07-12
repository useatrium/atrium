import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { WsHub, type HubSocket } from '../src/hub.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fixture: Fixture;
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
  fixture = await seedFixture(pool);
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

async function login() {
  const result = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
  expect(result.statusCode).toBe(200);
  return {
    cookie: result.headers['set-cookie'] as string,
    user: result.json().user as { id: string; handle: string; displayName: string },
  };
}

async function insertSession(): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO sessions (
       workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by, driver_id
     ) VALUES ($1, $2, $3, 'codex', 'Archive me', 'completed', $4, $4)
     RETURNING id`,
    [fixture.workspaceId, fixture.channelId, `test:${Date.now()}`, fixture.userId],
  );
  return inserted.rows[0]!.id;
}

describe('archive and pin routes', () => {
  it('persists global archive events, sends per-user pin frames, and revives a channel on message activity', async () => {
    const { cookie, user } = await login();
    const socket = fakeSocket();
    const client = hub.addClient(socket, user);
    hub.subscribe(client, [fixture.channelId]);
    const sessionId = await insertSession();

    const channelArchive = await app.inject({
      method: 'POST',
      url: `/api/channels/${fixture.channelId}/archive`,
      headers: { cookie },
      payload: { archived: true },
    });
    expect(channelArchive.statusCode).toBe(200);
    expect(channelArchive.json()).toMatchObject({ archived: true, archivedAt: expect.any(String) });
    expect(socket.received).toContainEqual(
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({
          type: 'channel.archived',
          payload: expect.objectContaining({ channelId: fixture.channelId }),
        }),
      }),
    );

    const channelPin = await app.inject({
      method: 'POST',
      url: `/api/channels/${fixture.channelId}/pin`,
      headers: { cookie },
      payload: { pinned: true },
    });
    expect(channelPin.json()).toEqual({ pinned: true });
    expect(socket.received).toContainEqual(
      expect.objectContaining({ type: 'channel-pinned', channelId: fixture.channelId, pinned: true }),
    );

    const sessionArchive = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/archive`,
      headers: { cookie },
      payload: { archived: true },
    });
    expect(sessionArchive.statusCode).toBe(200);
    expect(sessionArchive.json()).toMatchObject({ archived: true, archivedAt: expect.any(String) });
    expect(socket.received).toContainEqual(
      expect.objectContaining({ type: 'event', event: expect.objectContaining({ type: 'session.archived' }) }),
    );

    const sessionPin = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/pin`,
      headers: { cookie },
      payload: { pinned: true },
    });
    expect(sessionPin.json()).toEqual({ pinned: true });
    expect(socket.received).toContainEqual(
      expect.objectContaining({ type: 'session-pinned', sessionId, pinned: true }),
    );

    const singleSession = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}`,
      headers: { cookie },
    });
    expect(singleSession.json().session).toMatchObject({
      id: sessionId,
      archivedAt: expect.any(String),
      pinned: true,
    });

    const archivedSessions = await app.inject({
      method: 'GET',
      url: '/api/sessions?status=archived',
      headers: { cookie },
    });
    expect(archivedSessions.json().sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sessionId, archivedAt: expect.any(String), pinned: true }),
      ]),
    );

    const activeSessions = await app.inject({
      method: 'GET',
      url: '/api/sessions?status=all',
      headers: { cookie },
    });
    expect(activeSessions.json().sessions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sessionId })]),
    );

    const message = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { cookie },
      payload: { channelId: fixture.channelId, text: 'wake this channel', clientMsgId: 'wake-channel' },
    });
    expect(message.statusCode).toBe(201);
    expect(socket.received).toContainEqual(
      expect.objectContaining({ type: 'event', event: expect.objectContaining({ type: 'channel.unarchived' }) }),
    );
    const channel = await pool.query<{ archived_at: Date | null }>('SELECT archived_at FROM channels WHERE id = $1', [
      fixture.channelId,
    ]);
    expect(channel.rows[0]!.archived_at).toBeNull();
  });
});
