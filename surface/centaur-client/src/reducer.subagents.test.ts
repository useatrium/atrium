import { describe, expect, it } from 'vitest';
import { initialSessionState, parseSubagentId, reduceSession, type SessionState } from './reducer.js';
import type { CentaurEventFrame } from './types.js';

const reduceAll = (frames: CentaurEventFrame[]): SessionState =>
  frames.reduce((state, frame) => reduceSession(state, frame), initialSessionState());

const itemFrame = (eventId: number, method: 'item/started' | 'item/completed', item: object): CentaurEventFrame =>
  ({ event: 'amp_raw_event', event_id: eventId, data: { method, params: { item } } }) as CentaurEventFrame;

const taskArgs = { subagent_type: 'Explore', description: 'map the seam' };

describe('parseSubagentId', () => {
  it('parses a namespaced id into parent and child', () => {
    expect(parseSubagentId('sub~toolu_task1~toolu_b')).toEqual({ parentId: 'toolu_task1', childId: 'toolu_b' });
  });

  it('keeps later ~ separators inside the child id', () => {
    expect(parseSubagentId('sub~toolu_task1~msg_1-reasoning-0')).toEqual({
      parentId: 'toolu_task1',
      childId: 'msg_1-reasoning-0',
    });
  });

  it('rejects ordinary and malformed ids', () => {
    expect(parseSubagentId('toolu_b')).toBeNull();
    expect(parseSubagentId('sub~toolu_task1')).toBeNull();
    expect(parseSubagentId('sub~~child')).toBeNull();
    expect(parseSubagentId(undefined)).toBeNull();
  });
});

describe('subagent frame routing', () => {
  it('diverts subagent items out of the main transcript, keyed by parent', () => {
    const state = reduceAll([
      itemFrame(1, 'item/started', {
        id: 'toolu_task1',
        type: 'dynamicToolCall',
        tool: 'Task',
        arguments: taskArgs,
        status: 'inProgress',
      }),
      itemFrame(2, 'item/started', {
        id: 'sub~toolu_task1~toolu_b',
        type: 'commandExecution',
        command: 'ls',
        status: 'inProgress',
      }),
      itemFrame(3, 'item/completed', {
        id: 'sub~toolu_task1~toolu_b',
        type: 'commandExecution',
        command: 'ls',
        aggregatedOutput: 'a\nb\n',
        exitCode: 0,
      }),
    ]);

    // The parent Task stays in the transcript; the subagent's command does not.
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ type: 'tool_call', name: 'Task' });

    const group = state.subagents?.toolu_task1;
    expect(group?.items).toHaveLength(1);
    expect(group?.items[0]).toMatchObject({ type: 'tool_call', result: { content: 'a\nb\n', is_error: false } });
  });

  it('never lets a subagent TodoWrite pollute the parent turn aggregates', () => {
    const state = reduceAll([
      itemFrame(1, 'item/started', {
        id: 'toolu_task1',
        type: 'dynamicToolCall',
        tool: 'Task',
        arguments: taskArgs,
        status: 'inProgress',
      }),
      itemFrame(2, 'item/completed', {
        id: 'sub~toolu_task1~toolu_todo',
        type: 'dynamicToolCall',
        tool: 'TodoWrite',
        arguments: { todos: [{ content: 'inner todo', status: 'pending' }] },
        status: 'completed',
        success: true,
      }),
    ]);

    // The subagent's TodoWrite side effect landed in the throwaway scratch, not
    // the parent's todos.
    expect(state.todos).toBeUndefined();
    expect(state.subagents?.toolu_task1.items).toHaveLength(1);
  });

  it('keeps parallel subagents in separate streams', () => {
    const state = reduceAll([
      itemFrame(1, 'item/started', {
        id: 'toolu_a',
        type: 'dynamicToolCall',
        tool: 'Task',
        arguments: taskArgs,
        status: 'inProgress',
      }),
      itemFrame(2, 'item/started', {
        id: 'toolu_b',
        type: 'dynamicToolCall',
        tool: 'Task',
        arguments: taskArgs,
        status: 'inProgress',
      }),
      itemFrame(3, 'item/completed', {
        id: 'sub~toolu_a~toolu_r',
        type: 'dynamicToolCall',
        tool: 'Read',
        arguments: { file_path: 'a' },
        status: 'completed',
        success: true,
      }),
      itemFrame(4, 'item/completed', {
        id: 'sub~toolu_b~toolu_r',
        type: 'dynamicToolCall',
        tool: 'Read',
        arguments: { file_path: 'b' },
        status: 'completed',
        success: true,
      }),
    ]);

    expect(state.subagents?.toolu_a.items).toHaveLength(1);
    expect(state.subagents?.toolu_b.items).toHaveLength(1);
    expect(state.subagents?.toolu_a.items[0]).toMatchObject({ input: { file_path: 'a' } });
    expect(state.subagents?.toolu_b.items[0]).toMatchObject({ input: { file_path: 'b' } });
  });

  it('does not mutate the prior state (immutable reducer)', () => {
    const started = reduceSession(
      initialSessionState(),
      itemFrame(1, 'item/started', {
        id: 'toolu_task1',
        type: 'dynamicToolCall',
        tool: 'Task',
        arguments: taskArgs,
        status: 'inProgress',
      }),
    );
    const before = started.subagents;
    reduceSession(
      started,
      itemFrame(2, 'item/started', {
        id: 'sub~toolu_task1~toolu_b',
        type: 'commandExecution',
        command: 'ls',
        status: 'inProgress',
      }),
    );
    // The first state's subagents reference is unchanged by the later reduction.
    expect(started.subagents).toBe(before);
  });
});
