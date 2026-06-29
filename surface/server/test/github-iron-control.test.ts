import { describe, expect, it, vi } from 'vitest';
import {
  convergeGitHubBrokerGrant,
  convergeExistingGitHubDirectGrant,
  convergeGitHubPatGrant,
  convergeGitHubPublicReadFallback,
  convergeGitHubPublicReadRole,
} from '../src/github-iron-control.js';
import { IronControlAdminClient } from '../src/iron-control.js';

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
