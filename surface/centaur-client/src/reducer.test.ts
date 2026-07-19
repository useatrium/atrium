import { describe, expect, it } from 'vitest';
import { initialSessionState, reduceSession, type SessionState, type ToolCallItem } from './reducer.js';
import type { CentaurEventFrame } from './types.js';

const reduceAll = (frames: CentaurEventFrame[]): SessionState =>
  frames.reduce((state, frame) => reduceSession(state, frame), initialSessionState());

const toolCalls = (state: SessionState): ToolCallItem[] =>
  state.items.filter((item): item is ToolCallItem => item.type === 'tool_call');

describe('Codex command execution', () => {
  it('uses aggregatedOutput from a completed command item', () => {
    const frame = {
      event: 'amp_raw_event',
      event_id: 1,
      data: {
        method: 'item/completed',
        params: {
          item: {
            id: 'cmd-1',
            type: 'commandExecution',
            command: 'printf hello',
            aggregatedOutput: 'hello\n',
            exitCode: 0,
          },
        },
      },
    } as CentaurEventFrame;

    const state = reduceSession(initialSessionState(), frame);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      type: 'tool_call',
      result: { content: 'hello\n', is_error: false },
    });
  });
});

describe('Codex dynamicToolCall items', () => {
  it('folds a completed Edit dynamicToolCall into a tool_call with args and result', () => {
    const state = reduceSession(initialSessionState(), {
      event: 'amp_raw_event',
      event_id: 5,
      data: {
        method: 'item/completed',
        params: {
          item: {
            id: 'dyn-edit',
            type: 'dynamicToolCall',
            namespace: null,
            tool: 'Edit',
            arguments: { file_path: 'src/reducer.ts', old_string: 'a', new_string: 'b' },
            status: 'completed',
            success: true,
            contentItems: [{ type: 'inputText', text: 'Applied edit to src/reducer.ts' }],
          },
        },
      },
    } as CentaurEventFrame);

    const calls = toolCalls(state);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      type: 'tool_call',
      name: 'Edit',
      input: { file_path: 'src/reducer.ts' },
      result: { content: 'Applied edit to src/reducer.ts', is_error: false },
    });
  });

  it('marks success:false dynamicToolCall results as errors', () => {
    const state = reduceSession(initialSessionState(), {
      event: 'amp_raw_event',
      event_id: 6,
      data: {
        method: 'item/completed',
        params: {
          item: {
            id: 'dyn-read',
            type: 'dynamicToolCall',
            tool: 'Read',
            arguments: { file_path: '/missing' },
            status: 'failed',
            success: false,
            contentItems: [{ type: 'inputText', text: 'File not found' }],
          },
        },
      },
    } as CentaurEventFrame);

    expect(toolCalls(state)[0]?.result).toEqual({ content: 'File not found', is_error: true });
  });

  it('transitions a started dynamicToolCall to completed on the same id', () => {
    const state = reduceAll([
      {
        event: 'amp_raw_event',
        event_id: 10,
        data: {
          method: 'item/started',
          params: {
            item: {
              id: 'dyn-web',
              type: 'dynamicToolCall',
              tool: 'WebSearch',
              arguments: { query: 'atrium' },
              status: 'inProgress',
            },
          },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 11,
        data: {
          method: 'item/completed',
          params: {
            item: {
              id: 'dyn-web',
              type: 'dynamicToolCall',
              tool: 'WebSearch',
              arguments: { query: 'atrium' },
              status: 'completed',
              success: true,
              contentItems: [{ type: 'inputText', text: '3 results' }],
            },
          },
        },
      },
    ] as CentaurEventFrame[]);

    const calls = toolCalls(state);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'WebSearch',
      input: { query: 'atrium' },
      result: { content: '3 results', is_error: false },
    });
    expect(calls[0]?.sourceEventIds).toEqual([10, 11]);
  });

  it('derives todos from a TodoWrite dynamicToolCall', () => {
    const state = reduceSession(initialSessionState(), {
      event: 'amp_raw_event',
      event_id: 20,
      data: {
        method: 'item/completed',
        params: {
          item: {
            id: 'dyn-todo',
            type: 'dynamicToolCall',
            tool: 'TodoWrite',
            arguments: {
              todos: [
                { content: 'Wire reducer', status: 'completed', activeForm: 'Wiring reducer' },
                { content: 'Add tests', status: 'in_progress', activeForm: 'Adding tests' },
              ],
            },
            status: 'completed',
            success: true,
            contentItems: [],
          },
        },
      },
    } as CentaurEventFrame);

    expect(state.todos).toEqual([
      { content: 'Wire reducer', status: 'completed', activeForm: 'Wiring reducer' },
      { content: 'Add tests', status: 'in_progress', activeForm: 'Adding tests' },
    ]);
  });

  it('tolerates null/malformed contentItems and arguments', () => {
    const state = reduceSession(initialSessionState(), {
      event: 'amp_raw_event',
      event_id: 30,
      data: {
        method: 'item/completed',
        params: {
          item: {
            id: 'dyn-weird',
            type: 'dynamicToolCall',
            tool: 'Task',
            arguments: null,
            status: 'completed',
            success: null,
            contentItems: [null, { type: 'inputImage', imageUrl: 'x' }, { type: 'inputText' }],
          },
        },
      },
    } as CentaurEventFrame);

    const calls = toolCalls(state);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'Task', input: {}, result: { content: '', is_error: false } });
  });
});

describe('Codex mcpToolCall items', () => {
  it('folds an mcpToolCall into an mcp-prefixed tool_call with joined result text', () => {
    const state = reduceSession(initialSessionState(), {
      event: 'amp_raw_event',
      event_id: 40,
      data: {
        method: 'item/completed',
        params: {
          item: {
            id: 'mcp-1',
            type: 'mcpToolCall',
            server: 'github',
            tool: 'search_issues',
            status: 'completed',
            arguments: { query: 'is:open' },
            result: {
              content: [
                { type: 'text', text: 'Issue 1' },
                { type: 'text', text: 'Issue 2' },
              ],
              structuredContent: null,
            },
            error: null,
          },
        },
      },
    } as CentaurEventFrame);

    const calls = toolCalls(state);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'mcp:github.search_issues',
      input: { query: 'is:open' },
      result: { content: 'Issue 1Issue 2', is_error: false },
    });
  });

  it('marks an mcpToolCall with an error object as failed', () => {
    const state = reduceSession(initialSessionState(), {
      event: 'amp_raw_event',
      event_id: 41,
      data: {
        method: 'item/completed',
        params: {
          item: {
            id: 'mcp-2',
            type: 'mcpToolCall',
            server: 'github',
            tool: 'create_issue',
            status: 'failed',
            arguments: {},
            result: null,
            error: { message: 'permission denied' },
          },
        },
      },
    } as CentaurEventFrame);

    expect(toolCalls(state)[0]).toMatchObject({
      name: 'mcp:github.create_issue',
      result: { content: 'permission denied', is_error: true },
    });
  });
});
