import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';
import { DEFAULT_PREFS, mobilePalette, normalizePrefs, type Accent, type UserPrefs } from '@atrium/surface-client';
import { persistPrefs } from './prefsStorage';

export type ColorScheme = 'light' | 'dark';

export function buildColors(scheme: ColorScheme, accent: Accent, highContrast: boolean) {
  return {
    ...mobilePalette.schemeTokens[scheme],
    ...mobilePalette.accents[scheme][accent],
    ...(highContrast ? mobilePalette.highContrast[scheme] : null),
  };
}

export type Colors = ReturnType<typeof buildColors>;

const baseFont = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
} as const;

export type FontScale = Record<keyof typeof baseFont, number>;
export const font: FontScale = { ...baseFont };

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
} as const;

interface ThemeContextValue {
  colors: Colors;
  scheme: ColorScheme;
  prefs: UserPrefs;
  font: FontScale;
  reduceMotion: boolean;
  setPrefs: (prefs: Partial<UserPrefs> | UserPrefs | ((prev: UserPrefs) => UserPrefs)) => void;
  adoptPrefs: (prefs: UserPrefs) => void;
  registerPrefsPatcher: (patcher: ((patch: Partial<UserPrefs>) => Promise<void>) | null) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  children,
  initialPrefs = DEFAULT_PREFS,
}: {
  children: ReactNode;
  initialPrefs?: UserPrefs;
}) {
  const systemScheme = useColorScheme();
  const [systemReduceMotion, setSystemReduceMotion] = useState(false);
  const patcherRef = useRef<((patch: Partial<UserPrefs>) => Promise<void>) | null>(null);
  const [prefs, setPrefsState] = useState<UserPrefs>(() => normalizePrefs(initialPrefs));

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setSystemReduceMotion(enabled);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setSystemReduceMotion);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  const registerPrefsPatcher = useCallback((patcher: ((patch: Partial<UserPrefs>) => Promise<void>) | null) => {
    patcherRef.current = patcher;
  }, []);

  const adoptPrefs = useCallback((nextPrefs: UserPrefs) => {
    const normalized = normalizePrefs(nextPrefs);
    setPrefsState(normalized);
    void persistPrefs(normalized).catch((err: unknown) => {
      console.warn('failed to persist prefs', err);
    });
  }, []);

  const setPrefs = useCallback((update: Partial<UserPrefs> | UserPrefs | ((prev: UserPrefs) => UserPrefs)) => {
    setPrefsState((prev) => {
      const next = normalizePrefs(typeof update === 'function' ? update(prev) : { ...prev, ...update });
      const patch: Partial<UserPrefs> = {};
      for (const key of Object.keys(next) as (keyof UserPrefs)[]) {
        if (next[key] !== prev[key]) patch[key] = next[key] as never;
      }
      if (Object.keys(patch).length === 0) return prev;
      void persistPrefs(next).catch((err: unknown) => {
        console.warn('failed to persist prefs', err);
      });
      void patcherRef.current?.(patch).catch(() => {
        // Pref changes are local-first. Network/server-version failures keep
        // the local value; boot/login reconciliation below decides whether
        // it is safe to re-push instead of clobbering a newer remote.
      });
      return next;
    });
  }, []);

  const scheme: ColorScheme = prefs.theme === 'system' ? (systemScheme === 'light' ? 'light' : 'dark') : prefs.theme;
  const scaledFont = useMemo(
    () =>
      Object.fromEntries(Object.entries(baseFont).map(([key, value]) => [key, value * prefs.fontScale])) as FontScale,
    [prefs.fontScale],
  );
  Object.assign(font, scaledFont);
  const reduceMotion = prefs.motion === 'reduced' || (prefs.motion === 'system' && systemReduceMotion);
  const colors = useMemo(
    () => buildColors(scheme, prefs.accent, prefs.highContrast),
    [prefs.accent, prefs.highContrast, scheme],
  );
  const value = useMemo(
    () => ({
      colors,
      scheme,
      prefs,
      font: scaledFont,
      reduceMotion,
      setPrefs,
      adoptPrefs,
      registerPrefsPatcher,
    }),
    [adoptPrefs, colors, prefs, reduceMotion, registerPrefsPatcher, scaledFont, scheme, setPrefs],
  );
  return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
