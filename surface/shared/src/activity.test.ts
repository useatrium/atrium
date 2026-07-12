import { describe, expect, it } from 'vitest';
import { activityKindMarker, isActivityUnread, matchesActivityFilter, type ActivityFeedFilter } from './activity.js';
import type { ActivityItem } from './api.js';

function item(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    eventId: '10',
    kind: 'mention',
    channelId: 'ch-1',
    channelName: 'general',
    actorId: 'u-1',
    actorName: 'Alice',
    snippet: 'hi',
    createdAt: new Date().toISOString(),
    attention: false,
    ...overrides,
  };
}

describe('isActivityUnread', () => {
  it('treats ids above the watermark as unread', () => {
    expect(isActivityUnread(item({ eventId: '12' }), '10')).toBe(true);
    expect(isActivityUnread(item({ eventId: '8' }), '10')).toBe(false);
  });

  it('honors mark-unread exceptions under the watermark', () => {
    expect(isActivityUnread(item({ eventId: '8' }), '10', new Set(['8']))).toBe(true);
  });

  it('never counts muted rows', () => {
    expect(isActivityUnread(item({ eventId: '12', muted: true }), '10', new Set(['12']))).toBe(false);
  });

  it('prefers the server-computed unread flag when present', () => {
    expect(isActivityUnread(item({ eventId: '8', unread: true }), '10')).toBe(true);
    expect(isActivityUnread(item({ eventId: '12', unread: false }), '10')).toBe(false);
  });
});

describe('matchesActivityFilter', () => {
  const cases: Array<{ filter: ActivityFeedFilter; completed: boolean; unread: boolean; expect: boolean }> = [
    { filter: 'inbox', completed: false, unread: false, expect: true },
    { filter: 'inbox', completed: true, unread: false, expect: false },
    { filter: 'done', completed: true, unread: false, expect: true },
    { filter: 'done', completed: false, unread: true, expect: false },
    { filter: 'unread', completed: true, unread: true, expect: true },
    { filter: 'unread', completed: false, unread: false, expect: false },
    { filter: 'all', completed: true, unread: false, expect: true },
  ];

  for (const c of cases) {
    it(`${c.filter}: completed=${c.completed} unread=${c.unread} → ${c.expect}`, () => {
      const row = item({ kind: c.completed ? 'session_completed' : 'mention' });
      expect(matchesActivityFilter(row, c.filter, c.unread)).toBe(c.expect);
    });
  }
});

describe('activityKindMarker', () => {
  it('uses a check for completed sessions instead of OK', () => {
    expect(activityKindMarker('session_completed')).toBe('✓');
    expect(activityKindMarker('session_failed')).toBe('!');
    expect(activityKindMarker('mention')).toBe('@');
  });
});
