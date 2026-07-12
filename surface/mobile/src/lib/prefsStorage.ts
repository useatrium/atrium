import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizePrefs, type UserPrefs } from '@atrium/surface-client';

export const PREFS_STORAGE_KEY = 'atrium.prefs.v1';
export const TRANSCRIPT_VIEW_STORAGE_KEY = 'atrium.prefs.transcript-view.v1';
export type TranscriptView = 'focus' | 'full';

export async function loadTranscriptView(): Promise<TranscriptView> {
  return (await AsyncStorage.getItem(TRANSCRIPT_VIEW_STORAGE_KEY)) === 'full' ? 'full' : 'focus';
}

export async function persistTranscriptView(view: TranscriptView): Promise<void> {
  await AsyncStorage.setItem(TRANSCRIPT_VIEW_STORAGE_KEY, view);
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
