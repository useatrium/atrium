import { generateKeyPairSync } from 'node:crypto';
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
  publicReadToken: config.githubPublicReadToken,
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
  config.githubPublicReadToken = originalGithubAppConfig.publicReadToken;
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
        id: 'github:public_read',
        workspaceId: fx.workspaceId,
        connected: false,
        status: 'public_read',
        tokenKind: 'public_read',
        accountLogin: null,
        scopes: [],
      }),
    ]);
  });

  it('rejects duplicate workspace query selectors', async () => {
    const cookie = await loginCookie();
    const query = `workspaceId=${fx.workspaceId}&workspaceId=other`;

    const listed = await app.inject({
      method: 'GET',
      url: `/api/me/connections?${query}`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(400);
    expect(listed.json()).toMatchObject({ error: 'bad_request', message: 'invalid request query' });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/me/connections/github?${query}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(400);
    expect(deleted.json()).toMatchObject({ error: 'bad_request', message: 'invalid request query' });
  });

  it('stores GitHub connection metadata without storing token material', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ login: 'octo-user' }), {
        status: 200,
        headers: { 'x-oauth-scopes': 'repo, read:user, repo' },
      }),
    );
    const cookie = await loginCookie();

    const res = await app.inject({
      method: 'POST',
      url: '/api/me/connections/github',
      headers: { cookie },
      payload: {
        workspaceId: fx.workspaceId,
        tokenKind: 'pat',
        token: 'ghp_secret_1234',
        accountLogin: 'spoofed-user',
        scopes: ['admin:org'],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().connection).toMatchObject({
      provider: 'github',
      id: 'github:pat',
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

  it('keeps prior GitHub identities as inactive metadata when another identity becomes active', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ login: 'octo-user' }), {
        status: 200,
        headers: { 'x-oauth-scopes': 'repo, read:user' },
      }),
    );
    const cookie = await loginCookie();

    const pat = await app.inject({
      method: 'POST',
      url: '/api/me/connections/github',
      headers: { cookie },
      payload: {
        workspaceId: fx.workspaceId,
        tokenKind: 'pat',
        token: 'ghp_secret_5678',
      },
    });
    expect(pat.statusCode).toBe(200);
    expect(pat.json().connection.identities).toMatchObject([
      expect.objectContaining({
        id: 'github:pat',
        active: true,
        tokenKind: 'pat',
        accountLogin: 'octo-user',
        metadata: expect.objectContaining({ last4: '5678' }),
      }),
    ]);

    const appInstall = await app.inject({
      method: 'POST',
      url: '/api/me/connections/github',
      headers: { cookie },
      payload: {
        workspaceId: fx.workspaceId,
        tokenKind: 'app_installation',
        brokerCredentialId: 'bcr_installation',
        installationId: '12345',
        accountLogin: 'acme',
      },
    });
    expect(appInstall.statusCode).toBe(200);
    expect(appInstall.json().connection).toMatchObject({
      id: 'github:app_installation:12345',
      tokenKind: 'app_installation',
      accountLogin: 'acme',
      identities: [
        expect.objectContaining({
          id: 'github:app_installation:12345',
          active: true,
          tokenKind: 'app_installation',
          accountLogin: 'acme',
        }),
        expect.objectContaining({
          id: 'github:pat',
          active: false,
          tokenKind: 'pat',
          accountLogin: 'octo-user',
          metadata: expect.objectContaining({ last4: '5678' }),
        }),
      ],
    });

    const listed = await app.inject({
      method: 'GET',
      url: `/api/me/connections?workspaceId=${fx.workspaceId}`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().connections[0]).toMatchObject({
      id: 'github:app_installation:12345',
      identities: [
        expect.objectContaining({ id: 'github:app_installation:12345', active: true }),
        expect.objectContaining({ id: 'github:pat', active: false }),
      ],
    });

    const stored = await pool.query<{ identity_id: string; active: boolean; metadata: unknown }>(
      `SELECT identity_id, active, metadata
         FROM user_connection_identities
        WHERE workspace_id = $1 AND user_id = $2 AND provider = 'github'
        ORDER BY active DESC, identity_id ASC`,
      [fx.workspaceId, fx.userId],
    );
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows.map((row) => [row.identity_id, row.active])).toEqual([
      ['github:app_installation:12345', true],
      ['github:pat', false],
    ]);
    expect(JSON.stringify(stored.rows)).not.toContain('ghp_secret_5678');

    const activated = await app.inject({
      method: 'POST',
      url: '/api/me/connections/github/active',
      headers: { cookie },
      payload: {
        workspaceId: fx.workspaceId,
        identityId: 'github:pat',
      },
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().connection).toMatchObject({
      id: 'github:pat',
      tokenKind: 'pat',
      accountLogin: 'octo-user',
      identities: [
        expect.objectContaining({ id: 'github:pat', active: true }),
        expect.objectContaining({ id: 'github:app_installation:12345', active: false }),
      ],
    });
    const activationGrant = ironCalls.find((call) => {
      if (new URL(call.url).pathname !== '/api/v1/grants' || call.init.method !== 'POST') return false;
      return String(call.init.body).includes('ssr_github_pat');
    });
    expect(activationGrant).toBeTruthy();
  });

  it('rejects invalid GitHub PATs before storing or granting them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad credentials', { status: 401 }));
    const cookie = await loginCookie();

    const res = await app.inject({
      method: 'POST',
      url: '/api/me/connections/github',
      headers: { cookie },
      payload: {
        workspaceId: fx.workspaceId,
        tokenKind: 'pat',
        token: 'ghp_bad_token',
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'github_token_invalid' });
    expect(ironCalls.some((call) => String(call.init.body).includes('ghp_bad_token'))).toBe(false);

    const stored = await pool.query(
      `SELECT 1
         FROM user_connections
        WHERE workspace_id = $1 AND user_id = $2 AND provider = 'github'`,
      [fx.workspaceId, fx.userId],
    );
    expect(stored.rowCount).toBe(0);
  });

  it('disconnects GitHub back to public-read fallback', async () => {
    config.githubPublicReadToken = 'github-public-token';
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
      id: 'github:public_read',
      workspaceId: fx.workspaceId,
      connected: false,
      status: 'public_read',
      tokenKind: 'public_read',
    });
    expect(ironCalls.map((call) => [call.init.method, call.url])).toEqual(
      expect.arrayContaining([
        ['PUT', 'http://iron.test/api/v1/static_secrets/github-public-read-token'],
        ['GET', 'http://iron.test/api/v1/roles/role_github_default/grants'],
        ['POST', 'http://iron.test/api/v1/grants'],
      ]),
    );
  });

  it('creates a GitHub App installation broker credential from an installation id', async () => {
    config.githubAppId = '98765';
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    config.githubAppPrivateKey = privateKeyPem;
    config.githubAppPrivateKeyId = 'key-1';
    const githubFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        id: 12345,
        account: { login: 'verified-acme', type: 'Organization' },
        target_type: 'Organization',
      }),
    );
    const cookie = await loginCookie();

    const res = await app.inject({
      method: 'POST',
      url: '/api/me/connections/github',
      headers: { cookie },
      payload: {
        workspaceId: fx.workspaceId,
        tokenKind: 'app_installation',
        installationId: 12345,
        accountLogin: 'forged-acme',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().connection).toMatchObject({
      provider: 'github',
      id: 'github:app_installation:12345',
      workspaceId: fx.workspaceId,
      connected: true,
      status: 'connected',
      tokenKind: 'app_installation',
      accountLogin: 'verified-acme',
      metadata: {
        brokerCredentialId: `github-app-installation-${fx.workspaceId}-installation-12345`,
        installationId: '12345',
        installationAccountType: 'Organization',
        installationTargetType: 'Organization',
      },
    });
    expect(githubFetch).toHaveBeenCalledWith(
      'https://api.github.com/app/installations/12345',
      expect.objectContaining({ method: 'GET' }),
    );
    const brokerCall = ironCalls.find((call) => call.url.includes('/broker_credentials/github-app-installation-'));
    expect(brokerCall).toBeTruthy();
    expect(JSON.parse(String(brokerCall!.init.body))).toMatchObject({
      data: {
        grant: 'github_app_installation',
        github_app_id: '98765',
        github_installation_id: '12345',
        github_private_key: privateKeyPem,
        github_private_key_id: 'key-1',
      },
    });

    const stored = await pool.query<{ metadata: unknown }>(
      `SELECT metadata
         FROM user_connections
        WHERE workspace_id = $1 AND user_id = $2 AND provider = 'github'`,
      [fx.workspaceId, fx.userId],
    );
    expect(JSON.stringify(stored.rows[0]!.metadata)).not.toContain(privateKeyPem);
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

  it('rejects unverified GitHub App installation ids before storing or granting them', async () => {
    config.githubAppId = '98765';
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    config.githubAppPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
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

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'github_installation_unverified' });
    expect(ironCalls.some((call) => call.url.includes('/broker_credentials/github-app-installation-'))).toBe(false);
    const stored = await pool.query(
      `SELECT 1
         FROM user_connections
        WHERE workspace_id = $1 AND user_id = $2 AND provider = 'github'`,
      [fx.workspaceId, fx.userId],
    );
    expect(stored.rowCount).toBe(0);
  });

  it('starts and completes GitHub App user OAuth through a broker credential', async () => {
    config.githubAppClientId = 'github-client-id';
    config.githubAppClientSecret = 'github-client-secret';
    config.githubAppRedirectUrl = 'http://server.test/api/me/connections/github/callback';
    const githubFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        json({
          access_token: 'access-token-not-stored',
          refresh_token: 'refresh-token-secret',
          scope: 'repo,read:user',
        }),
      )
      .mockResolvedValueOnce(json({ login: 'octo-user' }));
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
    expect(githubFetch).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer access-token-not-stored' }),
      }),
    );
    expect(ironCalls.some((call) => call.url.includes('/broker_credentials/'))).toBe(true);
    expect(ironCalls.some((call) => String(call.init.body).includes('refresh-token-secret'))).toBe(true);

    const stored = await pool.query<{
      token_kind: string;
      account_login: string | null;
      account_label: string | null;
      metadata: unknown;
    }>(
      `SELECT token_kind, account_login, account_label, metadata
         FROM user_connections
        WHERE workspace_id = $1 AND user_id = $2 AND provider = 'github'`,
      [fx.workspaceId, fx.userId],
    );
    expect(stored.rows[0]!.token_kind).toBe('app_user');
    expect(stored.rows[0]!.account_login).toBe('octo-user');
    expect(stored.rows[0]!.account_label).toBe('octo-user');
    expect(JSON.stringify(stored.rows[0]!.metadata)).not.toContain('refresh-token-secret');
    expect(JSON.stringify(stored.rows[0]!.metadata)).not.toContain('access-token-not-stored');
  });

  it('rejects explicit workspaces outside membership', async () => {
    const cookie = await loginCookie();
    const other = await pool.query<{ id: string }>(`INSERT INTO workspaces (name) VALUES ('other') RETURNING id`);

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
        const foreignId = decodeURIComponent(path.split('/').at(-1) ?? 'github-token');
        const id = foreignId.endsWith('github-pat')
          ? 'ssr_github_pat'
          : foreignId.endsWith('github-app_installation-12345')
            ? 'ssr_github_app_installation'
            : 'ssr_github';
        return json({ data: { id, namespace: 'default', foreign_id: foreignId } });
      }
      if (path.includes('/roles/')) {
        return json({ data: { id: 'role_github_default', namespace: 'default', foreign_id: 'github-default' } });
      }
      if (path.includes('/principals/')) {
        return json({ data: { id: 'prn_atrium', namespace: 'default', foreign_id: 'atrium-principal' } });
      }
      if (path.endsWith('/grants') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { data?: Record<string, unknown> };
        return json({ data: { id: 'grant_github', ...(body.data ?? {}) } });
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
