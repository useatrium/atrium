// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatMessage, UserRef } from '@atrium/surface-client';
import { encodeEventHandle } from '@atrium/surface-client/handle';
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

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('ThreadPanel delegate to agent', () => {
  it('anchors the thread composer to the selected reply', () => {
    const reply = message({
      id: 84,
      threadRootEventId: 42,
      text: 'Reply message',
    });

    render(
      <ThemeProvider>
        <ThreadPanel
          root={message()}
          replies={[reply]}
          loaded
          sessions={{}}
          spectators={{}}
          meId="u-1"
          meHandle="ada"
          onClose={vi.fn()}
          onSend={vi.fn()}
          onAgentSend={vi.fn()}
          onOpenSession={vi.fn()}
          onRetry={vi.fn()}
        />
      </ThemeProvider>,
    );

    fireEvent.contextMenu(screen.getByText('Reply message'), { clientX: 64, clientY: 96 });
    const actionMenu = screen.getByRole('dialog', { name: 'Message actions' });
    fireEvent.click(within(actionMenu).getByRole('button', { name: 'Delegate to agent…' }));

    expect(screen.getAllByRole('button', { name: 'Exit agent mode' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`/e/${encodeEventHandle(reply.id!)}`).length).toBeGreaterThan(0);
  });
});
