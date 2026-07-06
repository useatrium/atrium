// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import type { ChatMessage, UserRef } from '@atrium/surface-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme';
import { ThreadPanel } from './ThreadPanel';

const ada: UserRef = {
  id: 'u-1',
  handle: 'ada',
  displayName: 'Ada Lovelace',
};

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 42,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: null,
    text: 'Root message',
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

function renderPanel() {
  render(
    <ThemeProvider>
      <ThreadPanel
        root={message()}
        replies={[]}
        loaded
        sessions={{}}
        spectators={{}}
        meId="u-1"
        meHandle="ada"
        onClose={vi.fn()}
        onSend={vi.fn()}
        onOpenSession={vi.fn()}
        onRetry={vi.fn()}
      />
    </ThemeProvider>,
  );
}

function pointerMouseEvent(type: string, clientX: number): MouseEvent {
  const event = new MouseEvent(type, { button: 0, clientX, bubbles: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('ThreadPanel resize', () => {
  it('renders a resize handle', () => {
    renderPanel();

    expect(screen.getByTestId('thread-resize-handle')).toBeTruthy();
  });

  it('updates the pane width while dragging and persists once on pointer up', () => {
    renderPanel();
    const handle = screen.getByTestId('thread-resize-handle') as HTMLElement;
    const aside = handle.parentElement as HTMLElement;
    handle.setPointerCapture = vi.fn();
    vi.spyOn(aside, 'getBoundingClientRect').mockReturnValue({
      width: 380,
      height: 600,
      top: 0,
      right: 380,
      bottom: 600,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    act(() => {
      handle.dispatchEvent(pointerMouseEvent('pointerdown', 500));
      handle.dispatchEvent(pointerMouseEvent('pointermove', 450));
    });

    expect(aside.style.width).toBe('min(430px, 60vw)');
    expect(window.localStorage.getItem('atrium.threadPaneWidth')).toBeNull();

    act(() => {
      handle.dispatchEvent(pointerMouseEvent('pointerup', 450));
    });

    expect(window.localStorage.getItem('atrium.threadPaneWidth')).toBe('430');
    expect(handle.getAttribute('aria-valuenow')).toBe('430');
  });

  it('resets to the adaptive default on double click', () => {
    window.localStorage.setItem('atrium.threadPaneWidth', '430');
    renderPanel();
    const handle = screen.getByTestId('thread-resize-handle') as HTMLElement;
    const aside = handle.parentElement as HTMLElement;

    expect(aside.style.width).toBe('min(430px, 60vw)');

    act(() => {
      handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    expect(window.localStorage.getItem('atrium.threadPaneWidth')).toBeNull();
    expect(aside.className).toContain('w-[min(380px,38vw)]');
    expect(handle.getAttribute('aria-valuenow')).toBe('380');
  });
});
