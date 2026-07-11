import { describe, expect, it } from 'vitest';
import { compactMarkdownSource, isStructuredTextForMarkup, splitMarkdownFrontmatter } from './markup';

describe('compactMarkdownSource', () => {
  it('flattens block markdown while preserving the first line of fenced code', () => {
    expect(compactMarkdownSource('# Plan\n\n- [x] done\n- next\n\n```ts\nconst answer = 42;\nignored();\n```')).toBe(
      'Plan done next `const answer = 42;`',
    );
  });

  it('normalizes quotes, ordered lists, and whitespace', () => {
    expect(compactMarkdownSource('> quoted\n\n1. first\n2. second')).toBe('quoted first second');
  });
});

describe('isStructuredTextForMarkup', () => {
  it.each([
    ['two non-empty lines', 'First line\n\nSecond line', true],
    ['heading', '# Plan', true],
    ['dash list', '- item', true],
    ['numbered list', '1. item', true],
    ['blockquote', '> quoted', true],
    ['fence', '```ts\nconst x = 1;\n```', true],
    ['one plain line', 'Just a sentence.', false],
    ['blank padded one line', '\n  Just a sentence. \n', false],
  ])('%s', (_label, text, expected) => {
    expect(isStructuredTextForMarkup(text)).toBe(expected);
  });
});

describe('splitMarkdownFrontmatter', () => {
  it('splits frontmatter from the markdown body', () => {
    expect(splitMarkdownFrontmatter('---\ntitle: Result Notes\n---\n\n# Body\n')).toEqual({
      frontmatter: '---\ntitle: Result Notes\n---\n',
      body: '# Body\n',
    });
  });

  it('leaves plain markdown untouched', () => {
    expect(splitMarkdownFrontmatter('# Body')).toEqual({ frontmatter: '', body: '# Body' });
  });
});
