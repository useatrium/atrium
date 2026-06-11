import { describe, expect, it } from 'vitest';
import { initials } from '../src/util.js';

describe('initials', () => {
  it('keeps existing plain-name behavior', () => {
    expect(initials('alice')).toBe('AL');
    expect(initials('Gary Basin')).toBe('GB');
  });

  it('strips leading punctuation from each name part', () => {
    expect(initials('Gary (mobile)')).toBe('GM');
    expect(initials('(bot) helper')).toBe('BH');
  });

  it('falls back for names with no letters or digits', () => {
    expect(initials('???')).toBe('?');
  });
});
