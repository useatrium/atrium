// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { initialSessionState, type SessionState } from '@atrium/centaur-client';
import type { ChatMessage, UserRef } from '@atrium/surface-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadPanel } from '../src/components/ThreadPanel';
import type { Session } from '../src/sessions/types';
import { ThemeProvider } from '../src/theme';

const mocks = vi.hoisted(() => ({ stream: null as SessionState | null, conflicts: [] as unknown[] }));

vi.mock('../src/sessions/useSessionStream', () => ({
  useSessionStream: () => ({
    stream: mocks.stream!,
    connected: true,
    lastFrameAt: null,
    clockSkewMs: null,
  }),
}));

vi.mock('../src/sessions/useConflicts', () => ({
  useConflicts: () => ({ conflicts: mocks.conflicts, resolve: vi.fn(), refresh: vi.fn() }),
}));

const ada: UserRef = { id: 'u-1', handle: 'ada', displayName: 'Ada Lovelace' };
const agent: UserRef = { id: 'agent:s-1', handle: 'agent', displayName: 'Agent' };

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 42,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: null,
    text: 'Please inspect the build.',
    edited: false,
    reactions: [],
    attachments: [],
    author: ada,
    createdAt: '2026-07-14T12:00:00.000Z',
    replyCount: 2,
    lastReplyId: 44,
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
    title: 'Inspect the build',
    status: 'completed',
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
    resultText: 'Done',
    createdAt: '2026-07-14T12:00:00.000Z',
    completedAt: '2026-07-14T12:00:04.000Z',
    archivedAt: null,
    pinned: false,
    lastEventId: 4,
    permalink: '/s/s-1',
    ...overrides,
  };
}

function sessionStream(): SessionState {
  return {
    ...initialSessionState(),
    status: 'completed',
    lastEventId: 4,
    items: [
      {
        type: 'user_message',
        id: 'ask',
        text: 'Please inspect the build.',
        ts: '2026-07-14T12:00:00.000Z',
        sourceEventIds: [1],
      },
      {
        type: 'tool_call',
        id: 'tool',
        name: 'Bash',
        input: { command: 'pnpm test' },
        result: { content: 'passed', is_error: false },
        ts: '2026-07-14T12:00:01.000Z',
        sourceEventIds: [2],
      },
      {
        type: 'text',
        id: 'answer',
        text: 'The build passes.',
        ts: '2026-07-14T12:00:04.000Z',
        sourceEventIds: [3],
      },
    ],
    fileChanges: [
      {
        id: 'change',
        path: '/workspace/src/app.ts',
        kind: 'update',
        diff: '+ fixed',
        toolName: 'apply_patch',
        sourceEventIds: [2],
      },
    ],
  };
}

function renderPanel({ attached = true, onOpenSession = vi.fn() } = {}) {
  const replies = attached
    ? [
        message({
          id: 43,
          threadRootEventId: 42,
          text: 'The build passes.',
          author: agent,
          sessionId: 's-1',
          sessionEventType: 'replied',
          createdAt: '2026-07-14T12:00:04.000Z',
        }),
        message({
          id: 44,
          threadRootEventId: 42,
          text: 'Nice, thank you.',
          createdAt: '2026-07-14T12:00:05.000Z',
        }),
      ]
    : [];
  render(
    <ThemeProvider>
      <ThreadPanel
        root={message(attached ? { sessionId: 's-1' } : {})}
        replies={replies}
        loaded
        sessions={attached ? { 's-1': session() } : {}}
        spectators={{}}
        meId="u-1"
        meHandle="ada"
        onClose={vi.fn()}
        onSend={vi.fn()}
        onAgentSend={vi.fn()}
        onOpenSession={onOpenSession}
        onRetry={vi.fn()}
      />
    </ThemeProvider>,
  );
  return { onOpenSession };
}

beforeEach(() => {
  mocks.stream = sessionStream();
  mocks.conflicts = [{}];
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('thread spine integration', () => {
  it('interleaves a completed fold, tags asides, and opens non-empty work strips', () => {
    const { onOpenSession } = renderPanel();

    const workFold = screen.getByTestId('work-fold-collapsed');
    const agentReply = screen.getByText('The build passes.');
    expect(workFold.compareDocumentPosition(agentReply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('aside-row').textContent).toContain('Aside');
    expect(screen.getByTestId('spine-work-strips')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '⚠ Conflicts · 1' }));
    expect(onOpenSession).toHaveBeenLastCalledWith('s-1', { workTab: 'conflicts' });
    fireEvent.click(screen.getByRole('button', { name: '≡ What changed · 1' }));
    expect(onOpenSession).toHaveBeenLastCalledWith('s-1', { workTab: 'changes' });
    fireEvent.click(screen.getByRole('button', { name: '⚙ What it ran · 1' }));
    expect(onOpenSession).toHaveBeenLastCalledWith('s-1', { workTab: 'sideEffects' });
    fireEvent.click(screen.getByRole('button', { name: '▣ Files' }));
    expect(onOpenSession).toHaveBeenLastCalledWith('s-1', { workTab: 'hubFiles' });
  });

  it('defaults to agent mode and Esc changes the attached composer to an aside', () => {
    renderPanel();
    const input = screen.getByLabelText('Message input');
    expect(screen.getByTestId('composer-audience-pill').textContent).toContain('Steer · “Inspect the build”');
    expect(screen.getByText('Goes to the agent · Esc for an aside')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /also send to channel/i })).toBeNull();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByTestId('composer-audience-pill').textContent).toContain('Aside');
    expect(screen.getByText('Aside — visible to people, never sent to the agent')).toBeTruthy();
  });

  it('omits the work-strip row when an attached session has no outputs', () => {
    mocks.stream = initialSessionState();
    mocks.conflicts = [];
    renderPanel();

    expect(screen.queryByTestId('spine-work-strips')).toBeNull();
  });

  it('keeps human-only threads in plain reply mode with broadcast available and no strips', () => {
    mocks.stream = initialSessionState();
    mocks.conflicts = [];
    renderPanel({ attached: false });

    expect(screen.getByTestId('composer-audience-pill').textContent).toContain('this thread');
    expect(screen.getByRole('checkbox', { name: /also send to channel/i })).toBeTruthy();
    expect(screen.queryByTestId('spine-work-strips')).toBeNull();
  });
});
