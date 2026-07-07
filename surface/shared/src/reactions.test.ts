import { describe, expect, it } from 'vitest';
import {
  QUICK_REACTIONS,
  REACTION_EMOJI,
  REACTION_GROUPS,
  REACTION_KEYWORDS,
  searchReactions,
} from './reactions';

describe('reactions', () => {
  it('has a unique allowlist', () => {
    expect(new Set(REACTION_EMOJI).size).toBe(REACTION_EMOJI.length);
  });

  it('groups cover the allowlist exactly (guards drift)', () => {
    const grouped = REACTION_GROUPS.flatMap((g) => g.emojis);
    expect(new Set(grouped)).toEqual(new Set(REACTION_EMOJI));
    // no emoji appears in more than one group
    expect(grouped.length).toBe(REACTION_EMOJI.length);
  });

  it('quick reactions are all in the allowlist', () => {
    for (const emoji of QUICK_REACTIONS) {
      expect(REACTION_EMOJI).toContain(emoji);
    }
  });

  it('every allowlist emoji has search keywords', () => {
    for (const emoji of REACTION_EMOJI) {
      expect(REACTION_KEYWORDS[emoji]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('search matches keywords and returns allowlist members only', () => {
    expect(searchReactions('fire')).toContain('🔥');
    expect(searchReactions('rocket')).toContain('🚀');
    expect(searchReactions('bug')).toContain('🐛');
    expect(searchReactions('party')).toContain('🎉');
    const results = searchReactions('thumbs');
    expect(results).toContain('👍');
    expect(results.every((e) => (REACTION_EMOJI as readonly string[]).includes(e))).toBe(true);
  });

  it('empty query returns the full list', () => {
    expect(searchReactions('')).toHaveLength(REACTION_EMOJI.length);
    expect(searchReactions('   ')).toHaveLength(REACTION_EMOJI.length);
  });

  it('matches an emoji passed directly', () => {
    expect(searchReactions('🔥')).toEqual(['🔥']);
  });
});
