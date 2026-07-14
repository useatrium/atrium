import { describe, expect, it } from 'vitest';
import type { SessionItem, ToolCallItem } from './reducer.js';
import { foldedTurnRows, focusTranscriptRows, fullTranscriptRows, toolDefaultOpen } from './transcriptRows.js';

const item = (id: string, type: SessionItem['type']): SessionItem => ({ id, type }) as SessionItem;

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
  it('groups work after each human input and before that turn’s final answer', () => {
    const items = [
      { ...item('ask-1', 'user_message'), text: 'First', ts: '2026-07-14T12:00:00.000Z' },
      { ...item('thought-1', 'reasoning'), text: 'Think', ts: '2026-07-14T12:00:01.000Z' },
      {
        ...item('tool-1', 'tool_call'),
        name: 'Bash',
        input: {},
        result: { content: 'ok', is_error: false },
        ts: '2026-07-14T12:00:02.000Z',
      },
      { ...item('answer-1', 'text'), text: 'Done', ts: '2026-07-14T12:00:04.000Z' },
      { ...item('ask-2', 'user_message'), text: 'Again', ts: '2026-07-14T12:01:00.000Z' },
      { ...item('tool-2', 'tool_call'), name: 'Read', input: {}, ts: '2026-07-14T12:01:01.000Z' },
    ] as SessionItem[];

    const folds = foldedTurnRows(items);
    expect(folds).toHaveLength(2);
    expect(folds[0]).toMatchObject({
      items: [items[1], items[2]],
      toolNames: ['Bash'],
      replyOrdinal: 0,
      triggerIndex: 0,
      triggerOrdinal: 0,
      replyIndex: 3,
      durationMs: 3000,
      completed: true,
    });
    expect(folds[1]).toMatchObject({
      items: [items[5]],
      toolNames: ['Read'],
      replyOrdinal: null,
      triggerIndex: 4,
      triggerOrdinal: 1,
      replyIndex: null,
      completed: false,
    });
  });

  it('preserves the reply ordinal when an earlier turn has no hidden work', () => {
    const items = [
      { ...item('ask-1', 'user_message'), text: 'First' },
      { ...item('answer-1', 'text'), text: 'Immediate answer' },
      { ...item('ask-2', 'user_message'), text: 'Second' },
      { ...item('thought-2', 'reasoning'), text: 'Think' },
      { ...item('answer-2', 'text'), text: 'Worked answer' },
    ] as SessionItem[];

    expect(foldedTurnRows(items)).toHaveLength(1);
    expect(foldedTurnRows(items)[0]).toMatchObject({ replyOrdinal: 1, replyIndex: 4 });
  });
});
