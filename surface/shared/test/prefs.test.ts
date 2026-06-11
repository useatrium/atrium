import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, normalizePrefs } from '../src/prefs';
import { userColor, userColorTokens } from '../src/util';

describe('normalizePrefs', () => {
  it('returns defaults for nullish/garbage input', () => {
    expect(normalizePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs('dark')).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs(42)).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs({})).toEqual(DEFAULT_PREFS);
  });

  it('keeps valid fields and drops invalid ones independently', () => {
    expect(
      normalizePrefs({ theme: 'light', accent: 'mauve', fontScale: 1.125 }),
    ).toEqual({ ...DEFAULT_PREFS, theme: 'light', fontScale: 1.125 });
    expect(normalizePrefs({ highContrast: true, motion: 'reduced' })).toEqual({
      ...DEFAULT_PREFS,
      highContrast: true,
      motion: 'reduced',
    });
  });

  it('rejects off-list numeric fontScale and unknown keys', () => {
    const out = normalizePrefs({ fontScale: 3, hacker: 'yes' });
    expect(out).toEqual(DEFAULT_PREFS);
    expect('hacker' in out).toBe(false);
  });

  it('acts as the PATCH merge: stored ∪ patch normalizes cleanly', () => {
    const stored = { theme: 'dark', accent: 'teal' };
    const patch = { theme: 'system', fontScale: 0.875 };
    expect(normalizePrefs({ ...stored, ...patch })).toEqual({
      ...DEFAULT_PREFS,
      theme: 'system',
      accent: 'teal',
      fontScale: 0.875,
    });
  });
});

describe('userColorTokens', () => {
  // Same luminance math as the implementation, derived independently from
  // the returned hsl() string so a formula typo can't self-validate.
  function contrastVsFg(bg: string, fg: string): number {
    const m = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(bg);
    if (!m) throw new Error(`unexpected bg format: ${bg}`);
    const [h, s, l] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const mm = l - c / 2;
    const rgb =
      h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
      : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    const lin = (v: number) => {
      const sv = v + mm;
      return sv <= 0.04045 ? sv / 12.92 : ((sv + 0.055) / 1.055) ** 2.4;
    };
    const lum = 0.2126 * lin(rgb[0]!) + 0.7152 * lin(rgb[1]!) + 0.0722 * lin(rgb[2]!);
    const fgLum = hexLuminance(fg);
    const [hi, lo] = lum > fgLum ? [lum, fgLum] : [fgLum, lum];
    return (hi + 0.05) / (lo + 0.05);
  }

  function hexLuminance(hex: string): number {
    const lin = (v: number) =>
      v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    const ch = (i: number) => lin(parseInt(hex.slice(i, i + 2), 16) / 255);
    return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
  }

  it('initials meet 4.5:1 on every hue in both schemes', () => {
    for (let i = 0; i < 360; i++) {
      const seed = `user-${i}`;
      for (const scheme of ['dark', 'light'] as const) {
        const { bg, fg } = userColorTokens(seed, scheme);
        expect(contrastVsFg(bg, fg), `${seed} ${scheme} ${bg}/${fg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('is deterministic and userColor stays the dark-scheme bg', () => {
    expect(userColorTokens('gary')).toEqual(userColorTokens('gary', 'dark'));
    expect(userColor('gary')).toBe(userColorTokens('gary', 'dark').bg);
  });
});
