// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityCounts } from '@atrium/surface-client';
import type { Session } from '../sessions/types';
import { sidebarAgentWorkCollapsedKey, sidebarAgentWorkRecentCollapsedKey } from '../storageKeys';
import { ThemeProvider } from '../theme';
import { Sidebar } from './Sidebar';

const NOW = '2026-07-15T15:00:00.000Z';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    channelId: 'channel-other',
    threadRootEventId: null,
    title: 'Background implementation',
    status: 'running',
    harness: 'codex',
    spawnedBy: 'u-1',
    driverId: 'u-1',
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: NOW,
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 1,
    permalink: '/s/session-1',
    ...overrides,
  };
}

function renderSidebar({
  sessions = {},
  activityCounts,
  onOpenSession = vi.fn(),
}: {
  sessions?: Record<string, Session>;
  activityCounts?: ActivityCounts;
  onOpenSession?: (id: string) => void;
} = {}) {
  return {
    onOpenSession,
    ...render(
      <ThemeProvider>
        <Sidebar
          workspaceName="atrium"
          channels={[]}
          activeChannelId="channel-active"
          unread={{}}
          me={{ id: 'u-1', handle: 'ada', displayName: 'Ada' }}
          wsStatus="open"
          queueSync={{ queuedCount: 0, syncStuck: false }}
          onSelect={vi.fn()}
          onSetMute={vi.fn()}
          onCreateChannel={vi.fn().mockResolvedValue(undefined)}
          onStartDm={vi.fn()}
          onOpenActivity={vi.fn()}
          activityCounts={activityCounts}
          onOpenSession={onOpenSession}
          onLogout={vi.fn()}
          sessions={sessions}
        />
      </ThemeProvider>,
    ),
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('Sidebar agent work', () => {
  it('puts needs-you rows first and gives the active channel priority within each group', () => {
    const { onOpenSession } = renderSidebar({
      sessions: {
        otherQuestion: session({
          id: 'other-question',
          title: 'Older question elsewhere',
          pendingQuestion: {
            questionId: 'q-other',
            questions: [{ id: 'question-other', header: 'Environment', question: 'Which environment should I use?' }],
            askedAt: '2026-07-15T12:00:00.000Z',
          },
        }),
        activeQuestion: session({
          id: 'active-question',
          channelId: 'channel-active',
          title: 'Question in the active channel',
          pendingQuestion: {
            questionId: 'q-active',
            questions: [{ id: 'question-active', header: 'Merge', question: 'Can I merge this change?' }],
            askedAt: '2026-07-15T14:00:00.000Z',
          },
        }),
        otherRunning: session({ id: 'other-running', title: 'Running elsewhere' }),
        activeRunning: session({ id: 'active-running', channelId: 'channel-active', title: 'Running here' }),
      },
    });

    const rows = screen
      .getAllByRole('button', { name: /— (needs your answer|running,)/ })
      .map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringContaining('Question in the active channel'),
      expect.stringContaining('Older question elsewhere'),
      expect.stringContaining('Running here'),
      expect.stringContaining('Running elsewhere'),
    ]);
    expect(
      screen.getByRole('button', { name: 'Question in the active channel — needs your answer' }).getAttribute('title'),
    ).toBe('Can I merge this change?');

    fireEvent.click(screen.getByRole('button', { name: /Running here — running,/ }));
    expect(onOpenSession).toHaveBeenCalledWith('active-running');
  });

  it('collapses and restores the persisted state', () => {
    const rendered = renderSidebar({ sessions: { running: session() } });
    const toggle = screen.getByRole('button', { name: /Agent work/ });
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(window.localStorage.getItem(sidebarAgentWorkCollapsedKey('u-1'))).toBe('true');
    expect(screen.queryByRole('button', { name: /Background implementation — running,/ })).toBeNull();

    rendered.unmount();
    renderSidebar({ sessions: { running: session() } });
    expect(screen.getByRole('button', { name: /Agent work/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the section mounted when there is no live work or review activity', () => {
    renderSidebar();

    expect(screen.getByRole('button', { name: /Agent work/ })).toBeTruthy();
    expect(screen.getByText('No agent work yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Agents$/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Inbox$/ })).toBeTruthy();
  });

  it('shows a fold-only session in neither live work nor Recent', () => {
    renderSidebar({
      sessions: {
        unknown: session({
          id: 'fold-only',
          title: 'Fold-only phantom',
          status: 'unknown' as Session['status'],
        }),
      },
    });

    expect(screen.queryByText('Fold-only phantom')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recent' })).toBeNull();
    expect(screen.getByText('No agent work yet.')).toBeTruthy();
  });

  it('lists the eight newest terminal sessions in Recent and excludes archived sessions', () => {
    const recent = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => {
        const id = `recent-${index}`;
        return [
          id,
          session({
            id,
            title: `Recent ${index}`,
            status: 'completed',
            createdAt: '2026-07-15T12:00:00.000Z',
            completedAt: `2026-07-15T14:${String(59 - index).padStart(2, '0')}:00.000Z`,
          }),
        ];
      }),
    );
    const { onOpenSession } = renderSidebar({
      sessions: {
        ...recent,
        archived: session({
          id: 'archived',
          title: 'Archived newest',
          status: 'completed',
          completedAt: '2026-07-15T15:00:00.000Z',
          archivedAt: '2026-07-15T15:01:00.000Z',
        }),
      },
    });

    expect(screen.queryByRole('button', { name: /Recent 0 — Done in/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Recent' }));

    const rows = screen.getAllByRole('button', { name: /Recent \d+ — Done in/ });
    expect(rows.map((row) => row.textContent)).toEqual(
      Array.from({ length: 8 }, (_, index) => expect.stringContaining(`Recent ${index}`)),
    );
    expect(screen.queryByText('Recent 8')).toBeNull();
    expect(screen.queryByText('Archived newest')).toBeNull();

    fireEvent.click(rows[0]!);
    expect(onOpenSession).toHaveBeenCalledWith('recent-0');
  });

  it('persists the Recent disclosure choice', () => {
    const completed = session({ status: 'completed', completedAt: '2026-07-15T15:00:00.000Z' });
    const rendered = renderSidebar({ sessions: { completed } });
    fireEvent.click(screen.getByRole('button', { name: 'Recent' }));

    expect(window.localStorage.getItem(sidebarAgentWorkRecentCollapsedKey('u-1'))).toBe('false');
    rendered.unmount();
    renderSidebar({ sessions: { completed } });
    expect(screen.getByRole('button', { name: 'Recent' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps Recent out of the collapsed live-work count', () => {
    renderSidebar({
      sessions: {
        running: session({ id: 'running' }),
        completed: session({ id: 'completed', status: 'completed', completedAt: '2026-07-15T15:00:00.000Z' }),
      },
    });

    const toggle = screen.getByRole('button', { name: /Agent work/ });
    fireEvent.click(toggle);
    expect(toggle.textContent).toContain('· 1');
    expect(toggle.textContent).not.toContain('· 2');
  });

  it('shows the server to-review total and hides the line when it is zero', () => {
    const { rerender } = renderSidebar({ activityCounts: { attention: 0, unread: 7, toReview: 3 } });

    expect(screen.getByRole('button', { name: '3 to review →' })).toBeTruthy();

    rerender(
      <ThemeProvider>
        <Sidebar
          workspaceName="atrium"
          channels={[]}
          activeChannelId="channel-active"
          unread={{}}
          me={{ id: 'u-1', handle: 'ada', displayName: 'Ada' }}
          wsStatus="open"
          queueSync={{ queuedCount: 0, syncStuck: false }}
          onSelect={vi.fn()}
          onSetMute={vi.fn()}
          onCreateChannel={vi.fn().mockResolvedValue(undefined)}
          onStartDm={vi.fn()}
          onOpenActivity={vi.fn()}
          onOpenSession={vi.fn()}
          onLogout={vi.fn()}
          activityCounts={{ attention: 0, unread: 7, toReview: 0 }}
        />
      </ThemeProvider>,
    );

    expect(screen.queryByRole('button', { name: /to review/ })).toBeNull();
  });

  it('splits Inbox badges by needs-you and review, with unread fallback for human-only activity', () => {
    const { rerender } = renderSidebar({
      activityCounts: { attention: 9, unread: 12, needsYou: 2, toReview: 4 },
    });

    const inbox = screen.getByRole('button', { name: 'Inbox 2 need you 4 to review' });
    expect(inbox.textContent).toContain('2 need you4 to review');
    expect(inbox.querySelectorAll('.bg-warning-tint')).toHaveLength(1);
    expect(inbox.querySelectorAll('.bg-surface-overlay')).toHaveLength(1);

    rerender(
      <ThemeProvider>
        <Sidebar
          workspaceName="atrium"
          channels={[]}
          activeChannelId="channel-active"
          unread={{}}
          me={{ id: 'u-1', handle: 'ada', displayName: 'Ada' }}
          wsStatus="open"
          queueSync={{ queuedCount: 0, syncStuck: false }}
          onSelect={vi.fn()}
          onSetMute={vi.fn()}
          onCreateChannel={vi.fn().mockResolvedValue(undefined)}
          onStartDm={vi.fn()}
          onOpenActivity={vi.fn()}
          onOpenSession={vi.fn()}
          onLogout={vi.fn()}
          activityCounts={{ attention: 0, unread: 6, needsYou: 0, toReview: 0 }}
        />
      </ThemeProvider>,
    );

    expect(screen.getByRole('button', { name: 'Inbox 6 unread activity' })).toBeTruthy();
  });
});
