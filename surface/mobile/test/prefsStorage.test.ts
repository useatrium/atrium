import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS } from '@atrium/surface-client';
import {
  COLLAPSED_UNFURLS_STORAGE_KEY,
  loadCollapsedUnfurls,
  loadStoredPrefs,
  loadTranscriptView,
  persistCollapsedUnfurl,
  persistPrefs,
  persistTranscriptView,
  PREFS_STORAGE_KEY,
  TRANSCRIPT_VIEW_STORAGE_KEY,
} from '../src/lib/prefsStorage';

const store = new Map<string, string>();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
  },
}));

describe('prefs storage', () => {
  beforeEach(() => {
    store.clear();
  });

  it('normalizes missing, invalid, and stale stored prefs on hydrate', async () => {
    await expect(loadStoredPrefs()).resolves.toEqual(DEFAULT_PREFS);

    store.set(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        theme: 'dark',
        accent: 'not-real',
        motion: 'reduced',
        fontScale: 999,
        highContrast: true,
        extra: 'ignored',
      }),
    );

    await expect(loadStoredPrefs()).resolves.toEqual({
      ...DEFAULT_PREFS,
      theme: 'dark',
      motion: 'reduced',
      highContrast: true,
    });

    store.set(PREFS_STORAGE_KEY, '{bad json');
    await expect(loadStoredPrefs()).resolves.toEqual(DEFAULT_PREFS);
  });

  it('persists normalized prefs JSON', async () => {
    await persistPrefs({
      ...DEFAULT_PREFS,
      theme: 'light',
      accent: 'teal',
      fontScale: 1.25,
    });

    expect(JSON.parse(store.get(PREFS_STORAGE_KEY)!)).toEqual({
      ...DEFAULT_PREFS,
      theme: 'light',
      accent: 'teal',
      fontScale: 1.25,
    });
  });

  it('defaults transcript view to focus and persists full view', async () => {
    await expect(loadTranscriptView()).resolves.toBe('focus');
    await persistTranscriptView('full');
    expect(store.get(TRANSCRIPT_VIEW_STORAGE_KEY)).toBe('full');
    await expect(loadTranscriptView()).resolves.toBe('full');
  });

  it('persists a bounded oldest-first list of collapsed unfurls', async () => {
    store.set(
      COLLAPSED_UNFURLS_STORAGE_KEY,
      JSON.stringify(Array.from({ length: 500 }, (_, index) => `1:evt_${index}`)),
    );

    await persistCollapsedUnfurl('1:evt_500', true);
    const stored = await loadCollapsedUnfurls();
    expect(stored).toHaveLength(500);
    expect(stored[0]).toBe('1:evt_1');
    expect(stored.at(-1)).toBe('1:evt_500');

    await persistCollapsedUnfurl('1:evt_250', false);
    await expect(loadCollapsedUnfurls()).resolves.not.toContain('1:evt_250');
  });
});
