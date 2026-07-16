// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatExactTimestamp, type ActivityItem, type WireEvent } from '@atrium/surface-client';
import { ActivityView, partitionActivity } from '../src/components/ActivityView';
import type { Session } from '../src/sessions/types';

const apiMock = vi.hoisted(() => ({
  getActivity: vi.fn(),
  markActivityRead: vi.fn(),
  markActivityItemRead: vi.fn(),
  markActivityItemUnread: vi.fn(),
  messages: vi.fn(),
}));

vi.mock('../src/api', () => ({
  api: apiMock,
}));

afterEach(cleanup);

beforeEach(() => {
  apiMock.getActivity.mockReset();
  apiMock.markActivityRead.mockReset();
  apiMock.markActivityItemRead.mockReset();
  apiMock.markActivityItemUnread.mockReset();
  apiMock.messages.mockReset();
  apiMock.markActivityRead.mockResolvedValue({ lastReadEventId: '0', unreadExceptionIds: [] });
  apiMock.markActivityItemRead.mockResolvedValue({ lastReadEventId: '0', unreadExceptionIds: [] });
  apiMock.markActivityItemUnread.mockResolvedValue({ lastReadEventId: '0', unreadExceptionIds: [] });
});

function activityItem(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    eventId: '9',
    kind: 'mention',
    channelId: 'ch-public',
    channelName: 'general',
    actorId: 'u-alice',
    actorName: 'Alice',
    snippet: 'hello @me',
    createdAt: '2026-07-02T10:10:00.000Z',
    sessionId: null,
    sessionTitle: null,
    sessionStatus: null,
    attention: false,
    ...overrides,
  };
}

function activityResponse(
  items: ActivityItem[],
  opts: Partial<{
    nextCursor: string | null;
    lastReadEventId: string;
    attention: number;
    unread: number;
    unreadExceptionIds: string[];
  }> = {},
) {
  return {
    items,
    nextCursor: opts.nextCursor ?? null,
    lastReadEventId: opts.lastReadEventId ?? '0',
    unreadExceptionIds: opts.unreadExceptionIds ?? [],
    counts: { attention: opts.attention ?? 0, unread: opts.unread ?? items.length },
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    workspaceId: 'ws-1',
    channelId: 'ch-agent',
    threadRootEventId: 1,
    title: 'Deploy assistant',
    status: 'running',
    harness: 'codex',
    spawnedBy: 'u-me',
    driverId: 'u-me',
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: '2026-07-02T10:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 1,
    permalink: '/s/s-1',
    ...overrides,
  };
}

describe('partitionActivity', () => {
  it('pins only the newest current attention state per session and leaves older rows in history', () => {
    const latestAuth = activityItem({
      eventId: '20',
      kind: 'agent_auth',
      sessionId: 's-1',
      sessionTitle: 'Deploy assistant',
      attention: true,
    });
    const olderQuestion = activityItem({
      eventId: '18',
      kind: 'agent_question',
      sessionId: 's-1',
      sessionTitle: 'Deploy assistant',
      attention: true,
    });
    const resolvedQuestion = activityItem({
      eventId: '17',
      kind: 'agent_question',
      sessionId: 's-2',
      sessionTitle: 'Resolved assistant',
      attention: false,
    });

    expect(partitionActivity([latestAuth, olderQuestion, resolvedQuestion])).toEqual({
      attention: [latestAuth],
      history: [olderQuestion, resolvedQuestion],
    });
  });

  it('pins current seat requests in the Needs-you tier', () => {
    const seatRequest = activityItem({
      eventId: '21',
      kind: 'seat_request',
      sessionId: 's-1',
      sessionTitle: 'Deploy assistant',
      attention: true,
    });

    expect(partitionActivity([seatRequest])).toEqual({ attention: [seatRequest], history: [] });
  });
});

