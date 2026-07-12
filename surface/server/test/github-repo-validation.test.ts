import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { listGitHubAppInstallations } from '../src/github-repo-validation.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

describe('listGitHubAppInstallations', () => {
  it('lists the App installations with a JWT-signed request', async () => {
    const fetchImpl = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(url)).toBe('https://api.github.com/app/installations?per_page=100');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toMatch(/^Bearer /);
      expect(headers.accept).toBe('application/vnd.github+json');
      return new Response(
        JSON.stringify([
          { id: 777, account: { login: 'acme', type: 'Organization' }, target_type: 'Organization' },
          { id: 888, account: null, target_type: 'User' },
          { account: { login: 'no-id' } },
        ]),
        { status: 200 },
      );
    });

    const installations = await listGitHubAppInstallations({
      appId: '98765',
      privateKey: privateKeyPem,
      privateKeyId: 'key-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(installations).toEqual([
      { installationId: '777', accountLogin: 'acme', accountType: 'Organization', targetType: 'Organization' },
      { installationId: '888', accountLogin: null, accountType: null, targetType: 'User' },
    ]);
  });

  it('throws unconfigured when the App credentials are missing', async () => {
    await expect(listGitHubAppInstallations({ appId: '', privateKey: '' })).rejects.toMatchObject({
      code: 'unconfigured',
    });
  });

  it('surfaces GitHub list failures as token_exchange_failed', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));

    await expect(
      listGitHubAppInstallations({
        appId: '98765',
        privateKey: privateKeyPem,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'token_exchange_failed' });
  });

  it('rejects a non-array installations response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ installations: [] }), { status: 200 }));

    await expect(
      listGitHubAppInstallations({
        appId: '98765',
        privateKey: privateKeyPem,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'token_exchange_failed' });
  });
});
