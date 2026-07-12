// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
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
  const coreRules: Array<(state: unknown) => void> = [];
  class Token {
    type: string;
    content = '';
    children = null;
    attrs: [string, string][] | null = null;
    constructor(type: string) {
      this.type = type;
    }
    attrSet() {}
    attrJoin() {}
  }
  const MarkdownDisplay = ({
    children,
    rules,
  }: {
    children: string;
    rules: Record<string, ((node: unknown, children?: unknown[]) => unknown) | undefined>;
  }) => {
    const match = /```([^\n]*)\n([\s\S]*?)```/.exec(children);
    if (!match) {
      const inline = new Token('inline');
      const codeMatch = /^`([\s\S]*)`$/.exec(children);
      const child = new Token(codeMatch ? 'code_inline' : 'text');
      child.content = codeMatch?.[1] ?? children;
      inline.children = [child] as never;
      const state = { tokens: [inline], Token };
      for (const rule of coreRules) rule(state);
      const rendered: unknown[] = [];
      const tokens = inline.children as unknown as Array<Token>;
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token) continue;
        if (token.type === 'link_open') {
          const href = token.attrs?.find(([name]) => name === 'href')?.[1] ?? '';
          const label = tokens[index + 1]?.content ?? '';
          const renderLink = rules.link;
          if (renderLink) {
            rendered.push(
              renderLink({ key: `link-${index}`, attributes: { href } }, [<Text key={`label-${index}`}>{label}</Text>]),
            );
          }
          index += 2;
        } else {
          rendered.push(<Text key={`text-${index}`}>{token.content}</Text>);
        }
      }
      return <>{rendered}</>;
    }
    const renderFence = rules.fence;
    if (!renderFence) return null;
    return renderFence({
      key: 'code-1',
      content: match[2],
      sourceInfo: match[1],
    });
  };
  const MarkdownIt = () => {
    const md = {
      core: {
        ruler: { after: (_after: string, _name: string, rule: (state: unknown) => void) => coreRules.push(rule) },
      },
      use: (plugin: (instance: unknown) => void) => {
        plugin(md);
        return md;
      },
    };
    return md;
  };
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

  it('renders stable-id, special, and legacy mentions while leaving code spans literal', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const resolveUser = (userId: string) =>
      userId === id ? { id, handle: 'riley', displayName: 'Riley Chen' } : undefined;
    renderWithTheme(
      <MarkdownText text={`Hi <@${id}> <!channel> @legacy`} meId={id} meHandle="legacy" resolveUser={resolveUser} />,
    );

    expect(screen.getByText('@Riley Chen')).toBeInTheDocument();
    expect(screen.getByText('@channel')).toBeInTheDocument();
    expect(screen.getByText('@legacy')).toBeInTheDocument();

    cleanup();
    renderWithTheme(<MarkdownText text={`\`<@${id}>\``} meId={id} resolveUser={resolveUser} />);
    expect(screen.getByText(`<@${id}>`)).toBeInTheDocument();
    expect(screen.queryByText('@Riley Chen')).not.toBeInTheDocument();
  });

  it('renders unresolved stable IDs as @unknown', () => {
    renderWithTheme(<MarkdownText text="<@123e4567-e89b-12d3-a456-426614174099>" resolveUser={() => undefined} />);
    expect(screen.getByText('@unknown')).toBeInTheDocument();
  });
});
