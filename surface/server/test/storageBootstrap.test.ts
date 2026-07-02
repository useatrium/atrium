import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { isNoSuchBucketError, startStorageBootstrap, storageReady } from '../src/s3.js';
import type { Db } from '../src/db.js';

let app: Awaited<ReturnType<typeof buildApp>> | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

const silentLog = { info: () => {}, error: () => {} };

async function healthzStatus(): Promise<number> {
  const pool = { query: vi.fn() } as unknown as Db;
  app = await buildApp({
    pool,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
    rateLimit: false,
  });
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  return res.statusCode;
}

describe('isNoSuchBucketError', () => {
  it('matches the definitive not-found shapes only', () => {
    expect(isNoSuchBucketError({ name: 'NotFound' })).toBe(true);
    expect(isNoSuchBucketError({ name: 'NoSuchBucket' })).toBe(true);
    expect(isNoSuchBucketError({ Code: 'NoSuchBucket' })).toBe(true);
    expect(isNoSuchBucketError({ $metadata: { httpStatusCode: 404 } })).toBe(true);
    // Transient/auth failures must NOT trigger CreateBucket.
    expect(isNoSuchBucketError({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })).toBe(false);
    expect(isNoSuchBucketError(new Error('connect ECONNREFUSED'))).toBe(false);
    expect(isNoSuchBucketError(undefined)).toBe(false);
  });
});

// Module-level storage state is sticky by design, so these run as one ordered
// sequence: ungated (never started) → started-and-failing → succeeded.
describe('storage bootstrap health gate (#215)', () => {
  it('healthz is ungated when the bootstrap never started (tests/tooling builds)', async () => {
    expect(storageReady()).toBeNull();
    expect(await healthzStatus()).toBe(200);
  });

  it('healthz turns 503 while the bucket check fails, and recovers on success', async () => {
    // Failing ensure: state flips to false and stays there across retries.
    const failing = startStorageBootstrap(silentLog, {
      retryMs: 5,
      ensure: () => Promise.reject(new Error('store down')),
    });
    expect(storageReady()).toBe(false);
    expect(await healthzStatus()).toBe(503);
    failing.stop();
    await app?.close();
    app = null;

    // Succeeding ensure: sticky-ready, healthz green.
    const ok = startStorageBootstrap(silentLog, { ensure: () => Promise.resolve() });
    await vi.waitFor(() => expect(storageReady()).toBe(true));
    ok.stop();
    expect(await healthzStatus()).toBe(200);
  });
});
