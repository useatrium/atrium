import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizePrefs, type UserPrefs } from '@atrium/surface-client';

export const PREFS_STORAGE_KEY = 'atrium.prefs.v1';
export const TRANSCRIPT_VIEW_STORAGE_KEY = 'atrium.prefs.transcript-view.v1';
export const COLLAPSED_UNFURLS_STORAGE_KEY = 'unfurl.collapsed';
const COLLAPSED_UNFURLS_LIMIT = 500;
export type TranscriptView = 'focus' | 'full';

export async function loadTranscriptView(): Promise<TranscriptView> {
  return (await AsyncStorage.getItem(TRANSCRIPT_VIEW_STORAGE_KEY)) === 'full' ? 'full' : 'focus';
}

export async function persistTranscriptView(view: TranscriptView): Promise<void> {
  await AsyncStorage.setItem(TRANSCRIPT_VIEW_STORAGE_KEY, view);
}

export async function loadCollapsedUnfurls(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(COLLAPSED_UNFURLS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string').slice(-COLLAPSED_UNFURLS_LIMIT);
  } catch {
    return [];
  }
}

export async function persistCollapsedUnfurl(key: string, collapsed: boolean): Promise<void> {
  const stored = await loadCollapsedUnfurls();
  const next = stored.filter((value) => value !== key);
  if (collapsed) next.push(key);
  await AsyncStorage.setItem(COLLAPSED_UNFURLS_STORAGE_KEY, JSON.stringify(next.slice(-COLLAPSED_UNFURLS_LIMIT)));
}

export async function loadStoredPrefs(): Promise<UserPrefs> {
  const raw = await AsyncStorage.getItem(PREFS_STORAGE_KEY);
  if (!raw) return normalizePrefs(null);
  try {
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return normalizePrefs(null);
  }
}

export async function persistPrefs(prefs: UserPrefs): Promise<void> {
  await AsyncStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(normalizePrefs(prefs)));
}
