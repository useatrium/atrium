import { describe, expect, it, vi } from 'vitest';
import {
  convergeExistingGitHubDirectGrant,
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

  it('repairs an existing connected PAT principal by removing fallback role inheritance before verifying', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = fakeIronControl(calls);

    await convergeExistingGitHubDirectGrant(client, { workspaceId: 'ws1', userId: 'user1' });

    expect(callMethodsAndPaths(calls)).toEqual([
      ['PUT', '/api/v1/principals/atrium-workspace-ws1-user-user1'],
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
      ['DELETE', '/api/v1/static_secrets/github-token-atrium-workspace-ws1-user-user1'],
      ['PUT', '/api/v1/roles/github-default'],
      ['POST', '/api/v1/principals/prn_atrium/roles'],
      ['GET', '/api/v1/principals/lookup/default/atrium-workspace-ws1-user-user1/effective_config'],
    ]);
  });
});

function fakeIronControl(
  calls: Array<{ url: string; init: RequestInit }>,
  options: { roleGrants?: Array<{ id: string; role_id: string; static_secret_id: string }> } = {},
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
      if (path.includes('/static_secrets/github-public-read-token')) {
        return json({ data: { id: 'ssr_public_read', namespace: 'default', foreign_id: 'github-public-read-token' } });
      }
      if (path.includes('/roles/')) {
        return json({ data: { id: 'role_github_default', namespace: 'default', foreign_id: 'github-default' } });
      }
      if (path.includes('/principals/')) {
        return json({ data: { id: 'prn_atrium', namespace: 'default', foreign_id: 'atrium-principal' } });
      }
      if (path.endsWith('/grants') && init?.method === 'POST') {
        return json({
          data: { id: 'grant_github', role_id: 'role_github_default', static_secret_id: 'ssr_public_read' },
        });
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
