import { describe, expect, it } from 'vitest';
import type { SessionItem, ToolCallItem } from './reducer.js';
import {
  coalesceTurnFolds,
  foldedTurnRows,
  focusTranscriptRows,
  fullTranscriptRows,
  isLiveFold,
  toolDefaultOpen,
} from './transcriptRows.js';

const item = (id: string, type: SessionItem['type'], executionId: string | null = null): SessionItem =>
  ({ id, type, executionId }) as SessionItem;

describe('notice markers stay visible (non-work)', () => {
  it('keeps notice rows visible in the focus view and folds only the work around them', () => {
    const items = [
      item('answer-1', 'text'),
      item('thinking', 'reasoning'),
      item('tool', 'tool_call'),
      item('notice:thread-name', 'notice'),
      item('answer-2', 'text'),
    ];
    const changesAt = () => [];

    expect(
      focusTranscriptRows(items, changesAt).map((row) =>
        row.kind === 'item' ? `item:${row.item.id}` : `${row.kind}:${row.kind === 'hidden' ? row.count : ''}`,
      ),
    ).toEqual(['item:answer-1', 'hidden:2', 'item:notice:thread-name', 'item:answer-2']);
  });

  it('does not sweep a notice into a work fold', () => {
    const items = [item('u', 'user_message'), item('r', 'reasoning'), item('cc', 'notice'), item('t', 'tool_call')];
    const folds = foldedTurnRows(items);
    const foldedIds = folds.flatMap((fold) => fold.items.map((foldItem) => foldItem.id));
    expect(foldedIds).not.toContain('cc');
    expect(foldedIds).toEqual(expect.arrayContaining(['r', 't']));
  });
});

describe('focus transcript rows', () => {
  it('groups contiguous reasoning, tools, and inline changes into one count', () => {
    const items = [
      item('answer-1', 'text'),
      item('thinking', 'reasoning'),
      item('tool', 'tool_call'),
      item('question', 'question'),
      item('answer-2', 'text'),
    ];
    const changesAt = (index: number) => (index === 2 ? [{ id: 'edit' }] : []);

    expect(
      focusTranscriptRows(items, changesAt).map((row) =>
        row.kind === 'item' ? `item:${row.item.id}` : `${row.kind}:${row.kind === 'hidden' ? row.count : ''}`,
      ),
    ).toEqual(['item:answer-1', 'hidden:3', 'item:question', 'item:answer-2']);
  });

  it('does not split or double-count a hidden run at a mid-run change anchor', () => {
    const items = [
      item('answer-1', 'text'),
      item('thinking', 'reasoning'),
      item('tool-1', 'tool_call'),
      item('tool-2', 'tool_call'),
      item('answer-2', 'text'),
    ];
    const rows = focusTranscriptRows(items, (index) => (index === 2 ? [{ id: 'edit' }] : []));

    expect(rows).toEqual([
      { kind: 'item', item: items[0], index: 0 },
      { kind: 'hidden', count: 4, key: 'thinking', startIndex: 1, endIndex: 3 },
      { kind: 'item', item: items[4], index: 4 },
    ]);
  });

  it('emits trailing changes after a visible last item as their own hidden run', () => {
    const items = [item('answer', 'text')];
    expect(focusTranscriptRows(items, (index) => (index === items.length ? [{ id: 'edit' }] : []))).toEqual([
      { kind: 'item', item: items[0], index: 0 },
      { kind: 'hidden', count: 1, key: 'change-1', startIndex: 1, endIndex: 1 },
    ]);
  });

  it('keeps separated hidden runs separate', () => {
    const items = [item('tool-1', 'tool_call'), item('answer', 'text'), item('tool-2', 'tool_call')];
    expect(focusTranscriptRows(items, () => [])).toEqual([
      { kind: 'hidden', count: 1, key: 'tool-1', startIndex: 0, endIndex: 0 },
      { kind: 'item', item: items[1], index: 1 },
      { kind: 'hidden', count: 1, key: 'tool-2', startIndex: 2, endIndex: 2 },
    ]);
  });
});

