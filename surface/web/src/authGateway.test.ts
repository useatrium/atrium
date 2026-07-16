// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { authGatewayRedirected, clearAuthGatewayReloadGuard, reloadForAuthGateway } from './authGateway';

afterEach(() => {
  vi.unstubAllGlobals(); // put the real sessionStorage back before touching it
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('authGatewayRedirected', () => {
  it('reports a redirect the browser refused to follow', async () => {
    // What Cloudflare Access does to /auth/me once the session lapses: a 302 to
    // its own host, which `redirect: 'manual'` surfaces as an opaqueredirect.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ type: 'opaqueredirect', status: 0 }) as Response),
    );
    await expect(authGatewayRedirected()).resolves.toBe(true);
  });

  it('asks for the redirect rather than following it', async () => {
    const fetchMock = vi.fn(async () => ({ type: 'opaqueredirect' }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await authGatewayRedirected();

    expect(fetchMock).toHaveBeenCalledWith('/auth/me', { redirect: 'manual', credentials: 'include' });
  });

  it('does not mistake a real response for a redirect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ type: 'basic', status: 401 }) as Response),
    );
    await expect(authGatewayRedirected()).resolves.toBe(false);
  });

  it('treats a dead network as not-a-redirect, so offline keeps offline behaviour', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(authGatewayRedirected()).resolves.toBe(false);
  });
});

describe('reloadForAuthGateway', () => {
  it('reloads once, then refuses — a bouncing gateway must not loop', () => {
    const reload = vi.fn();

    expect(reloadForAuthGateway(reload)).toBe(true);
    expect(reloadForAuthGateway(reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again after a boot that succeeded in between', () => {
    const reload = vi.fn();

    reloadForAuthGateway(reload);
    clearAuthGatewayReloadGuard();

    expect(reloadForAuthGateway(reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('refuses to reload when storage is unavailable — an unbounded loop is worse', () => {
    const reload = vi.fn();
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
      removeItem: () => {
        throw new Error('storage disabled');
      },
    });

    expect(reloadForAuthGateway(reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(() => clearAuthGatewayReloadGuard()).not.toThrow();
  });
});
