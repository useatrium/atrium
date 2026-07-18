// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItem, WireEvent } from '@atrium/surface-client';
import { ActivityView } from '../src/components/ActivityView';

const apiMock = vi.hoisted(() => ({
  getActivity: vi.fn(),
  markActivityRead: vi.fn(),
  markActivityItemRead: vi.fn(),
  markActivityItemUnread: vi.fn(),
}));

vi.mock('../src/api', () => ({ api: apiMock }));

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
    unread: true,
    ...overrides,
  };
}

function activityResponse(items: ActivityItem[], nextCursor: string | null = null) {
  return {
    items,
    nextCursor,
    lastReadEventId: '0',
    unreadExceptionIds: [],
    counts: { attention: 0, unread: items.length, needsYou: 0, running: 0, toReview: 0 },
    channelCounts: {},
  };
}

beforeEach(() => {
  apiMock.getActivity.mockReset();
  apiMock.markActivityRead.mockReset().mockResolvedValue({ lastReadEventId: '9', unreadExceptionIds: [] });
  apiMock.markActivityItemRead.mockReset().mockResolvedValue({ lastReadEventId: '9', unreadExceptionIds: [] });
  apiMock.markActivityItemUnread.mockReset().mockResolvedValue({ lastReadEventId: '0', unreadExceptionIds: ['9'] });
});

afterEach(cleanup);

describe('ActivityView', () => {
  it('renders and paginates people activity while excluding agent events', async () => {
    const first = activityResponse(
      [
        activityItem({
          eventId: '10',
          kind: 'session_failed',
          sessionId: 's-1',
          sessionTitle: 'Broken deploy',
          sessionStatus: 'failed',
          attention: true,
        }),
        activityItem(),
      ],
      '9',
    );
    const second = activityResponse([
      activityItem({ eventId: '5', kind: 'dm', channelId: 'ch-dm', channelName: 'dm:alice' }),
    ]);
    apiMock.getActivity.mockImplementation(async (cursor?: string) => (cursor ? second : first));
    const onSelectChannel = vi.fn();

    render(<ActivityView onSelectChannel={onSelectChannel} />);

    expect(await screen.findByText('Alice mentioned you')).toBeTruthy();
    expect(screen.queryByText(/Broken deploy/)).toBeNull();
    expect(screen.queryByRole('heading', { name: /Needs you|Running|To review/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Alice sent a DM')).toBeTruthy();
    expect(apiMock.getActivity).toHaveBeenLastCalledWith('9');

    fireEvent.click(screen.getByText('Alice mentioned you'));
    expect(onSelectChannel).toHaveBeenCalledWith('ch-public');
  });

  it('debounces a refresh from the shared live event stream', async () => {
    apiMock.getActivity
      .mockResolvedValueOnce(activityResponse([activityItem({ eventId: '4' })]))
      .mockResolvedValueOnce(activityResponse([activityItem({ eventId: '5', snippet: 'fresh inbox item' })]));
    const event: WireEvent = {
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
    const { rerender } = render(<ActivityView onSelectChannel={vi.fn()} />);

    await screen.findByRole('button', { name: /hello @me/ });
    rerender(<ActivityView onSelectChannel={vi.fn()} liveEvent={event} />);

    await waitFor(() => expect(apiMock.getActivity).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('fresh inbox item')).toBeTruthy();
  });
});
