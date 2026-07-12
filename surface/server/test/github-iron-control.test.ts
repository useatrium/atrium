import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import {
  GitHubAppInstallationUnconfiguredError,
  convergeGitHubBrokerGrant,
  convergeExistingGitHubDirectGrant,
  convergeGitHubPatGrant,
  convergeGitHubPublicReadFallback,
  convergeGitHubPublicReadRole,
  upsertGitHubInstallationBrokerCredential,
} from '../src/github-iron-control.js';
import { IronControlAdminClient } from '../src/iron-control.js';

const originalGitHubConfig = {
  appId: config.githubAppId,
  privateKey: config.githubAppPrivateKey,
  privateKeyId: config.githubAppPrivateKeyId,
  fallbackInstallationId: config.githubAppFallbackInstallationId,
  publicReadToken: config.githubPublicReadToken,
};

beforeEach(() => {
  config.githubAppId = '';
  config.githubAppPrivateKey = '';
  config.githubAppPrivateKeyId = '';
  config.githubAppFallbackInstallationId = '';
  config.githubPublicReadToken = '';
});

afterEach(() => {
  config.githubAppId = originalGitHubConfig.appId;
  config.githubAppPrivateKey = originalGitHubConfig.privateKey;
  config.githubAppPrivateKeyId = originalGitHubConfig.privateKeyId;
  config.githubAppFallbackInstallationId = originalGitHubConfig.fallbackInstallationId;
  config.githubPublicReadToken = originalGitHubConfig.publicReadToken;
  vi.restoreAllMocks();
});

