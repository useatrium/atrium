// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Channel, ProviderCredentialStatus } from '../src/api';
import { Sidebar } from '../src/components/Sidebar';
import { ThemeProvider } from '../src/theme';

afterEach(cleanup);

const me = { id: 'u-allan', handle: 'allann', displayName: 'Allan Niemerg' };

function renderSidebar(channels: Channel[], props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return render(
    <ThemeProvider>
      <Sidebar
        workspaceName="atrium"
        channels={channels}
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
        {...props}
      />
    </ThemeProvider>,
  );
}

describe('Sidebar', () => {
  it('uses the DM partner display name, not the decorated label, for avatar initials', () => {
    renderSidebar([
        {
          id: 'ch-general',
          workspaceId: 'ws-1',
          name: 'general',
          kind: 'public',
          muted: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'dm-self',
          workspaceId: 'ws-1',
          name: 'dm-self',
          kind: 'dm',
          muted: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          members: [me],
        },
    ]);

    expect(screen.getByText('Allan Niemerg (you)')).toBeTruthy();
    expect(screen.getByTitle('Allan Niemerg').textContent).toBe('AN');
    expect(screen.queryByText('AY')).toBeNull();
  });

  it('shows Files as a workspace destination', () => {
    const onOpenFiles = vi.fn();
    renderSidebar(
      [
        {
          id: 'ch-general',
          workspaceId: 'ws-1',
          name: 'general',
          kind: 'public',
          muted: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      { activeSurface: 'files', activeChannelId: null, onOpenFiles },
    );

    const files = screen.getByRole('button', { name: 'Files' });
    expect(files.getAttribute('aria-current')).toBe('page');
    fireEvent.click(files);
    expect(onOpenFiles).toHaveBeenCalledOnce();
  });

  it('groups sidebar navigation into workspace, conversations, and agents', () => {
    renderSidebar([
      {
        id: 'ch-general',
        workspaceId: 'ws-1',
        name: 'general',
        kind: 'public',
        muted: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(screen.getByText('Conversations')).toBeTruthy();
    expect(screen.getByText('Agents')).toBeTruthy();
    expect(screen.queryByText('Sessions')).toBeNull();
  });

  it('shows unavailable GitHub connection state without breaking provider settings', () => {
    renderSidebar(
      [
        {
          id: 'ch-general',
          workspaceId: 'ws-1',
          name: 'general',
          kind: 'public',
          muted: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      { connectionsAvailable: false },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(screen.getByRole('button', { name: /Unavailable/ })).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
  });

  it('shows explicit GitHub fallback and needs-auth states in settings', () => {
    renderSidebar(
      [
        {
          id: 'ch-general',
          workspaceId: 'ws-1',
          name: 'general',
          kind: 'public',
          muted: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      { connectionsAvailable: true },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(screen.getByRole('button', { name: /Public read/ })).toBeTruthy();
    cleanup();

    renderSidebar(
      [
        {
          id: 'ch-general',
          workspaceId: 'ws-1',
          name: 'general',
          kind: 'public',
          muted: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      {
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
      },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(screen.getByRole('button', { name: /Needs auth/ })).toBeTruthy();
  });

  it('shows GitHub identity kind in connected settings state', () => {
    renderSidebar(
      [
        {
          id: 'ch-general',
          workspaceId: 'ws-1',
          name: 'general',
          kind: 'public',
          muted: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      {
        connectionsAvailable: true,
        githubConnection: {
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
        },
      },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(screen.getByRole('button', { name: /acme · App/ })).toBeTruthy();
  });
});
