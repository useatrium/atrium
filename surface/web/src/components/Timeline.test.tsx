// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage, UserRef } from '@atrium/surface-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme';
import type { Session } from '../sessions/types';
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

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: 1,
    title: 'Session',
    status: 'running',
    harness: 'codex',
    spawnedBy: 'u-1',
    driverId: 'u-1',
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    pendingQuestion: null,
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: '2026-07-05T12:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 0,
    permalink: '/s/s-1',
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
  sessions = {},
  loaded = true,
}: {
  messages?: ChatMessage[];
  unreadDividerAfterId?: number | null;
  onReachBottom?: () => void;
  sessions?: Record<string, Session>;
  loaded?: boolean;
} = {}) {
  const renderElement = (nextMessages: ChatMessage[], nextLoaded: boolean) => (
    <ThemeProvider>
      <Timeline
        messages={nextMessages}
        loaded={nextLoaded}
        hasMoreBefore={false}
        sessions={sessions}
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
    </ThemeProvider>
  );
  const view = render(renderElement(messages, loaded));
  return {
    ...view,
    rerenderMessages: (nextMessages: ChatMessage[], nextLoaded = true) =>
      view.rerender(renderElement(nextMessages, nextLoaded)),
  };
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
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
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

describe('Timeline anchored agent answers', () => {
  const answer = () =>
    message({
      id: 9,
      threadRootEventId: 1,
      text: 'Shipped the channel grammar.',
      sessionId: 's-1',
      sessionEventType: 'replied',
      broadcast: true,
      author: { id: 'agent:s-1', handle: 'agent', displayName: 'Agent' },
      createdAt: '2026-07-05T12:01:00.000Z',
    });

  it('anchors and suppresses a broadcast answer when the root is loaded', () => {
    renderTimeline({
      messages: [message({ id: 1, text: 'Please ship it', replyCount: 1, lastReplyId: 9 }), answer()],
      unreadDividerAfterId: null,
    });

    expect(screen.getAllByText('Shipped the channel grammar.')).toHaveLength(1);
    expect(screen.getByTestId('channel-annotation-cluster')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '↳ replied to a thread' })).toBeNull();
  });

  it('keeps the standalone answer when its root is outside the loaded window', () => {
    renderTimeline({ messages: [answer()], unreadDividerAfterId: null });

    expect(screen.getByText('Shipped the channel grammar.')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Agent' })).toBeTruthy();
  });

  it('suppresses thread-rooted spawn rows and stacks their sessions on the trigger', () => {
    const first = session({ id: 's-1' });
    const second = session({ id: 's-2', createdAt: '2026-07-05T12:00:02.000Z' });
    renderTimeline({
      messages: [
        message({ id: 1, text: 'Trigger both agents' }),
        message({
          id: 8,
          threadRootEventId: 1,
          sessionId: 's-1',
          sessionTask: 'Duplicate spawn row one',
          broadcast: true,
        }),
        message({
          id: 9,
          threadRootEventId: 1,
          sessionId: 's-2',
          sessionTask: 'Duplicate spawn row two',
          broadcast: true,
        }),
      ],
      sessions: { 's-1': first, 's-2': second },
      unreadDividerAfterId: null,
    });

    expect(screen.getAllByTestId('session-slot-working')).toHaveLength(2);
    expect(screen.queryByText('Duplicate spawn row one')).toBeNull();
    expect(screen.queryByText('Duplicate spawn row two')).toBeNull();
  });

  it('shows the latest-answer jump chip for an offscreen root and dismisses it on click', async () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'log') {
        return { top: 0, bottom: 200, left: 0, right: 300, width: 300, height: 200, x: 0, y: 0, toJSON: vi.fn() };
      }
      if (this.getAttribute('data-eid') === '1') {
        return { top: -120, bottom: -80, left: 0, right: 300, width: 300, height: 40, x: 0, y: -120, toJSON: vi.fn() };
      }
      return { top: 20, bottom: 60, left: 0, right: 300, width: 300, height: 40, x: 0, y: 20, toJSON: vi.fn() };
    });
    const root = message({ id: 1, text: 'Please ship this carefully' });
    const view = renderTimeline({ messages: [root], unreadDividerAfterId: null });

    view.rerenderMessages([{ ...root, replyCount: 1, lastReplyId: 9 }, answer()]);
    const chip = await screen.findByTestId('agent-answer-jump-chip');
    expect(chip.textContent).toContain('Please ship this carefully');
    fireEvent.click(chip);
    expect(screen.queryByTestId('agent-answer-jump-chip')).toBeNull();
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    rect.mockRestore();
  });

  // Timeline mounts before the first history page lands (that is what the
  // skeleton is for), so the "have I seen an answer before?" baseline must not
  // be taken from that empty first render — every reload would replay the chip
  // for an answer that arrived days ago.
  it('does not show the jump chip for the first history page after an empty mount', async () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'log') {
        return { top: 0, bottom: 200, left: 0, right: 300, width: 300, height: 200, x: 0, y: 0, toJSON: vi.fn() };
      }
      if (this.getAttribute('data-eid') === '1') {
        return { top: -120, bottom: -80, left: 0, right: 300, width: 300, height: 40, x: 0, y: -120, toJSON: vi.fn() };
      }
      return { top: 20, bottom: 60, left: 0, right: 300, width: 300, height: 40, x: 0, y: 20, toJSON: vi.fn() };
    });
    const root = message({ id: 1, text: 'Please ship this carefully' });
    // The real mount order: the skeleton renders with no history, then the
    // first page lands with the answer already in it.
    const view = renderTimeline({ messages: [], loaded: false, unreadDividerAfterId: null });

    view.rerenderMessages([{ ...root, replyCount: 1, lastReplyId: 9 }, answer()], true);

    await act(async () => {});
    expect(screen.queryByTestId('agent-answer-jump-chip')).toBeNull();
    rect.mockRestore();
  });
});

