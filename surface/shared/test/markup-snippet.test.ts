import { describe, expect, it } from 'vitest';
import { plainMarkdownSnippet } from '../src/markup';

describe('plainMarkdownSnippet', () => {
  it('strips inline markup for one-line previews', () => {
    expect(plainMarkdownSnippet('hello **@me** with `code` and [docs](https://example.com)')).toBe(
      'hello @me with code and docs',
    );
  });

  it('compacts blocks and flattens whitespace', () => {
    expect(plainMarkdownSnippet('- item one\n- *emphasis* mid `x=1`')).toBe('item one emphasis mid x=1');
  });

  it('leaves plain text and bare asterisk math alone', () => {
    expect(plainMarkdownSnippet('plain text stays')).toBe('plain text stays');
    expect(plainMarkdownSnippet('2 * 3 * 4 = 24')).toBe('2 * 3 * 4 = 24');
  });
});
