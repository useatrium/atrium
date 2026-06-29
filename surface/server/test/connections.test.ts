import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { IronControlAdminClient } from '../src/iron-control.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;
let ironCalls: Array<{ url: string; init: RequestInit }>;
const originalGithubAppConfig = {
  clientId: config.githubAppClientId,
  clientSecret: config.githubAppClientSecret,
  redirectUrl: config.githubAppRedirectUrl,
  appId: config.githubAppId,
  privateKey: config.githubAppPrivateKey,
  privateKeyId: config.githubAppPrivateKeyId,
};

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  fx = await seedFixture(pool);
  ironCalls = [];
  app = await buildApp({
    pool,
    ironControl: fakeIronControl(ironCalls),
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});

afterEach(async () => {
  config.githubAppClientId = originalGithubAppConfig.clientId;
  config.githubAppClientSecret = originalGithubAppConfig.clientSecret;
  config.githubAppRedirectUrl = originalGithubAppConfig.redirectUrl;
  config.githubAppId = originalGithubAppConfig.appId;
  config.githubAppPrivateKey = originalGithubAppConfig.privateKey;
  config.githubAppPrivateKeyId = originalGithubAppConfig.privateKeyId;
  vi.restoreAllMocks();
  await app.close();
});

async function loginCookie(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.headers['set-cookie'];
  return Array.isArray(cookie) ? cookie[0]! : String(cookie);
}