describe('GitHub iron-control convergence', () => {
  it('provisions the public-read fallback secret and role grant when a token is configured', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls, { roleGrants: [] });

    await convergeGitHubPublicReadRole(client, 'github-public-token');

    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/roles/github-default'],
      ['PUT', '/api/v1/static_secrets/github-public-read-token'],
      ['GET', '/api/v1/roles/role_github_default/grants'],
      ['POST', '/api/v1/grants'],
    ]);
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({
      data: {
        source: { source_type: 'control_plane', secret: 'github-public-token' },
        labels: { source: 'atrium', provider: 'github', token_kind: 'public_read' },
      },
    });
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({
      data: { role_id: 'role_github_default', static_secret_id: 'ssr_public_read' },
    });
  });

  it('does not duplicate the public-read role grant when it already exists', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls, {
      roleGrants: [{ id: 'grant_public', role_id: 'role_github_default', static_secret_id: 'ssr_public_read' }],
    });

    await convergeGitHubPublicReadRole(client, 'github-public-token');

    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/roles/github-default'],
      ['PUT', '/api/v1/static_secrets/github-public-read-token'],
      ['GET', '/api/v1/roles/role_github_default/grants'],
    ]);
  });

  it('converges a PAT direct grant before removing fallback inheritance and verifying', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls, { principalGrants: [] });

    await convergeGitHubPatGrant(client, { workspaceId: 'ws1', userId: 'user1', token: 'ghp_secret' });

    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/principals/atrium-workspace-ws1-user-user1'],
      ['GET', '/api/v1/roles/lookup/default/infra'],
      ['POST', '/api/v1/principals/prn_atrium/roles'],
      ['PUT', '/api/v1/static_secrets/github-token-atrium-workspace-ws1-user-user1-github-pat'],
      ['GET', '/api/v1/principals/prn_atrium/grants'],
      ['POST', '/api/v1/grants'],
      ['PUT', '/api/v1/roles/github-default'],
      ['DELETE', '/api/v1/principals/prn_atrium/roles/role_github_default'],
      ['GET', '/api/v1/principals/lookup/default/atrium-workspace-ws1-user-user1/effective_config'],
    ]);
    expect(JSON.parse(String(calls[3]!.init.body))).toMatchObject({
      data: {
        foreign_id: 'github-token-atrium-workspace-ws1-user-user1-github-pat',
        source: { source_type: 'control_plane', secret: 'ghp_secret' },
        labels: { source: 'atrium', provider: 'github', atrium_workspace_id: 'ws1', atrium_user_id: 'user1' },
      },
    });
    expect(JSON.parse(String(calls[5]!.init.body))).toEqual({
      data: { principal_id: 'prn_atrium', static_secret_id: 'ssr_github_user' },
    });
  });

  it('does not duplicate an existing direct grant while converging an App-backed identity', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls, {
      principalGrants: [{ id: 'grant_user', principal_id: 'prn_atrium', static_secret_id: 'ssr_github_user' }],
    });

    await convergeGitHubBrokerGrant(client, {
      workspaceId: 'ws1',
      userId: 'user1',
      tokenKind: 'app_user',
      brokerCredentialId: 'bcr_user',
    });

    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/principals/atrium-workspace-ws1-user-user1'],
      ['GET', '/api/v1/roles/lookup/default/infra'],
      ['POST', '/api/v1/principals/prn_atrium/roles'],
      ['PUT', '/api/v1/static_secrets/github-token-atrium-workspace-ws1-user-user1-github-app_user'],
      ['GET', '/api/v1/principals/prn_atrium/grants'],
      ['PUT', '/api/v1/roles/github-default'],
      ['DELETE', '/api/v1/principals/prn_atrium/roles/role_github_default'],
      ['GET', '/api/v1/principals/lookup/default/atrium-workspace-ws1-user-user1/effective_config'],
    ]);
    expect(JSON.parse(String(calls[3]!.init.body))).toMatchObject({
      data: {
        source: {
          source_type: 'token_broker',
          config: { credential_id: 'bcr_user' },
        },
        labels: {
          source: 'atrium',
          provider: 'github',
          token_kind: 'app_user',
          atrium_workspace_id: 'ws1',
          atrium_user_id: 'user1',
        },
      },
    });
  });

  it('revokes stale direct GitHub identity grants before verifying', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls, {
      principalGrants: [
        { id: 'grant_old', principal_id: 'prn_atrium', static_secret_id: 'ssr_old_github' },
        { id: 'grant_keep', principal_id: 'prn_atrium', static_secret_id: 'ssr_other' },
      ],
    });

    await convergeGitHubBrokerGrant(client, {
      workspaceId: 'ws1',
      userId: 'user1',
      tokenKind: 'app_installation',
      brokerCredentialId: 'bcr_installation',
      installationId: '12345',
      staleStaticSecretIds: ['ssr_old_github'],
    });

    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/principals/atrium-workspace-ws1-user-user1'],
      ['GET', '/api/v1/roles/lookup/default/infra'],
      ['POST', '/api/v1/principals/prn_atrium/roles'],
      ['PUT', '/api/v1/static_secrets/github-token-atrium-workspace-ws1-user-user1-github-app_installation-12345'],
      ['GET', '/api/v1/principals/prn_atrium/grants'],
      ['DELETE', '/api/v1/grants/grant_old'],
      ['POST', '/api/v1/grants'],
      ['PUT', '/api/v1/roles/github-default'],
      ['DELETE', '/api/v1/principals/prn_atrium/roles/role_github_default'],
      ['GET', '/api/v1/principals/lookup/default/atrium-workspace-ws1-user-user1/effective_config'],
    ]);
  });

  it('repairs an existing connected PAT principal by removing fallback role inheritance before verifying', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls);

    await convergeExistingGitHubDirectGrant(client, { workspaceId: 'ws1', userId: 'user1' });

    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/principals/atrium-workspace-ws1-user-user1'],
      ['GET', '/api/v1/roles/lookup/default/infra'],
      ['POST', '/api/v1/principals/prn_atrium/roles'],
      ['PUT', '/api/v1/roles/github-default'],
      ['DELETE', '/api/v1/principals/prn_atrium/roles/role_github_default'],
      ['GET', '/api/v1/principals/lookup/default/atrium-workspace-ws1-user-user1/effective_config'],
    ]);
  });

  it('moves a disconnected principal to fallback and deletes the known per-user GitHub secret first', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls);

    await convergeGitHubPublicReadFallback(client, { workspaceId: 'ws1', userId: 'user1' });

    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/principals/atrium-workspace-ws1-user-user1'],
      ['GET', '/api/v1/roles/lookup/default/infra'],
      ['POST', '/api/v1/principals/prn_atrium/roles'],
      ['DELETE', '/api/v1/static_secrets/github-token-atrium-workspace-ws1-user-user1'],
      ['PUT', '/api/v1/roles/github-default'],
      ['POST', '/api/v1/principals/prn_atrium/roles'],
      ['GET', '/api/v1/principals/lookup/default/atrium-workspace-ws1-user-user1/effective_config'],
    ]);
  });
});