describe('full transcript rows', () => {
  it('assigns anchor indexes to changes and position indexes to items', () => {
    const items = [item('answer-1', 'text'), item('answer-2', 'text')];
    const before = { id: 'before' };
    const trailing = { id: 'trailing' };

    expect(
      fullTranscriptRows(items, (index) => {
        if (index === 1) return [before];
        if (index === items.length) return [trailing];
        return [];
      }),
    ).toEqual([
      { kind: 'item', item: items[0], index: 0 },
      { kind: 'change', change: before, index: 1 },
      { kind: 'item', item: items[1], index: 1 },
      { kind: 'change', change: trailing, index: 2 },
    ]);
  });
});

describe('tool default visibility', () => {
  it('opens running tools and collapses completed tools', () => {
    const running = { id: 'tool', type: 'tool_call', input: {} } as ToolCallItem;
    const completed = { ...running, result: { content: '', is_error: false } } as ToolCallItem;
    expect(toolDefaultOpen(running)).toBe(true);
    expect(toolDefaultOpen(completed)).toBe(false);
  });
});

describe('turn work folds', () => {
  it('splits work into chronological runs around intermediate narration', () => {
    const items = [
      { ...item('ask', 'user_message', 'exe-1'), text: 'Ship it', ts: '2026-07-14T12:00:00.000Z' },
      {
        ...item('tool-1', 'tool_call', 'exe-1'),
        name: 'Bash',
        input: {},
        result: { content: 'ok', is_error: false },
        ts: '2026-07-14T12:00:01.000Z',
      },
      { ...item('narration', 'text', 'exe-1'), text: 'The first check passed.', ts: '2026-07-14T12:00:02.000Z' },
      { ...item('thought-2', 'reasoning', 'exe-1'), text: 'Verify the build', ts: '2026-07-14T12:00:03.000Z' },
      {
        ...item('tool-2', 'tool_call', 'exe-1'),
        name: 'Read',
        input: {},
        result: { content: 'clean', is_error: false },
        ts: '2026-07-14T12:00:04.000Z',
      },
      { ...item('answer', 'text', 'exe-1'), text: 'Done', ts: '2026-07-14T12:00:07.000Z' },
    ] as SessionItem[];

    const folds = foldedTurnRows(items);

    expect(folds).toHaveLength(2);
    expect(folds[0]).toMatchObject({
      key: 'turn-1-tool-1',
      turn: 1,
      executionId: 'exe-1',
      items: [items[1]],
      toolNames: ['Bash'],
      startIndex: 1,
      endIndex: 1,
      triggerIndex: 0,
      triggerOrdinal: 0,
      replyIndex: null,
      durationMs: 0,
      completed: true,
    });
    expect(folds[1]).toMatchObject({
      key: 'turn-1-thought-2',
      turn: 1,
      executionId: 'exe-1',
      items: [items[3], items[4]],
      toolNames: ['Read'],
      startIndex: 3,
      endIndex: 4,
      triggerIndex: 0,
      triggerOrdinal: 0,
      replyIndex: 5,
      durationMs: 4000,
      completed: true,
    });
    expect(folds.map((fold) => fold.startIndex)).toEqual([1, 3]);
  });

  it('keeps uninterrupted work in exactly one fold', () => {
    const items = [
      { ...item('ask', 'user_message', 'exe-1'), text: 'Ship it' },
      { ...item('thought', 'reasoning', 'exe-1'), text: 'Think' },
      { ...item('tool', 'tool_call', 'exe-1'), name: 'Bash', input: {} },
      { ...item('answer', 'text', 'exe-1'), text: 'Done' },
    ] as SessionItem[];

    const folds = foldedTurnRows(items);

    expect(folds).toHaveLength(1);
    expect(folds[0]).toMatchObject({
      items: [items[1], items[2]],
      startIndex: 1,
      endIndex: 2,
      replyIndex: 3,
      completed: true,
    });
  });

  it('groups work after each human input and before that turn’s final answer', () => {
    const items = [
      { ...item('ask-1', 'user_message', 'exe-1'), text: 'First', ts: '2026-07-14T12:00:00.000Z' },
      { ...item('thought-1', 'reasoning', 'exe-1'), text: 'Think', ts: '2026-07-14T12:00:01.000Z' },
      {
        ...item('tool-1', 'tool_call', 'exe-1'),
        name: 'Bash',
        input: {},
        result: { content: 'ok', is_error: false },
        ts: '2026-07-14T12:00:02.000Z',
      },
      { ...item('answer-1', 'text', 'exe-1'), text: 'Done', ts: '2026-07-14T12:00:04.000Z' },
      { ...item('ask-2', 'user_message', 'exe-2'), text: 'Again', ts: '2026-07-14T12:01:00.000Z' },
      { ...item('tool-2', 'tool_call', 'exe-2'), name: 'Read', input: {}, ts: '2026-07-14T12:01:01.000Z' },
    ] as SessionItem[];

    const folds = foldedTurnRows(items);
    expect(folds).toHaveLength(2);
    expect(folds[0]).toMatchObject({
      items: [items[1], items[2]],
      toolNames: ['Bash'],
      executionId: 'exe-1',
      triggerIndex: 0,
      triggerOrdinal: 0,
      replyIndex: 3,
      durationMs: 3000,
      completed: true,
    });
    expect(folds[1]).toMatchObject({
      items: [items[5]],
      toolNames: ['Read'],
      executionId: 'exe-2',
      triggerIndex: 4,
      triggerOrdinal: 1,
      replyIndex: null,
      completed: false,
    });
  });

  it('takes identity from the fold’s own work and final reply', () => {
    const items = [
      { ...item('ask-1', 'user_message', 'exe-1'), text: 'First' },
      { ...item('answer-1', 'text', 'exe-1'), text: 'Immediate answer' },
      { ...item('ask-2', 'user_message', 'exe-2'), text: 'Second' },
      { ...item('thought-2', 'reasoning', 'exe-2'), text: 'Think' },
      { ...item('answer-2', 'text', 'exe-2'), text: 'Worked answer' },
    ] as SessionItem[];

    expect(foldedTurnRows(items)).toHaveLength(1);
    expect(foldedTurnRows(items)[0]).toMatchObject({ executionId: 'exe-2', replyIndex: 4 });
  });
});

