// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatExactTimestamp, type ActivityItem, type WireEvent } from '@atrium/surface-client';
import { ActivityView, partitionActivity } from '../src/components/ActivityView';

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
});

describe('ActivityView', () => {
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
    expect(screen.getByRole('heading', { name: 'Needs attention · 1' })).toBeTruthy();
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

    await screen.findByText('Build docs failed');
    expect(screen.getAllByLabelText('Unread')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'Inbox' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Done' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));

    await waitFor(() => expect(apiMock.markActivityRead).toHaveBeenCalledWith(12));
    expect(screen.queryByLabelText('Unread')).toBeNull();
    expect(onCountsChange).toHaveBeenCalledWith({ attention: 1, unread: 0 });
    await waitFor(() => expect(apiMock.getActivity).toHaveBeenCalledTimes(2));
  });

  it('hides completions under Done until the Done filter is selected', async () => {
    apiMock.getActivity.mockResolvedValue(
      activityResponse(
        [
          activityItem({
            eventId: '20',
            kind: 'session_completed',
            sessionTitle: 'Ship notes',
            snippet: 'Done shipping',
          }),
          activityItem({ eventId: '19', kind: 'mention', snippet: 'see this' }),
        ],
        { lastReadEventId: '0', unread: 2 },
      ),
    );

    render(<ActivityView onSelectChannel={vi.fn()} onOpenSession={vi.fn()} />);

    expect(await screen.findByText('Alice mentioned you')).toBeTruthy();
    expect(screen.queryByText(/Ship notes · completed/)).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Done' }));
    expect(await screen.findByText(/Ship notes · completed/)).toBeTruthy();
    expect(screen.queryByText('Alice mentioned you')).toBeNull();
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
