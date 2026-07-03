// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { Text } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageText } from '../src/components/MessageText';
import { renderWithTheme } from './rnTestUtils';

vi.mock('../src/components/Markdown', () => ({
  MarkdownText: ({ text }: { text: string }) => (
    <Text>
      {text
        .replace(/^#+\s+/gm, '')
        .replace(/\*\*/g, '')
        .replace(/`/g, '')}
    </Text>
  ),
}));

afterEach(cleanup);

describe('mobile MessageText', () => {
  it('renders through the markdown renderer', () => {
    renderWithTheme(
      <MessageText text={['## Plan', '', '- Ship **markdown** for @me', '', '`retry()`'].join('\n')} meHandle="me" />,
    );

    expect(screen.getByText(/Plan/)).toBeInTheDocument();
    expect(screen.getByText(/markdown/)).toBeInTheDocument();
    expect(screen.getByText(/@me/)).toBeInTheDocument();
    expect(screen.getByText(/retry\(\)/)).toBeInTheDocument();
  });

  it('collapses long markdown and can expand it', () => {
    renderWithTheme(<MessageText text={Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')} meHandle="me" />);

    fireEvent.click(screen.getByLabelText('Show more'));
    expect(screen.getByLabelText('Show less')).toBeInTheDocument();
  });
});
