import {
  ApiError,
  DEFAULT_PREFS,
  normalizePrefs,
  type UserPrefs,
} from '@atrium/surface-client';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';
import { showErrorToast } from './components/Toasts';

const PREFS_KEY = 'atrium:prefs';
const THEME_META: Record<'dark' | 'light', string> = {
  dark: '#09090b',
  light: '#fafafa',
};

type Scheme = 'dark' | 'light';
type ThemeContextValue = {
  prefs: UserPrefs;
  resolvedScheme: Scheme;
  setPrefs: (patch: Partial<UserPrefs>) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
let currentPrefs = loadPrefs();
let currentScheme = resolveScheme(currentPrefs);
const listeners = new Set<() => void>();

function canUseDom(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function safeStore(prefs: UserPrefs): void {
  if (!canUseDom()) return;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private-mode storage failures leave the in-memory pref active */
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function resolveScheme(prefs: UserPrefs): Scheme {
  if (prefs.theme === 'light' || prefs.theme === 'dark') return prefs.theme;
  if (!canUseDom()) return 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function syncThemeColor(scheme: Scheme): void {
  if (!canUseDom()) return;
  let meta = document.querySelector<HTMLMetaElement>("meta[name='theme-color']");
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = THEME_META[scheme];
}

export function loadPrefs(): UserPrefs {
  if (!canUseDom()) return DEFAULT_PREFS;
  try {
    return normalizePrefs(JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null'));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function applyPrefs(prefs: UserPrefs): Scheme {
  const resolved = resolveScheme(prefs);
  if (!canUseDom()) return resolved;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.accent = prefs.accent;
  if (prefs.highContrast) root.dataset.contrast = 'high';
  else delete root.dataset.contrast;
  if (prefs.motion === 'system') delete root.dataset.motion;
  else root.dataset.motion = prefs.motion;
  if (prefs.fontScale === 1) delete root.dataset.fontscale;
  else root.dataset.fontscale = String(prefs.fontScale);
  syncThemeColor(resolved);
  return resolved;
}

export function adoptPrefs(next: unknown): void {
  currentPrefs = normalizePrefs(next);
  currentScheme = applyPrefs(currentPrefs);
  safeStore(currentPrefs);
  notify();
}

function commitPrefs(next: UserPrefs): void {
  currentPrefs = next;
  currentScheme = applyPrefs(next);
  safeStore(next);
  notify();
}

applyPrefs(currentPrefs);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState(() => ({
    prefs: currentPrefs,
    resolvedScheme: currentScheme,
  }));

  useEffect(() => {
    const listener = () => setSnapshot({ prefs: currentPrefs, resolvedScheme: currentScheme });
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!canUseDom() || snapshot.prefs.theme !== 'system') return;
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const onChange = () => {
      currentScheme = applyPrefs(currentPrefs);
      notify();
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [snapshot.prefs.theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      ...snapshot,
      setPrefs: (patch) => {
        const next = normalizePrefs({ ...currentPrefs, ...patch });
        commitPrefs(next);
        void api.patchPrefs(patch).catch((err) => {
          if (err instanceof ApiError && err.status === 404) return;
          showErrorToast("Couldn't sync settings. Your local change was kept.");
        });
      },
    }),
    [snapshot],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