describe('GitHub App-backed fallback role', () => {
  function configureApp(): void {
    config.githubAppId = '98765';
    config.githubAppPrivateKey = 'app-private-key-pem';
    config.githubAppPrivateKeyId = 'key-1';
  }

  it('backs the fallback role with the App installation broker secret when an installation id is pinned', async () => {
    configureApp();
    config.githubAppFallbackInstallationId = '12345';
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls, { roleGrants: [] });
    const listInstallations = vi.fn(async () => []);

    await convergeGitHubPublicReadRole(client, 'github-public-token', listInstallations);

    expect(listInstallations).not.toHaveBeenCalled();
    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/roles/github-default'],
      ['PUT', '/api/v1/broker_credentials/github-app-fallback-installation-12345'],
      ['PUT', '/api/v1/static_secrets/github-app-fallback-token'],
      ['GET', '/api/v1/roles/role_github_default/grants'],
      ['POST', '/api/v1/grants'],
    ]);
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({
      data: {
        grant: 'github_app_installation',
        github_app_id: '98765',
        github_installation_id: '12345',
        github_private_key: 'app-private-key-pem',
        github_private_key_id: 'key-1',
        labels: {
          source: 'atrium',
          provider: 'github',
          token_kind: 'app_installation',
          kind: 'fallback',
          github_installation_id: '12345',
        },
      },
    });
    expect(JSON.parse(String(calls[2]!.init.body))).toMatchObject({
      data: {
        source: {
          source_type: 'token_broker',
          config: { credential_id: 'github-app-fallback-installation-12345', credential_namespace: 'default' },
        },
        labels: { source: 'atrium', provider: 'github', kind: 'fallback', token_kind: 'app_installation' },
      },
    });
    expect(JSON.parse(String(calls[4]!.init.body))).toEqual({
      data: { role_id: 'role_github_default', static_secret_id: 'ssr_app_fallback' },
    });
  });

  it('auto-discovers a single App installation when none is pinned', async () => {
    configureApp();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls, { roleGrants: [] });
    const listInstallations = vi.fn(async () => [
      { installationId: '777', accountLogin: 'acme', accountType: 'Organization', targetType: 'Organization' },
    ]);

    await convergeGitHubPublicReadRole(client, 'github-public-token', listInstallations);

    expect(listInstallations).toHaveBeenCalledWith({
      appId: '98765',
      privateKey: 'app-private-key-pem',
      privateKeyId: 'key-1',
    });
    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/roles/github-default'],
      ['PUT', '/api/v1/broker_credentials/github-app-fallback-installation-777'],
      ['PUT', '/api/v1/static_secrets/github-app-fallback-token'],
      ['GET', '/api/v1/roles/role_github_default/grants'],
      ['POST', '/api/v1/grants'],
    ]);
  });

  it('warns and keeps the static public-read fallback when discovery finds no installations', async () => {
    configureApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls, { roleGrants: [] });
    const listInstallations = vi.fn(async () => []);

    await convergeGitHubPublicReadRole(client, 'github-public-token', listInstallations);

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain('GITHUB_APP_FALLBACK_INSTALLATION_ID');
    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/roles/github-default'],
      ['PUT', '/api/v1/static_secrets/github-public-read-token'],
      ['GET', '/api/v1/roles/role_github_default/grants'],
      ['POST', '/api/v1/grants'],
    ]);
  });

  it('warns and keeps the static public-read fallback when multiple installations are found', async () => {
    configureApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls, { roleGrants: [] });
    const listInstallations = vi.fn(async () => [
      { installationId: '777', accountLogin: 'acme', accountType: 'Organization', targetType: 'Organization' },
      { installationId: '888', accountLogin: 'globex', accountType: 'Organization', targetType: 'Organization' },
    ]);

    await convergeGitHubPublicReadRole(client, 'github-public-token', listInstallations);

    expect(warn).toHaveBeenCalledOnce();
    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/roles/github-default'],
      ['PUT', '/api/v1/static_secrets/github-public-read-token'],
      ['GET', '/api/v1/roles/role_github_default/grants'],
      ['POST', '/api/v1/grants'],
    ]);
  });

  it('degrades to the static fallback without throwing when installation discovery fails', async () => {
    configureApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls, { roleGrants: [] });
    const listInstallations = vi.fn(async () => {
      throw new Error('github unreachable');
    });

    await convergeGitHubPublicReadRole(client, 'github-public-token', listInstallations);

    expect(warn).toHaveBeenCalledOnce();
    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/roles/github-default'],
      ['PUT', '/api/v1/static_secrets/github-public-read-token'],
      ['GET', '/api/v1/roles/role_github_default/grants'],
      ['POST', '/api/v1/grants'],
    ]);
  });

  it('removes the stale public-read grant when switching the role to the App-backed secret', async () => {
    configureApp();
    config.githubAppFallbackInstallationId = '12345';
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls, {
      roleGrants: [{ id: 'grant_public', role_id: 'role_github_default', static_secret_id: 'ssr_public_read' }],
    });

    await convergeGitHubPublicReadRole(client, 'github-public-token');

    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/roles/github-default'],
      ['PUT', '/api/v1/broker_credentials/github-app-fallback-installation-12345'],
      ['PUT', '/api/v1/static_secrets/github-app-fallback-token'],
      ['GET', '/api/v1/roles/role_github_default/grants'],
      ['DELETE', '/api/v1/grants/grant_public'],
      ['POST', '/api/v1/grants'],
    ]);
    expect(JSON.parse(String(calls[5]!.init.body))).toEqual({
      data: { role_id: 'role_github_default', static_secret_id: 'ssr_app_fallback' },
    });
  });

  it('removes the stale App-backed grant when switching the role back to the static token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls, {
      roleGrants: [{ id: 'grant_app', role_id: 'role_github_default', static_secret_id: 'ssr_app_fallback' }],
    });

    await convergeGitHubPublicReadRole(client, 'github-public-token');

    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/roles/github-default'],
      ['PUT', '/api/v1/static_secrets/github-public-read-token'],
      ['GET', '/api/v1/roles/role_github_default/grants'],
      ['DELETE', '/api/v1/grants/grant_app'],
      ['POST', '/api/v1/grants'],
    ]);
    expect(JSON.parse(String(calls[4]!.init.body))).toEqual({
      data: { role_id: 'role_github_default', static_secret_id: 'ssr_public_read' },
    });
  });

  it('leaves the role bare when neither the App nor a public-read token is configured', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls, { roleGrants: [] });

    await convergeGitHubPublicReadRole(client, '');

    expect(callMethodsAndPaths(calls)).toEqual([['PUT', '/api/v1/roles/github-default']]);
  });
});

