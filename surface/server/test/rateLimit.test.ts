import client from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { signSession } from '../src/cookie.js';
import type { Db } from '../src/db.js';

let app: Awaited<ReturnType<typeof buildApp>> | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

describe('rate limiting', () => {
  it('returns the app error envelope when a client exceeds the limit', async () => {
    const pool = { query: vi.fn() } as unknown as Db;
    app = await buildApp({
      pool,
      sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
      rateLimit: { max: 1 },
    });
    await app.ready();

    const first = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(first.statusCode).toBe(401);

    const second = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({
      error: 'rate_limited',
      message: expect.stringMatching(/^rate limit exceeded, retry in .+$/),
    });
  });

  it.each([
    ['X-Forwarded-For', (ip: string) => ({ 'x-forwarded-for': ip })],
    ['CF-Connecting-IP', (ip: string) => ({ 'cf-connecting-ip': ip, 'x-forwarded-for': '192.0.2.10' })],
  ])('gives different %s clients separate buckets', async (_header, headersFor) => {
    const pool = { query: vi.fn() } as unknown as Db;
    app = await buildApp({
      pool,
      sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
      rateLimit: { max: 1 },
    });
    await app.ready();

    const firstClient = headersFor('198.51.100.1');
    const secondClient = headersFor('198.51.100.2');
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: firstClient })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: secondClient })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: firstClient })).statusCode).toBe(429);
  });

  it('gives different session cookies separate buckets', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Db;
    app = await buildApp({
      pool,
      sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
      rateLimit: { max: 1 },
    });
    await app.ready();

    const cookieFor = (id: string) => `${config.sessionCookie}=${signSession(id, config.sessionSecret)}`;
    const firstCookie = cookieFor('00000000-0000-4000-8000-000000000001');
    const secondCookie = cookieFor('00000000-0000-4000-8000-000000000002');
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: firstCookie } })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: secondCookie } })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: firstCookie } })).statusCode).toBe(
      429,
    );
  });

  it('does not grant forged (unsigned) cookies their own buckets', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Db;
    app = await buildApp({
      pool,
      sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
      rateLimit: { max: 1 },
    });
    await app.ready();

    // Same client IP, different unverifiable cookie values: both must land in
    // the shared IP bucket, so the second request rate-limits.
    const forged = (id: string) => ({ cookie: `${config.sessionCookie}=${id}.not-a-real-signature` });
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: forged('a') })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: forged('b') })).statusCode).toBe(429);
  });

  it('increments the rate-limited counter once for a 429', async () => {
    const before = await rateLimitedCount('/auth/me');
    const pool = { query: vi.fn() } as unknown as Db;
    app = await buildApp({
      pool,
      sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
      rateLimit: { max: 1 },
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/auth/me' });
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(429);
    expect(await rateLimitedCount('/auth/me')).toBe(before + 1);
  });

  it('exempts internal service routes from the per-IP bucket', async () => {
    const pool = { query: vi.fn() } as unknown as Db;
    app = await buildApp({
      pool,
      sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
      rateLimit: { max: 1 },
    });
    await app.ready();

    // Exhaust the bucket with a public route…
    await app.inject({ method: 'GET', url: '/auth/me' });
    const throttled = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(throttled.statusCode).toBe(429);

    // …internal routes (Centaur node-sync capture/changes) still get through:
    // they must 401 on auth, never 429 on the shared bucket.
    for (let i = 0; i < 3; i += 1) {
      const internal = await app.inject({
        method: 'GET',
        url: '/api/internal/sessions/surface:x/artifacts/changes?since=0.0',
      });
      expect(internal.statusCode).not.toBe(429);
    }
  });
});

async function rateLimitedCount(route: string): Promise<number> {
  const metric = client.register.getSingleMetric('atrium_rate_limited_total');
  const values = metric ? (await metric.get()).values : [];
  return values.filter((value) => value.labels.route === route).reduce((sum, value) => sum + value.value, 0);
}
