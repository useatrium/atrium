// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage, UserRef } from '@atrium/surface-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme';
import { Timeline } from './Timeline';

const ada: UserRef = {
  id: 'u-1',
  handle: 'ada',
  displayName: 'Ada Lovelace',
};

const resizeObservers: MockResizeObserver[] = [];

class MockResizeObserver {
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 1,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: null,
    text: 'Message 1',
    edited: false,
    reactions: [],
    attachments: [],
    author: ada,
    createdAt: '2026-07-05T12:00:00.000Z',
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
    ...overrides,
  };
}

function renderTimeline({
  messages = [
    message({ id: 1, text: 'Message 1' }),
    message({ id: 2, text: 'Message 2' }),
    message({ id: 3, text: 'Message 3' }),
  ],
  unreadDividerAfterId = 1,
  onReachBottom,
}: {
  messages?: ChatMessage[];
  unreadDividerAfterId?: number | null;
  onReachBottom?: () => void;
} = {}) {
  render(
    <ThemeProvider>
      <Timeline
        messages={messages}
        loaded
        hasMoreBefore={false}
        sessions={{}}
        spectators={{}}
        meId="u-1"
        meHandle="ada"
        onLoadEarlier={vi.fn().mockResolvedValue(undefined)}
        onOpenThread={vi.fn()}
        onOpenSession={vi.fn()}
        onRetry={vi.fn()}
        unreadDividerAfterId={unreadDividerAfterId}
        dividerReady
        onReachBottom={onReachBottom}
      />
    </ThemeProvider>,
  );
}

function setScrollMetrics(
  el: HTMLElement,
  metrics: {
    scrollHeight: number;
    clientHeight: number;
  },
) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: metrics.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: metrics.clientHeight });
}

function triggerContentResize() {
  const observer = resizeObservers.at(-1);
  if (!observer) throw new Error('expected ResizeObserver to be installed');
  act(() => observer.trigger());
}

function mockLatestMessageOffscreen() {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.getAttribute('role') === 'log') {
      return { top: 0, bottom: 200, left: 0, right: 300, width: 300, height: 200, x: 0, y: 0, toJSON: vi.fn() };
    }
    if (this.getAttribute('data-eid') === '3') {
      return { top: 420, bottom: 460, left: 0, right: 300, width: 300, height: 40, x: 0, y: 420, toJSON: vi.fn() };
    }
    return { top: 0, bottom: 20, left: 0, right: 300, width: 300, height: 20, x: 0, y: 0, toJSON: vi.fn() };
  });
}

