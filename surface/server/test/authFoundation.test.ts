import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createTestPool, truncateAll } from './helpers.js';

let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
const originalAuthOpen = config.authOpen;
const originalAuthDevCodes = config.authDevCodes;
const originalGoogleClientId = config.googleClientId;
const originalGoogleClientSecret = config.googleClientSecret;
const originalGoogleRedirectUrl = config.googleRedirectUrl;

async function startApp(rateLimit?: false | { max?: number; loginMax?: number }) {
  app = await buildApp({
    pool,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
    rateLimit,
  });
  await app.ready();
}

async function requestCode(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/email/request',
    payload: { email },
  });
  expect(res.statusCode).toBe(200);
  return res.json().devCode as string;
}

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  config.authOpen = originalAuthOpen;
  config.authDevCodes = originalAuthDevCodes;
  config.googleClientId = originalGoogleClientId;
  config.googleClientSecret = originalGoogleClientSecret;
  config.googleRedirectUrl = originalGoogleRedirectUrl;
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  config.authOpen = true;
  config.authDevCodes = true;
  config.googleClientId = '';
  config.googleClientSecret = '';
  config.googleRedirectUrl = '';
});

afterEach(async () => {
  await app?.close();
});

describe('auth foundation', () => {
  it('reports available auth methods', async () => {
    config.authOpen = false;
    await startApp(false);
    const res = await app.inject({ method: 'GET', url: '/auth/methods' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ open: false, email: true, google: false });
  });

  it('requests and verifies an email code', async () => {
    await startApp(false);
    const code = await requestCode('Alice@example.com');

    const verify = await app.inject({
      method: 'POST',
      url: '/auth/email/verify',
      payload: { email: 'alice@example.com', code },
    });

    expect(verify.statusCode).toBe(200);
    expect(verify.json().user).toMatchObject({
      handle: 'alice',
      displayName: 'alice',
    });
    expect(typeof verify.json().token).toBe('string');
    expect(verify.headers['set-cookie']).toContain(verify.json().token);
  });

  it('allows only one concurrent verification of a valid email code', async () => {
    await startApp(false);
    const code = await requestCode('race@example.com');

    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: 'POST',
          url: '/auth/email/verify',
          payload: { email: 'race@example.com', code },
        }),
      ),
    );

    expect(attempts.filter((res) => res.statusCode === 200)).toHaveLength(1);
    expect(attempts.filter((res) => res.statusCode === 400)).toHaveLength(19);
    const row = await pool.query('SELECT consumed_at, attempts FROM login_codes WHERE email = $1', [
      'race@example.com',
    ]);
    expect(row.rows[0].consumed_at).toBeInstanceOf(Date);
  });

  it('rejects an expired email code', async () => {
    await startApp(false);
    const code = await requestCode('expired@example.com');
    await pool.query(`UPDATE login_codes SET expires_at = now() - interval '1 minute'`);

    const verify = await app.inject({
      method: 'POST',
      url: '/auth/email/verify',
      payload: { email: 'expired@example.com', code },
    });

    expect(verify.statusCode).toBe(400);
    expect(verify.json().error).toBe('invalid_code');
  });

  it('consumes a code after five wrong attempts', async () => {
    await startApp(false);
    const code = await requestCode('lockout@example.com');

    for (let i = 0; i < 5; i += 1) {
      const wrong = await app.inject({
        method: 'POST',
        url: '/auth/email/verify',
        payload: { email: 'lockout@example.com', code: '000000' },
      });
      expect(wrong.statusCode).toBe(400);
    }

    const verify = await app.inject({
      method: 'POST',
      url: '/auth/email/verify',
      payload: { email: 'lockout@example.com', code },
    });
    expect(verify.statusCode).toBe(400);
    expect(verify.json().error).toBe('invalid_code');
  });

  it('does not allow code reuse', async () => {
    await startApp(false);
    const code = await requestCode('single@example.com');

    const first = await app.inject({
      method: 'POST',
      url: '/auth/email/verify',
      payload: { email: 'single@example.com', code },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/auth/email/verify',
      payload: { email: 'single@example.com', code },
    });
    expect(second.statusCode).toBe(400);
  });

  it('rate limits email code requests more tightly than the app default', async () => {
    await startApp({ max: 100 });
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/email/request',
        payload: { email: `rate${i}@example.com` },
      });
      expect(res.statusCode).toBe(200);
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/auth/email/request',
      payload: { email: 'rate6@example.com' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('rate_limited');
  });

  it('closes handle login without closing email login', async () => {
    config.authOpen = false;
    await startApp(false);

    const handleLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { handle: 'alice', displayName: 'Alice' },
    });
    expect(handleLogin.statusCode).toBe(403);
    expect(handleLogin.json().error).toBe('auth_closed');

    const code = await requestCode('closed@example.com');
    const emailLogin = await app.inject({
      method: 'POST',
      url: '/auth/email/verify',
      payload: { email: 'closed@example.com', code },
    });
    expect(emailLogin.statusCode).toBe(200);
  });

  it('suffixes generated handles on local-part collision', async () => {
    await startApp(false);
    const firstCode = await requestCode('same@example.com');
    const secondCode = await requestCode('same@other.example');

    const first = await app.inject({
      method: 'POST',
      url: '/auth/email/verify',
      payload: { email: 'same@example.com', code: firstCode },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/auth/email/verify',
      payload: { email: 'same@other.example', code: secondCode },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().user.handle).toBe('same');
    expect(second.json().user.handle).toBe('same-2');
  });
});
