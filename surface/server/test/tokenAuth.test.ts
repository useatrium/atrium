// Bearer-token auth for native clients: /auth/login returns the signed
// session token; HTTP routes accept it via Authorization header.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { createTestPool, seedFixture, truncateAll } from './helpers.js';

let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  pool = await createTestPool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  await seedFixture(pool);
  app = await buildApp({
    pool,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

describe('bearer-token auth', () => {
  it('login returns a token equal to the session cookie value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { handle: 'alice', displayName: 'Alice' },
    });
    expect(res.statusCode).toBe(200);
    const token = res.json().token as string;
    expect(typeof token).toBe('string');
    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toContain(token);
  });

  it('authorizes HTTP requests with Authorization: Bearer and no cookie', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { handle: 'alice', displayName: 'Alice' },
    });
    const token = login.json().token as string;

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.handle).toBe('alice');

    const channels = await app.inject({
      method: 'GET',
      url: '/api/channels',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(channels.statusCode).toBe(200);
  });

  it('rejects a tampered bearer token', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { handle: 'alice', displayName: 'Alice' },
    });
    const token = login.json().token as string;
    // Flip a char in the middle of the MAC — the final base64url char only
    // carries padding bits, so flipping it wouldn't change the decoded bytes.
    const dot = token.lastIndexOf('.');
    const i = dot + 10;
    const flipped = token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1);
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${flipped}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it('rejects an expired session', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { handle: 'alice', displayName: 'Alice' },
    });
    const token = login.json().token as string;
    const sessionId = token.slice(0, token.lastIndexOf('.'));
    await pool.query(`UPDATE auth_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [sessionId]);
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it('slides expiry forward when a session nears its deadline', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { handle: 'alice', displayName: 'Alice' },
    });
    const token = login.json().token as string;
    const sessionId = token.slice(0, token.lastIndexOf('.'));
    await pool.query(`UPDATE auth_sessions SET expires_at = now() + interval '5 days' WHERE id = $1`, [sessionId]);
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    // Renewal is fire-and-forget — poll briefly for it to land.
    let renewed = false;
    for (let i = 0; i < 20 && !renewed; i++) {
      const row = await pool.query<{ days: number }>(
        `SELECT EXTRACT(EPOCH FROM (expires_at - now())) / 86400 AS days
         FROM auth_sessions WHERE id = $1`,
        [sessionId],
      );
      renewed = Number(row.rows[0]?.days) > 20;
      if (!renewed) await new Promise((r) => setTimeout(r, 50));
    }
    expect(renewed).toBe(true);
  });

  it('logout via bearer revokes the session', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { handle: 'alice', displayName: 'Alice' },
    });
    const token = login.json().token as string;
    const headers = { authorization: `Bearer ${token}` };

    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers, payload: {} });
    expect(out.statusCode).toBe(200);

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers });
    expect(me.statusCode).toBe(401);
  });
});
