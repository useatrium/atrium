// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatMessage, UserRef } from '@atrium/surface-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme';
import type { Session } from '../sessions/types';
import { ThreadPanelHarness as ThreadPanel } from '../../test/renderConversation';

vi.mock('../sessions/useSessionStream', async () => {
  const { initialSessionState } = await import('@atrium/centaur-client');
  return {
    useSessionStream: () => ({
      stream: initialSessionState(),
      connected: false,
      lastFrameAt: null,
      clockSkewMs: null,
    }),
  };
});

afterEach(cleanup);

const ada: UserRef = { id: 'u-1', handle: 'ada', displayName: 'Ada Lovelace' };

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 42,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: null,
    text: 'Can we ship the migration today?',
    edited: false,
    reactions: [],
    attachments: [],
    author: ada,
    createdAt: '2026-07-05T12:00:00.000Z',
    replyCount: 1,
    lastReplyId: 0,
    status: 'confirmed',
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: 42,
    title: 'Fix the flaky login test',
    status: 'running',
    harness: 'codex',
    repo: null,
    branch: null,
    repos: null,
    spawnedBy: 'u-1',
    driverId: 'u-1',
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    pendingQuestion: null,
    providerAuthRequired: null,
    githubIdentityMode: null,
    providerConnectionId: null,
    agentProfileVersionId: null,
    modelEffort: null,
    questionEvents: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: '2026-07-05T12:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 0,
    permalink: '/s/s-1',
    ...overrides,
  };
}

function renderPanel({
  root = message(),
  sessions = {},
  onOpenSession = vi.fn(),
  onClose = vi.fn(),
}: {
  root?: ChatMessage;
  sessions?: Record<string, Session>;
  onOpenSession?: (sessionId: string) => void;
  onClose?: () => void;
} = {}) {
  render(
    <ThemeProvider>
      <ThreadPanel
        root={root}
        replies={[]}
        loaded
        sessions={sessions}
        spectators={{}}
        meId="u-1"
        meHandle="ada"
        channelLabel="#eng"
        onClose={onClose}
        onSend={vi.fn()}
        onOpenSession={onOpenSession}
        onRetry={vi.fn()}
      />
    </ThemeProvider>,
  );
}

describe('ThreadPanel identity header', () => {
  it('wears the attached session’s identity instead of generic thread chrome', () => {
    renderPanel({ sessions: { 's-1': session() } });

    const header = screen.getByTestId('conversation-header');
    // Same chip · same title the card and the pane show — the middle zoom finally
    // says its own name. The old generic "Thread · N replies" chrome is gone.
    expect(screen.getByTestId('conversation-title').textContent).toBe('Fix the flaky login test');
    expect(screen.getByTestId('glance-chip')).toBeTruthy();
    expect(header.textContent).not.toContain('Thread');
  });

  it('demotes the reply count to the crumb line, in the pane’s crumb vocabulary', () => {
    const onClose = vi.fn();
    renderPanel({ sessions: { 's-1': session() }, onClose });

    const crumb = screen.getByTestId('conversation-crumb');
    expect(crumb.textContent).toContain('#eng');
    expect(crumb.textContent).toContain('thread');
    expect(crumb.textContent).toContain('1 reply');

    fireEvent.click(screen.getByRole('button', { name: '#eng' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('zooms from the identity into the work', () => {
    const onOpenSession = vi.fn();
    renderPanel({ sessions: { 's-1': session() }, onOpenSession });

    fireEvent.click(screen.getByTestId('conversation-title'));
    expect(onOpenSession).toHaveBeenCalledWith('s-1');
  });

  it('gives a human thread its own identity — author and opening line', () => {
    renderPanel({ root: message({ replyCount: 3 }) });

    const header = screen.getByTestId('conversation-header');
    expect(screen.getByTestId('conversation-title').textContent).toBe('Ada Lovelace');
    expect(within(header).getByText('Can we ship the migration today?')).toBeTruthy();
    expect(screen.queryByTestId('glance-chip')).toBeNull();
    expect(screen.getByTestId('conversation-crumb').textContent).toContain('3 replies');
    // Nothing about the human thread breaks: it still closes.
    expect(screen.getByRole('button', { name: 'Close thread' })).toBeTruthy();
  });
});