// A deleted message with no replies renders no row at all (buildTimelineItems
// skips it), so nothing can scroll to it or mark it read. Every set that drives
// unread, scroll landing, and mark-read has to agree it isn't there — otherwise
// deleting the newest message in a channel strands the read cursor forever.
describe('Timeline deleted tail message', () => {
  const deletedTail = (replyCount = 0) => message({ id: 3, text: '', deleted: true, replyCount });

  function mockRowVisibility(visibleEid: string) {
    return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'log') {
        return { top: 0, bottom: 200, left: 0, right: 300, width: 300, height: 200, x: 0, y: 0, toJSON: vi.fn() };
      }
      if (this.getAttribute('data-eid') === visibleEid) {
        return { top: 150, bottom: 190, left: 0, right: 300, width: 300, height: 40, x: 0, y: 150, toJSON: vi.fn() };
      }
      return { top: 420, bottom: 460, left: 0, right: 300, width: 300, height: 40, x: 0, y: 420, toJSON: vi.fn() };
    });
  }

  it('marks read when the newest rendered row is visible behind a deleted tail', () => {
    const onReachBottom = vi.fn();
    const rect = mockRowVisibility('2');

    renderTimeline({
      messages: [message({ id: 1, text: 'Message 1' }), message({ id: 2, text: 'Message 2' }), deletedTail()],
      unreadDividerAfterId: 1,
      onReachBottom,
    });
    fireEvent.scroll(screen.getByRole('log', { name: 'Messages' }));

    expect(onReachBottom).toHaveBeenCalled();
    rect.mockRestore();
  });

  it('does not count a deleted tail message as unread', () => {
    renderTimeline({
      messages: [message({ id: 1, text: 'Message 1' }), message({ id: 2, text: 'Message 2' }), deletedTail()],
      unreadDividerAfterId: 2,
    });

    const log = screen.getByRole('log', { name: 'Messages' });
    setScrollMetrics(log, { scrollHeight: 1000, clientHeight: 200 });
    log.scrollTop = 0;
    fireEvent.scroll(log);

    expect(screen.queryByTestId('jump-to-unread')).toBeNull();
  });

  it('does not count a deleted tombstone with replies as unread', () => {
    const view = renderTimeline({
      messages: [message({ id: 1, text: 'Message 1' }), message({ id: 2, text: 'Message 2' }), deletedTail(1)],
      unreadDividerAfterId: 2,
    });

    expect(view.container.querySelector('[data-eid="3"]')).not.toBeNull();
    const log = screen.getByRole('log', { name: 'Messages' });
    setScrollMetrics(log, { scrollHeight: 1000, clientHeight: 200 });
    log.scrollTop = 0;
    fireEvent.scroll(log);

    expect(screen.queryByTestId('jump-to-unread')).toBeNull();
  });

  it('lands at the bottom when the only unread message is a deleted one', () => {
    const rect = mockRowVisibility('2');
    Object.defineProperty(HTMLDivElement.prototype, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(HTMLDivElement.prototype, 'clientHeight', { configurable: true, value: 200 });

    renderTimeline({
      messages: [message({ id: 1, text: 'Message 1' }), message({ id: 2, text: 'Message 2' }), deletedTail()],
      unreadDividerAfterId: 2,
    });

    expect(screen.getByRole('log', { name: 'Messages' }).scrollTop).toBe(1000);
    Reflect.deleteProperty(HTMLDivElement.prototype, 'scrollHeight');
    Reflect.deleteProperty(HTMLDivElement.prototype, 'clientHeight');
    rect.mockRestore();
  });
});

describe('Timeline human broadcast replies', () => {
  const humanReply = () =>
    message({
      id: 9,
      threadRootEventId: 1,
      text: 'Chiming in from the thread.',
      broadcast: true,
      author: { id: 'u-2', handle: 'grace', displayName: 'Grace Hopper' },
      createdAt: '2026-07-05T12:01:00.000Z',
    });

  it('keeps a human "also send to channel" reply standalone, attributed to its author', () => {
    renderTimeline({
      messages: [
        message({
          id: 1,
          text: 'Root ask',
          replyCount: 1,
          lastReplyId: 9,
          lastReply: humanReply(),
        }),
        humanReply(),
      ],
      unreadDividerAfterId: null,
    });

    // Exactly one render: the standalone row — never the cluster's compact
    // preview or an agent-dressed slot answer.
    expect(screen.getAllByText('Chiming in from the thread.')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '↳ replied to a thread' })).toBeTruthy();
    // The author's own name and avatar, not the agent mark.
    expect(screen.getByText('Grace Hopper')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Agent' })).toBeNull();
  });
});