describe('connections routes', () => {
  it('returns GitHub public-read fallback when no connection exists', async () => {
    const cookie = await loginCookie();

    const res = await app.inject({
      method: 'GET',
      url: '/api/me/connections',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().connections).toEqual([
      expect.objectContaining({
        provider: 'github',
        workspaceId: fx.workspaceId,
        connected: false,
        status: 'public_read',
        tokenKind: 'public_read',
        accountLogin: null,
        scopes: [],
      }),
    ]);
  });

  it('stores GitHub connection metadata without storing token material', async () => {
    const cookie = await loginCookie();

    const res = await app.inject({
      method: 'POST',
      url: '/api/me/connections/github',
      headers: { cookie },
      payload: {
        workspaceId: fx.workspaceId,
        tokenKind: 'pat',
        token: 'ghp_secret_1234',
        accountLogin: 'octo-user',
        scopes: ['repo', 'read:user', 'repo'],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().connection).toMatchObject({
      provider: 'github',
      workspaceId: fx.workspaceId,
      connected: true,
      status: 'connected',
      tokenKind: 'pat',
      accountLogin: 'octo-user',
      accountLabel: 'octo-user',
      scopes: ['read:user', 'repo'],
      metadata: { last4: '1234' },
    });
    expect(ironCalls.some((call) => String(call.init.body).includes('ghp_secret_1234'))).toBe(true);

    const stored = await pool.query<{ metadata: unknown }>(
      `SELECT metadata
         FROM user_connections
        WHERE workspace_id = $1 AND user_id = $2 AND provider = 'github'`,
      [fx.workspaceId, fx.userId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(JSON.stringify(stored.rows[0]!.metadata)).not.toContain('ghp_secret_1234');
  });

  it('disconnects GitHub back to public-read fallback', async () => {
    const cookie = await loginCookie();
    await app.inject({
      method: 'POST',
      url: '/api/me/connections/github',
      headers: { cookie },
      payload: {
        workspaceId: fx.workspaceId,
        tokenKind: 'app_installation',
        brokerCredentialId: 'bcr_installation',
        accountLogin: 'acme',
      },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/me/connections/github?workspaceId=${fx.workspaceId}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().connection).toMatchObject({
      provider: 'github',
      workspaceId: fx.workspaceId,
      connected: false,
      status: 'public_read',
      tokenKind: 'public_read',
    });
  });

  it('creates a GitHub App installation broker credential from an installation id', async () => {
    config.githubAppId = '98765';
    config.githubAppPrivateKey = 'private-key-secret';
    config.githubAppPrivateKeyId = 'key-1';
    const cookie = await loginCookie();

    const res = await app.inject({
      method: 'POST',
      url: '/api/me/connections/github',
      headers: { cookie },
      payload: {
        workspaceId: fx.workspaceId,
        tokenKind: 'app_installation',
        installationId: 12345,
        accountLogin: 'acme',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().connection).toMatchObject({
      provider: 'github',
      workspaceId: fx.workspaceId,
      connected: true,
      status: 'connected',
      tokenKind: 'app_installation',
      accountLogin: 'acme',
      metadata: {
        brokerCredentialId: `github-app-installation-${fx.workspaceId}-installation-12345`,
        installationId: '12345',
      },
    });
    const brokerCall = ironCalls.find((call) => call.url.includes('/broker_credentials/github-app-installation-'));
    expect(brokerCall).toBeTruthy();
    expect(JSON.parse(String(brokerCall!.init.body))).toMatchObject({
      data: {
        grant: 'github_app_installation',
        github_app_id: '98765',
        github_installation_id: '12345',
        github_private_key: 'private-key-secret',
        github_private_key_id: 'key-1',
      },
    });

    const stored = await pool.query<{ metadata: unknown }>(
      `SELECT metadata
         FROM user_connections
        WHERE workspace_id = $1 AND user_id = $2 AND provider = 'github'`,
      [fx.workspaceId, fx.userId],
    );
    expect(JSON.stringify(stored.rows[0]!.metadata)).not.toContain('private-key-secret');
  });

  it('requires configured GitHub App material before creating an installation broker credential', async () => {
    config.githubAppId = '';
    config.githubAppPrivateKey = '';
    const cookie = await loginCookie();

    const res = await app.inject({
      method: 'POST',
      url: '/api/me/connections/github',
      headers: { cookie },
      payload: {
        workspaceId: fx.workspaceId,
        tokenKind: 'app_installation',
        installationId: '12345',
      },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'github_app_installation_unconfigured' });
  });

  it('starts and completes GitHub App user OAuth through a broker credential', async () => {
    config.githubAppClientId = 'github-client-id';
    config.githubAppClientSecret = 'github-client-secret';
    config.githubAppRedirectUrl = 'http://server.test/api/me/connections/github/callback';
    const githubFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        access_token: 'access-token-not-stored',
        refresh_token: 'refresh-token-secret',
        scope: 'repo,read:user',
      }),
    );
    const cookie = await loginCookie();

    const start = await app.inject({
      method: 'POST',
      url: '/api/me/connections/github',
      headers: { cookie },
      payload: { workspaceId: fx.workspaceId, tokenKind: 'app_user' },
    });
    expect(start.statusCode).toBe(200);
    const authorizeUrl = new URL(start.json().authorizeUrl);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(authorizeUrl.searchParams.get('client_id')).toBe('github-client-id');

    const callback = await app.inject({
      method: 'GET',
      url: `/api/me/connections/github/callback?code=oauth-code&state=${encodeURIComponent(
        authorizeUrl.searchParams.get('state')!,
      )}`,
      headers: { cookie },
    });

    expect(callback.statusCode).toBe(302);
    expect(githubFetch).toHaveBeenCalledWith(
      'https://github.com/login/oauth/access_token',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(ironCalls.some((call) => call.url.includes('/broker_credentials/'))).toBe(true);
    expect(ironCalls.some((call) => String(call.init.body).includes('refresh-token-secret'))).toBe(true);

    const stored = await pool.query<{ token_kind: string; metadata: unknown }>(
      `SELECT token_kind, metadata
         FROM user_connections
        WHERE workspace_id = $1 AND user_id = $2 AND provider = 'github'`,
      [fx.workspaceId, fx.userId],
    );
    expect(stored.rows[0]!.token_kind).toBe('app_user');
    expect(JSON.stringify(stored.rows[0]!.metadata)).not.toContain('refresh-token-secret');
  });

  it('rejects explicit workspaces outside membership', async () => {
    const cookie = await loginCookie();
    const other = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('other') RETURNING id`,
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/me/connections?workspaceId=${other.rows[0]!.id}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'workspace_not_found' });
  });
});

function fakeIronControl(calls: Array<{ url: string; init: RequestInit }>): IronControlAdminClient {
  return new IronControlAdminClient({
    baseUrl: 'http://iron.test',
    apiKey: 'iak_test',
    fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const path = new URL(String(url)).pathname;
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (path.endsWith('/effective_config')) {
        return json({
          data: {
            secrets: [{ replace: { proxy_value: 'GITHUB_TOKEN' }, rules: [{ host: 'api.github.com' }] }],
          },
        });
      }
      if (path.endsWith('/grants') && init?.method === 'GET') {
        return json({ data: [] });
      }
      if (path.includes('/static_secrets/')) {
        return json({ data: { id: 'ssr_github', namespace: 'default', foreign_id: 'github-token' } });
      }
      if (path.includes('/roles/')) {
        return json({ data: { id: 'role_github_default', namespace: 'default', foreign_id: 'github-default' } });
      }
      if (path.includes('/principals/')) {
        return json({ data: { id: 'prn_atrium', namespace: 'default', foreign_id: 'atrium-principal' } });
      }
      if (path.endsWith('/grants') && init?.method === 'POST') {
        return json({ data: { id: 'grant_github', principal_id: 'prn_atrium', static_secret_id: 'ssr_github' } });
      }
      return json({ data: { ok: true } });
    }) as typeof fetch,
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
