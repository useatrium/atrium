// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS, type UserPrefs } from '@atrium/surface-client';
import type { Channel, ProviderCredentialStatus } from '../src/api';
import { Sidebar } from '../src/components/Sidebar';

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

vi.mock('../src/sessions/api', () => ({
  sessionsApi: {
    list: vi.fn(async () => ({ sessions: [] })),
  },
}));

const me = { id: 'u-allan', handle: 'allann', displayName: 'Allan Niemerg' };

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-general',
    workspaceId: 'ws-1',
    name: 'general',
    kind: 'public',
    muted: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderSettings() {
  render(
    <Sidebar
      workspaceName="atrium"
      channels={[channel()]}
      activeChannelId="ch-general"
      unread={{}}
      me={me}
      wsStatus="open"
      onSelect={vi.fn()}
      onSetMute={vi.fn()}
      onCreateChannel={async () => {}}
      onStartDm={vi.fn()}
      onOpenSession={vi.fn()}
      sessionEventSeq={0}
      providerCredentials={{} as Record<string, ProviderCredentialStatus | undefined>}
      onLogout={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
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
    expect(screen.getByRole('button', { name: 'Agent sessions notifications' })).toBeTruthy();
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

    fireEvent.click(screen.getByRole('button', { name: 'Agent sessions notifications' }));
    expect(mockTheme.setPrefs).toHaveBeenLastCalledWith({
      notifications: { messages: 'dm_mention', sessions: false, calls: true },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Call notifications' }));
    expect(mockTheme.setPrefs).toHaveBeenLastCalledWith({
      notifications: { messages: 'dm_mention', sessions: true, calls: false },
    });
  });
});
