// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatMessage, UserRef } from '@atrium/surface-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme';
import type { Session } from '../sessions/types';
import { MessageRow } from './MessageRow';

const ada: UserRef = {
  id: 'u-1',
  handle: 'ada',
  displayName: 'Ada Lovelace',
};

const bea: UserRef = {
  id: 'u-2',
  handle: 'bea',
  displayName: 'Bea Chan',
};

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 42,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: null,
    text: 'Hello',
    edited: false,
    reactions: [{ emoji: '👍', userIds: ['u-1', 'u-2', 'u-3'] }],
    attachments: [],
    author: ada,
    createdAt: '2026-07-05T12:00:00.000Z',
    replyCount: 0,
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
    title: 'Timeline migration',
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

function renderRow({
  resolveUser,
  onReact = vi.fn().mockResolvedValue(undefined),
  onOpenThread,
  onDelegateToAgent,
  row = message(),
  session: rowSession,
  slotSessions,
  anchoredAnswers,
}: {
  resolveUser?: (id: string) => UserRef | undefined;
  onReact?: (message: ChatMessage, emoji: string) => Promise<void>;
  onOpenThread?: (rootEventId: number) => void;
  onDelegateToAgent?: (message: ChatMessage) => void;
  row?: ChatMessage;
  session?: Session;
  slotSessions?: Session[];
  anchoredAnswers?: ChatMessage[];
} = {}) {
  const view = render(
    <ThemeProvider>
      <MessageRow
        message={row}
        session={rowSession}
        slotSessions={slotSessions}
        anchoredAnswers={anchoredAnswers}
        grouped={false}
        meId="u-1"
        meHandle="ada"
        onRetry={vi.fn()}
        onOpenThread={onOpenThread}
        onDelegateToAgent={onDelegateToAgent}
        onReact={onReact}
        resolveUser={resolveUser}
      />
    </ThemeProvider>,
  );
  return { onReact, ...view };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MessageRow reactions', () => {
  it('lists reactor names on hover and focus without stealing click-to-toggle', () => {
    const users = new Map<string, UserRef>([
      [ada.id, ada],
      [bea.id, bea],
    ]);
    const onReact = vi.fn().mockResolvedValue(undefined);
    renderRow({ resolveUser: (id) => users.get(id), onReact });

    // The pill keeps a concise, stable accessible name (count only, like before);
    // reactor names live in the hover/focus tooltip, not the button label.
    const pill = screen.getByRole('button', { name: '👍 3, including you' });
    expect(pill.getAttribute('aria-label')).not.toContain('u-3');

    fireEvent.mouseEnter(pill.parentElement ?? pill);
    const tooltip = screen.getByRole('tooltip', { name: '3 people reacted with 👍' });
    expect(within(tooltip).getByText('Ada Lovelace')).toBeTruthy();
    expect(within(tooltip).getByText('Bea Chan')).toBeTruthy();
    expect(within(tooltip).getByText('Unknown')).toBeTruthy();

    fireEvent.click(pill);
    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }), '👍');

    fireEvent.keyDown(pill, { key: 'Escape' });
    expect(screen.queryByRole('tooltip', { name: '3 people reacted with 👍' })).toBeNull();

    fireEvent.focus(pill);
    expect(screen.getByRole('tooltip', { name: '3 people reacted with 👍' })).toBeTruthy();
    fireEvent.blur(pill);
    expect(screen.queryByRole('tooltip', { name: '3 people reacted with 👍' })).toBeNull();
  });

  it('keeps count-only behavior when no resolver is provided', () => {
    renderRow({
      row: message({ reactions: [{ emoji: '👍', userIds: ['u-1'] }] }),
    });

    const pill = screen.getByRole('button', { name: '👍 1, including you' });
    expect(pill.getAttribute('title')).toBe('1 reacted with 👍');

    fireEvent.mouseEnter(pill.parentElement ?? pill);
    expect(screen.queryByRole('tooltip', { name: '1 person reacted with 👍' })).toBeNull();
  });
});