describe('ActivityView', () => {
  it('renders a pending seat request in the Needs-you shelf', async () => {
    const onOpenSession = vi.fn();
    apiMock.getActivity.mockResolvedValue(
      activityResponse(
        [
          activityItem({
            eventId: '21',
            kind: 'seat_request',
            actorName: 'Bea',
            sessionId: 's-1',
            sessionTitle: 'Deploy assistant',
            attention: true,
          }),
        ],
        { attention: 1, unread: 1 },
      ),
    );
    apiMock.messages.mockResolvedValue({
      events: [{ id: 21, payload: { sessionId: 's-1' } }],
      hasMore: false,
    });

    render(<ActivityView onSelectChannel={vi.fn()} onOpenSession={onOpenSession} />);

    expect(await screen.findByRole('heading', { name: 'Needs you · 1' })).toBeTruthy();
    fireEvent.click(screen.getByText('Bea wants to drive · Deploy assistant'));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('s-1'));
    expect(apiMock.markActivityItemRead).not.toHaveBeenCalledWith(21);
  });

  it('does not offer Archive for a fold-only session', async () => {
    apiMock.getActivity.mockResolvedValue(
      activityResponse([
        activityItem({
          eventId: '22',
          kind: 'agent_question',
          sessionId: 's-unknown',
          sessionTitle: 'Unknown lifecycle',
          attention: false,
        }),
      ]),
    );

    render(
      <ActivityView
        onSelectChannel={vi.fn()}
        onOpenSession={vi.fn()}
        onArchiveSession={vi.fn()}
        sessions={{
          's-unknown': session({
            id: 's-unknown',
            status: 'unknown' as Session['status'],
          }),
        }}
      />,
    );

    const actions = await screen.findByRole('button', { name: 'Actions for Unknown lifecycle · needs your answer' });
    fireEvent.keyDown(actions, { key: 'Enter' });
    expect(await screen.findByRole('menuitem', { name: 'Mark read' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Archive session' })).toBeNull();
  });

  it('renders the two tiers, paginates, and dispatches click destinations', async () => {
    const onSelectChannel = vi.fn();
    const onOpenSession = vi.fn();
    const questionCreatedAt = '2026-07-02T10:15:00.000Z';
    const mentionCreatedAt = '2026-07-02T10:10:00.000Z';
    const dmCreatedAt = '2026-07-02T10:05:00.000Z';
    const firstPage = activityResponse(
      [
        activityItem({
          eventId: '12',
          kind: 'agent_question',
          channelId: 'ch-agent',
          actorId: 'u-me',
          actorName: 'Me',
          snippet: 'Deploy now?',
          createdAt: questionCreatedAt,
          sessionId: 's-1',
          attention: true,
        }),
        activityItem({
          eventId: '9',
          snippet: 'hello **@me** with `code` and [docs](https://example.com)',
          createdAt: mentionCreatedAt,
        }),
      ],
      { nextCursor: '9', lastReadEventId: '8', attention: 1, unread: 2 },
    );
    const secondPage = activityResponse(
      [
        activityItem({
          eventId: '5',
          kind: 'dm',
          channelId: 'ch-dm',
          channelName: 'dm-alice',
          createdAt: dmCreatedAt,
        }),
      ],
      { lastReadEventId: '8', attention: 1, unread: 2 },
    );
    // Default to first page so background refetches after mark-read stay stable.
    apiMock.getActivity.mockImplementation(async (cursor?: string) => (cursor ? secondPage : firstPage));
    apiMock.markActivityItemRead.mockResolvedValue({ lastReadEventId: '9', unreadExceptionIds: [] });
    apiMock.messages.mockResolvedValue({
      events: [
        {
          id: 12,
          workspaceId: 'ws-1',
          channelId: 'ch-agent',
          threadRootEventId: 1,
          type: 'session.question_requested',
          actorId: 'u-me',
          payload: { sessionId: 's-1' },
          createdAt: questionCreatedAt,
        },
      ],
      hasMore: false,
    });

    render(<ActivityView onSelectChannel={onSelectChannel} onOpenSession={onOpenSession} />);

    expect(await screen.findByText('Agent needs your input')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Needs you · 1' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeTruthy();
    expect(screen.getByText('Alice mentioned you')).toBeTruthy();
    expect(screen.getByText('@me').closest('strong')).toBeTruthy();
    expect(screen.getByText('code').closest('code')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'docs' })).toBeNull();
    expect(screen.getByTitle(formatExactTimestamp(questionCreatedAt))).toBeTruthy();
    expect(
      screen.getByRole('button', { name: (name) => name.includes(formatExactTimestamp(questionCreatedAt)) }),
    ).toBeTruthy();

    fireEvent.click(screen.getByText('Alice mentioned you'));
    expect(onSelectChannel).toHaveBeenCalledWith('ch-public');
    expect(apiMock.messages).not.toHaveBeenCalled();
    // History rows auto-mark read on open.
    await waitFor(() => expect(apiMock.markActivityItemRead).toHaveBeenCalledWith(9));

    fireEvent.click(screen.getByText('Agent needs your input'));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('s-1'));
    expect(onSelectChannel).toHaveBeenCalledWith('ch-agent');
    // Pinned attention questions do not auto-mark read.
    expect(apiMock.markActivityItemRead).not.toHaveBeenCalledWith(12);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Alice sent a DM');
    expect(apiMock.getActivity).toHaveBeenLastCalledWith('9');
  });

  it('uses the watermark for unread dots and marks all current activity read optimistically', async () => {
    const onCountsChange = vi.fn();
    const items = [
      activityItem({
        eventId: '12',
        kind: 'session_failed',
        sessionId: 's-failed',
        sessionTitle: 'Build docs',
        attention: true,
      }),
      activityItem({ eventId: '8', snippet: 'already read mention' }),
    ];
    apiMock.getActivity
      .mockResolvedValueOnce(activityResponse(items, { lastReadEventId: '8', attention: 1, unread: 1 }))
      .mockResolvedValueOnce(activityResponse(items, { lastReadEventId: '12', attention: 0, unread: 0 }));
    apiMock.markActivityRead.mockResolvedValue({ lastReadEventId: '12', unreadExceptionIds: [] });

    render(<ActivityView onSelectChannel={vi.fn()} onOpenSession={vi.fn()} onCountsChange={onCountsChange} />);

    await screen.findAllByText('Build docs failed');
    // One unread item → one dot: the pinned failure renders in Needs you only.
    expect(screen.getAllByLabelText('Unread')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'Inbox · 2' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Reviewed · 0' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));

    await waitFor(() => expect(apiMock.markActivityRead).toHaveBeenCalledWith(12));
    expect(screen.queryByLabelText('Unread')).toBeNull();
    expect(onCountsChange).toHaveBeenCalledWith({ attention: 1, unread: 0, needsYou: 0, running: 0, toReview: 0 });
    await waitFor(() => expect(apiMock.getActivity).toHaveBeenCalledTimes(2));
  });

  it('keeps unread completions in To review, then moves them to Reviewed after opening', async () => {
    const rows = [
      activityItem({
        eventId: '20',
        kind: 'session_completed',
        sessionTitle: 'Ship notes',
        snippet: 'Done shipping',
      }),
      activityItem({ eventId: '19', kind: 'mention', snippet: 'see this' }),
    ];
    apiMock.getActivity
      .mockResolvedValueOnce(activityResponse(rows, { lastReadEventId: '0', unread: 2 }))
      .mockResolvedValue(activityResponse(rows, { lastReadEventId: '20', unread: 0 }));
    apiMock.markActivityItemRead.mockResolvedValue({ lastReadEventId: '20', unreadExceptionIds: [] });
    apiMock.messages.mockResolvedValue({
      events: [{ id: 20, payload: { sessionId: 's-completed' } }],
      hasMore: false,
    });

    render(<ActivityView onSelectChannel={vi.fn()} onOpenSession={vi.fn()} />);

    expect(await screen.findByText('Alice mentioned you')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'To review · 1' })).toBeTruthy();
    fireEvent.click(screen.getByText(/Ship notes · completed/));
    await waitFor(() => expect(apiMock.markActivityItemRead).toHaveBeenCalledWith(20));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'To review · 1' })).toBeNull());

    fireEvent.click(screen.getByRole('tab', { name: 'Reviewed · 1' }));
    expect(await screen.findByText(/Ship notes · completed/)).toBeTruthy();
    expect(screen.queryByText('Alice mentioned you')).toBeNull();
  });

  it('never shelves a Needs-you-pinned failure under To review as well', async () => {
    const rows = [
      activityItem({
        eventId: '30',
        kind: 'session_failed',
        sessionId: 's-pinned-fail',
        sessionTitle: 'Broken deploy',
        attention: true,
      }),
      activityItem({
        eventId: '29',
        kind: 'session_completed',
        sessionId: 's-quiet-done',
        sessionTitle: 'Quiet cleanup',
        snippet: 'All tidy',
      }),
    ];
    apiMock.getActivity.mockResolvedValue(activityResponse(rows, { lastReadEventId: '0', attention: 1, unread: 2 }));

    render(<ActivityView onSelectChannel={vi.fn()} onOpenSession={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Needs you · 1' })).toBeTruthy();
    // The pinned failure renders exactly once — in Needs you, not To review.
    expect(screen.getByRole('heading', { name: 'To review · 1' })).toBeTruthy();
    expect(screen.getAllByText(/Broken deploy failed/)).toHaveLength(1);
    expect(screen.getByText(/Quiet cleanup · completed/)).toBeTruthy();
  });

  it('renders the three Inbox shelves from feed and live sessions, with terminal archive actions', async () => {
    const onArchiveSession = vi.fn();
    apiMock.getActivity.mockResolvedValue(
      activityResponse(
        [
          activityItem({
            eventId: '20',
            kind: 'session_completed',
            sessionId: 's-completed',
            sessionTitle: 'Finished notes',
            snippet: 'Result excerpt',
          }),
        ],
        { lastReadEventId: '0', unread: 1 },
      ),
    );

    render(
      <ActivityView
        onSelectChannel={vi.fn()}
        onOpenSession={vi.fn()}
        onArchiveSession={onArchiveSession}
        channelNames={{ 'ch-agent': 'agents' }}
        sessions={{
          's-running': session({
            id: 's-running',
            title: 'Live deploy',
            latestActivity: { summary: 'Running tests', at: '2026-07-02T10:10:00.000Z' },
          }),
          's-completed': session({
            id: 's-completed',
            title: 'Finished notes',
            status: 'completed',
            completedAt: '2026-07-02T10:02:00.000Z',
          }),
        }}
        liveAttention={[
          activityItem({
            eventId: 'live:s-running',
            kind: 'agent_question',
            sessionId: 's-running',
            sessionTitle: 'Live deploy',
            snippet: 'Approve deploy?',
            attention: true,
            unread: true,
          }),
        ]}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Needs you · 1' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Running · 1' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'To review · 1' })).toBeTruthy();
    expect(screen.getByText('Running tests')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Inbox · 2' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Unread · 2' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Reviewed · 0' })).toBeTruthy();

    const actions = screen.getByRole('button', { name: 'Actions for Finished notes · completed' });
    fireEvent.keyDown(actions, { key: 'Enter' });
    expect(await screen.findByRole('menuitem', { name: 'Archive session' })).toBeTruthy();
  });

  // Synthetic `live:<sessionId>` rows have no feed event behind them, so every
  // read-state op no-ops on them. A "Mark read" there is a button that lies.
  it('offers no dead ⋯ menu on synthetic live rows, and says what clears them instead', async () => {
    apiMock.getActivity.mockResolvedValue(activityResponse([activityItem({ eventId: '9' })], { unread: 1 }));

    render(
      <ActivityView
        onSelectChannel={vi.fn()}
        onOpenSession={vi.fn()}
        liveAttention={[
          activityItem({
            eventId: 'live:s-live',
            kind: 'agent_question',
            channelId: 'ch-agent',
            channelName: 'agents',
            snippet: 'Deploy now?',
            sessionId: 's-live',
            sessionTitle: 'Deploy assistant',
            attention: true,
          }),
        ]}
      />,
    );

    expect(await screen.findByText('Deploy assistant · needs your answer')).toBeTruthy();
    // The real (mark-readable) mention row keeps its ⋯ menu…
    expect(screen.getByRole('button', { name: 'Actions for Alice mentioned you' })).toBeTruthy();
    // …the synthetic one has none, because there is nothing behind it to mark.
    expect(screen.queryByRole('button', { name: /Actions for Deploy assistant/ })).toBeNull();
    expect(screen.getByTestId('activity-clears-when').textContent).toBe('Clears when answered');
  });

  // The row that says someone is waiting on you must not be a dead end: it has
  // no feed event to resolve, but it names its session outright.
  it('opens the session a synthetic row names, without hunting for a feed event', async () => {
    apiMock.getActivity.mockResolvedValue(activityResponse([activityItem({ eventId: '9' })], { unread: 1 }));
    const onOpenSession = vi.fn();
    const onSelectChannel = vi.fn();

    render(
      <ActivityView
        onSelectChannel={onSelectChannel}
        onOpenSession={onOpenSession}
        liveAttention={[
          activityItem({
            eventId: 'live:s-live',
            kind: 'agent_question',
            channelId: 'ch-agent',
            channelName: 'agents',
            snippet: 'Deploy now?',
            sessionId: 's-live',
            sessionTitle: 'Deploy assistant',
            attention: true,
          }),
        ]}
      />,
    );

    fireEvent.click(await screen.findByText('Deploy assistant · needs your answer'));

    expect(onSelectChannel).toHaveBeenCalledWith('ch-agent');
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('s-live'));
    // There is no event behind a synthetic row — we must not go looking for one.
    expect(apiMock.messages).not.toHaveBeenCalled();
    // …and the click still must not mark anything read (that op no-ops anyway).
    expect(apiMock.markActivityItemRead).not.toHaveBeenCalled();
  });

  it('still resolves a real attention row through its feed event', async () => {
    const onOpenSession = vi.fn();
    apiMock.getActivity.mockResolvedValue(
      activityResponse(
        [
          activityItem({
            eventId: '12',
            kind: 'agent_question',
            channelId: 'ch-agent',
            sessionId: 's-1',
            sessionTitle: 'Deploy assistant',
            attention: true,
          }),
        ],
        { attention: 1, unread: 1 },
      ),
    );
    apiMock.messages.mockResolvedValue({
      events: [
        {
          id: 12,
          workspaceId: 'ws-1',
          channelId: 'ch-agent',
          threadRootEventId: 1,
          type: 'session.question_requested',
          actorId: 'u-me',
          payload: { sessionId: 's-from-event' },
          createdAt: '2026-07-02T10:15:00.000Z',
        },
      ],
      hasMore: false,
    });

    render(<ActivityView onSelectChannel={vi.fn()} onOpenSession={onOpenSession} />);

    fireEvent.click(await screen.findByText('Deploy assistant · needs your answer'));

    // Unchanged: the real path still trusts the event payload, not the row.
    await waitFor(() => expect(apiMock.messages).toHaveBeenCalledWith('ch-agent', { afterId: 11, limit: 1 }));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('s-from-event'));
  });

  it('tells an auth-blocked synthetic row what actually clears it', async () => {
    apiMock.getActivity.mockResolvedValue(activityResponse([activityItem({ eventId: '9' })], { unread: 1 }));

    render(
      <ActivityView
        onSelectChannel={vi.fn()}
        onOpenSession={vi.fn()}
        liveAttention={[
          activityItem({
            eventId: 'live:s-auth',
            kind: 'agent_auth',
            sessionId: 's-auth',
            sessionTitle: 'Deploy assistant',
            attention: true,
          }),
        ]}
      />,
    );

    expect(await screen.findByText(/reconnect provider/)).toBeTruthy();
    expect(screen.getByTestId('activity-clears-when').textContent).toBe('Clears when reconnected');
  });

  it('debounces a refresh from the shared live event stream', async () => {
    const first = activityResponse([activityItem({ eventId: '4' })], { lastReadEventId: '0', unread: 1 });
    const second = activityResponse([activityItem({ eventId: '5', snippet: 'fresh inbox item' })], {
      lastReadEventId: '0',
      unread: 2,
    });
    apiMock.getActivity.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const fakeLiveEvent: WireEvent = {
      id: 5,
      workspaceId: 'ws-1',
      channelId: 'ch-public',
      threadRootEventId: null,
      type: 'message.posted',
      actorId: 'u-alice',
      payload: { text: 'fresh inbox item' },
      createdAt: '2026-07-02T10:20:00.000Z',
      author: { id: 'u-alice', handle: 'alice', displayName: 'Alice' },
    };
    const { rerender } = render(<ActivityView onSelectChannel={vi.fn()} onOpenSession={vi.fn()} />);

    await screen.findByText('Alice mentioned you');
    rerender(<ActivityView onSelectChannel={vi.fn()} onOpenSession={vi.fn()} liveEvent={fakeLiveEvent} />);

    await waitFor(() => expect(apiMock.getActivity).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('fresh inbox item')).toBeTruthy();
  });
});
