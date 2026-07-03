import { describe, expect, it, vi } from 'vitest';
import { unreadBadgeCount } from '../src/lib/useBadgeSync';

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

vi.mock('expo-notifications', () => ({
  setBadgeCountAsync: vi.fn(() => Promise.resolve(true)),
}));

describe('badge sync', () => {
  it('counts truthy unread channel values', () => {
    expect(
      unreadBadgeCount({
        'read-channel': false,
        'plain-unread': true,
        mention: 'mention',
        missing: undefined,
      }),
    ).toBe(2);
  });
});
