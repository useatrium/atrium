// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { setDesktopBadge } from '../src/desktop';
import { applyUnreadBadges } from '../src/Chat';

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
