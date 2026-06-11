import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS } from '@atrium/surface-client';
import { loadStoredPrefs, persistPrefs, PREFS_STORAGE_KEY } from '../src/lib/prefsStorage';

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
});