describe('upsertGitHubInstallationBrokerCredential', () => {
  it('upserts the workspace-scoped installation broker credential and returns its foreign id', async () => {
    config.githubAppId = '98765';
    config.githubAppPrivateKey = 'app-private-key-pem';
    config.githubAppPrivateKeyId = 'key-1';
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls);

    const foreignId = await upsertGitHubInstallationBrokerCredential(client, {
      workspaceId: 'ws1',
      installationId: '12345',
    });

    expect(foreignId).toBe('github-app-installation-ws1-installation-12345');
    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/broker_credentials/github-app-installation-ws1-installation-12345'],
    ]);
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      data: {
        grant: 'github_app_installation',
        github_app_id: '98765',
        github_installation_id: '12345',
        github_private_key: 'app-private-key-pem',
        github_private_key_id: 'key-1',
        labels: {
          source: 'atrium',
          provider: 'github',
          token_kind: 'app_installation',
          atrium_workspace_id: 'ws1',
          github_installation_id: '12345',
        },
      },
    });
  });

  it('rejects when the GitHub App is not configured', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls);

    await expect(
      upsertGitHubInstallationBrokerCredential(client, { workspaceId: 'ws1', installationId: '12345' }),
    ).rejects.toBeInstanceOf(GitHubAppInstallationUnconfiguredError);
    expect(calls).toEqual([]);
  });
});

function fakeIronControl(
  calls: Array<{ url: string; init: RequestInit }>,
  options: {
    principalGrants?: Array<{ id: string; principal_id: string; static_secret_id: string }>;
    roleGrants?: Array<{ id: string; role_id: string; static_secret_id: string }>;
  } = {},
): IronControlAdminClient {
  return new IronControlAdminClient({
    baseUrl: 'http://iron.test',
    apiKey: 'iak_test',
    fetchImpl: vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
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
      if (path.endsWith('/roles/role_github_default/grants')) {
        return json({ data: options.roleGrants ?? [] });
      }
      if (path.endsWith('/principals/prn_atrium/grants')) {
        return json({ data: options.principalGrants ?? [] });
      }
      if (path.endsWith('/roles/lookup/default/infra')) {
        return json({ data: { id: 'role_infra', namespace: 'default', foreign_id: 'infra' } });
      }
      if (path.includes('/static_secrets/github-public-read-token')) {
        return json({ data: { id: 'ssr_public_read', namespace: 'default', foreign_id: 'github-public-read-token' } });
      }
      if (path.includes('/static_secrets/github-app-fallback-token')) {
        return json({
          data: { id: 'ssr_app_fallback', namespace: 'default', foreign_id: 'github-app-fallback-token' },
        });
      }
      if (path.includes('/broker_credentials/')) {
        return json({ data: { id: 'bcr_iron', namespace: 'default', foreign_id: path.split('/').at(-1) } });
      }
      if (path.includes('/static_secrets/github-token-atrium-workspace-ws1-user-user1')) {
        const staticSecretId = path.endsWith(
          'github-token-atrium-workspace-ws1-user-user1-github-app_installation-12345',
        )
          ? 'ssr_github_installation'
          : 'ssr_github_user';
        return json({
          data: {
            id: staticSecretId,
            namespace: 'default',
            foreign_id: path.split('/').at(-1),
          },
        });
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
    }) as unknown as typeof fetch,
  });
}

function callMethodsAndPaths(calls: Array<{ url: string; init: RequestInit }>): Array<[string, string]> {
  return calls.map((call) => [String(call.init.method ?? 'GET'), new URL(call.url).pathname]);
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
