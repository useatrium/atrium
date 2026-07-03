// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@atrium/surface-client';
import { isStructuredTextForMarkup, MessageRow } from '../src/components/MessageRow';
import { ThemeProvider } from '../src/theme';

function message(overrides: Partial<ChatMessage> & { handle?: string | null } = {}): ChatMessage & { handle?: string | null } {
  return {
    id: 101,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: null,
    text: 'First line\nSecond line',
    edited: false,
    author: { id: 'u-1', handle: 'ada', displayName: 'Ada' },
    createdAt: new Date(0).toISOString(),
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
    handle: 'evt_101',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('MessageRow markup action', () => {
  it.each([
    ['two non-empty lines', 'First line\n\nSecond line', true],
    ['heading', '# Plan', true],
    ['dash list', '- item', true],
    ['numbered list', '1. item', true],
    ['blockquote', '> quoted', true],
    ['fence', '```ts\nconst x = 1;\n```', true],
    ['one plain line', 'Just a sentence.', false],
    ['blank padded one line', '\n  Just a sentence. \n', false],
  ])('detects structured text: %s', (_label, text, expected) => {
    expect(isStructuredTextForMarkup(text)).toBe(expected);
  });

  it('shows Mark up & reply for confirmed structured text messages', () => {
    const onMarkupEntry = vi.fn();
    render(
      <ThemeProvider>
        <MessageRow
          message={message()}
          grouped={false}
          onMarkupEntry={onMarkupEntry}
        />
      </ThemeProvider>,
    );

    expect(screen.getByRole('button', { name: 'Mark up & reply' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Comment on entry' })).toBeNull();

    fireEvent.click(screen.getByTestId('markup-reply'));
    expect(onMarkupEntry).toHaveBeenCalledWith('evt_101', expect.objectContaining({ id: 101 }));
  });

  it('hides the action for plain, deleted, pending, and voice messages', () => {
    const { rerender } = render(
      <ThemeProvider>
        <MessageRow message={message({ text: 'plain sentence' })} grouped={false} onMarkupEntry={vi.fn()} />
      </ThemeProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Mark up & reply' })).toBeNull();

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    rerender(
      <ThemeProvider>
        <MessageRow
          message={message({ deleted: true })}
          grouped={false}
          onMarkupEntry={vi.fn()}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Mark up & reply' })).toBeNull();

    rerender(
      <ThemeProvider>
        <MessageRow
          message={message({ status: 'pending', id: null })}
          grouped={false}
          onMarkupEntry={vi.fn()}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Mark up & reply' })).toBeNull();

    rerender(
      <ThemeProvider>
        <MessageRow
          message={message({ voice: { fileId: 'file-1', durationMs: 1200, transcript: { status: 'pending' } } })}
          grouped={false}
          onMarkupEntry={vi.fn()}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Mark up & reply' })).toBeNull();
  });
});