describe('live turn work folds', () => {
  it('keeps only the final run of the final unanswered turn incomplete and live', () => {
    const folds = foldedTurnRows([
      { ...item('ask-1', 'user_message', 'exe-1'), text: 'First' },
      { ...item('tool-1a', 'tool_call', 'exe-1'), name: 'Bash', input: {} },
      { ...item('narration-1', 'text', 'exe-1'), text: 'Still working' },
      { ...item('tool-1b', 'tool_call', 'exe-1'), name: 'Read', input: {} },
      { ...item('ask-2', 'user_message', 'exe-2'), text: 'Second' },
      { ...item('tool-2a', 'tool_call', 'exe-2'), name: 'Bash', input: {} },
      { ...item('narration-2', 'text', 'exe-2'), text: 'One more check' },
      { ...item('tool-2b', 'tool_call', 'exe-2'), name: 'Read', input: {} },
    ] as SessionItem[]);

    expect(folds.map((fold) => [fold.key, fold.replyIndex, fold.completed])).toEqual([
      ['turn-1-tool-1a', null, true],
      ['turn-1-tool-1b', null, true],
      ['turn-2-tool-2a', null, true],
      ['turn-2-tool-2b', null, false],
    ]);
    expect(folds.map((fold) => isLiveFold(fold, folds, true))).toEqual([false, false, false, true]);
  });

  it('marks an incomplete newest fold live while the conversation is active', () => {
    const folds = foldedTurnRows([
      { ...item('ask', 'user_message'), text: 'Run it' },
      { ...item('tool', 'tool_call'), name: 'Bash', input: {} },
    ] as SessionItem[]);

    expect(isLiveFold(folds[0]!, folds, true)).toBe(true);
  });

  it('does not mark a completed newest fold live', () => {
    const folds = foldedTurnRows([
      { ...item('ask', 'user_message'), text: 'Run it' },
      { ...item('tool', 'tool_call'), name: 'Bash', input: {} },
      { ...item('answer', 'text'), text: 'Done' },
    ] as SessionItem[]);

    expect(isLiveFold(folds[0]!, folds, true)).toBe(false);
  });

  it('does not mark an incomplete newest fold live while the conversation is inactive', () => {
    const folds = foldedTurnRows([
      { ...item('ask', 'user_message'), text: 'Run it' },
      { ...item('tool', 'tool_call'), name: 'Bash', input: {} },
    ] as SessionItem[]);

    expect(isLiveFold(folds[0]!, folds, false)).toBe(false);
  });
});

