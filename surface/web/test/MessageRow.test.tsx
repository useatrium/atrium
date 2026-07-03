// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@atrium/surface-client';
import { MessageRow } from '../src/components/MessageRow';
import { ThemeProvider } from '../src/theme';

function message(overrides: Partial<ChatMessage> & { handle?: string | null } = {}): ChatMessage & { handle?: string | null } {
  return {
    id: 101,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: null,
    text: 'Agent output',
    edited: false,
    author: { id: 'agent-1', handle: 'agent-1', displayName: 'Agent' },
    createdAt: new Date(0).toISOString(),
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
    handle: 'rec_abc',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('MessageRow markup action', () => {
  it('shows Mark up & reply only with an explicit record handle, agent text, and session id', () => {
    render(
      <ThemeProvider>
        <MessageRow
          message={message()}
          grouped={false}
          markupSessionId="sess-1"
          onMarkupEntry={vi.fn()}
        />
      </ThemeProvider>,
    );

    expect(screen.getByRole('button', { name: 'Mark up & reply' })).toBeTruthy();
  });

  it('hides the action without a session id, record handle, or agent author', () => {
    const { rerender } = render(
      <ThemeProvider>
        <MessageRow message={message()} grouped={false} onMarkupEntry={vi.fn()} />
      </ThemeProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Mark up & reply' })).toBeNull();

    rerender(
      <ThemeProvider>
        <MessageRow
          message={message({ handle: 'evt_101' })}
          grouped={false}
          markupSessionId="sess-1"
          onMarkupEntry={vi.fn()}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Mark up & reply' })).toBeNull();

    rerender(
      <ThemeProvider>
        <MessageRow
          message={message({ author: { id: 'u-1', handle: 'me', displayName: 'Me' } })}
          grouped={false}
          markupSessionId="sess-1"
          onMarkupEntry={vi.fn()}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Mark up & reply' })).toBeNull();
  });
});
