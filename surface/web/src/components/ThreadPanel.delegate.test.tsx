// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatMessage, UserRef } from '@atrium/surface-client';
import { encodeEventHandle } from '@atrium/surface-client/handle';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme';
import { ThreadPanelHarness as ThreadPanel } from '../../test/renderConversation';
import { reconcileThreadSteerReplies } from './ThreadPanel';

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
  it('reconciles one optimistic steer per durable thread echo', () => {
    const pending = message({
      id: null,
      clientMsgId: 'local-1',
      threadRootEventId: 42,
      text: 'Try another path',
      createdAt: '2026-07-05T12:00:00.000Z',
      status: 'pending',
      steeredSessionId: 's-1',
    });
    const durable = message({
      id: 84,
      threadRootEventId: 42,
      text: 'Try another path',
      createdAt: '2026-07-05T12:00:01.000Z',
      steeredSessionId: 's-1',
    });

    expect(reconcileThreadSteerReplies([pending, durable])).toEqual([durable]);
    expect(reconcileThreadSteerReplies([pending, { ...pending, clientMsgId: 'local-2' }, durable])).toHaveLength(2);
  });

  it('preserves failed and newly repeated steers instead of consuming an older echo', () => {
    const durable = message({
      id: 84,
      threadRootEventId: 42,
      text: 'Try another path',
      createdAt: '2026-07-05T12:00:01.000Z',
      steeredSessionId: 's-1',
    });
    const failed = message({
      id: null,
      clientMsgId: 'failed-1',
      threadRootEventId: 42,
      text: 'Try another path',
      createdAt: '2026-07-05T12:00:00.000Z',
      status: 'failed',
      steeredSessionId: 's-1',
    });
    const repeatedLater = message({
      ...failed,
      clientMsgId: 'pending-2',
      createdAt: '2026-07-05T12:00:02.000Z',
      status: 'pending',
    });

    expect(reconcileThreadSteerReplies([failed, durable])).toEqual([failed, durable]);
    expect(reconcileThreadSteerReplies([durable, repeatedLater])).toEqual([durable, repeatedLater]);
  });

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

    // Delegate used to be right-click-only. It now lives behind the row's visible
    // ⋯ button, which is the only keyboard-reachable route to it.
    const row = screen.getByText('Reply message').closest('[data-eid]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'More message actions' }));
    const actionMenu = screen.getByRole('dialog', { name: 'Message actions' });
    fireEvent.click(within(actionMenu).getByRole('button', { name: 'Delegate to agent…' }));

    expect(screen.getByTestId('composer-audience-pill').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByPlaceholderText('Prompt agent…')).toBeTruthy();
    expect(screen.getAllByText(`/e/${encodeEventHandle(reply.id!)}`).length).toBeGreaterThan(0);
  });
});
