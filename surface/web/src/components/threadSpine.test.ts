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
    executionId: null,
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
    sessionExecutionId: null,
    status: 'confirmed',
    ...overrides,
  };
}

const reply = (id: number, executionId: string | null = null) =>
  msg(id, { sessionId: SESSION, sessionEventType: 'replied', sessionExecutionId: executionId });
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
  it('nests a fold in the reply carrying its execution id', () => {
    const result = rows(
      [reply(2, 'exe-b'), reply(4, 'exe-a')],
      [fold({ key: 'a', executionId: 'exe-a' }), fold({ key: 'b', executionId: 'exe-b' })],
    );

    expect(nestedOn(result, 2).fold?.key).toBe('b');
    expect(nestedOn(result, 4).fold?.key).toBe('a');
    // Nested means NOT also standalone.
    expect(result.filter((row) => row.kind === 'fold')).toHaveLength(0);
  });

  it('does not nest a reply with no execution id and keeps its fold standalone', () => {
    const result = rows([reply(2)], [fold({ key: 'legacy', executionId: 'exe-legacy', triggerOrdinal: 0 })]);

    expect(nestedOn(result, 2).fold).toBeUndefined();
    expect(result.filter((row) => row.kind === 'fold').map((row) => row.key)).toEqual(['legacy']);
  });

  it('nests the last fold when several folds share one execution id', () => {
    const result = rows(
      [steer(1), reply(2, 'exe-shared')],
      [
        fold({ key: 'early', executionId: 'exe-shared', triggerOrdinal: 0 }),
        fold({ key: 'final', executionId: 'exe-shared', triggerOrdinal: 1 }),
      ],
    );

    expect(nestedOn(result, 2).fold?.key).toBe('final');
    expect(result.filter((row) => row.kind === 'fold').map((row) => row.key)).toEqual(['early']);
    expect(foldKeysOf(result)).toEqual(['early', 'final']);
  });

  it('never drops a fold, whatever the shape', () => {
    const workFolds = [
      fold({ key: 'matched', executionId: 'exe-a', triggerOrdinal: null }),
      fold({ key: 'shared-early', executionId: 'exe-b', triggerOrdinal: 1 }),
      fold({ key: 'shared-final', executionId: 'exe-b', triggerOrdinal: 2 }),
      fold({ key: 'legacy', executionId: null, triggerOrdinal: 2 }),
      fold({ key: 'unanswered', executionId: 'exe-c', triggerOrdinal: 9 }),
    ];
    const result = rows([reply(2, 'exe-a'), steer(3), reply(4, 'exe-b'), steer(5)], workFolds);

    expect(new Set(foldKeysOf(result))).toEqual(
      new Set(['matched', 'shared-early', 'shared-final', 'legacy', 'unanswered']),
    );
    expect(foldKeysOf(result)).toHaveLength(5);
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
