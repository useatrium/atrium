import { describe, expect, it } from 'vitest';
import { lineDiffOps } from './textDiff';

describe('lineDiffOps', () => {
  it('preserves common lines around additions and removals', () => {
    expect(lineDiffOps('one\ntwo\nthree', 'one\nnew\nthree')).toEqual([
      { kind: 'context', text: 'one' },
      { kind: 'remove', text: 'two' },
      { kind: 'add', text: 'new' },
      { kind: 'context', text: 'three' },
    ]);
  });

  it('normalizes Windows line endings', () => {
    expect(lineDiffOps('one\r\ntwo', 'one\ntwo')).toEqual([
      { kind: 'context', text: 'one' },
      { kind: 'context', text: 'two' },
    ]);
  });
});
