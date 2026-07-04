// User preferences — the shared contract for theming and accessibility
// config across web, mobile, and server. The server stores prefs as a JSONB
// column and normalizes on read; clients normalize anything loaded from
// local storage so stale or foreign shapes degrade to defaults instead of
// crashing. Workers on all three surfaces build against this exact shape.

import { Option, Schema } from 'effect';

export const ThemeModeSchema = Schema.Literal('system', 'light', 'dark');
export type ThemeMode = Schema.Schema.Type<typeof ThemeModeSchema>;

export const MotionPrefSchema = Schema.Literal('system', 'reduced', 'full');
export type MotionPref = Schema.Schema.Type<typeof MotionPrefSchema>;

export const NotificationMessagePrefSchema = Schema.Literal('all', 'dm_mention', 'off');
export type NotificationMessagePref = Schema.Schema.Type<typeof NotificationMessagePrefSchema>;

export const ACCENTS = ['indigo', 'teal', 'amber', 'rose'] as const;
export const AccentSchema = Schema.Literal(...ACCENTS);
export type Accent = Schema.Schema.Type<typeof AccentSchema>;

/** Multipliers applied to the base type scale (web: root font-size). */
export const FONT_SCALES = [0.875, 1, 1.125, 1.25] as const;
export const FontScaleSchema = Schema.Literal(...FONT_SCALES);
export type FontScale = Schema.Schema.Type<typeof FontScaleSchema>;

export const NotificationPrefsSchema = Schema.Struct({
  messages: NotificationMessagePrefSchema,
  sessions: Schema.Boolean,
  calls: Schema.Boolean,
});

export interface NotificationPrefs {
  messages: NotificationMessagePref;
  sessions: boolean;
  calls: boolean;
}

export const UserPrefsSchema = Schema.Struct({
  theme: ThemeModeSchema,
  accent: AccentSchema,
  motion: MotionPrefSchema,
  fontScale: FontScaleSchema,
  highContrast: Schema.Boolean,
  notifications: NotificationPrefsSchema,
});

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

function objectRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function decodeOr<A>(schema: Schema.Schema<A>, input: unknown, fallback: A): A {
  const decoded = Schema.decodeUnknownOption(schema)(input);
  return Option.isSome(decoded) ? decoded.value : fallback;
}

export function normalizeNotificationPrefs(input: unknown): NotificationPrefs {
  const raw = objectRecord(input);
  return {
    messages: decodeOr(
      NotificationMessagePrefSchema,
      raw.messages,
      DEFAULT_PREFS.notifications.messages,
    ),
    sessions: decodeOr(Schema.Boolean, raw.sessions, DEFAULT_PREFS.notifications.sessions),
    calls: decodeOr(Schema.Boolean, raw.calls, DEFAULT_PREFS.notifications.calls),
  };
}

/** Coerce unknown input (JSONB column, localStorage, request body) into a
 * complete UserPrefs: unknown keys dropped, invalid values replaced by
 * defaults. Also serves as the PATCH merge: normalizePrefs({...stored,
 * ...patch}). */
export function normalizePrefs(input: unknown): UserPrefs {
  const raw = objectRecord(input);
  return {
    theme: decodeOr(ThemeModeSchema, raw.theme, DEFAULT_PREFS.theme),
    accent: decodeOr(AccentSchema, raw.accent, DEFAULT_PREFS.accent),
    motion: decodeOr(MotionPrefSchema, raw.motion, DEFAULT_PREFS.motion),
    fontScale: decodeOr(FontScaleSchema, raw.fontScale, DEFAULT_PREFS.fontScale),
    highContrast: decodeOr(Schema.Boolean, raw.highContrast, DEFAULT_PREFS.highContrast),
    notifications: normalizeNotificationPrefs(raw.notifications),
  };
}

export function normalizePrefsPatch(input: unknown): Partial<UserPrefs> {
  const raw = objectRecord(input);
  const patch: Partial<UserPrefs> = {};
  for (const key of Object.keys(DEFAULT_PREFS) as (keyof UserPrefs)[]) {
    const value = raw[key];
    if (key === 'notifications') {
      const normalized = normalizeNotificationPrefs(value);
      const notificationRaw = objectRecord(value) as Record<keyof NotificationPrefs, unknown>;
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
