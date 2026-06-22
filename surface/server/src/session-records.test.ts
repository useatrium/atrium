import { describe, expect, it } from 'vitest';
import type { CentaurEventFrame } from '@atrium/centaur-client';
import { projectFrames, redactText } from './session-records.js';

describe('redactText', () => {
  it('redacts common token shapes and high-entropy strings', () => {
    expect(redactText('OPENAI_API_KEY=sk-test-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456')).toBe(
      'OPENAI_API_KEY=[redacted]',
    );
    expect(redactText('digest 0123456789abcdef02468ace13579bdf')).toBe('digest [redacted]');
    expect(
      redactText(
        '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----',
      ),
    ).toBe('[redacted]');
  });
});

describe('projectFrames', () => {
  it('projects completed session items, tiers full-only records, dedups deltas, strips context, and redacts secrets', () => {
    const frames: CentaurEventFrame[] = [
      {
        event: 'amp_raw_event',
        event_id: 1,
        data: {
          type: 'item.completed',
          item: {
            id: 'u-1',
            type: 'userMessage',
            text:
              'Please run the check with sk-test-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456\n# Session Context\n\nhidden harness notes',
          },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 2,
        data: {
          method: 'item/agentMessage/delta',
          params: { itemId: 'a-1', delta: 'partial duplicate ' },
        } as unknown as Extract<CentaurEventFrame, { event: 'amp_raw_event' }>['data'],
      },
      {
        event: 'amp_raw_event',
        event_id: 3,
        data: {
          method: 'item/completed',
          params: { item: { id: 'a-1', type: 'agentMessage', text: 'Final agent answer.' } },
        } as unknown as Extract<CentaurEventFrame, { event: 'amp_raw_event' }>['data'],
      },
      {
        event: 'amp_raw_event',
        event_id: 4,
        data: {
          method: 'item/started',
          params: { item: { id: 'cmd-1', type: 'commandExecution', command: 'pwd' } },
        } as unknown as Extract<CentaurEventFrame, { event: 'amp_raw_event' }>['data'],
      },
      {
        event: 'amp_raw_event',
        event_id: 5,
        data: {
          method: 'item/commandExecution/outputDelta',
          params: { itemId: 'cmd-1', delta: 'delta output that should not project' },
        } as unknown as Extract<CentaurEventFrame, { event: 'amp_raw_event' }>['data'],
      },
      {
        event: 'amp_raw_event',
        event_id: 6,
        data: {
          method: 'item/completed',
          params: {
            item: {
              id: 'cmd-1',
              type: 'commandExecution',
              command: 'pwd',
              output: '/home/agent/workspace\n',
              exitCode: 0,
              status: 'completed',
            },
          },
        } as unknown as Extract<CentaurEventFrame, { event: 'amp_raw_event' }>['data'],
      },
      {
        event: 'amp_raw_event',
        event_id: 7,
        data: {
          type: 'item.completed',
          item: {
            id: 'fc-1',
            type: 'fileChange',
            changes: [
              {
                path: '/home/agent/workspace/src/app.ts',
                kind: 'update',
                diff: '@@\n-old\n+new',
              },
            ],
          },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 8,
        data: {
          type: 'item.completed',
          item: { id: 'r-1', type: 'reasoning', text: 'I should inspect the failing path.' },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 9,
        data: {
          type: 'item.completed',
          item: { id: 'p-1', type: 'plan', text: '1. Inspect\n2. Patch\n3. Test' },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 10,
        data: {
          type: 'assistant',
          uuid: 'tool-msg-1',
          message: {
            id: 'msg-tool-1',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'WebFetch',
                input: { url: 'https://example.test/docs' },
              },
            ],
          },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 11,
        data: {
          type: 'tool',
          content: [
            {
              tool_use_id: 'tool-1',
              content: 'Fetched docs',
              is_error: false,
            },
          ],
        },
      },
    ];

    const records = projectFrames(frames, { driver: 'codex' });
    const lean = records.filter((record) => record.viewTier === 'lean');
    const fullOnly = records.filter((record) => record.viewTier === 'full');

    expect(lean.map((record) => record.kind)).toEqual([
      'message',
      'message',
      'command',
      'file_change',
    ]);
    expect(fullOnly.map((record) => record.kind)).toEqual(['reasoning', 'plan', 'tool_call']);
    expect(records.map((record) => record.seq)).toEqual(records.map((_record, index) => index));

    const user = records.find((record) => record.actor === 'user');
    expect(user?.text).toContain('[redacted]');
    expect(user?.text).not.toContain('sk-test');
    expect(user?.text).not.toContain('# Session Context');

    const messages = records.filter((record) => record.kind === 'message');
    expect(messages).toHaveLength(2);
    expect(messages.map((record) => record.text).join('\n')).toContain('Final agent answer.');
    expect(messages.map((record) => record.text).join('\n')).not.toContain('partial duplicate');

    const command = records.find((record) => record.kind === 'command');
    expect(command?.text).toContain('$ pwd');
    expect(command?.text).toContain('/home/agent/workspace');
    expect(command?.text).not.toContain('delta output');

    const fileChange = records.find((record) => record.kind === 'file_change');
    expect(fileChange?.meta).toMatchObject({ path: 'src/app.ts', kind: 'update' });

    const toolCall = records.find((record) => record.kind === 'tool_call');
    expect(toolCall?.text).toContain('Tool: WebFetch');
    expect(toolCall?.text).toContain('Fetched docs');
  });
});
