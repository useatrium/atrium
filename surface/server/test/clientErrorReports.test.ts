import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { recordClientErrorReport } from '../src/client-error-reports.js';
import { createTestPool, seedFixture, truncateAll } from './helpers.js';

let pool: pg.Pool;

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
});

describe('client error reports', () => {
  it('stores hashes and metadata without raw client error content', async () => {
    const fixture = await seedFixture(pool);
    const report = await recordClientErrorReport(pool, {
      userId: fixture.userId,
      kind: 'unhandledrejection',
      errorName: 'Error',
      message: 'secret failure message',
      stack: 'Error: secret failure message\n at render',
      urlPath: 'https://atrium.local/sessions/abc?token=secret',
      component: 'window',
      userAgent: 'test-agent',
    });

    expect(report.messageHash).toBe(sha256('secret failure message'));
    expect(report.stackHash).toBe(sha256('Error: secret failure message\n at render'));
    expect(report.messageLength).toBe('secret failure message'.length);
    expect(report.urlPath).toBe('/sessions/abc');
    expect(JSON.stringify(report)).not.toContain('secret failure message');
    expect(JSON.stringify(report)).not.toContain('token=secret');
  });
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
