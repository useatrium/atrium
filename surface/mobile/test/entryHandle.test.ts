import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@atrium/surface-client';
import { entryHandleForMessage } from '../src/lib/entryHandle';

const author = { id: 'u-1', handle: 'ada', displayName: 'Ada' };

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 42,
    clientMsgId: null,
    channelId: 'c-1',
    threadRootEventId: null,
    text: 'hello',
    edited: false,
    author,
    createdAt: '2026-06-24T12:00:00.000Z',
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
    ...overrides,
  };
}

describe('entryHandleForMessage', () => {
  it('uses the wire handle when present', () => {
    const m = message() as ChatMessage & { handle: string };
    m.handle = 'evt_99';

    expect(entryHandleForMessage(m)).toBe('evt_99');
  });

  it('derives an event handle for confirmed message rows', () => {
    expect(entryHandleForMessage(message({ id: 7 }))).toBe('evt_7');
  });

  it('skips messages that should not open entry comments', () => {
    expect(entryHandleForMessage(message({ id: null, status: 'pending' }))).toBeNull();
    expect(entryHandleForMessage(message({ deleted: true }))).toBeNull();
    expect(entryHandleForMessage(message({ sessionId: 's-1' }))).toBeNull();
    expect(entryHandleForMessage(message({ sessionEventType: 'question_requested' }))).toBeNull();
  });
});
