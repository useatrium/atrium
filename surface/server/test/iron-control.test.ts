import { describe, expect, it, vi } from 'vitest';
import {
  IronControlAdminClient,
  type IronControlRequestError,
  atriumPrincipalForeignId,
  countGitHubTokenTransforms,
  githubAppInstallationBrokerCredentialForeignId,
  githubPatSecretForeignId,
} from '../src/iron-control.js';

function okFetch(calls: Array<{ url: string; init: RequestInit }>) {
  return vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ data: { id: 'id_1', namespace: 'default', foreign_id: 'fid_1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('IronControlAdminClient', () => {
  it('derives the shared Atrium workspace/user principal foreign id', () => {
    expect(atriumPrincipalForeignId('workspace-1', 'user-1')).toBe('atrium-workspace-workspace-1-user-user-1');
    expect(githubPatSecretForeignId('workspace-1', 'user-1')).toBe(
      'github-token-atrium-workspace-workspace-1-user-user-1',
    );
    expect(githubAppInstallationBrokerCredentialForeignId('workspace-1', '12345')).toBe(
      'github-app-installation-workspace-1-installation-12345',
    );
  });

  it('upserts principals with bearer auth and namespace labels', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new IronControlAdminClient({
      baseUrl: 'http://iron.test',
      apiKey: 'iak_test',
      namespace: 'default',
      fetchImpl: okFetch(calls),
    });

    await client.upsertPrincipal({
      foreignId: 'atrium-workspace-ws-user-user',
      name: 'Atrium Workspace ws User user',
      labels: { atrium_workspace_id: 'ws', atrium_user_id: 'user' },
    });

    expect(calls[0]!.url).toBe('http://iron.test/api/v1/principals/atrium-workspace-ws-user-user');
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer iak_test' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      data: {
        namespace: 'default',
        foreign_id: 'atrium-workspace-ws-user-user',
        name: 'Atrium Workspace ws User user',
        labels: { atrium_workspace_id: 'ws', atrium_user_id: 'user' },
      },
    });
  });

  it('upserts GitHub PAT replacement secrets as write-only control-plane source', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new IronControlAdminClient({
      baseUrl: 'http://iron.test/',
      apiKey: 'iak_test',
      fetchImpl: okFetch(calls),
    });

    await client.upsertGitHubPatSecret({
      foreignId: 'github-token-atrium-workspace-ws-user-user',
      name: 'GitHub token for user',
      token: 'ghp_secret',
      labels: { provider: 'github' },
    });

    expect(calls[0]!.url).toBe(
      'http://iron.test/api/v1/static_secrets/github-token-atrium-workspace-ws-user-user',
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      data: {
        namespace: 'default',
        foreign_id: 'github-token-atrium-workspace-ws-user-user',
        name: 'GitHub token for user',
        labels: { provider: 'github' },
        replace_config: {
          proxy_value: 'GITHUB_TOKEN',
          match_headers: ['Authorization'],
          require: true,
        },
        source: {
          source_type: 'control_plane',
          secret: 'ghp_secret',
          config: {},
        },
        rules: [{ host: 'github.com' }, { host: 'api.github.com' }],
      },
    });
  });

  it('upserts GitHub App replacement secrets from token broker credentials', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new IronControlAdminClient({
      baseUrl: 'http://iron.test/',
      apiKey: 'iak_test',
      fetchImpl: okFetch(calls),
    });

    await client.upsertGitHubBrokerSecret({
      foreignId: 'github-token-atrium-workspace-ws-user-user',
      name: 'GitHub app token for user',
      brokerCredentialId: 'bcr_installation',
      labels: { provider: 'github', token_kind: 'app_installation' },
    });

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      data: {
        namespace: 'default',
        foreign_id: 'github-token-atrium-workspace-ws-user-user',
        name: 'GitHub app token for user',
        labels: { provider: 'github', token_kind: 'app_installation' },
        replace_config: {
          proxy_value: 'GITHUB_TOKEN',
          match_headers: ['Authorization'],
          require: true,
        },
        source: {
          source_type: 'token_broker',
          config: { credential_id: 'bcr_installation' },
        },
        rules: [{ host: 'github.com' }, { host: 'api.github.com' }],
      },
    });
  });

  it('references namespaced broker credential foreign ids for GitHub App secrets', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new IronControlAdminClient({
      baseUrl: 'http://iron.test/',
      apiKey: 'iak_test',
      namespace: 'atrium',
      fetchImpl: okFetch(calls),
    });

    await client.upsertGitHubBrokerSecret({
      foreignId: 'github-token-atrium-workspace-ws-user-user',
      name: 'GitHub app token for user',
      brokerCredentialId: 'github-app-user-atrium-workspace-ws-user-user',
      labels: { provider: 'github', token_kind: 'app_user' },
    });

    expect(JSON.parse(String(calls[0]!.init.body)).data.source).toEqual({
      source_type: 'token_broker',
      config: {
        credential_id: 'github-app-user-atrium-workspace-ws-user-user',
        credential_namespace: 'atrium',
      },
    });
  });

  it('upserts GitHub App user broker credentials with write-only refresh tokens', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new IronControlAdminClient({
      baseUrl: 'http://iron.test/',
      apiKey: 'iak_test',
      fetchImpl: okFetch(calls),
    });

    await client.upsertBrokerCredential({
      foreignId: 'github-app-user-atrium-workspace-ws-user-user',
      name: 'GitHub app user token for user',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-secret',
      scopes: ['repo', 'read:user'],
      labels: { provider: 'github', token_kind: 'app_user' },
    });

    expect(calls[0]!.url).toBe(
      'http://iron.test/api/v1/broker_credentials/github-app-user-atrium-workspace-ws-user-user',
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      data: {
        namespace: 'default',
        foreign_id: 'github-app-user-atrium-workspace-ws-user-user',
        name: 'GitHub app user token for user',
        labels: { provider: 'github', token_kind: 'app_user' },
        token_endpoint: 'https://github.com/login/oauth/access_token',
        scopes: ['repo', 'read:user'],
        client_id: 'client-id',
        client_secret: 'client-secret',
        refresh_token: 'refresh-secret',
      },
    });
  });

  it('upserts GitHub App installation broker credentials with write-only private keys', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new IronControlAdminClient({
      baseUrl: 'http://iron.test/',
      apiKey: 'iak_test',
      fetchImpl: okFetch(calls),
    });

    await client.upsertGitHubAppInstallationBrokerCredential({
      foreignId: 'github-app-installation-ws-installation-12345',
      name: 'GitHub App installation 12345',
      githubAppId: '98765',
      githubInstallationId: '12345',
      githubPrivateKey: 'private-key',
      githubPrivateKeyId: 'key-1',
      labels: { provider: 'github', token_kind: 'app_installation' },
    });

    expect(calls[0]!.url).toBe('http://iron.test/api/v1/broker_credentials/github-app-installation-ws-installation-12345');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      data: {
        namespace: 'default',
        foreign_id: 'github-app-installation-ws-installation-12345',
        name: 'GitHub App installation 12345',
        labels: { provider: 'github', token_kind: 'app_installation' },
        grant: 'github_app_installation',
        github_app_id: '98765',
        github_installation_id: '12345',
        github_private_key: 'private-key',
        github_private_key_id: 'key-1',
      },
    });
  });

  it('validates GitHub repo access through a broker credential without returning token material', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new IronControlAdminClient({
      baseUrl: 'http://iron.test/',
      apiKey: 'iak_test',
      fetchImpl: vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ data: { inaccessible: ['acme/missing'] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    await expect(client.validateGitHubBrokerRepos('bcr_user', ['acme/private', 'acme/missing'])).resolves.toEqual({
      inaccessible: ['acme/missing'],
    });
    expect(calls[0]!.url).toBe('http://iron.test/api/v1/broker_credentials/bcr_user/validate_github_repos');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      data: { namespace: 'default', repos: ['acme/private', 'acme/missing'] },
    });
  });

  it('exposes iron-control response status and body on request failures', async () => {
    const client = new IronControlAdminClient({
      baseUrl: 'http://iron.test/',
      apiKey: 'iak_test',
      fetchImpl: vi.fn(async () => new Response('credential unavailable', { status: 409 })) as unknown as typeof fetch,
    });

    await expect(client.validateGitHubBrokerRepos('bcr_user', ['acme/private'])).rejects.toMatchObject({
      status: 409,
      bodyText: 'credential unavailable',
    } satisfies Partial<IronControlRequestError>);
  });

  it('creates and revokes grants by iron-control object id', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new IronControlAdminClient({
      baseUrl: 'http://iron.test',
      apiKey: 'iak_test',
      fetchImpl: okFetch(calls),
    });

    await client.createPrincipalStaticGrant('prn_1', 'ssr_1');
    await client.deleteGrant('grant_1');

    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ['POST', 'http://iron.test/api/v1/grants'],
      ['DELETE', 'http://iron.test/api/v1/grants/grant_1'],
    ]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      data: { principal_id: 'prn_1', static_secret_id: 'ssr_1' },
    });
  });

  it('counts GitHub GITHUB_TOKEN replacement transforms in effective config', () => {
    expect(
      countGitHubTokenTransforms({
        secrets: [
          {
            replace: { proxy_value: 'GITHUB_TOKEN' },
            rules: [{ host: 'github.com' }, { host: 'api.github.com' }],
          },
          {
            replace: { proxy_value: 'SLACK_BOT_TOKEN' },
            rules: [{ host: 'slack.com' }],
          },
        ],
      }),
    ).toBe(1);
  });

  it('verifies exactly one GitHub transform for a principal', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new IronControlAdminClient({
      baseUrl: 'http://iron.test',
      apiKey: 'iak_test',
      fetchImpl: vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            data: {
              secrets: [{ replace: { proxy_value: 'GITHUB_TOKEN' }, rules: [{ host: 'api.github.com' }] }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    await expect(client.verifySingleGitHubTokenTransform('atrium-workspace-ws-user-user')).resolves.toEqual({
      count: 1,
      ok: true,
    });
    expect(calls[0]!.url).toBe(
      'http://iron.test/api/v1/principals/lookup/default/atrium-workspace-ws-user-user/effective_config',
    );
  });
});
