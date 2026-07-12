// @vitest-environment jsdom
// Audit-driven polish: message formatting, loading-vs-empty gating, permalink
// failure state, status non-regression, terminal pane read-only.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appReducer, initialAppState, mentionsHandle, type AppState } from '@atrium/surface-client';
import { MessageRow } from '../src/components/MessageRow';
import { MessageText } from '../src/components/MessageText';
import { Timeline } from '../src/components/Timeline';
import type { ChatMessage, WireEvent } from '@atrium/surface-client';
import { buildTimelineItems } from '@atrium/surface-client';
import { SessionPane } from '../src/sessions/SessionPane';
import { ThemeProvider } from '../src/theme';
import { isStalledSessionStatus, STALLED_AFTER_MS, type Session } from '../src/sessions/types';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';
import type { CentaurEventFrame } from '@atrium/centaur-client';
import { clearUserDirectoryForTests, primeUserDirectory } from '../src/userDirectory';

afterEach(() => {
  cleanup();
  clearUserDirectoryForTests();
});

const me = { id: 'u-me', handle: 'me', displayName: 'Me' };

function renderThemed(ui: ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('MessageText formatting', () => {
  it('renders markdown blocks, inline code, links, and mentions', () => {
    render(
      <div data-testid="root">
        <MessageText
          meHandle="me"
          text={[
            '## Plan',
            '',
            '- Ship **markdown** for @me',
            '',
            'see `retry()` here:',
            '```ts',
            'const x = 1;',
            '```',
            'https://example.com/a?b=1 done',
          ].join('\n')}
        />
      </div>,
    );
    const root = screen.getByTestId('root');
    expect(screen.getByRole('heading', { name: 'Plan' })).toBeTruthy();
    expect(screen.getByText('markdown').closest('strong')).toBeTruthy();
    expect(root.querySelector('li')?.textContent).toContain('Ship markdown for @me');
    expect(root.querySelector('pre')?.textContent?.trim()).toBe('const x = 1;');
    expect(root.querySelector('code')?.textContent).toBe('retry()');
    const a = root.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/a?b=1');
    expect(a.getAttribute('rel')).toContain('noopener');
    expect(root.textContent).toContain('done');
  });

  it('copies fenced code blocks from the inline code control', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<MessageText text={['```ts', 'const x = 1;', '```'].join('\n')} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const x = 1;'));
    expect(screen.getByRole('button', { name: 'Copied code' })).toBeTruthy();
  });

  it('skips unsafe inline html and collapses long markdown', () => {
    render(
      <div data-testid="root">
        <MessageText
          text={`${'<img src=x onerror=alert(1)> '}${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')}`}
        />
      </div>,
    );

    expect(screen.getByTestId('root').querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
  });

  it('renders plain text unchanged (no formatting tokens)', () => {
    render(
      <div data-testid="plain">
        <MessageText text="deploying in 5" />
      </div>,
    );
    expect(screen.getByTestId('plain').textContent).toBe('deploying in 5');
  });
});

describe('Timeline loading vs empty', () => {
  const common = {
    messages: [],
    hasMoreBefore: false,
    sessions: {},
    spectators: {},
    onLoadEarlier: () => Promise.resolve(),
    onOpenThread: () => {},
    onOpenSession: () => {},
    onRetry: () => {},
  };

  it('never claims "No messages yet" while history is still loading', () => {
    render(<Timeline {...common} loaded={false} />);
    expect(screen.queryByText(/No messages yet/)).toBeNull();
  });

  it('shows the empty state (with the @agent hint) once loaded', () => {
    render(<Timeline {...common} loaded={true} />);
    expect(screen.getByText(/No messages yet/)).toBeTruthy();
    expect(screen.getByText(/@agent/)).toBeTruthy();
  });
});

describe('permalink failure and status regression guards', () => {
  it('session-load-failed flags the open pane; open/close clears it', () => {
    let s: AppState = appReducer(initialAppState, { type: 'open-session', sessionId: 's-x' });
    s = appReducer(s, { type: 'session-load-failed', sessionId: 's-x' });
    expect(s.openSessionError).toBe(true);
    s = appReducer(s, { type: 'close-session' });
    expect(s.openSessionError).toBe(false);
    expect(s.openSessionId).toBeNull();
  });

  it('ignores a load failure for a session that is no longer open', () => {
    let s: AppState = appReducer(initialAppState, { type: 'open-session', sessionId: 's-y' });
    s = appReducer(s, { type: 'session-load-failed', sessionId: 's-other' });
    expect(s.openSessionError).toBe(false);
  });

  it('session-upsert never regresses a status WS already advanced', () => {
    const base: Session = {
      id: 's-z',
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      threadRootEventId: null,
      title: 't',
      status: 'completed',
      harness: 'claude-code',
      spawnedBy: me.id,
      driverId: null,
      archivedAt: null,
      pinned: false,
      pendingSeatRequests: [],
      suggestions: [],
      answerProposals: [],
      seatEvents: [],
      costUsd: 0,
      resultText: 'done',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      lastEventId: 5,
      permalink: '/s/s-z',
    };
    let s: AppState = appReducer(initialAppState, { type: 'session-upsert', session: base });
    // A stale GET snapshot from before completion must not roll it back.
    s = appReducer(s, {
      type: 'session-upsert',
      session: { ...base, status: 'running', resultText: null },
    });
    expect(s.sessions['s-z']!.status).toBe('completed');
  });
});

describe('stalled session detection', () => {
  const session = (status: Session['status'], ageMs: number): Session => ({
    id: 's',
    workspaceId: 'w',
    channelId: 'c',
    threadRootEventId: null,
    title: 't',
    status,
    harness: 'claude-code',
    spawnedBy: me.id,
    driverId: null,
    archivedAt: null,
    pinned: false,
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: new Date(Date.now() - ageMs).toISOString(),
    completedAt: null,
    lastEventId: 0,
    permalink: '/s/s',
  });

  it('flags old spawning/queued sessions, not fresh or running ones', () => {
    const now = Date.now();
    expect(isStalledSessionStatus(session('spawning', STALLED_AFTER_MS + 1000), now)).toBe(true);
    expect(isStalledSessionStatus(session('queued', STALLED_AFTER_MS + 1000), now)).toBe(true);
    expect(isStalledSessionStatus(session('spawning', 5000), now)).toBe(false);
    expect(isStalledSessionStatus(session('running', STALLED_AFTER_MS + 1000), now)).toBe(false);
  });
});

describe('message editing', () => {
  const msg = (authorId: string): ChatMessage => ({
    id: 42,
    clientMsgId: 'c1',
    channelId: 'ch-1',
    threadRootEventId: null,
    text: 'typo here',
    edited: false,
    author: { id: authorId, handle: 'me', displayName: 'Me' },
    createdAt: new Date().toISOString(),
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
  });

  it('Edit → modify → Enter calls onEdit and closes the editor on success', async () => {
    const onEdit = vi.fn(async () => {});
    renderThemed(<MessageRow message={msg(me.id)} grouped={false} meId={me.id} onEdit={onEdit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    const box = screen.getByRole('combobox', { name: 'Edit message text' });
    fireEvent.change(box, { target: { value: 'typo fixed' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }), 'typo fixed'));
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Edit message text' })).toBeNull());
  });

  it('offers no Edit button on other people’s messages', () => {
    renderThemed(<MessageRow message={msg('u-other')} grouped={false} meId={me.id} onEdit={async () => {}} />);
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
  });

  it('decodes stable mention tokens for editing and encodes them again on save', async () => {
    const user = { id: '11111111-1111-4111-8111-111111111111', handle: 'ada', displayName: 'Ada Lovelace' };
    primeUserDirectory([user]);
    const onEdit = vi.fn(async () => {});
    renderThemed(
      <MessageRow
        message={{ ...msg(me.id), text: `hello <@${user.id}>` }}
        grouped={false}
        meId={me.id}
        onEdit={onEdit}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    const box = screen.getByRole('combobox', { name: 'Edit message text' }) as HTMLTextAreaElement;
    expect(box.value).toBe('hello @ada');
    fireEvent.change(box, { target: { value: 'hello @ada!' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(onEdit).toHaveBeenCalledWith(expect.anything(), `hello <@${user.id}>!`));
  });
});

describe('session question events', () => {
  const sessionEvent = (over: Partial<ChatMessage>): ChatMessage => ({
    id: 50,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: 1,
    text: '',
    edited: false,
    author: { id: 'agent', handle: 'agent', displayName: 'Agent' },
    createdAt: new Date().toISOString(),
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
    sessionId: 'sess-1',
    ...over,
  });

  it('renders requested questions as a wrapped open-pane event', async () => {
    const onOpenSession = vi.fn();
    renderThemed(
      <MessageRow
        message={sessionEvent({
          sessionEventType: 'question_requested',
          sessionEventPayload: {
            questions: [{ id: 'q1', header: 'Decision', question: 'Deploy now?' }],
          },
        })}
        grouped={false}
        onOpenSession={onOpenSession}
      />,
    );

    expect(screen.getByText('Question asked')).toBeTruthy();
    expect(screen.getByText('Deploy now?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open session pane for this question' }));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('sess-1'));
  });

  it('renders requested questions with a generic fallback', () => {
    renderThemed(
      <MessageRow
        message={sessionEvent({
          sessionEventType: 'question_requested',
          sessionEventPayload: { questions: [] },
        })}
        grouped={false}
      />,
    );

    expect(screen.getByText('Question asked')).toBeTruthy();
    expect(screen.getByText('Agent asked a question')).toBeTruthy();
  });

  it('renders answered questions with answer summaries', () => {
    renderThemed(
      <MessageRow
        message={sessionEvent({
          sessionEventType: 'question_answered',
          sessionEventPayload: {
            answers: [{ id: 'q1', header: 'Decision', answers: ['Ship it'], count: 1 }],
          },
        })}
        grouped={false}
      />,
    );

    expect(screen.getByText('Question answered')).toBeTruthy();
    expect(screen.getByText('Decision')).toBeTruthy();
    expect(screen.getByText('Ship it')).toBeTruthy();
  });

  it('renders resolved questions with the reason', () => {
    renderThemed(
      <MessageRow
        message={sessionEvent({
          sessionEventType: 'question_resolved',
          sessionEventPayload: { reason: 'cancelled' },
        })}
        grouped={false}
      />,
    );

    expect(screen.getByText('Question cancelled')).toBeTruthy();
  });
});

describe('mentions', () => {
  it('mentionsHandle matches whole handles only', () => {
    expect(mentionsHandle('hey @gary look', 'gary')).toBe(true);
    expect(mentionsHandle('hey @garys look', 'gary')).toBe(false);
    expect(mentionsHandle('hey @GARY', 'gary')).toBe(true);
    expect(mentionsHandle('no mention', 'gary')).toBe(false);
    expect(mentionsHandle('@gary', null)).toBe(false);
  });

  it('a mention in an inactive channel sets a mention-level unread', () => {
    const wire = (id: number, channelId: string, text: string): WireEvent => ({
      id,
      workspaceId: 'ws-1',
      channelId,
      threadRootEventId: null,
      type: 'message.posted',
      actorId: 'u-other',
      payload: { text },
      createdAt: new Date().toISOString(),
      author: { id: 'u-other', handle: 'other', displayName: 'Other' },
    });
    let s: AppState = appReducer(initialAppState, { type: 'init-me', handle: 'gary' });
    s = appReducer(s, {
      type: 'channels-loaded',
      channels: [
        { id: 'ch-a', workspaceId: 'ws-1', name: 'a', createdAt: '' },
        { id: 'ch-b', workspaceId: 'ws-1', name: 'b', createdAt: '' },
      ],
    });
    s = appReducer(s, { type: 'select-channel', channelId: 'ch-a' });
    s = appReducer(s, { type: 'server-event', event: wire(1, 'ch-b', 'plain note') });
    expect(s.unread['ch-b']).toBe(true);
    s = appReducer(s, { type: 'server-event', event: wire(2, 'ch-b', 'ping @gary now') });
    expect(s.unread['ch-b']).toBe('mention');
    // A later plain message must not downgrade the mention badge.
    s = appReducer(s, { type: 'server-event', event: wire(3, 'ch-b', 'more chatter') });
    expect(s.unread['ch-b']).toBe('mention');
    s = appReducer(s, { type: 'select-channel', channelId: 'ch-b' });
    expect(s.unread['ch-b']).toBe(false);
  });

  it('highlights @me differently from other mentions', () => {
    render(
      <div data-testid="m">
        <MessageText text="cc @gary and @ben" meHandle="gary" />
      </div>,
    );
    const root = screen.getByTestId('m');
    const spans = root.querySelectorAll('span');
    const meSpan = [...spans].find((s) => s.textContent === '@gary')!;
    const otherSpan = [...spans].find((s) => s.textContent === '@ben')!;
    expect(meSpan.className).toContain('warning');
    expect(otherSpan.className).toContain('accent');
    expect(meSpan.className).not.toBe(otherSpan.className);
  });

  it('tints the full row for stable-id and group mentions', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const message: ChatMessage = {
      id: 42,
      clientMsgId: null,
      channelId: 'ch-1',
      threadRootEventId: null,
      text: `hello <@${id}>`,
      edited: false,
      author: { id: 'other', handle: 'other', displayName: 'Other' },
      createdAt: new Date().toISOString(),
      replyCount: 0,
      lastReplyId: 0,
      status: 'confirmed',
    };
    const { container, rerender } = renderThemed(
      <MessageRow message={message} grouped={false} meId={id} meHandle="me" />,
    );
    expect(container.querySelector('[data-eid="42"]')?.className).toContain('warning');

    rerender(
      <ThemeProvider>
        <MessageRow message={{ ...message, text: '<!here>' }} grouped={false} meId={id} meHandle="me" />
      </ThemeProvider>,
    );
    expect(container.querySelector('[data-eid="42"]')?.className).toContain('warning');
  });
});

describe('message delete', () => {
  const own = (over: Partial<ChatMessage> = {}): ChatMessage => ({
    id: 7,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: null,
    text: 'remove me',
    edited: false,
    author: me,
    createdAt: new Date().toISOString(),
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
    ...over,
  });

  it('two-step confirm then onDelete', async () => {
    const onDelete = vi.fn(async () => {});
    renderThemed(<MessageRow message={own()} grouped={false} meId={me.id} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete message' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it('deleted messages are hidden unless they anchor a thread', () => {
    const items = buildTimelineItems([
      own({ id: 1, deleted: true, replyCount: 0 }),
      own({ id: 2, deleted: true, replyCount: 2, text: '' }),
      own({ id: 3, text: 'visible' }),
    ]);
    const ids = items.filter((i) => i.kind === 'message').map((i) => i.message!.id);
    expect(ids).toEqual([2, 3]);
  });

  it('renders a tombstone with no hover actions', () => {
    renderThemed(
      <MessageRow
        message={own({ deleted: true, replyCount: 1, text: '' })}
        grouped={false}
        meId={me.id}
        onDelete={async () => {}}
        onEdit={async () => {}}
        onOpenThread={() => {}}
      />,
    );
    expect(screen.getByText('Message deleted')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    // The replies link survives so the thread stays reachable.
    expect(screen.getByText(/1 reply/)).toBeTruthy();
  });
});

describe('reactions', () => {
  const reactedMsg = (): ChatMessage => ({
    id: 9,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: null,
    text: 'nice work',
    edited: false,
    reactions: [
      { emoji: '👍', userIds: [me.id, 'u-other'] },
      { emoji: '🎉', userIds: ['u-other'] },
    ],
    author: { id: 'u-other', handle: 'other', displayName: 'Other' },
    createdAt: new Date().toISOString(),
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
  });

  it('renders chips with counts and marks mine; clicking toggles', async () => {
    const onReact = vi.fn(async () => {});
    renderThemed(<MessageRow message={reactedMsg()} grouped={false} meId={me.id} onReact={onReact} />);
    const mine = screen.getByRole('button', { name: '👍 2, including you' });
    expect(mine.className).toContain('accent');
    expect(screen.getByRole('button', { name: '🎉 1' })).toBeTruthy();
    fireEvent.click(mine);
    await waitFor(() => expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }), '👍'));
  });

  it('the picker offers the allowlist and reacts on pick', async () => {
    const onReact = vi.fn(async () => {});
    renderThemed(<MessageRow message={reactedMsg()} grouped={false} meId={me.id} onReact={onReact} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add reaction' }));
    fireEvent.click(screen.getByRole('button', { name: 'React with 🚀' }));
    await waitFor(() => expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }), '🚀'));
  });

  it('reducer folds live reaction.added/removed events', () => {
    const post = (id: number, text: string): WireEvent => ({
      id,
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      threadRootEventId: null,
      type: 'message.posted',
      actorId: 'u-other',
      payload: { text },
      createdAt: new Date().toISOString(),
      author: { id: 'u-other', handle: 'other', displayName: 'Other' },
    });
    const reaction = (id: number, type: string, emoji: string, by: string): WireEvent => ({
      id,
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      threadRootEventId: null,
      type,
      actorId: by,
      payload: { target: 'evt_1', emoji },
      createdAt: new Date().toISOString(),
      author: null,
    });
    let s: AppState = appReducer(initialAppState, {
      type: 'history-loaded',
      channelId: 'ch-1',
      events: [post(1, 'hello')],
      hasMore: false,
    });
    s = appReducer(s, { type: 'server-event', event: reaction(2, 'reaction.added', '👍', 'u-a') });
    s = appReducer(s, { type: 'server-event', event: reaction(3, 'reaction.added', '👍', 'u-b') });
    expect(s.timelines['ch-1']!.main[0]!.reactions).toEqual([{ emoji: '👍', userIds: ['u-a', 'u-b'] }]);
    // Duplicate event id is ignored (WS + catch-up overlap).
    s = appReducer(s, { type: 'server-event', event: reaction(3, 'reaction.added', '👍', 'u-b') });
    expect(s.timelines['ch-1']!.main[0]!.reactions![0]!.userIds).toHaveLength(2);
    s = appReducer(s, { type: 'server-event', event: reaction(4, 'reaction.removed', '👍', 'u-a') });
    s = appReducer(s, { type: 'server-event', event: reaction(5, 'reaction.removed', '👍', 'u-b') });
    expect(s.timelines['ch-1']!.main[0]!.reactions).toEqual([]);
  });
});

