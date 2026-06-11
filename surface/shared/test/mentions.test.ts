import { describe, expect, it } from 'vitest';
import { matchMentionPrefix } from '../src/mentions';

describe('matchMentionPrefix', () => {
  it('returns the trailing mention prefix', () => {
    expect(matchMentionPrefix('hello @al')).toEqual({ start: 6, prefix: 'al' });
    expect(matchMentionPrefix('@')).toEqual({ start: 0, prefix: '' });
    expect(matchMentionPrefix('ask @agent')).toEqual({ start: 4, prefix: 'agent' });
  });

  it('dismisses when the text no longer ends in a mention prefix', () => {
    expect(matchMentionPrefix('hello @al ')).toBeNull();
    expect(matchMentionPrefix('hello @al!')).toBeNull();
    expect(matchMentionPrefix('hello @a.b')).toBeNull();
    expect(matchMentionPrefix('hello')).toBeNull();
  });
});
