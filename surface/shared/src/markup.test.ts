import { describe, expect, it } from 'vitest';
import { isStructuredTextForMarkup, splitMarkdownFrontmatter } from './markup';

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
