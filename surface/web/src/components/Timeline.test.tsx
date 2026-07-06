// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage, UserRef } from '@atrium/surface-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme';
import { Timeline } from './Timeline';

const ada: UserRef = {
  id: 'u-1',
  handle: 'ada',
  displayName: 'Ada Lovelace',
};

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
}: {
  messages?: ChatMessage[];
  unreadDividerAfterId?: number | null;
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
      />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Timeline unread divider', () => {
  it('renders immediately before the first unread message', () => {
    renderTimeline();

    const divider = screen.getByLabelText('New messages');
    expect(divider.hasAttribute('data-unread-divider')).toBe(true);
    expect(divider.nextElementSibling?.getAttribute('data-eid')).toBe('2');
  });

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
});
