// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Text } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownText } from '../src/components/Markdown';
import { renderWithTheme } from './rnTestUtils';

const setStringAsync = vi.fn(async (_value: string) => {});

vi.mock('expo-clipboard', () => ({
  setStringAsync: (value: string) => setStringAsync(value),
}));

vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(async () => {}),
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => <Text>{name}</Text>,
}));

vi.mock('react-native-markdown-display', () => {
  const MarkdownDisplay = ({
    children,
    rules,
  }: {
    children: string;
    rules: Record<string, (node: unknown) => unknown>;
  }) => {
    const match = /```([^\n]*)\n([\s\S]*?)```/.exec(children);
    if (!match) return <Text>{children}</Text>;
    const renderFence = rules.fence;
    if (!renderFence) return null;
    return renderFence({
      key: 'code-1',
      content: match[2],
      sourceInfo: match[1],
    });
  };
  const MarkdownIt = () => ({ use: () => ({ use: () => ({}) }) });
  return {
    default: MarkdownDisplay,
    MarkdownIt,
    renderRules: {},
  };
});

vi.mock('react-native-syntax-highlighter', () => ({
  default: ({ children }: { children: string }) => <Text>{children}</Text>,
}));

describe('mobile MarkdownText', () => {
  it('copies fenced code blocks from the copy control', async () => {
    renderWithTheme(<MarkdownText text={['```ts', 'const x = 1;', '```'].join('\n')} />);

    fireEvent.click(screen.getByLabelText('Copy code'));

    expect(setStringAsync).toHaveBeenCalledWith('const x = 1;');
    expect(await screen.findByLabelText('Copied code')).toBeInTheDocument();
  });
});
