import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { DEFAULT_PREFS, type Accent, type UserPrefs } from '@atrium/surface-client';

export type ColorScheme = 'light' | 'dark';

const accentTokens = {
  dark: {
    indigo: { accent: '#818cf8', accentBg: 'rgba(129, 140, 248, 0.16)', onAccent: '#09090b' },
    teal: { accent: '#2dd4bf', accentBg: 'rgba(45, 212, 191, 0.14)', onAccent: '#09090b' },
    amber: { accent: '#fbbf24', accentBg: 'rgba(251, 191, 36, 0.14)', onAccent: '#09090b' },
    rose: { accent: '#fb7185', accentBg: 'rgba(251, 113, 133, 0.16)', onAccent: '#09090b' },
  },
  light: {
    indigo: { accent: '#4f46e5', accentBg: 'rgba(79, 70, 229, 0.11)', onAccent: '#ffffff' },
    teal: { accent: '#0f766e', accentBg: 'rgba(15, 118, 110, 0.1)', onAccent: '#ffffff' },
    amber: { accent: '#b45309', accentBg: 'rgba(180, 83, 9, 0.11)', onAccent: '#ffffff' },
    rose: { accent: '#be123c', accentBg: 'rgba(190, 18, 60, 0.1)', onAccent: '#ffffff' },
  },
} as const satisfies Record<ColorScheme, Record<Accent, { accent: string; accentBg: string; onAccent: string }>>;

const schemeTokens = {
  dark: {
    bg: '#09090b',
    bgElevated: '#18181b',
    bgInput: '#1f1f23',
    bgPressed: '#27272a',
    border: '#27272a',
    borderSoft: '#1c1c20',
    text: '#f4f4f5',
    textSecondary: '#a1a1aa',
    // #71717a (zinc-500) is 4.1:1 on bg — below AA; matches web's fg-muted bump.
    textMuted: '#8f8f98',
    textFaint: '#52525b',
    // red-500 leaves the white "@" at 3.85:1; red-600 clears 4.5 (parity with web).
    mention: '#dc2626',
    onMention: '#ffffff',
    danger: '#f87171',
    dangerSurface: 'rgba(127, 29, 29, 0.22)',
    dangerBorder: 'rgba(248, 113, 113, 0.55)',
    warning: '#fbbf24',
    warningSurface: 'rgba(120, 53, 15, 0.3)',
    warningBorder: 'rgba(146, 64, 14, 0.4)',
    online: '#34d399',
    codeAccent: '#fda4af',
    scrim: 'rgba(0, 0, 0, 0.55)',
    letterbox: '#000000',
    switchTrackOff: '#3f3f46',
    switchThumbOff: '#d4d4d8',
  },
  light: {
    bg: '#fafafa',
    bgElevated: '#ffffff',
    bgInput: '#ffffff',
    bgPressed: '#e4e4e7',
    border: '#d4d4d8',
    borderSoft: '#e4e4e7',
    text: '#18181b',
    textSecondary: '#3f3f46',
    textMuted: '#52525b',
    textFaint: '#71717a',
    mention: '#dc2626',
    onMention: '#ffffff',
    danger: '#dc2626',
    dangerSurface: 'rgba(254, 226, 226, 0.92)',
    dangerBorder: 'rgba(220, 38, 38, 0.5)',
    warning: '#b45309',
    warningSurface: 'rgba(254, 243, 199, 0.9)',
    warningBorder: 'rgba(180, 83, 9, 0.42)',
    online: '#047857',
    codeAccent: '#be123c',
    scrim: 'rgba(0, 0, 0, 0.45)',
    letterbox: '#000000',
    switchTrackOff: '#d4d4d8',
    switchThumbOff: '#ffffff',
  },
} as const;

const highContrastTokens = {
  dark: {
    textMuted: '#a1a1aa',
    textFaint: '#71717a',
    border: '#71717a',
    borderSoft: '#52525b',
  },
  light: {
    textMuted: '#3f3f46',
    textFaint: '#52525b',
    border: '#71717a',
    borderSoft: '#71717a',
  },
} as const;

export function buildColors(scheme: ColorScheme, accent: Accent, highContrast: boolean) {
  return {
    ...schemeTokens[scheme],
    ...accentTokens[scheme][accent],
    ...(highContrast ? highContrastTokens[scheme] : null),
  };
}

export type Colors = ReturnType<typeof buildColors>;

export const font = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
} as const;

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
  setPrefs: (prefs: UserPrefs | ((prev: UserPrefs) => UserPrefs)) => void;
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
  const [prefs, setPrefs] = useState<UserPrefs>(initialPrefs);
  const scheme: ColorScheme =
    prefs.theme === 'system' ? (systemScheme === 'light' ? 'light' : 'dark') : prefs.theme;
  const colors = useMemo(
    () => buildColors(scheme, prefs.accent, prefs.highContrast),
    [prefs.accent, prefs.highContrast, scheme],
  );
  const value = useMemo(
    () => ({ colors, scheme, prefs, setPrefs }),
    [colors, prefs, scheme],
  );
  return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
