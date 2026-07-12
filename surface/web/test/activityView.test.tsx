// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatExactTimestamp, type ActivityItem, type WireEvent } from '@atrium/surface-client';
import { ActivityView, partitionActivity } from '../src/components/ActivityView';

const apiMock = vi.hoisted(() => ({
  getActivity: vi.fn(),
  markActivityRead: vi.fn(),
  messages: vi.fn(),
}));

vi.mock('../src/api', () => ({
  api: apiMock,
}));

afterEach(cleanup);

beforeEach(() => {
  apiMock.getActivity.mockReset();
  apiMock.markActivityRead.mockReset();
  apiMock.messages.mockReset();
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
  opts: Partial<{ nextCursor: string | null; lastReadEventId: string; attention: number; unread: number }> = {},
) {
  return {
    items,
    nextCursor: opts.nextCursor ?? null,
    lastReadEventId: opts.lastReadEventId ?? '0',
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
    apiMock.getActivity
      .mockResolvedValueOnce(
        activityResponse(
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
        ),
      )
      .mockResolvedValueOnce(
        activityResponse(
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

    fireEvent.click(screen.getByText('Agent needs your input'));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('s-1'));
    expect(onSelectChannel).toHaveBeenCalledWith('ch-agent');

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
    apiMock.markActivityRead.mockResolvedValue({ lastReadEventId: '12' });

    render(<ActivityView onSelectChannel={vi.fn()} onOpenSession={vi.fn()} onCountsChange={onCountsChange} />);

    await screen.findByText('Build docs failed');
    expect(screen.getAllByLabelText('Unread')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));

    await waitFor(() => expect(apiMock.markActivityRead).toHaveBeenCalledWith(12));
    expect(screen.queryByLabelText('Unread')).toBeNull();
    expect(onCountsChange).toHaveBeenCalledWith({ attention: 1, unread: 0 });
    await waitFor(() => expect(apiMock.getActivity).toHaveBeenCalledTimes(2));
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
