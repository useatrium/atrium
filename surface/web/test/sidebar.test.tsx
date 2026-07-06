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

    expect(sessionSidebarPreview(sessions).map((item) => item.id)).toEqual([
      's-5',
      's-4',
      's-3',
      's-2',
      's-1',
    ]);
  });
});

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
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    await screen.findByText('Newer queued');

    const agentsSection = screen.getByRole('heading', { name: 'Agents' }).closest('section');
    expect(agentsSection).toBeTruthy();
    const buttons = within(agentsSection!).getAllByRole('button').map((button) => button.textContent ?? '');

    expect(buttons[0]).toContain('Newer queued');
    expect(buttons[1]).toContain('Older running');
    expect(buttons[2]).toContain('Newest cancelled');
    expect(buttons[3]).toContain('Fresh completed');
    expect(buttons[4]).toContain('Recent failed');
    expect(buttons[5]).toContain('View all agent sessions');
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
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      { onOpenAgents },
    );

    await screen.findByText('Active session');
    fireEvent.click(screen.getByRole('button', { name: 'View all agent sessions' }));
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
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      { onOpenSettings },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});
