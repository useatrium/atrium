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
});
