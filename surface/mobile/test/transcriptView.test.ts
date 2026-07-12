import { describe, expect, it } from 'vitest';
import type { SessionItem, ToolCallItem } from '@atrium/centaur-client';
import { focusTranscriptRows, toolDefaultOpen } from '../src/lib/transcriptView';

const item = (id: string, type: SessionItem['type']): SessionItem => ({ id, type } as SessionItem);

describe('focus transcript rows', () => {
  it('groups contiguous reasoning, tools, and inline changes into one count', () => {
    const items = [
      item('answer-1', 'text'),
      item('thinking', 'reasoning'),
      item('tool', 'tool_call'),
      item('question', 'question'),
      item('answer-2', 'text'),
    ];
    const changesAt = (index: number) => index === 2 ? [{ id: 'edit' }] : [];

    expect(focusTranscriptRows(items, changesAt).map((row) =>
      row.kind === 'item' ? `item:${row.item.id}` : `${row.kind}:${row.kind === 'hidden' ? row.count : ''}`,
    )).toEqual(['item:answer-1', 'hidden:3', 'item:question', 'item:answer-2']);
  });

  it('keeps separated hidden runs separate', () => {
    const items = [item('tool-1', 'tool_call'), item('answer', 'text'), item('tool-2', 'tool_call')];
    expect(focusTranscriptRows(items, () => []).map((row) => row.kind === 'hidden' ? row.count : row.kind))
      .toEqual([1, 'item', 1]);
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
