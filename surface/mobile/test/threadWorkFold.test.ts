import { describe, expect, it } from 'vitest';
import { foldedTurnRows, type SessionItem } from '@atrium/centaur-client';
import { mapFoldedTurnRow } from '../src/lib/threadWorkFold';

const sourceEventIds: number[] = [];

describe('thread work fold view mapping', () => {
  it('splits work around a question, keeping it outside the folds', () => {
    const items: SessionItem[] = [
      {
        id: 'ask',
        type: 'user_message',
        text: 'Inspect it',
        ts: '2026-07-16T12:00:00.000Z',
        executionId: null,
        sourceEventIds,
      },
      {
        id: 'reasoning',
        type: 'reasoning',
        summary: 'Inspecting',
        text: 'I will read the file.',
        ts: '2026-07-16T12:00:01.000Z',
        executionId: null,
        sourceEventIds,
      },
      {
        id: 'question',
        type: 'question',
        questionId: 'question-1',
        questions: [{ id: 'prompt-1', header: 'Choice', question: 'Which file?' }],
        status: 'resolved',
        ts: '2026-07-16T12:00:02.000Z',
        executionId: null,
        sourceEventIds,
      },
      {
        id: 'read',
        type: 'tool_call',
        name: 'Read',
        input: { file_path: 'src/file.ts' },
        result: { content: 'file contents', is_error: false },
        ts: '2026-07-16T12:00:03.000Z',
        executionId: null,
        sourceEventIds,
      },
      {
        id: 'answer',
        type: 'text',
        text: 'Done',
        ts: '2026-07-16T12:00:05.000Z',
        executionId: null,
        sourceEventIds,
      },
    ];

    // The question is a non-work item, so the surrounding reasoning and tool
    // work split into two folds that render on either side of it — keeping the
    // transcript chronological rather than hoisting all work above the question.
    const folds = foldedTurnRows(items);
    expect(folds).toHaveLength(2);
    expect(folds[0]!.items.map((item) => item.id)).toEqual(['reasoning']);
    expect(folds[1]!.items.map((item) => item.id)).toEqual(['read']);
    expect(mapFoldedTurnRow(folds[0]!)).toEqual({
      duration: '0s',
      steps: [
        {
          id: 'reasoning',
          label: 'Inspecting',
          detail: 'I will read the file.',
          status: 'done',
        },
      ],
    });
    expect(mapFoldedTurnRow(folds[1]!)).toEqual({
      duration: '2s',
      steps: [
        {
          id: 'read',
          label: 'Read · src/file.ts',
          detail: '{\n  "file_path": "src/file.ts"\n}\n\nfile contents',
          status: 'done',
        },
      ],
    });
  });

  it('maps an incomplete turn with no reply as live tool work', () => {
    const items: SessionItem[] = [
      { id: 'ask', type: 'user_message', text: 'Run it', executionId: null, sourceEventIds },
      {
        id: 'run',
        type: 'tool_call',
        name: 'Bash',
        input: { command: 'pnpm test' },
        executionId: null,
        sourceEventIds,
      },
    ];

    const folds = foldedTurnRows(items);
    expect(folds[0]!.replyIndex).toBeNull();
    expect(mapFoldedTurnRow(folds[0]!)).toEqual({
      steps: [
        {
          id: 'run',
          label: 'pnpm test',
          detail: '{\n  "command": "pnpm test"\n}',
          status: 'running',
        },
      ],
    });
  });
});
