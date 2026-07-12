import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_PROVIDER, PROXY_CREDENTIAL_SENTINEL, ProviderCredentials } from '../src/provider-credentials.js';
import { createTestPool, seedFixture, truncateAll } from './helpers.js';

const TEST_SECRET = 'provider-credentials-test-secret';
const TEST_CODEX_AUTH_JSON = JSON.stringify({
  OPENAI_API_KEY: null,
  auth_mode: 'chatgpt',
  tokens: {
    access_token: 'test-codex-access-token',
    account_id: '00000000-0000-0000-0000-000000000000',
  },
});

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

describe('ProviderCredentials proxy status healing', () => {
  it('reconnects proxy placeholder rows without touching real-token rows', async () => {
    const fixture = await seedFixture(pool);
    const credentials = new ProviderCredentials(pool, TEST_SECRET);

    await credentials.markConnectedViaProxy(fixture.userId, CODEX_PROVIDER);
    await credentials.markCodexAuthRequired(fixture.userId, 'transient codex auth failure');
    await credentials.markConnectedIfProxy(fixture.userId, CODEX_PROVIDER);

    const proxyRow = await readCodexCredential(fixture.userId);
    expect(proxyRow).toMatchObject({
      token_ciphertext: PROXY_CREDENTIAL_SENTINEL,
      status: 'connected',
      last_error: null,
    });

    await credentials.upsertCodexAuthJson(fixture.userId, TEST_CODEX_AUTH_JSON);
    await credentials.markCodexAuthRequired(fixture.userId, 'real token auth failure');
    await credentials.markConnectedIfProxy(fixture.userId, CODEX_PROVIDER);

    const realTokenRow = await readCodexCredential(fixture.userId);
    expect(realTokenRow?.token_ciphertext).not.toBe(PROXY_CREDENTIAL_SENTINEL);
    expect(realTokenRow).toMatchObject({
      status: 'needs_auth',
      last_error: 'real token auth failure',
    });
  });
});

async function readCodexCredential(userId: string): Promise<{
  token_ciphertext: string;
  status: string;
  last_error: string | null;
} | null> {
  const res = await pool.query(
    `SELECT token_ciphertext, status, last_error
     FROM user_provider_credentials
     WHERE user_id = $1 AND provider = $2`,
    [userId, CODEX_PROVIDER],
  );
  return res.rows[0] ?? null;
}
