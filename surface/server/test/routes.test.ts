import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
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

describe('extracted routes', () => {
  it('serves the health check', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('registers and unregisters push tokens', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { handle: 'alice', displayName: 'Alice' },
    });
    const token = `ExponentPushToken[route-${Date.now()}]`;

    const registered = await app.inject({
      method: 'POST',
      url: '/api/push/register',
      headers: { cookie: login.headers['set-cookie'] as string },
      payload: { token, platform: 'android', kind: 'expo' },
    });

    expect(registered.statusCode).toBe(200);
    expect(registered.json()).toEqual({ ok: true });
    await expect(
      pool.query('SELECT platform, kind FROM push_tokens WHERE token = $1', [token]),
    ).resolves.toMatchObject({
      rows: [{ platform: 'android', kind: 'expo' }],
    });

    const unregistered = await app.inject({
      method: 'POST',
      url: '/api/push/unregister',
      headers: { cookie: login.headers['set-cookie'] as string },
      payload: { token },
    });

    expect(unregistered.statusCode).toBe(200);
    expect(unregistered.json()).toEqual({ ok: true });
    await expect(pool.query('SELECT 1 FROM push_tokens WHERE token = $1', [token])).resolves.toMatchObject({
      rowCount: 0,
    });
  });

  it('registers webpush subscriptions by endpoint token', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { handle: 'alice', displayName: 'Alice' },
    });
    const subscription = {
      endpoint: 'https://push.example.test/subscriptions/route-webpush',
      keys: {
        p256dh:
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg', // gitleaks:allow — public RFC 8291 Appendix A test vector
      },
    };

    const registered = await app.inject({
      method: 'POST',
      url: '/api/push/register',
      headers: { cookie: login.headers['set-cookie'] as string },
      payload: {
        token: subscription.endpoint,
        platform: 'web',
        kind: 'webpush',
        subscription,
      },
    });

    expect(registered.statusCode).toBe(200);
    await expect(
      pool.query('SELECT platform, kind, subscription FROM push_tokens WHERE token = $1', [
        subscription.endpoint,
      ]),
    ).resolves.toMatchObject({
      rows: [{ platform: 'web', kind: 'webpush', subscription }],
    });
  });

  it('rejects unauthenticated push registration', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/register',
      payload: { token: 'ExponentPushToken[route-auth]' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized', message: 'login required' });
  });

  it('validates push registration input', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { handle: 'alice', displayName: 'Alice' },
    });
    const headers = { cookie: login.headers['set-cookie'] as string };

    const missingToken = await app.inject({
      method: 'POST',
      url: '/api/push/register',
      headers,
      payload: {},
    });
    expect(missingToken.statusCode).toBe(400);
    expect(missingToken.json()).toEqual({ error: 'bad_request', message: 'token required' });

    const overlongToken = await app.inject({
      method: 'POST',
      url: '/api/push/register',
      headers,
      payload: { token: 'x'.repeat(201) },
    });
    expect(overlongToken.statusCode).toBe(400);
    expect(overlongToken.json()).toEqual({ error: 'bad_request', message: 'token required' });

    const invalidKind = await app.inject({
      method: 'POST',
      url: '/api/push/register',
      headers,
      payload: { token: 'ExponentPushToken[route-kind]', kind: 'apns' },
    });
    expect(invalidKind.statusCode).toBe(400);
    expect(invalidKind.json()).toEqual({
      error: 'bad_request',
      message: 'kind must be expo, voip, or webpush',
    });

    const mismatchedWebpush = await app.inject({
      method: 'POST',
      url: '/api/push/register',
      headers,
      payload: {
        token: 'https://push.example.test/other',
        platform: 'web',
        kind: 'webpush',
        subscription: {
          endpoint: 'https://push.example.test/subscriptions/route-webpush',
          keys: { p256dh: 'p256dh', auth: 'auth' },
        },
      },
    });
    expect(mismatchedWebpush.statusCode).toBe(400);
    expect(mismatchedWebpush.json()).toEqual({
      error: 'bad_request',
      message: 'token must match subscription endpoint',
    });
  });

  it('serves the configured VAPID public key', async () => {
    const oldKey = config.vapidPublicKey;
    config.vapidPublicKey = 'public-key-for-test';
    try {
      const res = await app.inject({ method: 'GET', url: '/api/push/vapid-public-key' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ key: 'public-key-for-test' });
    } finally {
      config.vapidPublicKey = oldKey;
    }
  });

  it('validates push unregistration input', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { handle: 'alice', displayName: 'Alice' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/push/unregister',
      headers: { cookie: login.headers['set-cookie'] as string },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request', message: 'token required' });
  });
});
