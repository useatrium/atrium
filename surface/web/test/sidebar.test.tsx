// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/api';
import { Sidebar } from '../src/components/Sidebar';
import { ThemeProvider } from '../src/theme';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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
        queueSync={{ queuedCount: 0, syncStuck: false }}
        onSelect={vi.fn()}
        onSetMute={vi.fn()}
        onCreateChannel={async () => {}}
        onStartDm={vi.fn()}
        onLogout={vi.fn()}
        {...props}
      />
    </ThemeProvider>,
  );
}

describe('Sidebar', () => {
  it('offers progressive inline pin, archive, and mute actions', () => {
    const onSetPinned = vi.fn();
    const onSetArchived = vi.fn();
    renderSidebar(
      [
        {
          id: 'ch-general',
          workspaceId: 'ws-1',
          name: 'general',
          kind: 'public',
          muted: false,
          archivedAt: null,
          pinned: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      { onSetPinned, onSetArchived },
    );

    const pin = screen.getByRole('button', { name: 'Pin general' });
    const archive = screen.getByRole('button', { name: 'Archive general' });
    expect(pin.className).toContain('@[12rem]:block');
    expect(archive.className).toContain('@[15.5rem]:block');

    fireEvent.click(pin);
    fireEvent.click(archive);
    expect(onSetPinned).toHaveBeenCalledWith('ch-general', true);
    expect(onSetArchived).toHaveBeenCalledWith('ch-general', true);
    expect(screen.getByRole('button', { name: 'Mute general' })).toBeTruthy();
  });

  it('shows unpin for pinned channels and only unarchive for archived channels', () => {
    const onSetPinned = vi.fn();
    const onSetArchived = vi.fn();
    const base = {
      workspaceId: 'ws-1',
      kind: 'public' as const,
      muted: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    renderSidebar(
      [
        { ...base, id: 'ch-pinned', name: 'pinned', archivedAt: null, pinned: true },
        { ...base, id: 'ch-old', name: 'old', archivedAt: '2026-07-01T00:00:00.000Z', pinned: false },
      ],
      { onSetPinned, onSetArchived },
    );

    fireEvent.click(screen.getByRole('button', { name: /Archived/ }));
    const unpin = screen.getByRole('button', { name: 'Unpin pinned' });
    const unarchive = screen.getByRole('button', { name: 'Unarchive old' });
    expect(screen.queryByRole('button', { name: 'Pin old' })).toBeNull();

    fireEvent.click(unpin);
    fireEvent.click(unarchive);
    expect(onSetPinned).toHaveBeenCalledWith('ch-pinned', false);
    expect(onSetArchived).toHaveBeenCalledWith('ch-old', false);
  });

  it('shows only the people Inbox unread badge and caps its display', () => {
    const channel = {
      id: 'ch-general',
      workspaceId: 'ws-1',
      name: 'general',
      kind: 'public' as const,
      muted: false,
      archivedAt: null,
      pinned: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const { unmount } = renderSidebar([channel], {
      activityCounts: { attention: 99, unread: 120, needsYou: 99, toReview: 2 },
    });

    const attentionRow = screen.getByRole('button', { name: /Inbox.*99\+ unread activity/ });
    const attentionBadge = within(attentionRow).getByText('99+');
    expect(attentionBadge.className).toContain('bg-surface-overlay');

    unmount();
    renderSidebar([channel], { activityCounts: { attention: 0, unread: 3, needsYou: 0, toReview: 0 } });
    const unreadRow = screen.getByRole('button', { name: /Inbox.*unread activity/ });
    const unreadBadge = within(unreadRow).getByText('3');
    expect(unreadBadge.className).toContain('bg-surface-overlay');
  });

  it('splits pinned channels into a Pinned section and hides archived behind a disclosure', () => {
    const base = {
      workspaceId: 'ws-1',
      kind: 'public' as const,
      muted: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    renderSidebar([
      { ...base, id: 'ch-general', name: 'general', archivedAt: null, pinned: false },
      { ...base, id: 'ch-pinned', name: 'pinned-chan', archivedAt: null, pinned: true },
      { ...base, id: 'ch-archived', name: 'old-chan', archivedAt: '2026-07-01T00:00:00.000Z', pinned: false },
    ]);

    expect(screen.getByText('Pinned')).toBeTruthy();
    expect(screen.getByText('pinned-chan')).toBeTruthy();
    expect(screen.getByText('general')).toBeTruthy();
    // Archived channels are collapsed by default and appear on expand.
    expect(screen.queryByText('old-chan')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Archived/ }));
    expect(screen.getByText('old-chan')).toBeTruthy();
  });

  it('keeps the connection status accessible but invisible when healthy', () => {
    renderSidebar([
      {
        id: 'ch-general',
        workspaceId: 'ws-1',
        name: 'general',
        kind: 'public',
        muted: false,
        archivedAt: null,
        pinned: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const status = screen.getByRole('status', { name: 'connection: open' });
    expect(status.getAttribute('class')).toContain('bg-transparent');
    expect(status.getAttribute('class')).not.toContain('animate-pulse');
    expect(status.getAttribute('title')).toBe('connection: open');
  });

  it('shows an info pulsing connection status when sync is stuck', () => {
    renderSidebar(
      [
        {
          id: 'ch-general',
          workspaceId: 'ws-1',
          name: 'general',
          kind: 'public',
          muted: false,
          archivedAt: null,
          pinned: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      { queueSync: { queuedCount: 3, syncStuck: true } },
    );

    const status = screen.getByRole('status', { name: 'connection: open' });
    const className = status.getAttribute('class') ?? '';
    expect(className).toContain('animate-pulse');
    expect(className).toContain('bg-info');
    expect(status.getAttribute('title')).toBe('Syncing — 3 changes queued');
  });

  it('uses the singular sync title for one queued change', () => {
    renderSidebar(
      [
        {
          id: 'ch-general',
          workspaceId: 'ws-1',
          name: 'general',
          kind: 'public',
          muted: false,
          archivedAt: null,
          pinned: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      { queueSync: { queuedCount: 1, syncStuck: true } },
    );

    expect(screen.getByRole('status', { name: 'connection: open' }).getAttribute('title')).toBe(
      'Syncing — 1 change queued',
    );
  });

  it('keeps warning and danger connection dots for connecting and closed states', () => {
    const channel = {
      id: 'ch-general',
      workspaceId: 'ws-1',
      name: 'general',
      kind: 'public' as const,
      muted: false,
      archivedAt: null,
      pinned: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    const { unmount } = renderSidebar([channel], { wsStatus: 'connecting' });
    const connecting = screen.getByRole('status', { name: 'connection: connecting' });
    expect(connecting.getAttribute('class')).toContain('animate-pulse');
    expect(connecting.getAttribute('class')).toContain('bg-warning');
    expect(connecting.getAttribute('title')).toBe('connection: connecting');

    unmount();
    renderSidebar([channel], { wsStatus: 'closed' });
    const closed = screen.getByRole('status', { name: 'connection: closed' });
    expect(closed.getAttribute('class')).toContain('bg-danger');
    expect(closed.getAttribute('class')).not.toContain('animate-pulse');
    expect(closed.getAttribute('title')).toBe('connection: closed');
  });

  it('uses the DM partner display name, not the decorated label, for avatar initials', () => {
    renderSidebar([
      {
        id: 'ch-general',
        workspaceId: 'ws-1',
        name: 'general',
        kind: 'public',
        muted: false,
        archivedAt: null,
        pinned: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'dm-self',
        workspaceId: 'ws-1',
        name: 'dm-self',
        kind: 'dm',
        muted: false,
        archivedAt: null,
        pinned: false,
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
          archivedAt: null,
          pinned: false,
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

  it('does not show Agents as a workspace destination', () => {
    renderSidebar(
      [
        {
          id: 'ch-general',
          workspaceId: 'ws-1',
          name: 'general',
          kind: 'public',
          muted: false,
          archivedAt: null,
          pinned: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      { activeSurface: 'chat', activeChannelId: null },
    );

    expect(screen.queryByRole('button', { name: 'Agents' })).toBeNull();
  });

  it('groups global destinations separately from conversations', () => {
    renderSidebar([
      {
        id: 'ch-general',
        workspaceId: 'ws-1',
        name: 'general',
        kind: 'public',
        muted: false,
        archivedAt: null,
        pinned: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(screen.getByText('Conversations')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Agents' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeTruthy();
    expect(screen.queryByText('Sessions')).toBeNull();
  });

  it('routes settings from the footer gear', () => {
    const onOpenSettings = vi.fn();
    renderSidebar(
      [
        {
          id: 'ch-general',
          workspaceId: 'ws-1',
          name: 'general',
          kind: 'public',
          muted: false,
          archivedAt: null,
          pinned: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      { onOpenSettings },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});
