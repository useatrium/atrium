// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WireEvent } from '@atrium/surface-client';
import { setDesktopBadge } from '../src/desktop';
import { applyUnreadBadges, isActivityRefreshEvent } from '../src/Chat';

vi.mock('../src/desktop', () => ({
  isDesktop: false,
  desktopWsUrl: vi.fn(() => null),
  desktopApiOptions: vi.fn(() => undefined),
  setDesktopBadge: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: undefined });
});

describe('applyUnreadBadges', () => {
  it('sets browser and desktop badges for unread counts', () => {
    const setAppBadge = vi.fn(async () => {});
    const clearAppBadge = vi.fn(async () => {});
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge });
    Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: clearAppBadge });

    applyUnreadBadges(3);

    expect(setAppBadge).toHaveBeenCalledWith(3);
    expect(clearAppBadge).not.toHaveBeenCalled();
    expect(setDesktopBadge).toHaveBeenCalledWith(3);
  });

  it('clears browser badges and desktop badges when unread reaches zero', () => {
    const setAppBadge = vi.fn(async () => {});
    const clearAppBadge = vi.fn(async () => {});
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: setAppBadge });
    Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: clearAppBadge });

    applyUnreadBadges(0);

    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).toHaveBeenCalledOnce();
    expect(setDesktopBadge).toHaveBeenCalledWith(0);
  });
});

describe('isActivityRefreshEvent', () => {
  const me = { id: 'u-me', handle: 'me', displayName: 'Me' };
  const event = (overrides: Partial<WireEvent> = {}): WireEvent => ({
    id: 10,
    workspaceId: 'ws-1',
    channelId: 'ch-general',
    threadRootEventId: null,
    type: 'message.posted',
    actorId: 'u-alice',
    payload: {},
    createdAt: '2026-07-02T10:00:00.000Z',
    author: { id: 'u-alice', handle: 'alice', displayName: 'Alice' },
    ...overrides,
  });

  it('selects feed events and state-clearing events for sessions I spawned', () => {
    expect(isActivityRefreshEvent(event({ payload: { text: 'ping @me' } }), me, [], {})).toBe(true);
    expect(
      isActivityRefreshEvent(
        event({
          type: 'session.question_resolved',
          channelId: 'ch-agent',
          actorId: 'u-me',
          payload: { sessionId: 's-1' },
        }),
        me,
        [],
        { 's-1': { spawnedBy: me.id } },
      ),
    ).toBe(true);
    expect(
      isActivityRefreshEvent(
        event({
          type: 'session.question_resolved',
          channelId: 'ch-agent',
          payload: { sessionId: 's-other' },
        }),
        me,
        [],
        { 's-other': { spawnedBy: 'u-other' } },
      ),
    ).toBe(false);
  });
});
