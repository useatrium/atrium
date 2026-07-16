// @vitest-environment jsdom

// A turn's work belongs to the answer it produced. These cover the seam where
// the session stream's folds meet the thread's message spine: the fold must
// render inside the reply's own row, not as a detached row above it.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage, UserRef } from '@atrium/surface-client';
import type { SessionItem } from '@atrium/centaur-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme';
import type { Session } from '../sessions/types';
import { ThreadPanelHarness as ThreadPanel } from '../../test/renderConversation';

const streamItems: SessionItem[] = [];

vi.mock('../sessions/useSessionStream', async () => {
  const { initialSessionState } = await import('@atrium/centaur-client');
  return {
    useSessionStream: () => ({
      stream: { ...initialSessionState(), items: streamItems },
      connected: true,
      lastFrameAt: null,
      clockSkewMs: null,
    }),
  };
});

afterEach(cleanup);

const ada: UserRef = { id: 'u-1', handle: 'ada', displayName: 'Ada Lovelace' };
const agent: UserRef = { id: 'u-agent', handle: 'agent', displayName: 'Agent' };

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
    sessionExecutionId: null,
    status: 'confirmed',
    ...overrides,
  };
}

function agentReply(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return message({
    id: 43,
    threadRootEventId: 42,
    text: 'The migration is safe to ship.',
    author: agent,
    sessionId: 's-1',
    sessionEventType: 'replied',
    sessionExecutionId: 'exe-1',
    ...overrides,
  });
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: 42,
    title: 'Ship the migration',
    // Terminal: the turn is done, so its fold renders collapsed rather than live.
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
    resultText: null,
    createdAt: '2026-07-05T12:00:00.000Z',
    completedAt: '2026-07-05T12:05:00.000Z',
    archivedAt: null,
    pinned: false,
    lastEventId: 0,
    permalink: '/s/s-1',
    ...overrides,
  };
}

/** One completed turn: two tool calls, then the answer that closes the turn. */
function workedTurn(): SessionItem[] {
  return [
    {
      type: 'tool_call',
      id: 't-1',
      name: 'Bash',
      input: { command: 'pnpm test' },
      executionId: 'exe-1',
      result: { content: 'ok', is_error: false },
      ts: '2026-07-05T12:00:01.000Z',
      sourceEventIds: [2],
    },
    {
      type: 'tool_call',
      id: 't-2',
      name: 'Read',
      input: { file_path: 'migrations/081.sql' },
      executionId: 'exe-1',
      result: { content: 'ok', is_error: false },
      ts: '2026-07-05T12:00:02.000Z',
      sourceEventIds: [3],
    },
    {
      type: 'text',
      id: 'x-1',
      text: 'The migration is safe to ship.',
      executionId: 'exe-1',
      ts: '2026-07-05T12:00:03.000Z',
      sourceEventIds: [4],
    },
  ];
}

/** Two steered turns, each: steer echo → work → the answer that closed it. */
function twoSteeredTurns(): SessionItem[] {
  return [
    {
      type: 'user_message',
      id: 'u-1',
      text: 'first steer',
      executionId: 'exe-1',
      ts: '2026-07-05T12:00:00.000Z',
      sourceEventIds: [1],
    },
    {
      type: 'tool_call',
      id: 't-1',
      name: 'Bash',
      input: { command: 'pnpm test' },
      executionId: 'exe-1',
      result: { content: 'ok', is_error: false },
      ts: '2026-07-05T12:00:01.000Z',
      sourceEventIds: [2],
    },
    {
      type: 'text',
      id: 'x-1',
      text: 'First answer.',
      executionId: 'exe-1',
      ts: '2026-07-05T12:00:02.000Z',
      sourceEventIds: [3],
    },
    {
      type: 'user_message',
      id: 'u-2',
      text: 'second steer',
      executionId: 'exe-2',
      ts: '2026-07-05T12:00:03.000Z',
      sourceEventIds: [4],
    },
    {
      type: 'tool_call',
      id: 't-2',
      name: 'Read',
      input: { file_path: 'a.ts' },
      executionId: 'exe-2',
      result: { content: 'ok', is_error: false },
      ts: '2026-07-05T12:00:04.000Z',
      sourceEventIds: [5],
    },
    {
      type: 'text',
      id: 'x-2',
      text: 'Second answer.',
      executionId: 'exe-2',
      ts: '2026-07-05T12:00:05.000Z',
      sourceEventIds: [6],
    },
  ];
}

