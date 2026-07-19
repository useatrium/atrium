import { describe, expect, it } from 'vitest';
import { initialSessionState, reduceSession, type SessionState } from './reducer.js';
import type { CentaurEventFrame } from './types.js';

const reduceAll = (frames: CentaurEventFrame[]): SessionState =>
  frames.reduce((state, frame) => reduceSession(state, frame), initialSessionState());

describe('reduceSession shared data layer', () => {
  it('strips injected context appendices from displayed user messages', () => {
    const state = reduceAll([
      {
        event: 'amp_raw_event',
        event_id: 1,
        data: {
          type: 'item.completed',
          item: {
            id: 'user-ref',
            type: 'userMessage',
            text: 'Use this entry\n\n---\nReferenced entries:\n- /e/evt_1\n# Session Context\nchannel notes',
          },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 2,
        data: {
          type: 'item.completed',
          item: {
            id: 'user-session',
            type: 'userMessage',
            text: 'Use this session\n# Session Context\nchannel notes\n\n---\nReferenced entries:\n- /e/evt_1',
          },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 3,
        data: {
          type: 'item.completed',
          item: {
            id: 'user-plain',
            type: 'userMessage',
            text: 'Leave this alone.',
          },
        },
      },
    ]);

    expect(state.items).toEqual([
      expect.objectContaining({ type: 'user_message', id: 'user-ref', text: 'Use this entry' }),
      expect.objectContaining({ type: 'user_message', id: 'user-session', text: 'Use this session' }),
      expect.objectContaining({ type: 'user_message', id: 'user-plain', text: 'Leave this alone.' }),
    ]);
  });

  it('accumulates reasoning text and summary deltas by itemId', () => {
    const state = reduceAll([
      {
        event: 'amp_raw_event',
        event_id: 1,
        data: {
          method: 'item/reasoning/textDelta',
          params: { itemId: 'reason-1', delta: 'First ' },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 2,
        data: {
          method: 'item/reasoning/textDelta',
          params: { itemId: 'reason-1', delta: 'thought.' },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 3,
        data: {
          method: 'item/reasoning/summaryTextDelta',
          params: { itemId: 'reason-1', delta: 'Summary ' },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 4,
        data: {
          method: 'item/reasoning/summaryTextDelta',
          params: { itemId: 'reason-1', delta: 'text.' },
        },
      },
    ]);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      type: 'reasoning',
      id: 'reasoning:reason-1',
      messageId: 'reason-1',
      text: 'First thought.',
      summary: 'Summary text.',
      sourceEventIds: [1, 2, 3, 4],
    });
  });

  it('folds completed Codex reasoning items', () => {
    const state = reduceAll([
      {
        event: 'amp_raw_event',
        event_id: 10,
        data: {
          type: 'item.completed',
          item: {
            id: 'reason-2',
            type: 'reasoning',
            content: [{ type: 'text', text: 'Codex reasoning.', text_elements: [] }],
          },
        },
      },
    ]);

    expect(state.items).toEqual([
      expect.objectContaining({
        type: 'reasoning',
        id: 'reasoning:reason-2',
        messageId: 'reason-2',
        text: 'Codex reasoning.',
        sourceEventIds: [10],
      }),
    ]);
  });

  it('replaces todos from TodoWrite and sets plan from ExitPlanMode', () => {
    const state = reduceAll([
      {
        event: 'amp_raw_event',
        event_id: 20,
        data: {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'todo-1',
                name: 'TodoWrite',
                input: {
                  todos: [
                    { content: 'Draft', status: 'pending' },
                    { content: 'Build', activeForm: 'Building', status: 'in_progress' },
                  ],
                },
              },
            ],
          },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 21,
        data: {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'todo-2',
                name: 'TodoWrite',
                input: {
                  todos: [{ content: 'Verify', status: 'completed' }],
                },
              },
            ],
          },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 22,
        data: {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'plan-1',
                name: 'ExitPlanMode',
                input: { plan: '1. Build shared state\n2. Test it' },
              },
            ],
          },
        },
      },
    ]);

    expect(state.todos).toEqual([{ content: 'Verify', status: 'completed' }]);
    expect(state.plan).toEqual({
      text: '1. Build shared state\n2. Test it',
      sourceEventIds: [22],
    });
    expect(state.items.filter((item) => item.type === 'tool_call')).toHaveLength(3);
  });

  it('feeds todos from a turn/plan/updated snapshot (codex + projected Claude)', () => {
    const state = reduceAll([
      {
        event: 'amp_raw_event',
        event_id: 40,
        data: {
          method: 'turn/plan/updated',
          params: {
            threadId: 'T-1',
            turnId: 'turn-1',
            explanation: 'Working the plan',
            plan: [
              { step: 'Read the code', status: 'completed' },
              { step: 'Write the fix', status: 'inProgress' },
              { step: 'Run tests', status: 'pending' },
            ],
          },
        },
      },
    ]);

    expect(state.todos).toEqual([
      { content: 'Read the code', status: 'completed' },
      { content: 'Write the fix', status: 'in_progress' },
      { content: 'Run tests', status: 'pending' },
    ]);
  });

  it('replaces todos wholesale on each turn/plan/updated snapshot (latest wins)', () => {
    const state = reduceAll([
      {
        event: 'amp_raw_event',
        event_id: 41,
        data: {
          method: 'turn/plan/updated',
          params: {
            turnId: 'turn-1',
            plan: [
              { step: 'Step A', status: 'inProgress' },
              { step: 'Step B', status: 'pending' },
            ],
          },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 42,
        data: {
          method: 'turn/plan/updated',
          params: {
            turnId: 'turn-1',
            plan: [{ step: 'Step A', status: 'completed' }],
          },
        },
      },
    ]);

    expect(state.todos).toEqual([{ content: 'Step A', status: 'completed' }]);
  });

  it('streams item/plan/delta into the freeform plan text then a completed plan replaces it', () => {
    const streamed = reduceAll([
      {
        event: 'amp_raw_event',
        event_id: 50,
        data: { method: 'item/plan/delta', params: { itemId: 'plan-9', delta: '1. Do this\n' } },
      },
      {
        event: 'amp_raw_event',
        event_id: 51,
        data: { method: 'item/plan/delta', params: { itemId: 'plan-9', delta: '2. Then that' } },
      },
    ]);
    expect(streamed.plan).toEqual({ text: '1. Do this\n2. Then that', sourceEventIds: [50, 51] });

    const completed = reduceSession(streamed, {
      event: 'amp_raw_event',
      event_id: 52,
      data: {
        type: 'item.completed',
        item: { id: 'plan-9', type: 'plan', text: '1. Do this\n2. Then that\n3. Finally' },
      },
    } as CentaurEventFrame);
    expect(completed.plan).toEqual({ text: '1. Do this\n2. Then that\n3. Finally', sourceEventIds: [52] });
  });

  it('sets plan from completed Codex plan items', () => {
    const state = reduceAll([
      {
        event: 'amp_raw_event',
        event_id: 30,
        data: {
          type: 'item.completed',
          item: {
            id: 'plan-2',
            type: 'plan',
            text: 'Codex plan',
          },
        },
      },
    ]);

    expect(state.plan).toEqual({ text: 'Codex plan', sourceEventIds: [30] });
  });

  it('folds a webSearch item into a web-search tool step', () => {
    const state = reduceAll([
      {
        event: 'amp_raw_event',
        event_id: 60,
        data: {
          type: 'item.completed',
          item: { id: 'ws-1', type: 'webSearch', query: 'atrium plan pipeline', action: null },
        },
      },
    ]);
    const tool = state.items.find((item) => item.type === 'tool_call');
    expect(tool).toMatchObject({ type: 'tool_call', name: 'web-search', input: { query: 'atrium plan pipeline' } });
    expect(tool?.type === 'tool_call' && tool.result).toEqual({ content: '', is_error: false });
  });

  it('folds an imageView item into a view-image step carrying the path', () => {
    const state = reduceAll([
      {
        event: 'amp_raw_event',
        event_id: 61,
        data: {
          type: 'item.completed',
          item: { id: 'iv-1', type: 'imageView', path: '/home/agent/repo/diagram.png' },
        },
      },
    ]);
    const tool = state.items.find((item) => item.type === 'tool_call');
    expect(tool).toMatchObject({
      type: 'tool_call',
      name: 'view-image',
      input: { path: '/home/agent/repo/diagram.png' },
    });
  });

  it('folds review-mode enter/exit into quiet notice markers, deduped across started/completed', () => {
    const state = reduceAll([
      {
        event: 'amp_raw_event',
        event_id: 70,
        data: { type: 'item.started', item: { id: 'rev-1', type: 'enteredReviewMode', review: 'Reviewing the diff' } },
      },
      {
        event: 'amp_raw_event',
        event_id: 71,
        data: {
          type: 'item.completed',
          item: { id: 'rev-1', type: 'enteredReviewMode', review: 'Reviewing the diff' },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 72,
        data: { type: 'item.completed', item: { id: 'rev-2', type: 'exitedReviewMode', review: 'Reviewing the diff' } },
      },
    ]);
    const notices = state.items.filter((item) => item.type === 'notice');
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({ type: 'notice', notice: 'review_started', text: 'Reviewing the diff' });
    expect(notices[0]?.sourceEventIds).toEqual([70, 71]);
    expect(notices[1]).toMatchObject({ type: 'notice', notice: 'review_ended' });
  });

  it('folds a contextCompaction item into a context_compacted notice', () => {
    const state = reduceAll([
      {
        event: 'amp_raw_event',
        event_id: 80,
        data: { type: 'item.completed', item: { id: 'cc-1', type: 'contextCompaction' } },
      },
    ]);
    const notice = state.items.find((item) => item.type === 'notice');
    expect(notice).toMatchObject({ type: 'notice', notice: 'context_compacted' });
    expect(notice?.type === 'notice' && notice.text).toBeUndefined();
  });

  it('records thread/name/updated into state and a single deduped notice row (latest name wins)', () => {
    const state = reduceAll([
      {
        event: 'amp_raw_event',
        event_id: 90,
        data: { method: 'thread/name/updated', params: { threadId: 'T-1', threadName: 'Draft the plan' } },
      },
      {
        event: 'amp_raw_event',
        event_id: 91,
        data: { method: 'thread/name/updated', params: { threadId: 'T-1', threadName: 'Ship the plan pipeline' } },
      },
    ]);
    expect(state.threadName).toBe('Ship the plan pipeline');
    const notices = state.items.filter((item) => item.type === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: 'notice', notice: 'thread_named', text: 'Ship the plan pipeline' });
    expect(notices[0]?.sourceEventIds).toEqual([90, 91]);
  });
});
