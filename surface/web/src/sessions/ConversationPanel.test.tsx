// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, UserRef } from '@atrium/surface-client';
import { ConversationPanel } from './ConversationPanel';
import type { ThreadPanelProps } from '../components/ThreadPanel';
import type { SessionPaneProps } from './SessionPane';
import { sessionsApi } from './api';
import type { Session } from './types';

const bodyMocks = vi.hoisted(() => ({ thread: vi.fn(), work: vi.fn() }));

vi.mock('../components/ThreadPanel', () => ({
  ThreadPanelContent: (props: { visible?: boolean }) => {
    bodyMocks.thread(props);
    return <div data-testid="thread-mode" />;
  },
}));

vi.mock('./SessionPane', () => ({
  SessionPaneContent: (props: { visible?: boolean }) => {
    bodyMocks.work(props);
    return <div data-testid="work-mode" />;
  },
}));

vi.mock('./api', () => ({
  sessionsApi: {
    openStream: vi.fn(),
  },
}));

const openStream = vi.mocked(sessionsApi.openStream);

const me: UserRef = { id: 'u-1', handle: 'ada', displayName: 'Ada' };
const session: Session = {
  id: 's-1',
  workspaceId: 'ws-1',
  channelId: 'ch-1',
  threadRootEventId: 42,
  title: 'Keep one stream',
  status: 'running',
  harness: 'codex',
  repo: null,
  branch: null,
  repos: null,
  spawnedBy: me.id,
  spawnerName: me.displayName,
  driverId: me.id,
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
  createdAt: '2026-07-15T12:00:00.000Z',
  completedAt: null,
  archivedAt: null,
  pinned: false,
  lastEventId: 0,
  permalink: '/s/s-1',
};

const sessionProps: SessionPaneProps = {
  session,
  me,
  watchers: [],
  onClose: vi.fn(),
  onAnswerQuestion: vi.fn(async () => {}),
};

const root: ChatMessage = {
  id: session.threadRootEventId!,
  clientMsgId: null,
  channelId: session.channelId,
  threadRootEventId: null,
  sessionId: session.id,
  text: session.title,
  edited: false,
  reactions: [],
  attachments: [],
  author: me,
  createdAt: session.createdAt,
  replyCount: 0,
  lastReplyId: session.threadRootEventId!,
  status: 'confirmed',
};

const threadProps: ThreadPanelProps = {
  root,
  replies: [],
  loaded: true,
  sessions: { [session.id]: session },
  spectators: {},
  onClose: vi.fn(),
  onSend: vi.fn(),
  onOpenSession: vi.fn(),
  onRetry: vi.fn(),
};

describe('ConversationPanel stream identity', () => {
  const close = vi.fn();

  beforeEach(() => {
    bodyMocks.thread.mockReset();
    bodyMocks.work.mockReset();
    close.mockReset();
    openStream.mockReset();
    openStream.mockReturnValue({ close });
  });

  afterEach(cleanup);

  it('does not close or reopen the SSE when the route changes modes', () => {
    const view = render(<ConversationPanel mode="work" session={sessionProps} />);
    expect(openStream).toHaveBeenCalledTimes(1);

    view.rerender(<ConversationPanel mode="thread" session={sessionProps} />);
    view.rerender(<ConversationPanel mode="work" session={sessionProps} />);

    expect(openStream).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    view.unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('enables effects for exactly one mounted body in thread mode', () => {
    render(<ConversationPanel mode="thread" thread={threadProps} session={sessionProps} />);

    expect(bodyMocks.thread).toHaveBeenCalledWith(expect.objectContaining({ visible: true }));
    expect(bodyMocks.work).toHaveBeenCalledWith(expect.objectContaining({ visible: false }));
    const enabledBodies = [
      bodyMocks.thread.mock.lastCall?.[0].visible,
      bodyMocks.work.mock.lastCall?.[0].visible,
    ].filter(Boolean);
    expect(enabledBodies).toHaveLength(1);
  });
});

describe('ConversationPanel pending mode', () => {
  beforeEach(() => {
    openStream.mockReset();
  });

  afterEach(cleanup);

  it('renders the loading shell with the split-pane sizing and close action', () => {
    const onClose = vi.fn();
    const { container } = render(
      <ConversationPanel
        mode="work"
        pending={{
          sessionId: 's-loading',
          error: false,
          onClose,
          layout: 'split',
          sizing: { className: 'w-pending-pane', style: { width: '444px' } },
        }}
      />,
    );

    expect(screen.getByText('Loading session…')).toBeTruthy();
    const aside = container.querySelector('aside');
    expect(aside?.className).toContain('shrink-0 w-pending-pane');
    expect((aside as HTMLElement).style.width).toBe('444px');

    fireEvent.click(screen.getByRole('button', { name: 'Close session details' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders the error shell at full width and closes from the body action', () => {
    const onClose = vi.fn();
    const { container } = render(
      <ConversationPanel
        mode="work"
        pending={{
          sessionId: 's-missing',
          error: true,
          onClose,
          layout: 'focus',
          sizing: { className: 'w-pending-pane', style: { width: '444px' } },
        }}
      />,
    );

    expect(screen.getByText('Agent not found')).toBeTruthy();
    expect(screen.getByText('It may have been removed, or the link is wrong.')).toBeTruthy();
    const aside = container.querySelector('aside');
    expect(aside?.className).toContain('flex-1');
    expect((aside as HTMLElement).style.width).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
