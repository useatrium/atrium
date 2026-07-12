// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS, type UserPrefs } from '@atrium/surface-client';
import type { ConnectionStatus, ProviderCredentialStatus } from '../src/api';
import { SettingsSurface } from '../src/components/SettingsSurface';

const mockTheme = vi.hoisted(() => ({
  prefs: null as UserPrefs | null,
  setPrefs: vi.fn(),
}));

vi.mock('../src/theme', () => ({
  useTheme: () => ({
    prefs: mockTheme.prefs,
    resolvedScheme: 'dark',
    setPrefs: mockTheme.setPrefs,
  }),
}));

vi.mock('../src/notify', () => ({
  notificationState: vi.fn(() => 'off'),
  toggleNotifications: vi.fn(async () => 'on'),
}));

function renderSettings(props: Partial<Parameters<typeof SettingsSurface>[0]> = {}) {
  render(
    <SettingsSurface
      connectionsAvailable
      claudeStatus={undefined as ProviderCredentialStatus | undefined}
      codexStatus={undefined as ProviderCredentialStatus | undefined}
      {...props}
    />,
  );
}

beforeEach(() => {
  mockTheme.prefs = { ...DEFAULT_PREFS, notifications: { ...DEFAULT_PREFS.notifications } };
  mockTheme.setPrefs.mockClear();
});

afterEach(cleanup);

describe('notification settings', () => {
  it('renders device and per-type notification controls', () => {
    renderSettings();

    expect(screen.getByText('Notifications')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Device notifications off/ })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Message notifications' })).toHaveProperty(
      'value',
      'dm_mention',
    );
    expect(screen.getByRole('button', { name: 'Agent notifications' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Call notifications' })).toBeTruthy();
  });

  it('writes complete notification preference objects', () => {
    renderSettings();

    fireEvent.change(screen.getByRole('combobox', { name: 'Message notifications' }), {
      target: { value: 'all' },
    });
    expect(mockTheme.setPrefs).toHaveBeenLastCalledWith({
      notifications: { messages: 'all', sessions: true, calls: true },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Agent notifications' }));
    expect(mockTheme.setPrefs).toHaveBeenLastCalledWith({
      notifications: { messages: 'dm_mention', sessions: false, calls: true },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Call notifications' }));
    expect(mockTheme.setPrefs).toHaveBeenLastCalledWith({
      notifications: { messages: 'dm_mention', sessions: true, calls: false },
    });
  });

  it('shows unavailable GitHub connection state without breaking provider settings', () => {
    renderSettings({ connectionsAvailable: false });

    expect(screen.getByRole('button', { name: /Unavailable/ })).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
  });

  it('shows explicit GitHub fallback and needs-auth states', () => {
    renderSettings({ connectionsAvailable: true });
    expect(screen.getByRole('button', { name: /Public read/ })).toBeTruthy();
    cleanup();

    renderSettings({
      connectionsAvailable: true,
      githubConnection: {
        id: 'github:app_installation',
        provider: 'github',
        workspaceId: 'ws-1',
        connected: false,
        status: 'needs_auth',
        tokenKind: 'app_installation',
        accountLogin: 'acme',
        accountLabel: 'acme',
        scopes: [],
        capabilities: {},
        metadata: {},
        identities: [],
        lastValidatedAt: null,
        lastError: 'token revoked',
        updatedAt: null,
      },
    });

    expect(screen.getByRole('button', { name: /Needs auth/ })).toBeTruthy();
  });

  it('shows GitHub identity kind in connected state', () => {
    const githubConnection: ConnectionStatus = {
      id: 'github:app_installation',
      provider: 'github',
      workspaceId: 'ws-1',
      connected: true,
      status: 'connected',
      tokenKind: 'app_installation',
      accountLogin: 'acme',
      accountLabel: 'acme',
      scopes: [],
      capabilities: {},
      metadata: {},
      identities: [],
      lastValidatedAt: null,
      lastError: null,
      updatedAt: null,
    };

    renderSettings({ githubConnection });

    expect(screen.getByRole('button', { name: /acme · App/ })).toBeTruthy();
  });
});