describe('MessageRow broadcast replies', () => {
  it('opens the parent thread from the broadcast reply affordance', () => {
    const onOpenThread = vi.fn();
    renderRow({
      onOpenThread,
      row: message({
        id: 99,
        threadRootEventId: 42,
        text: 'Broadcast reply',
        reactions: [],
      }),
    });

    fireEvent.click(screen.getByRole('button', { name: '↳ replied to a thread' }));

    expect(onOpenThread).toHaveBeenCalledWith(42);
    expect(onOpenThread).not.toHaveBeenCalledWith(99);

    onOpenThread.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }));

    expect(onOpenThread).toHaveBeenCalledWith(42);
    expect(onOpenThread).not.toHaveBeenCalledWith(99);
  });

  it('expands earlier replies lazily and keeps the newest compact reply collapsed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            events: [
              {
                id: 50,
                workspaceId: 'ws-1',
                channelId: 'ch-1',
                threadRootEventId: 42,
                type: 'message.posted',
                actorId: 'u-2',
                payload: { text: 'Earlier fetched reply' },
                createdAt: '2026-07-05T12:00:30.000Z',
                author: bea,
              },
              {
                id: 51,
                workspaceId: 'ws-1',
                channelId: 'ch-1',
                threadRootEventId: 42,
                type: 'message.posted',
                actorId: 'u-2',
                payload: { text: 'Newest preview reply' },
                createdAt: '2026-07-05T12:01:00.000Z',
                author: bea,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const latest = message({
      id: 51,
      threadRootEventId: 42,
      text: 'Newest preview reply',
      author: bea,
      createdAt: '2026-07-05T12:01:00.000Z',
      reactions: [],
    });
    renderRow({ row: message({ replyCount: 2, lastReplyId: 51, lastReply: latest, reactions: [] }) });

    expect(screen.getByText('Newest preview reply')).toBeTruthy();
    const earlierReplies = screen.getByRole('button', { name: '▶ 1 earlier reply' });
    expect(earlierReplies.className).toContain('whitespace-nowrap');
    expect(earlierReplies.className).toContain('[@media(pointer:coarse)]:min-h-11');
    fireEvent.click(earlierReplies);
    expect(await screen.findByText('Earlier fetched reply')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/api/threads/42/messages', expect.anything());
  });
});