beforeEach(() => {
  resizeObservers.length = 0;
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Timeline unread divider', () => {
  it('renders immediately before the first unread message', () => {
    renderTimeline();

    const divider = screen.getByLabelText('New messages');
    expect(divider.hasAttribute('data-unread-divider')).toBe(true);
    expect(divider.nextElementSibling?.getAttribute('data-eid')).toBe('2');
  }, 15_000);

  it('does not render when there is no unread watermark', () => {
    renderTimeline({ unreadDividerAfterId: null });

    expect(screen.queryByLabelText('New messages')).toBeNull();
  });

  it('shows the unread-count pill when the divider is outside the viewport', () => {
    renderTimeline();

    const log = screen.getByRole('log', { name: 'Messages' });
    const divider = screen.getByLabelText('New messages') as HTMLElement;
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(divider, 'offsetTop', { configurable: true, value: 100 });
    log.scrollTop = 500;

    fireEvent.scroll(log);

    const pill = screen.getByTestId('jump-to-unread');
    expect(pill.textContent).toBe('2 new');
    expect(pill.getAttribute('aria-label')).toBe('Jump to 2 new messages');
  });

  it('does not mark read when landing on the divider leaves the newest message off-screen', () => {
    const onReachBottom = vi.fn();
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'log') {
        return { top: 0, bottom: 200, left: 0, right: 300, width: 300, height: 200, x: 0, y: 0, toJSON: vi.fn() };
      }
      if (this.getAttribute('data-eid') === '3') {
        return { top: 420, bottom: 460, left: 0, right: 300, width: 300, height: 40, x: 0, y: 420, toJSON: vi.fn() };
      }
      return { top: 0, bottom: 20, left: 0, right: 300, width: 300, height: 20, x: 0, y: 0, toJSON: vi.fn() };
    });

    renderTimeline({ onReachBottom });

    expect(onReachBottom).not.toHaveBeenCalled();
    rect.mockRestore();
  });

  it('marks read when the newest message row is visible', () => {
    const onReachBottom = vi.fn();
    let latestVisible = false;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'log') {
        return { top: 0, bottom: 200, left: 0, right: 300, width: 300, height: 200, x: 0, y: 0, toJSON: vi.fn() };
      }
      if (this.getAttribute('data-eid') === '3') {
        return latestVisible
          ? { top: 150, bottom: 190, left: 0, right: 300, width: 300, height: 40, x: 0, y: 150, toJSON: vi.fn() }
          : { top: 420, bottom: 460, left: 0, right: 300, width: 300, height: 40, x: 0, y: 420, toJSON: vi.fn() };
      }
      return { top: 0, bottom: 20, left: 0, right: 300, width: 300, height: 20, x: 0, y: 0, toJSON: vi.fn() };
    });

    renderTimeline({ onReachBottom });
    const log = screen.getByRole('log', { name: 'Messages' });
    expect(onReachBottom).not.toHaveBeenCalled();

    latestVisible = true;
    fireEvent.scroll(log);

    expect(onReachBottom).toHaveBeenCalled();
    rect.mockRestore();
  });

  it('re-pins to the bottom when content grows while stuck to latest', () => {
    const onReachBottom = vi.fn();
    renderTimeline({ unreadDividerAfterId: null, onReachBottom });

    const log = screen.getByRole('log', { name: 'Messages' });
    setScrollMetrics(log, { scrollHeight: 1000, clientHeight: 200 });
    log.scrollTop = 800;
    onReachBottom.mockClear();

    setScrollMetrics(log, { scrollHeight: 1300, clientHeight: 200 });
    triggerContentResize();

    expect(log.scrollTop).toBe(1300);
    expect(onReachBottom).toHaveBeenCalled();
  }, 15_000);

  it('does not move the viewport on content growth after the user scrolls away', () => {
    renderTimeline({ unreadDividerAfterId: null });

    const log = screen.getByRole('log', { name: 'Messages' });
    setScrollMetrics(log, { scrollHeight: 1000, clientHeight: 200 });
    log.scrollTop = 800;
    log.scrollTop = 100;
    fireEvent.scroll(log);

    setScrollMetrics(log, { scrollHeight: 1300, clientHeight: 200 });
    triggerContentResize();

    expect(log.scrollTop).toBe(100);
  }, 15_000);

  it('re-anchors the unread divider when content grows on a pristine divider landing', () => {
    const rect = mockLatestMessageOffscreen();
    let dividerTop = 160;
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (!this.hasAttribute('data-unread-divider')) return;
      const log = this.closest('[role="log"]') as HTMLElement | null;
      if (log) log.scrollTop = dividerTop;
    });

    renderTimeline();
    const log = screen.getByRole('log', { name: 'Messages' });
    expect(log.scrollTop).toBe(160);

    dividerTop = 260;
    triggerContentResize();

    expect(log.scrollTop).toBe(260);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    rect.mockRestore();
  }, 15_000);

  it('does not re-anchor the unread divider after the user scrolls away from the landing', () => {
    const rect = mockLatestMessageOffscreen();
    let dividerTop = 160;
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (!this.hasAttribute('data-unread-divider')) return;
      const log = this.closest('[role="log"]') as HTMLElement | null;
      if (log) log.scrollTop = dividerTop;
    });

    renderTimeline();
    const log = screen.getByRole('log', { name: 'Messages' });
    setScrollMetrics(log, { scrollHeight: 1000, clientHeight: 200 });
    log.scrollTop = 180;
    fireEvent.scroll(log);

    dividerTop = 260;
    setScrollMetrics(log, { scrollHeight: 1300, clientHeight: 200 });
    triggerContentResize();

    expect(log.scrollTop).toBe(180);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    rect.mockRestore();
  }, 15_000);
});
