// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  workspaces: vi.fn(),
  loadBootSnapshot: vi.fn(),
  authMethods: vi.fn(),
  authGatewayRedirected: vi.fn(),
  reloadForAuthGateway: vi.fn(),
}));

vi.mock('../src/api', () => ({
  // Mirrors the real (status, code, message) signature so these tests can't drift
  // from what the client actually throws.
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  // The login screen probes which sign-in methods the deployment offers.
  api: { me: mocks.me, workspaces: mocks.workspaces, authMethods: mocks.authMethods },
}));
vi.mock('../src/cacheIdb', () => ({
  clearCache: vi.fn(),
  loadBootSnapshot: mocks.loadBootSnapshot,
  saveBootSnapshot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/desktop', () => ({
  clearDesktopSession: vi.fn(),
  desktopApiOptions: vi.fn(() => null),
  onDesktopNavigate: vi.fn(() => () => {}),
  isDesktop: false,
}));
vi.mock('../src/authGateway', () => ({
  authGatewayRedirected: mocks.authGatewayRedirected,
  reloadForAuthGateway: mocks.reloadForAuthGateway,
  clearAuthGatewayReloadGuard: vi.fn(),
}));
vi.mock('../src/theme', () => ({ adoptPrefs: vi.fn() }));
vi.mock('../src/Chat', () => ({ Chat: () => <div>Chat</div> }));
vi.mock('../src/EntryLinkRoute', () => ({ EntryLinkRoute: () => null, entryHandleFromPath: () => null }));
vi.mock('../src/MarkupShellPage', () => ({ MarkupShellPage: () => null, isMarkupShellRoute: () => false }));
vi.mock('../src/sessions/SessionPanePage', () => ({ SessionPanePage: () => null }));
vi.mock('../src/sessions/SessionWorkPage', () => ({ SessionWorkPage: () => null }));
vi.mock('../src/sessions/WorkDrawer', () => ({ SLUG_TAB: {} }));
vi.mock('../src/components/Toasts', () => ({ Toasts: () => null }));
vi.mock('../src/components/a11y', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { App } from '../src/App';
import { ApiError } from '../src/api';

/** What an identity-gateway redirect looks like by the time App sees it: the fetch
 * threw, so the client reports status 0 rather than the 401 that means "log in". */
const gatewayShapedFailure = () => new ApiError(0, 'network_unreachable', 'Could not reach the server');

describe('App boot status', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/');
    mocks.me.mockReset();
    mocks.workspaces.mockReset();
    mocks.loadBootSnapshot.mockReset();
    mocks.authMethods.mockReset().mockResolvedValue({ open: true, email: false, google: false, calls: false });
    mocks.authGatewayRedirected.mockReset().mockResolvedValue(false);
    mocks.reloadForAuthGateway.mockReset().mockReturnValue(false);
  });
  afterEach(cleanup);

  it('announces the initial authentication check', () => {
    mocks.me.mockReturnValue(new Promise(() => {}));
    render(<App />);
    expect(screen.getByRole('status').textContent).toBe('Checking your sign-in…');
  });

  it('distinguishes a recoverable workspace failure and retries', async () => {
    mocks.me.mockResolvedValue({ user: { id: 'u1', handle: 'gary', displayName: 'Gary' }, prefs: null });
    mocks.workspaces.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
      workspaces: [{ id: 'w1', name: 'Atrium', createdAt: '' }],
    });
    mocks.loadBootSnapshot.mockResolvedValue(null);
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Workspace unavailable' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mocks.me).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Chat')).toBeTruthy();
  });

  // An expired Cloudflare Access session redirects even same-origin XHR to its own
  // host, which fetch reports as a bare network failure. Retrying in place can never
  // clear it — only a top-level navigation reaches the gateway's login page.
  describe('against an identity gateway', () => {
    it('reloads instead of walling when the gateway redirected the request', async () => {
      mocks.me.mockRejectedValue(gatewayShapedFailure());
      mocks.loadBootSnapshot.mockResolvedValue(null);
      mocks.authGatewayRedirected.mockResolvedValue(true);
      mocks.reloadForAuthGateway.mockReturnValue(true);
      render(<App />);

      await waitFor(() => expect(mocks.reloadForAuthGateway).toHaveBeenCalled());
      expect(screen.queryByRole('heading', { name: 'Couldn’t verify your sign-in' })).toBeNull();
    });

    it('names the expired session when a reload already failed to clear it', async () => {
      mocks.me.mockRejectedValue(gatewayShapedFailure());
      mocks.loadBootSnapshot.mockResolvedValue(null);
      mocks.authGatewayRedirected.mockResolvedValue(true);
      mocks.reloadForAuthGateway.mockReturnValue(false); // guard spent — no second reload
      render(<App />);

      expect(await screen.findByRole('heading', { name: 'Your sign-in session expired' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
    });

    it('does not reload a snapshot-backed boot when the network is merely down', async () => {
      mocks.me.mockRejectedValue(gatewayShapedFailure());
      mocks.loadBootSnapshot.mockResolvedValue({
        user: { id: 'u1', handle: 'allan', displayName: 'Allan' },
        workspace: { id: 'w1', name: 'Atrium', createdAt: '' },
      });
      render(<App />);

      expect(await screen.findByText('Chat')).toBeTruthy();
      expect(mocks.reloadForAuthGateway).not.toHaveBeenCalled();
    });

    it('still walls on a genuine network failure with nothing cached', async () => {
      mocks.me.mockRejectedValue(gatewayShapedFailure());
      mocks.loadBootSnapshot.mockResolvedValue(null);
      render(<App />);

      expect(await screen.findByRole('heading', { name: 'Couldn’t verify your sign-in' })).toBeTruthy();
      expect(mocks.reloadForAuthGateway).not.toHaveBeenCalled();
    });

    it('sends a plain 401 to the login screen without probing the gateway', async () => {
      mocks.me.mockRejectedValue(new ApiError(401, 'unauthorized', 'unauthorized'));
      mocks.loadBootSnapshot.mockResolvedValue(null);
      render(<App />);

      await waitFor(() => expect(mocks.me).toHaveBeenCalled());
      await waitFor(() => expect(mocks.authGatewayRedirected).not.toHaveBeenCalled());
    });
  });
});
