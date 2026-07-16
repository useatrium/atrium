// Fold-to-reply assignment, tested as data rather than through the DOM. The
// duplicate-render bug lived in here and survived a DOM test that only counted
// one reply — these cases are cheap enough to cover the awkward shapes.

import type { FoldedTurnRow } from '@atrium/centaur-client';
import type { ChatMessage, TimelineItem } from '@atrium/surface-client';
import { describe, expect, it } from 'vitest';
import { buildSpineRows, type SpineRow } from './threadSpine';

const SESSION = 's-1';

function fold(overrides: Partial<FoldedTurnRow> & { key: string }): FoldedTurnRow {
  return {
    kind: 'fold',
    turn: 0,
    replyOrdinal: null,
    items: [],
    toolNames: ['Bash'],
    startIndex: 0,
    endIndex: 0,
    triggerIndex: null,
    triggerOrdinal: null,
    replyIndex: null,
    completed: true,
    ...overrides,
  };
}

function msg(id: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: 42,
    text: `m${id}`,
    edited: false,
    reactions: [],
    attachments: [],
    author: { id: 'u-1', handle: 'ada', displayName: 'Ada' },
    createdAt: '2026-07-05T12:00:00.000Z',
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
    ...overrides,
  };
}

const reply = (id: number) => msg(id, { sessionId: SESSION, sessionEventType: 'replied' });
const steer = (id: number) => msg(id, { steeredSessionId: SESSION });

function timeline(messages: ChatMessage[]): TimelineItem[] {
  return messages.map((message) => ({ kind: 'message', key: `k${message.id}`, message }));
}

function rows(messages: ChatMessage[], workFolds: FoldedTurnRow[]): SpineRow[] {
  return buildSpineRows({ items: timeline(messages), workFolds, attachedSessionId: SESSION, sessionLive: false });
}

const foldKeysOf = (result: SpineRow[]) =>
  result.flatMap((row) => (row.kind === 'fold' ? [row.key] : row.fold ? [row.fold.key] : []));
const nestedOn = (result: SpineRow[], id: number) =>
  result.find((row) => row.kind === 'message' && row.message.id === id) as Extract<SpineRow, { kind: 'message' }>;

describe('buildSpineRows', () => {
  it('nests each turn’s fold in the reply it produced', () => {
    const result = rows(
      [steer(1), reply(2), steer(3), reply(4)],
      [fold({ key: 'a', replyOrdinal: 0, triggerOrdinal: 0 }), fold({ key: 'b', replyOrdinal: 1, triggerOrdinal: 1 })],
    );

    expect(nestedOn(result, 2).fold?.key).toBe('a');
    expect(nestedOn(result, 4).fold?.key).toBe('b');
    // Nested means NOT also standalone.
    expect(result.filter((row) => row.kind === 'fold')).toHaveLength(0);
  });

  it('renders a fold exactly once even when its steer precedes its reply', () => {
    // Regression: the trigger pass hoisted fold `b` into a standalone row before
    // reply 4 nested it, so the same work rendered twice.
    const result = rows(
      [steer(1), reply(2), steer(3), reply(4)],
      [fold({ key: 'a', replyOrdinal: 0, triggerOrdinal: 0 }), fold({ key: 'b', replyOrdinal: 1, triggerOrdinal: 1 })],
    );

    expect(foldKeysOf(result)).toEqual(['a', 'b']);
  });

  it('keeps work with no reply of its own as a standalone row', () => {
    const result = rows([steer(1)], [fold({ key: 'orphan', replyOrdinal: null, triggerOrdinal: 0 })]);

    expect(result.filter((row) => row.kind === 'fold').map((row) => row.key)).toEqual(['orphan']);
  });

  it('does not nest a turn the thread never heard an answer for', () => {
    // The stream saw three answered turns; the thread only carries two replies
    // (a failed execution posts no `session.replied`). The third fold must not
    // borrow someone else's answer — it keeps its own row.
    const result = rows(
      [reply(2), reply(4)],
      [fold({ key: 'a', replyOrdinal: 0 }), fold({ key: 'b', replyOrdinal: 1 }), fold({ key: 'c', replyOrdinal: 2 })],
    );

    expect(nestedOn(result, 2).fold?.key).toBe('a');
    expect(nestedOn(result, 4).fold?.key).toBe('b');
    expect(result.filter((row) => row.kind === 'fold').map((row) => row.key)).toEqual(['c']);
    expect(foldKeysOf(result)).toHaveLength(3);
  });

  it('never drops a fold, whatever the shape', () => {
    const workFolds = [
      fold({ key: 'a', replyOrdinal: 0, triggerOrdinal: null }),
      fold({ key: 'b', replyOrdinal: 1, triggerOrdinal: 1 }),
      fold({ key: 'c', replyOrdinal: null, triggerOrdinal: 2 }),
      fold({ key: 'd', replyOrdinal: null, triggerOrdinal: 9 }),
    ];
    const result = rows([reply(2), steer(3), reply(4), steer(5)], workFolds);

    expect(new Set(foldKeysOf(result))).toEqual(new Set(['a', 'b', 'c', 'd']));
    expect(foldKeysOf(result)).toHaveLength(4);
  });

  it('leaves a thread with no attached session untouched', () => {
    const result = buildSpineRows({
      items: timeline([msg(1), msg(2)]),
      workFolds: [],
      attachedSessionId: null,
      sessionLive: false,
    });

    expect(result).toHaveLength(2);
    expect(result.every((row) => row.kind === 'message' && !row.aside)).toBe(true);
  });
});
