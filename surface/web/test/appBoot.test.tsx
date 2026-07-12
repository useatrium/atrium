// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  workspaces: vi.fn(),
  loadBootSnapshot: vi.fn(),
}));

vi.mock('../src/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
  api: { me: mocks.me, workspaces: mocks.workspaces },
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
}));
vi.mock('../src/theme', () => ({ adoptPrefs: vi.fn() }));
vi.mock('../src/Chat', () => ({ Chat: () => <div>Chat</div> }));
vi.mock('../src/EntryLinkRoute', () => ({ EntryLinkRoute: () => null, entryHandleFromPath: () => null }));
vi.mock('../src/MarkupShellPage', () => ({ MarkupShellPage: () => null, isMarkupShellRoute: () => false }));
vi.mock('../src/sessions/SessionPanePage', () => ({ SessionPanePage: () => null }));
vi.mock('../src/sessions/SessionWorkPage', () => ({ SessionWorkPage: () => null }));
vi.mock('../src/sessions/WorkDrawer', () => ({ SLUG_TAB: {} }));
vi.mock('../src/components/Toasts', () => ({ Toasts: () => null }));
vi.mock('../src/components/a11y', () => ({ TooltipProvider: ({ children }: { children: React.ReactNode }) => children }));

import { App } from '../src/App';

describe('App boot status', () => {
  beforeEach(() => {
    history.replaceState(null, '', '/');
    mocks.me.mockReset();
    mocks.workspaces.mockReset();
    mocks.loadBootSnapshot.mockReset();
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
});
