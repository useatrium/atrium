import { DEFAULT_PREFS } from '@atrium/surface-client/prefs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { WsHub, type HubSocket } from '../src/hub.js';
import { createTestPool, seedFixture, truncateAll } from './helpers.js';

let pool: pg.Pool;
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
  await seedFixture(pool);
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

describe('user prefs', () => {
  it('/auth/me returns default prefs for a fresh user', async () => {
    const { cookie } = await login('alice', 'Alice');

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ prefs: DEFAULT_PREFS });
  });

  it('PATCH /api/me/prefs merges partial updates and persists them', async () => {
    const { cookie } = await login('alice', 'Alice');

    const theme = await app.inject({
      method: 'PATCH',
      url: '/api/me/prefs',
      headers: { cookie },
      payload: { theme: 'dark' },
    });
    expect(theme.statusCode).toBe(200);
    expect(theme.json().prefs).toEqual({ ...DEFAULT_PREFS, theme: 'dark' });

    const accent = await app.inject({
      method: 'PATCH',
      url: '/api/me/prefs',
      headers: { cookie },
      payload: { accent: 'teal' },
    });
    expect(accent.statusCode).toBe(200);
    expect(accent.json().prefs).toEqual({ ...DEFAULT_PREFS, theme: 'dark', accent: 'teal' });

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.json().prefs).toEqual({ ...DEFAULT_PREFS, theme: 'dark', accent: 'teal' });
  });

  it('drops invalid values and unknown keys', async () => {
    const { cookie } = await login('alice', 'Alice');
    await app.inject({
      method: 'PATCH',
      url: '/api/me/prefs',
      headers: { cookie },
      payload: { theme: 'dark', fontScale: 1.125 },
    });

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/me/prefs',
      headers: { cookie },
      payload: { theme: 'blue', fontScale: 3, hacker: 'x' },
    });

    expect(invalid.statusCode).toBe(200);
    expect(invalid.json().prefs).toEqual({ ...DEFAULT_PREFS, theme: 'dark', fontScale: 1.125 });
    expect(invalid.json().prefs).not.toHaveProperty('hacker');
  });

  it('rejects non-object bodies', async () => {
    const { cookie } = await login('alice', 'Alice');

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/me/prefs',
      headers: { cookie },
      payload: ['bad'],
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: 'bad_request' });
  });

  it('fans out prefs changes to the same user only', async () => {
    const { cookie, user: alice } = await login('alice', 'Alice');
    const { user: ben } = await login('ben', 'Ben');
    const aliceCaller = fakeSocket();
    const aliceOther = fakeSocket();
    const benSocket = fakeSocket();
    hub.addClient(aliceCaller, alice);
    hub.addClient(aliceOther, alice);
    hub.addClient(benSocket, ben);

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/me/prefs',
      headers: { cookie },
      payload: { theme: 'dark' },
    });

    expect(patched.statusCode).toBe(200);
    const expected = expect.objectContaining({ type: 'prefs', prefs: patched.json().prefs });
    expect(aliceCaller.received).toContainEqual(expected);
    expect(aliceOther.received).toContainEqual(expected);
    expect(benSocket.received).toEqual([]);
  });

  it('rejects unauthenticated PATCH', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me/prefs',
      payload: { theme: 'dark' },
    });

    expect(res.statusCode).toBe(401);
  });
});