describe('MessageRow actions', () => {
  it('leaves mouse context menus to the browser without opening message actions', () => {
    const { container } = renderRow({ onDelegateToAgent: vi.fn() });
    const row = container.querySelector('[data-eid="42"]');
    expect(row).toBeTruthy();

    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(row!, contextMenu);

    expect(contextMenu.defaultPrevented).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Message actions' })).toBeNull();
  });

  it('opens the complete action menu from the visible keyboard-focusable affordance', () => {
    const onDelegateToAgent = vi.fn();
    renderRow({ onDelegateToAgent });

    const moreActions = screen.getByRole('button', { name: 'More message actions' });
    moreActions.focus();
    expect(document.activeElement).toBe(moreActions);
    fireEvent.click(moreActions);

    const menu = screen.getByRole('dialog', { name: 'Message actions' });
    expect(within(menu).queryByRole('button', { name: 'Cancel' })).toBeNull();
    const delegate = within(menu).getByRole('button', { name: 'Delegate to agent…' });
    fireEvent.click(delegate);
    expect(onDelegateToAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }));
  });

  it('still opens the action sheet after a touch long-press', () => {
    vi.useFakeTimers();
    renderRow({ onDelegateToAgent: vi.fn() });
    const text = screen.getByText('Hello');
    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 20,
    });
    Object.defineProperties(pointerDown, {
      pointerId: { value: 1 },
      pointerType: { value: 'touch' },
    });

    fireEvent(text, pointerDown);
    act(() => vi.advanceTimersByTime(400));

    const sheet = screen.getByRole('dialog', { name: 'Message actions' });
    expect(within(sheet).getByRole('button', { name: 'Delegate to agent…' })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('keeps a 44px more-actions target visible on hover-less devices and opens the sheet', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    renderRow({ onDelegateToAgent: vi.fn() });

    const moreActions = screen.getByRole('button', { name: 'More message actions' });
    expect(moreActions.className).toContain('size-11');
    fireEvent.click(moreActions);

    const sheet = screen.getByRole('dialog', { name: 'Message actions' });
    expect(within(sheet).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});

describe('MessageRow web presence', () => {
  it('renders one working annotation slot and no feed SessionCard', () => {
    renderRow({
      row: message({ sessionId: 's-1', sessionTask: 'Refactor the timeline', reactions: [] }),
      session: session(),
      slotSessions: [session({ latestActivity: { summary: 'running timeline tests', at: '2026-07-05T12:00:01Z' } })],
    });

    expect(screen.getByTestId('session-slot-working')).toBeTruthy();
    const summary = screen.getByText('running timeline tests');
    expect(summary.className).toContain('flex-1');
    expect(summary.className).toContain('truncate');
    expect(screen.getByRole('button', { name: 'steer' }).className).toContain('whitespace-nowrap');
    expect(screen.getByRole('button', { name: 'open session' }).className).toContain('whitespace-nowrap');
    expect(screen.queryByTestId('session-card')).toBeNull();
    expect(screen.queryByTestId('session-slot-done')).toBeNull();
    expect(screen.queryByTestId('session-slot-failed')).toBeNull();
  });

  it('renders a terminal answer once, with a clamp toggle, instead of a card', () => {
    const answer = message({
      id: 99,
      threadRootEventId: 42,
      sessionId: 's-1',
      sessionEventType: 'replied',
      broadcast: true,
      text: 'A'.repeat(700),
      reactions: [],
      author: { id: 'agent:s-1', handle: 'agent', displayName: 'Agent' },
    });
    renderRow({
      row: message({
        sessionId: 's-1',
        sessionTask: 'Long answer please',
        replyCount: 1,
        lastReplyId: 99,
        reactions: [],
      }),
      session: session({ status: 'completed', completedAt: '2026-07-05T12:01:00.000Z' }),
      slotSessions: [session({ status: 'completed', completedAt: '2026-07-05T12:01:00.000Z' })],
      anchoredAnswers: [answer],
    });

    expect(screen.getByTestId('session-slot-answer')).toBeTruthy();
    expect(screen.getAllByText('A'.repeat(700))).toHaveLength(1);
    const fade = screen.getByTestId('session-slot-answer').querySelector('[aria-hidden="true"]');
    expect(fade?.className).toContain('pointer-events-none');
    expect(fade?.className).toContain('from-surface');
    const viewSession = within(screen.getByTestId('session-slot-answer')).getByRole('button', {
      name: 'view session',
    });
    expect(viewSession.parentElement?.className).toContain('whitespace-nowrap');
    expect(screen.getByRole('button', { name: 'Show all ↓' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all ↓' }));
    expect(screen.getByRole('button', { name: 'Show less ↑' })).toBeTruthy();
    expect(screen.queryByTestId('session-card')).toBeNull();
  });

  it('uses exactly the failed terminal slot and keeps driver recovery actions', () => {
    renderRow({
      row: message({ sessionId: 's-1', sessionTask: 'Risky task', reactions: [] }),
      session: session({ status: 'failed', completedAt: '2026-07-05T12:00:30.000Z' }),
      slotSessions: [
        session({
          status: 'failed',
          completedAt: '2026-07-05T12:00:30.000Z',
          resultText: 'A detailed failure reason that needs room to wrap without crowding recovery actions.',
        }),
      ],
    });

    const failedSlot = screen.getByTestId('session-slot-failed');
    expect(failedSlot.className).toContain('min-w-0');
    expect(failedSlot.textContent).toContain('Failed after 30s');
    expect(within(failedSlot).getByText(/A detailed failure reason/).className).toContain('break-words');
    expect(screen.getByTestId('card-retry-turn').className).toContain('whitespace-nowrap');
    expect(screen.getByTestId('card-ask-why').className).toContain('whitespace-nowrap');
    const viewSession = within(failedSlot).getByRole('button', { name: 'view session' });
    expect(viewSession.className).toContain('whitespace-nowrap');
    expect(viewSession.className).toContain('[@media(pointer:coarse)]:min-h-11');
    expect(screen.queryByTestId('session-slot-working')).toBeNull();
    expect(screen.queryByTestId('session-slot-done')).toBeNull();
  });

  it('moves the canonical question card into the needs-input slot', () => {
    const needsInput = session({
      pendingQuestion: {
        questionId: 'q-1',
        askedAt: '2026-07-05T12:00:05.000Z',
        questions: [
          {
            id: 'scope',
            header: 'Scope',
            question: 'Which scope?',
            options: [{ label: 'Small', description: 'Focused' }],
          },
        ],
      },
    });
    renderRow({
      row: message({ sessionId: 's-1', sessionTask: 'Pick a scope', reactions: [] }),
      session: needsInput,
      slotSessions: [needsInput],
    });

    expect(screen.getByTestId('session-slot-needs-input')).toBeTruthy();
    expect(screen.getByTestId('question-banner')).toBeTruthy();
    expect(screen.getByText('Which scope?')).toBeTruthy();
    expect(screen.queryByTestId('session-slot-working')).toBeNull();
  });

  it('renders the terminal outcome and result excerpt when no broadcast answer exists', () => {
    const completed = session({ status: 'completed', completedAt: '2026-07-05T12:01:00.000Z' });
    renderRow({
      row: message({ sessionId: 's-1', sessionTask: 'Quiet completion', reactions: [] }),
      session: completed,
      slotSessions: [completed],
    });

    const doneSlot = screen.getByTestId('session-slot-done');
    expect(doneSlot.querySelector('.flex-wrap')).toBeTruthy();
    expect(doneSlot.textContent).toContain('Done in 1m');
    expect(within(doneSlot).getByRole('button', { name: 'view session' }).parentElement?.className).toContain(
      'whitespace-nowrap',
    );
    expect(screen.queryByTestId('session-slot-answer')).toBeNull();
  });

  it('includes the completion result in the terminal strip', () => {
    const completed = session({
      status: 'completed',
      completedAt: '2026-07-05T12:01:00.000Z',
      resultText: 'Updated the retry backoff and added coverage.',
    });
    renderRow({
      row: message({ sessionId: 's-1', sessionTask: 'Quiet completion', reactions: [] }),
      session: completed,
      slotSessions: [completed],
    });

    expect(screen.getByTestId('session-slot-done').textContent).toContain(
      'Done in 1m — Updated the retry backoff and added coverage.',
    );
  });

  it('renders an agent reply with the fixed Agent identity and normal markdown body', () => {
    renderRow({
      session: session({ title: 'A task-shaped session title' }),
      row: message({
        sessionId: 's-1',
        sessionEventType: 'replied',
        threadRootEventId: 42,
        text: '**Shipped** the [timeline](https://example.com).',
        author: { id: 'agent:s-1', handle: 'agent', displayName: 'Harness persona' },
      }),
    });

    expect(screen.getByText('Agent')).toBeTruthy();
    expect(screen.queryByText('A task-shaped session title')).toBeNull();
    expect(screen.queryByText('Harness persona')).toBeNull();
    // The pill is gone — the AgentMark (role=img, label "Agent") is the only marker.
    expect(screen.queryByText('AGENT')).toBeNull();
    expect(screen.getByRole('img', { name: 'Agent' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'timeline' })).toBeTruthy();
    expect(screen.getByText('Shipped')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '↳ replied to a thread' })).toBeNull();
  });

  it('renders a spawn task once as the spawner message and never echoes its title', () => {
    const task = 'Refactor the timeline without losing accessibility.';
    renderRow({
      session: session({ title: 'Refactor the timeline' }),
      row: message({
        sessionId: 's-1',
        sessionTask: task,
        text: 'Refactor the timeline',
        reactions: [],
      }),
    });

    expect(screen.getAllByText(task)).toHaveLength(1);
    expect(screen.queryByText('Refactor the timeline')).toBeNull();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
  });

  it('points the live question row at the canonical card instead of a second form', () => {
    renderRow({
      session: session({
        pendingQuestion: {
          questionId: 'q-1',
          questions: [
            { id: 'prompt-1', header: 'Scope', question: 'Ship it?', options: [{ label: 'Yes', description: 'Ship' }] },
          ],
        },
      }),
      row: message({
        sessionId: 's-1',
        sessionEventType: 'question_requested',
        sessionEventPayload: { questionId: 'q-1' },
      }),
    });

    // One live answer form per screen: the root card owns it; this row points up.
    expect(screen.getByTestId('question-pointer-row')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull();
  });

  it('points non-drivers at the card too — no parallel suggestion form', () => {
    renderRow({
      session: session({
        driverId: 'u-2',
        pendingQuestion: { questionId: 'q-1', questions: [{ id: 'prompt-1', header: 'Scope', question: 'Ship it?' }] },
      }),
      row: message({
        sessionId: 's-1',
        sessionEventType: 'question_requested',
        sessionEventPayload: { questionId: 'q-1' },
      }),
    });

    expect(screen.getByTestId('question-pointer-row')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Suggest' })).toBeNull();
  });

  it('renders steer and driver-actionable suggestion provenance chips', () => {
    renderRow({
      session: session(),
      row: message({ steeredSessionId: 's-1', suggestedSessionId: 's-1', suggestionId: 'sg-1' }),
    });

    expect(screen.getByText('→ agent')).toBeTruthy();
    expect(screen.getByText('suggestion')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send to agent' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });
});