describe('coalesceTurnFolds', () => {
  it('merges a turn`s interleaved runs into one fold, leaving separate turns alone', () => {
    const items = [
      { ...item('ask-1', 'user_message', 'exe-1'), text: 'First', ts: '2026-07-14T12:00:00.000Z' },
      {
        ...item('tool-1', 'tool_call', 'exe-1'),
        name: 'Bash',
        input: {},
        result: { content: 'ok', is_error: false },
        ts: '2026-07-14T12:00:01.000Z',
      },
      { ...item('narration', 'text', 'exe-1'), text: 'progress', ts: '2026-07-14T12:00:02.000Z' },
      {
        ...item('tool-2', 'tool_call', 'exe-1'),
        name: 'Read',
        input: {},
        result: { content: 'clean', is_error: false },
        ts: '2026-07-14T12:00:05.000Z',
      },
      { ...item('answer-1', 'text', 'exe-1'), text: 'Done', ts: '2026-07-14T12:00:06.000Z' },
      { ...item('ask-2', 'user_message', 'exe-2'), text: 'Second', ts: '2026-07-14T12:00:07.000Z' },
      {
        ...item('tool-3', 'tool_call', 'exe-2'),
        name: 'Bash',
        input: {},
        result: { content: 'ok2', is_error: false },
        ts: '2026-07-14T12:00:08.000Z',
      },
    ] as SessionItem[];

    const split = foldedTurnRows(items);
    expect(split.map((fold) => fold.turn)).toEqual([1, 1, 2]);

    const coalesced = coalesceTurnFolds(split);
    expect(coalesced).toHaveLength(2);
    expect(coalesced[0]!.items.map((entry) => entry.id)).toEqual(['tool-1', 'tool-2']);
    expect(coalesced[0]!.toolNames).toEqual(['Bash', 'Read']);
    expect(coalesced[0]!.startIndex).toBe(1);
    expect(coalesced[0]!.endIndex).toBe(3);
    expect(coalesced[0]!.durationMs).toBe(4000); // tool-1 12:00:01 → tool-2 12:00:05
    expect(coalesced[0]!.completed).toBe(true);
    expect(coalesced[1]!.items.map((entry) => entry.id)).toEqual(['tool-3']);
  });

  it('is a no-op when every turn already has a single fold', () => {
    const items = [
      { ...item('ask', 'user_message', 'exe-1'), text: 'Go' },
      { ...item('reasoning', 'reasoning', 'exe-1'), text: 'Think' },
      { ...item('tool', 'tool_call', 'exe-1'), name: 'Bash', input: {} },
      { ...item('answer', 'text', 'exe-1'), text: 'Done' },
    ] as SessionItem[];
    const split = foldedTurnRows(items);
    expect(split).toHaveLength(1);
    expect(coalesceTurnFolds(split)).toHaveLength(1);
  });
});
