// @vitest-environment jsdom

import { buildTimelineItems, type ChatMessage } from '@atrium/surface-client';
import { describe, expect, it, vi } from 'vitest';
import {
  getUnreadDividerPlacement,
  latestRealMessageId,
  shouldMarkReadForVisibleLatest,
} from '../src/components/Timeline';

vi.mock('@shopify/flash-list', () => ({
  FlashList: () => null,
}));

vi.mock('../src/lib/chat', () => ({
  useReactionUserResolver: () => undefined,
}));

vi.mock('../src/components/bits', () => ({
  DayDivider: () => null,
}));

vi.mock('../src/components/MessageRow', () => ({
  MessageRow: () => null,
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

function message(id: number, createdAt: string): ChatMessage {
  return {
    id,
    clientMsgId: null,
    channelId: 'c-1',
    threadRootEventId: null,
    text: `message ${id}`,
    edited: false,
    author: { id: 'u-1', handle: 'riley', displayName: 'Riley' },
    createdAt,
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
  };
}

describe('getUnreadDividerPlacement', () => {
  it('finds the first unread render index after day divider rows', () => {
    const items = buildTimelineItems([
      message(10, '2026-07-02T12:00:00.000Z'),
      message(11, '2026-07-03T12:00:00.000Z'),
      message(12, '2026-07-03T12:01:00.000Z'),
    ]);

    expect(getUnreadDividerPlacement(items, 10)).toEqual({
      firstUnreadId: 11,
      firstUnreadIndex: 3,
      unreadCount: 2,
    });
  });

  it('does not place a divider when the frozen cursor has no unread messages', () => {
    const items = buildTimelineItems([
      message(10, '2026-07-02T12:00:00.000Z'),
      message(11, '2026-07-02T12:01:00.000Z'),
    ]);

    expect(getUnreadDividerPlacement(items, 0)).toEqual({
      firstUnreadId: null,
      firstUnreadIndex: null,
      unreadCount: 0,
    });
    expect(getUnreadDividerPlacement(items, 11)).toEqual({
      firstUnreadId: null,
      firstUnreadIndex: null,
      unreadCount: 0,
    });
  });
});

describe('latest visible mark-read gate', () => {
  it('finds the latest real message after non-message rows', () => {
    const items = buildTimelineItems([
      message(10, '2026-07-02T12:00:00.000Z'),
      message(11, '2026-07-03T12:00:00.000Z'),
    ]);

    expect(latestRealMessageId(items)).toBe(11);
  });

  it('requires user drag before visible latest marks read', () => {
    const items = buildTimelineItems([
      message(10, '2026-07-02T12:00:00.000Z'),
      message(11, '2026-07-02T12:01:00.000Z'),
    ]);
    const latest = latestRealMessageId(items);
    const latestItem = items.find((item) => item.message?.id === latest)!;

    expect(shouldMarkReadForVisibleLatest([{ isViewable: true, item: latestItem }], latest, false)).toBe(false);
    expect(shouldMarkReadForVisibleLatest([{ isViewable: true, item: latestItem }], latest, true)).toBe(true);
  });

  it('does not mark read for visible older messages', () => {
    const items = buildTimelineItems([
      message(10, '2026-07-02T12:00:00.000Z'),
      message(11, '2026-07-02T12:01:00.000Z'),
    ]);
    const olderItem = items.find((item) => item.message?.id === 10)!;

    expect(shouldMarkReadForVisibleLatest([{ isViewable: true, item: olderItem }], 11, true)).toBe(false);
  });
});
