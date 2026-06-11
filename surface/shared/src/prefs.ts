// User preferences — the shared contract for theming and accessibility
// config across web, mobile, and server. The server stores prefs as a JSONB
// column and normalizes on read; clients normalize anything loaded from
// local storage so stale or foreign shapes degrade to defaults instead of
// crashing. Workers on all three surfaces build against this exact shape.

export type ThemeMode = 'system' | 'light' | 'dark';
export type MotionPref = 'system' | 'reduced' | 'full';

export const ACCENTS = ['indigo', 'teal', 'amber', 'rose'] as const;
export type Accent = (typeof ACCENTS)[number];

/** Multipliers applied to the base type scale (web: root font-size). */
export const FONT_SCALES = [0.875, 1, 1.125, 1.25] as const;
export type FontScale = (typeof FONT_SCALES)[number];

export interface UserPrefs {
  theme: ThemeMode;
  accent: Accent;
  motion: MotionPref;
  fontScale: FontScale;
  highContrast: boolean;
}

export const DEFAULT_PREFS: UserPrefs = {
  theme: 'system',
  accent: 'indigo',
  motion: 'system',
  fontScale: 1,
  highContrast: false,
};

const THEMES: readonly ThemeMode[] = ['system', 'light', 'dark'];
const MOTIONS: readonly MotionPref[] = ['system', 'reduced', 'full'];

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
  return out;
}
