import { describe, expect, it } from 'vitest';
import { tokenizeMessage } from '../src/formatting';

describe('tokenizeMessage', () => {
  it('tokenizes fenced code blocks with and without language labels', () => {
    expect(tokenizeMessage('```ts\nconst x = 1;\n```\n```\nplain\n```')).toEqual([
      { kind: 'codeblock', lang: 'ts', code: 'const x = 1;' },
      { kind: 'text', text: '\n' },
      { kind: 'codeblock', lang: '', code: 'plain' },
    ]);
  });

  it('treats unterminated fences like ordinary web text', () => {
    expect(tokenizeMessage('before ```ts\nconst x = `value` @me')).toEqual([
      { kind: 'text', text: 'before ```ts\nconst x = ' },
      { kind: 'code', code: 'value' },
      { kind: 'text', text: ' ' },
      { kind: 'mention', handle: 'me' },
    ]);
  });

  it('does not tokenize mentions inside inline code', () => {
    expect(tokenizeMessage('hi `@agent` @gary')).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'code', code: '@agent' },
      { kind: 'text', text: ' ' },
      { kind: 'mention', handle: 'gary' },
    ]);
  });

  it('tokenizes stable-id and special wire mentions alongside legacy mentions', () => {
    expect(tokenizeMessage('Hi <@123E4567-E89B-12D3-A456-426614174000> <!channel> <!HERE> @legacy')).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'mentionId', userId: '123e4567-e89b-12d3-a456-426614174000' },
      { kind: 'text', text: ' ' },
      { kind: 'special', name: 'channel' },
      { kind: 'text', text: ' ' },
      { kind: 'special', name: 'here' },
      { kind: 'text', text: ' ' },
      { kind: 'mention', handle: 'legacy' },
    ]);
  });

  it('keeps wire tokens literal inside inline and fenced code', () => {
    expect(tokenizeMessage('`<@123e4567-e89b-12d3-a456-426614174000> <!here>` ```\n<!channel>\n```')).toEqual([
      { kind: 'code', code: '<@123e4567-e89b-12d3-a456-426614174000> <!here>' },
      { kind: 'text', text: ' ' },
      { kind: 'codeblock', lang: '', code: '<!channel>' },
    ]);
  });

  it('tokenizes links outside code and leaves links inside code alone', () => {
    expect(tokenizeMessage('see `https://example.com/a` https://example.com/b.')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'code', code: 'https://example.com/a' },
      { kind: 'text', text: ' ' },
      { kind: 'link', href: 'https://example.com/b' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('handles adjacent segments in precedence order', () => {
    expect(tokenizeMessage('@me`x`https://example.com```js\ny\n```@you')).toEqual([
      { kind: 'mention', handle: 'me' },
      { kind: 'code', code: 'x' },
      { kind: 'link', href: 'https://example.com' },
      { kind: 'codeblock', lang: 'js', code: 'y' },
      { kind: 'mention', handle: 'you' },
    ]);
  });
});