describe('terminal session pane', () => {
  it('is read-only: no composer, no seat controls, ended notice', () => {
    FakeEventSource.reset();
    installFakeEventSource();
    const done: Session = {
      id: 's-done',
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      threadRootEventId: null,
      title: 'finished task',
      status: 'failed',
      harness: 'claude-code',
      spawnedBy: 'u-alice',
      spawnerName: 'Alice',
      driverId: 'u-alice',
      driverName: 'Alice',
      archivedAt: null,
      pinned: false,
      pendingSeatRequests: [],
      suggestions: [],
      answerProposals: [],
      seatEvents: [],
      costUsd: 0.5,
      resultText: 'shipped',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: new Date().toISOString(),
      lastEventId: 9,
      permalink: '/s/s-done',
    };
    render(<SessionPane session={done} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />);
    expect(screen.getByText(/Agent ended/)).toBeTruthy();
    expect(screen.queryByText('Take seat')).toBeNull();
    expect(screen.queryByText('Request seat')).toBeNull();
    expect(screen.queryByPlaceholderText(/Message this session/)).toBeNull();
    expect(screen.queryByText('Cancel')).toBeNull();
    // Transcript replay hasn't finished → loading, not a false "No transcript."
    expect(screen.getByText('Loading transcript…')).toBeTruthy();
  });

  it('a completed session is resumable, not read-only', () => {
    FakeEventSource.reset();
    installFakeEventSource();
    const completed: Session = {
      id: 's-completed',
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      threadRootEventId: null,
      title: 'completed task',
      status: 'completed',
      harness: 'claude-code',
      spawnedBy: 'u-alice',
      spawnerName: 'Alice',
      driverId: 'u-alice',
      driverName: 'Alice',
      archivedAt: null,
      pinned: false,
      pendingSeatRequests: [],
      suggestions: [],
      answerProposals: [],
      seatEvents: [],
      costUsd: 0.5,
      resultText: 'shipped',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: new Date().toISOString(),
      lastEventId: 9,
      permalink: '/s/s-completed',
    };
    render(
      <SessionPane session={completed} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );
    // completed is idle/resumable — no read-only notice; a subtle status line
    // (not a card) reports the completed turn.
    expect(screen.queryByText(/Agent ended/)).toBeNull();
    expect(screen.getByTestId('turn-status').textContent).toContain('Turn complete');
  });
});

