import { describe, expect, it } from 'vitest';
import { looksLikeSummonSigil, parseSummonSigil } from '../src/spawnTrigger';

describe('composer summon sigil', () => {
  it('detects the sigil only at the start and extracts a non-empty task', () => {
    expect(looksLikeSummonSigil('!!')).toBe(true);
    expect(looksLikeSummonSigil('!!fix tests')).toBe(true);
    expect(looksLikeSummonSigil(' !!fix tests')).toBe(false);

    expect(parseSummonSigil('!! fix tests')).toEqual({ task: 'fix tests' });
    expect(parseSummonSigil('!!fix tests')).toEqual({ task: 'fix tests' });
    expect(parseSummonSigil('!!   fix tests   ')).toEqual({ task: 'fix tests' });
    expect(parseSummonSigil('!!')).toBeNull();
    expect(parseSummonSigil('!!   ')).toBeNull();
    expect(parseSummonSigil('@agent fix tests')).toBeNull();
  });
});
