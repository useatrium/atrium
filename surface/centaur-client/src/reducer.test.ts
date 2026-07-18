import { describe, expect, it } from 'vitest';
import { initialSessionState, reduceSession } from './reducer.js';
import type { CentaurEventFrame } from './types.js';

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