describe('session transcript rendering', () => {
  const running: Session = {
    id: 's-run',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    title: 'live task',
    status: 'running',
    harness: 'codex',
    spawnedBy: 'u-alice',
    spawnerName: 'Alice',
    driverId: 'u-alice',
    driverName: 'Alice',
    archivedAt: null,
    pinned: false,
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    lastEventId: 0,
    permalink: '/s/s-run',
  };

  const frames: CentaurEventFrame[] = [
    {
      event: 'execution_state',
      event_id: 1,
      data: { type: 'execution.state', status: 'running', thread_key: 't', execution_id: 'e' },
    },
    {
      event: 'amp_raw_event',
      event_id: 2,
      data: {
        type: 'item.completed',
        item: { id: 'steer-1', type: 'userMessage', content: [{ type: 'text', text: 'fix the flaky parser test' }] },
      },
    },
    {
      event: 'amp_raw_event',
      event_id: 3,
      data: { type: 'item.completed', item: { id: 'a1', type: 'agentMessage', text: 'On it — reproducing now.' } },
    },
  ] as CentaurEventFrame[];

  it('renders a folded steer as an attributed call-and-response', async () => {
    FakeEventSource.reset();
    installFakeEventSource();
    render(
      <SessionPane session={running} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );
    const src = FakeEventSource.last();
    src.open();
    src.emitAll(frames);

    // the steer renders attributed to the spawner: bold name + the words
    await waitFor(() => {
      const steer = screen.getByTestId('user-steer');
      expect(steer.textContent).toContain('Alice');
      expect(steer.textContent).toContain('fix the flaky parser test');
    });
    // the agent's reply renders as plain text beneath it
    expect(screen.getByText('On it — reproducing now.')).toBeTruthy();
  });

  it('shows a subtle turn status line (not a card, not the read-only block) on a completed session', () => {
    FakeEventSource.reset();
    installFakeEventSource();
    const completed: Session = { ...running, status: 'completed', resultText: 'shipped the fix' };
    render(
      <SessionPane session={completed} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );
    // A subtle status line reports the turn; the old bordered card is gone and
    // the read-only result block stays reserved for failed/cancelled sessions.
    const status = screen.getByTestId('turn-status');
    expect(status.textContent).toContain('Turn complete');
    expect(screen.queryByTestId('turn-card')).toBeNull();
    expect(screen.queryByTestId('session-result')).toBeNull();
  });

  it('optimistic steer: dimmed at send, undims once the turn is active, replaced by the codex echo', async () => {
    FakeEventSource.reset();
    installFakeEventSource();
    const completed: Session = { ...running, status: 'completed', resultText: 'done', driverId: me.id };
    const paneProps = {
      me,
      watchers: [],
      onClose: () => {},
      onAnswerQuestion: async () => {},
      onSteer: async () => {},
    };
    const { rerender } = render(<SessionPane session={completed} {...paneProps} />);
    const src = FakeEventSource.last();
    src.open();

    const box = screen.getByPlaceholderText('Steer the agent...');
    fireEvent.change(box, { target: { value: 'follow up please' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    // Pending bubble renders immediately, dimmed (delivery unconfirmed).
    const bubble = await screen.findByTestId('user-steer-pending');
    expect(bubble.textContent).toContain('follow up please');
    expect(bubble.className).toContain('opacity-60');

    // The follow-up turn goes active (status_changed over WS) → sticky undim.
    rerender(<SessionPane session={{ ...completed, status: 'running', completedAt: null }} {...paneProps} />);
    await waitFor(() => expect(screen.getByTestId('user-steer-pending').className).not.toContain('opacity-60'));

    // Codex echoes the steer → bubble is replaced by the real transcript row.
    src.emitAll([
      {
        event: 'amp_raw_event',
        event_id: 5,
        data: {
          type: 'item.completed',
          item: { id: 'u9', type: 'userMessage', content: [{ type: 'text', text: 'follow up please' }] },
        },
      },
    ] as CentaurEventFrame[]);
    await waitFor(() => expect(screen.queryByTestId('user-steer-pending')).toBeNull());
    expect(screen.getByTestId('user-steer').textContent).toContain('follow up please');
  });

  it('builds a turn rail with one navigable entry per steer', async () => {
    FakeEventSource.reset();
    installFakeEventSource();
    render(
      <SessionPane session={running} me={me} watchers={[]} onClose={() => {}} onAnswerQuestion={async () => {}} />,
    );
    const src = FakeEventSource.last();
    src.open();
    src.emitAll([
      {
        event: 'execution_state',
        event_id: 1,
        data: { type: 'execution.state', status: 'running', thread_key: 't', execution_id: 'e' },
      },
      {
        event: 'amp_raw_event',
        event_id: 2,
        data: {
          type: 'item.completed',
          item: { id: 's1', type: 'userMessage', content: [{ type: 'text', text: 'first turn ask' }] },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 3,
        data: { type: 'item.completed', item: { id: 'a1', type: 'agentMessage', text: 'working' } },
      },
      {
        event: 'amp_raw_event',
        event_id: 4,
        data: {
          type: 'item.completed',
          item: { id: 's2', type: 'userMessage', content: [{ type: 'text', text: 'second turn ask' }] },
        },
      },
    ] as CentaurEventFrame[]);

    await waitFor(() => {
      const rail = screen.getByTestId('turn-rail');
      // The rail has a tap-to-open toggle (for touch) plus one navigable entry
      // per steer (agent turns are not indexed).
      const toggle = within(rail).getByRole('button', { name: 'Open turn navigation' });
      const navEntries = within(rail)
        .getAllByRole('button')
        .filter((button) => button !== toggle);
      expect(navEntries).toHaveLength(2);
      expect(rail.textContent).toContain('first turn ask');
      expect(rail.textContent).toContain('second turn ask');
    });
  });
});
