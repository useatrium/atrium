// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CriticMarkupText } from '../src/components/CriticMarkupText';
import { renderWithTheme } from './rnTestUtils';

afterEach(cleanup);

describe('CriticMarkupText (mobile)', () => {
  it('renders prefixed standalone comment authors as a distinct chip plus note text', () => {
    renderWithTheme(<CriticMarkupText text="{>>@ada_1-dev: Please revise this note.<<}" />);

    const author = screen.getByText('@ada_1-dev');
    expect(author).toBeInTheDocument();
    expect(author).toHaveStyle({ fontWeight: '800' });
    expect(screen.getByText('Please revise this note.')).toBeInTheDocument();
    expect(screen.queryByText('@ada_1-dev: Please revise this note.')).toBeNull();
  });

  it('leaves unprefixed comments unchanged', () => {
    renderWithTheme(<CriticMarkupText text="{>>Please revise this note.<<}" />);

    const note = screen.getByText('Please revise this note.');
    expect(note).toBeInTheDocument();
    expect(note.textContent).toBe('Please revise this note.');
    expect(screen.queryByText('@ada_1-dev')).toBeNull();
  });

  it('renders prefixed highlight-note authors as a distinct chip plus note text', () => {
    renderWithTheme(<CriticMarkupText text="Keep {==this claim==}{>>@riley: Needs source.<<}." />);

    expect(screen.getByText('this claim')).toBeInTheDocument();
    expect(screen.getByText('@riley')).toHaveStyle({ fontWeight: '800' });
    expect(screen.getByText('Needs source.')).toBeInTheDocument();
    expect(screen.queryByText('@riley: Needs source.')).toBeNull();
  });

  it('renders prefixed block-comment authors as a distinct chip plus note text', () => {
    renderWithTheme(
      <CriticMarkupText text={'{==```ts\nconst value = 1;\n```==}{>>@block-author: Check the block.<<}'} />,
    );

    expect(screen.getByText('const value = 1;')).toBeInTheDocument();
    expect(screen.getByText('@block-author')).toHaveStyle({ fontWeight: '800' });
    expect(screen.getByText('Check the block.')).toBeInTheDocument();
    expect(screen.queryByText('@block-author: Check the block.')).toBeNull();
  });
});
