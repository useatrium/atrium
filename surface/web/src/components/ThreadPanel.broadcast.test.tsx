// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function renderPanel(onSend = vi.fn()) {
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
        onSend={onSend}
        onOpenSession={vi.fn()}
        onRetry={vi.fn()}
      />
    </ThemeProvider>,
  );
  return { onSend };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('ThreadPanel broadcast replies', () => {
  it('sends a reply with broadcast enabled and resets the checkbox', () => {
    const { onSend } = renderPanel();
    const checkbox = screen.getByRole('checkbox', { name: /also send to/i });
    const input = screen.getByLabelText('Message input');

    fireEvent.click(checkbox);
    fireEvent.change(input, { target: { value: 'Thread reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('Thread reply', undefined, undefined, undefined, true);
    expect((checkbox as HTMLInputElement).checked).toBe(false);
  });
});