function steer(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return message({ threadRootEventId: 42, steeredSessionId: 's-1', ...overrides });
}

function renderPanel(replies: ChatMessage[], sessions: Record<string, Session>) {
  render(
    <ThemeProvider>
      <ThreadPanel
        root={message()}
        replies={replies}
        loaded
        sessions={sessions}
        spectators={{}}
        meId="u-1"
        meHandle="ada"
        channelLabel="#eng"
        onClose={vi.fn()}
        onSend={vi.fn()}
        onOpenSession={vi.fn()}
        onRetry={vi.fn()}
      />
    </ThemeProvider>,
  );
}

describe('ThreadPanel work folds', () => {
  it('nests a turn’s work inside the reply it produced, not as a row above it', () => {
    streamItems.splice(0, streamItems.length, ...workedTurn());
    renderPanel([agentReply()], { 's-1': session() });

    const fold = screen.getByTestId('work-fold-collapsed');
    expect(fold.textContent).toContain('2 steps');

    // The claim that matters: the fold lives inside the agent's own message
    // row, so identity → work → answer read as one block.
    const row = document.querySelector('[data-eid="43"]');
    expect(row).toBeTruthy();
    expect(row?.contains(fold)).toBe(true);
    // And it sits above the answer it explains, still within that row.
    expect(fold.compareDocumentPosition(screen.getByText('The migration is safe to ship.'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('keeps orphan work — a turn with no reply of its own — as its own row', () => {
    // No trailing text item: the turn never produced a reply, so there is no
    // message row to nest into and the fold must still be reachable.
    streamItems.splice(0, streamItems.length, ...workedTurn().slice(0, 2));
    renderPanel([], { 's-1': session() });

    const fold = screen.getByTestId('work-fold-collapsed');
    expect(fold.textContent).toContain('2 steps');
    expect(document.querySelector('[data-eid="43"]')).toBeNull();
  });

  it('renders each fold exactly once when a steer precedes the reply it belongs to', () => {
    // The steer bumps triggerOrdinal, and the trigger pass would push the second
    // turn's fold as a standalone row before the reply that owns it ever nests
    // it — rendering the same work twice, which is what prod showed.
    streamItems.splice(0, streamItems.length, ...twoSteeredTurns());
    renderPanel(
      [
        steer({ id: 43, text: 'first steer' }),
        agentReply({ id: 44, text: 'First answer.', sessionExecutionId: 'exe-1' }),
        steer({ id: 45, text: 'second steer' }),
        agentReply({ id: 46, text: 'Second answer.', sessionExecutionId: 'exe-2' }),
      ],
      { 's-1': session() },
    );

    const folds = screen.getAllByTestId('work-fold-collapsed');
    expect(folds).toHaveLength(2);
    // Both belong to a reply, so neither may float as its own row.
    for (const fold of folds) expect(fold.closest('[data-eid]')).toBeTruthy();
    expect(
      document.querySelector('[data-eid="44"]')?.querySelector('[data-testid="work-fold-collapsed"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-eid="46"]')?.querySelector('[data-testid="work-fold-collapsed"]'),
    ).toBeTruthy();
  });

  it('opens and closes the fold from its own header', () => {
    streamItems.splice(0, streamItems.length, ...workedTurn());
    renderPanel([agentReply()], { 's-1': session() });

    fireEvent.click(screen.getByTestId('work-fold-collapsed'));
    const expanded = screen.getByTestId('work-fold-expanded');

    // The header is the toggle in both directions — it used to be an inert
    // glyph, so a fold could be opened and never closed.
    const header = expanded.querySelector('button[aria-expanded="true"]');
    expect(header).toBeTruthy();
    fireEvent.click(header as Element);

    expect(screen.queryByTestId('work-fold-expanded')).toBeNull();
    expect(screen.getByTestId('work-fold-collapsed')).toBeTruthy();
  });
});
