import { describe, expect, it } from 'vitest';
import { toolDisplay, type ToolDescriptor } from './toolDisplay.js';
import type { ToolCallItem } from './reducer.js';

const tool = (name: string, input: ToolCallItem['input'] = {}): ToolCallItem => ({
  type: 'tool_call',
  id: `tool:${name}`,
  name,
  input,
  sourceEventIds: [1],
});

const expectDescriptor = (descriptor: ToolDescriptor, expected: Partial<ToolDescriptor>): void => {
  expect(descriptor).toEqual(expect.objectContaining({ defaultExpanded: false, ...expected }));
};

describe('toolDisplay', () => {
  it('maps Bash to a command descriptor', () => {
    expectDescriptor(toolDisplay(tool('Bash', { command: 'pnpm test\npnpm build' })), {
      kind: 'command',
      title: 'pnpm test',
      language: 'bash',
    });
  });

  it('maps Codex command tools using input.command', () => {
    expectDescriptor(toolDisplay(tool('command', { command: 'pwd' })), {
      kind: 'command',
      title: 'pwd',
      language: 'bash',
    });
  });

  it('maps Read to a read descriptor', () => {
    expectDescriptor(toolDisplay(tool('Read', { file_path: 'src/reducer.ts' })), {
      kind: 'read',
      title: 'Read',
      subtitle: 'src/reducer.ts',
    });
  });

  it('maps Grep to a search descriptor', () => {
    expectDescriptor(toolDisplay(tool('Grep', { pattern: 'ReasoningItem', path: 'src' })), {
      kind: 'search',
      title: 'Grep',
      subtitle: 'ReasoningItem',
    });
  });

  it('maps Edit to a file-edit descriptor', () => {
    expectDescriptor(toolDisplay(tool('Edit', { path: 'src/types.ts' })), {
      kind: 'file-edit',
      title: 'Edit',
      subtitle: 'src/types.ts',
    });
  });

  it('maps TodoWrite to a todo descriptor', () => {
    expectDescriptor(toolDisplay(tool('TodoWrite')), {
      kind: 'todo',
      title: 'TodoWrite',
    });
  });

  it('maps unknown tools to generic descriptors', () => {
    expectDescriptor(toolDisplay(tool('CustomTool')), {
      kind: 'generic',
      title: 'CustomTool',
    });
  });
});
