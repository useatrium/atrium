import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizePrefs, type UserPrefs } from '@atrium/surface-client';

export const PREFS_STORAGE_KEY = 'atrium.prefs.v1';

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
