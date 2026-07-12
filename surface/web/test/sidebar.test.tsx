// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/api';
import { Sidebar, sessionSidebarPreview } from '../src/components/Sidebar';
import { sessionsApi } from '../src/sessions/api';
import type { SessionListItem } from '../src/sessions/types';
import { ThemeProvider } from '../src/theme';

vi.mock('../src/sessions/api', () => ({
  sessionsApi: {
    list: vi.fn(async () => ({ sessions: [] })),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.mocked(sessionsApi.list).mockResolvedValue({ sessions: [] });
});

const me = { id: 'u-allan', handle: 'allann', displayName: 'Allan Niemerg' };

function session(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: 's-1',
    channelId: 'ch-general',
    channelName: 'general',
    title: 'Agent session',
    status: 'running',
    harness: 'codex',
    spawnedBy: 'u-allan',
    spawnerName: 'Allan Niemerg',
    costUsd: 0,
    createdAt: '2026-07-03T10:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    ...overrides,
  };
}

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
        onOpenSession={vi.fn()}
        sessionEventSeq={0}
        onLogout={vi.fn()}
        {...props}
      />
    </ThemeProvider>,
  );
}

describe('sessionSidebarPreview', () => {
  it('orders attention, active, then terminal sessions by freshest timestamp', () => {
    const sessions = [
      session({
        id: 'terminal-newer-than-active',
        status: 'completed',
        createdAt: '2026-07-03T08:00:00.000Z',
        completedAt: '2026-07-03T12:00:00.000Z',
      }),
      session({ id: 'active-old', status: 'running', createdAt: '2026-07-03T09:00:00.000Z' }),
      session({ id: 'active-new', status: 'queued', createdAt: '2026-07-03T10:00:00.000Z' }),
      {
        ...session({
          id: 'needs-attention',
          status: 'completed',
          createdAt: '2026-07-03T07:00:00.000Z',
          completedAt: '2026-07-03T07:30:00.000Z',
        }),
        needsAttention: true,
      } as SessionListItem,
      session({
        id: 'terminal-old',
        status: 'failed',
        createdAt: '2026-07-03T06:00:00.000Z',
        completedAt: '2026-07-03T06:30:00.000Z',
      }),
    ];

    expect(sessionSidebarPreview(sessions).map((item) => item.id)).toEqual([
      'needs-attention',
      'active-new',
      'active-old',
      'terminal-newer-than-active',
      'terminal-old',
    ]);
  });

  it('limits the compact preview to five sessions', () => {
    const sessions = Array.from({ length: 6 }, (_, index) =>
      session({
        id: `s-${index}`,
        title: `Session ${index}`,
        createdAt: `2026-07-03T10:0${index}:00.000Z`,
      }),
    );

    expect(sessionSidebarPreview(sessions).map((item) => item.id)).toEqual(['s-5', 's-4', 's-3', 's-2', 's-1']);
  });
});

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

  it('shows Agents as a workspace destination', () => {
    const onOpenAgents = vi.fn();
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
      { activeSurface: 'agents', activeChannelId: null, onOpenAgents },
    );

    const agents = screen.getByRole('button', { name: 'Agents' });
    expect(agents.getAttribute('aria-current')).toBe('page');
    fireEvent.click(agents);
    expect(onOpenAgents).toHaveBeenCalledOnce();
  });

  it('groups sidebar navigation into workspace, conversations, and agents', () => {
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
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeTruthy();
    expect(screen.queryByText('Sessions')).toBeNull();
  });

  it('shows recent terminal sessions in the agents preview without a numeric count', async () => {
    vi.mocked(sessionsApi.list).mockResolvedValue({
      sessions: [
        session({
          id: 'done-fresh',
          title: 'Fresh completed',
          status: 'completed',
          createdAt: '2026-07-03T08:00:00.000Z',
          completedAt: '2026-07-03T12:00:00.000Z',
        }),
        session({
          id: 'active-old',
          title: 'Older running',
          status: 'running',
          createdAt: '2026-07-03T09:00:00.000Z',
        }),
        session({
          id: 'active-new',
          title: 'Newer queued',
          status: 'queued',
          createdAt: '2026-07-03T10:00:00.000Z',
        }),
        session({
          id: 'failed-recent',
          title: 'Recent failed',
          status: 'failed',
          createdAt: '2026-07-03T07:00:00.000Z',
          completedAt: '2026-07-03T11:00:00.000Z',
        }),
        session({
          id: 'cancelled-new',
          title: 'Newest cancelled',
          status: 'cancelled',
          createdAt: '2026-07-03T06:00:00.000Z',
          completedAt: '2026-07-03T13:00:00.000Z',
        }),
        session({
          id: 'done-old',
          title: 'Dropped completed',
          status: 'completed',
          createdAt: '2026-07-03T05:00:00.000Z',
          completedAt: '2026-07-03T05:30:00.000Z',
        }),
      ],
    });

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

    await screen.findByText('Newer queued');

    const agentsSection = screen.getByRole('heading', { name: 'Agents' }).closest('section');
    expect(agentsSection).toBeTruthy();
    const buttons = within(agentsSection!)
      .getAllByRole('button')
      .map((button) => button.textContent ?? '');

    expect(buttons[0]).toContain('Newer queued');
    expect(buttons[1]).toContain('Older running');
    expect(buttons[2]).toContain('Newest cancelled');
    expect(buttons[3]).toContain('Fresh completed');
    expect(buttons[4]).toContain('Recent failed');
    expect(buttons[5]).toContain('View all agents');
    expect(within(agentsSection!).queryByText('Dropped completed')).toBeNull();
    expect(within(agentsSection!).queryByText('2')).toBeNull();
  });

  it('routes the agents preview view-all affordance', async () => {
    const onOpenAgents = vi.fn();
    vi.mocked(sessionsApi.list).mockResolvedValue({
      sessions: [
        session({
          id: 'active-session',
          title: 'Active session',
          status: 'running',
          createdAt: '2026-07-03T10:00:00.000Z',
        }),
      ],
    });

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
      { onOpenAgents },
    );

    await screen.findByText('Active session');
    fireEvent.click(screen.getByRole('button', { name: 'View all agents' }));
    expect(onOpenAgents).toHaveBeenCalledOnce();
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
