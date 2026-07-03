// User preferences — the shared contract for theming and accessibility
// config across web, mobile, and server. The server stores prefs as a JSONB
// column and normalizes on read; clients normalize anything loaded from
// local storage so stale or foreign shapes degrade to defaults instead of
// crashing. Workers on all three surfaces build against this exact shape.

export type ThemeMode = 'system' | 'light' | 'dark';
export type MotionPref = 'system' | 'reduced' | 'full';
export type NotificationMessagePref = 'all' | 'dm_mention' | 'off';

export const ACCENTS = ['indigo', 'teal', 'amber', 'rose'] as const;
export type Accent = (typeof ACCENTS)[number];

/** Multipliers applied to the base type scale (web: root font-size). */
export const FONT_SCALES = [0.875, 1, 1.125, 1.25] as const;
export type FontScale = (typeof FONT_SCALES)[number];

export interface NotificationPrefs {
  messages: NotificationMessagePref;
  sessions: boolean;
  calls: boolean;
}

export interface UserPrefs {
  theme: ThemeMode;
  accent: Accent;
  motion: MotionPref;
  fontScale: FontScale;
  highContrast: boolean;
  notifications: NotificationPrefs;
}

export const DEFAULT_PREFS: UserPrefs = {
  theme: 'system',
  accent: 'indigo',
  motion: 'system',
  fontScale: 1,
  highContrast: false,
  notifications: {
    messages: 'dm_mention',
    sessions: true,
    calls: true,
  },
};

const THEMES: readonly ThemeMode[] = ['system', 'light', 'dark'];
const MOTIONS: readonly MotionPref[] = ['system', 'reduced', 'full'];
const NOTIFICATION_MESSAGES: readonly NotificationMessagePref[] = ['all', 'dm_mention', 'off'];

export function normalizeNotificationPrefs(input: unknown): NotificationPrefs {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const out: NotificationPrefs = { ...DEFAULT_PREFS.notifications };
  if (NOTIFICATION_MESSAGES.includes(raw.messages as NotificationMessagePref))
    out.messages = raw.messages as NotificationMessagePref;
  if (typeof raw.sessions === 'boolean') out.sessions = raw.sessions;
  if (typeof raw.calls === 'boolean') out.calls = raw.calls;
  return out;
}

/** Coerce unknown input (JSONB column, localStorage, request body) into a
 * complete UserPrefs: unknown keys dropped, invalid values replaced by
 * defaults. Also serves as the PATCH merge: normalizePrefs({...stored,
 * ...patch}). */
export function normalizePrefs(input: unknown): UserPrefs {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const out: UserPrefs = { ...DEFAULT_PREFS };
  if (THEMES.includes(raw.theme as ThemeMode)) out.theme = raw.theme as ThemeMode;
  if (ACCENTS.includes(raw.accent as Accent)) out.accent = raw.accent as Accent;
  if (MOTIONS.includes(raw.motion as MotionPref)) out.motion = raw.motion as MotionPref;
  if (FONT_SCALES.includes(raw.fontScale as FontScale))
    out.fontScale = raw.fontScale as FontScale;
  if (typeof raw.highContrast === 'boolean') out.highContrast = raw.highContrast;
  out.notifications = normalizeNotificationPrefs(raw.notifications);
  return out;
}

export function normalizePrefsPatch(input: unknown): Partial<UserPrefs> {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const patch: Partial<UserPrefs> = {};
  for (const key of Object.keys(DEFAULT_PREFS) as (keyof UserPrefs)[]) {
    const value = raw[key];
    if (key === 'notifications') {
      const normalized = normalizeNotificationPrefs(value);
      const notificationRaw = (typeof value === 'object' && value !== null ? value : {}) as Record<
        keyof NotificationPrefs,
        unknown
      >;
      if (
        Object.is(normalized.messages, notificationRaw.messages) &&
        Object.is(normalized.sessions, notificationRaw.sessions) &&
        Object.is(normalized.calls, notificationRaw.calls)
      ) {
        patch.notifications = normalized;
      }
      continue;
    }
    if (Object.is(normalizePrefs({ [key]: value })[key], value)) {
      (patch as Record<keyof UserPrefs, UserPrefs[keyof UserPrefs]>)[key] =
        value as UserPrefs[keyof UserPrefs];
    }
  }
  return patch;
}
