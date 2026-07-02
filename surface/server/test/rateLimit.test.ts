import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
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
      message: expect.stringContaining('rate limit exceeded'),
    });
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
