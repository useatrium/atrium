// Central keyboard-shortcut registry + platform-aware formatting/matching.
//
// A "chord" is an ordered list of canonical tokens. Modifier tokens:
//   'Mod'  -> Cmd (⌘) on macOS, Ctrl elsewhere
//   'Shift', 'Alt'
// Non-modifier tokens are matched case-insensitively against KeyboardEvent.key:
//   'Enter', 'Escape', letters ('K'), '?', '/', 'ArrowUp', ...
//
// The registry is the single source of truth for the shortcuts cheatsheet
// (ShortcutsHelp) and for the shortcut hints shown inside tooltips. Wire actual
// key handling with `matchesChord` so behavior and documentation never drift.

export type ChordToken = 'Mod' | 'Shift' | 'Alt' | (string & {});

export type Chord = ChordToken[];

export interface ShortcutDef {
  /** Stable id used as a React key and for lookups. */
  id: string;
  /** Canonical chord tokens. */
  keys: Chord;
  /** Human-readable description shown in the cheatsheet. */
  label: string;
  /** Cheatsheet grouping. */
  group: 'General' | 'Navigation' | 'Composer' | 'Sessions';
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform =
    // navigator.userAgentData is not in older TS DOM libs
    (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent ??
    '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const MOD_SYMBOLS_MAC: Record<string, string> = {
  Mod: '⌘',
  Shift: '⇧',
  Alt: '⌥',
};
const MOD_SYMBOLS_OTHER: Record<string, string> = {
  Mod: 'Ctrl',
  Shift: 'Shift',
  Alt: 'Alt',
};

const KEY_SYMBOLS: Record<string, string> = {
  Enter: '⏎',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'Space',
  Space: 'Space',
};

/** Format a chord into display tokens (e.g. ['Mod','K'] -> ['⌘','K'] on mac). */
export function formatChord(keys: Chord, mac: boolean = isMacPlatform()): string[] {
  const mods = mac ? MOD_SYMBOLS_MAC : MOD_SYMBOLS_OTHER;
  return keys.map((k) => {
    if (k in mods) return mods[k]!;
    if (k in KEY_SYMBOLS) return KEY_SYMBOLS[k]!;
    return k.length === 1 ? k.toUpperCase() : k;
  });
}

/** Format a chord into a single display string (e.g. '⌘K' or 'Ctrl+K'). */
export function formatChordString(keys: Chord, mac: boolean = isMacPlatform()): string {
  const parts = formatChord(keys, mac);
  return mac ? parts.join('') : parts.join('+');
}

/**
 * True if a keydown event matches the chord.
 *
 * `Mod` matches EITHER Cmd or Ctrl, regardless of platform — so a shortcut
 * fires whether the user reaches for ⌘K (mac habit) or Ctrl+K (cross-platform
 * habit). This mirrors the app's long-standing `metaKey || ctrlKey` behavior;
 * the visible hint still shows the platform-preferred key via `formatChord`.
 */
export function matchesChord(event: KeyboardEvent, keys: Chord): boolean {
  const wantMod = keys.includes('Mod');
  const wantShift = keys.includes('Shift');
  const wantAlt = keys.includes('Alt');
  const modActive = event.metaKey || event.ctrlKey;
  if (modActive !== wantMod) return false;
  if (event.altKey !== wantAlt) return false;
  const main = keys.find((k) => k !== 'Mod' && k !== 'Shift' && k !== 'Alt');
  // Symbol keys (e.g. '?', which is Shift+'/') already encode shift in the
  // character, so don't enforce shift state for them unless explicitly asked.
  const isSymbolKey = !!main && main.length === 1 && !/[a-z0-9]/i.test(main);
  if (wantShift) {
    if (!event.shiftKey) return false;
  } else if (!isSymbolKey && event.shiftKey) {
    return false;
  }
  if (!main) return true;
  return event.key.toLowerCase() === main.toLowerCase();
}

export const SHORTCUTS = {
  commandPalette: {
    id: 'commandPalette',
    keys: ['Mod', 'K'],
    label: 'Open command palette',
    group: 'Navigation',
  },
  toggleAgentDock: {
    id: 'toggleAgentDock',
    keys: ['Mod', '.'],
    label: 'Toggle agent dock',
    group: 'Navigation',
  },
  shortcutsHelp: {
    id: 'shortcutsHelp',
    keys: ['?'],
    label: 'Show keyboard shortcuts',
    group: 'General',
  },
  closeOrCancel: {
    id: 'closeOrCancel',
    keys: ['Escape'],
    label: 'Close dialog or stop turn',
    group: 'General',
  },
  sendMessage: {
    id: 'sendMessage',
    keys: ['Enter'],
    label: 'Send message',
    group: 'Composer',
  },
  newline: {
    id: 'newline',
    keys: ['Shift', 'Enter'],
    label: 'Insert a new line',
    group: 'Composer',
  },
  editLastMessage: {
    id: 'editLastMessage',
    keys: ['ArrowUp'],
    label: 'Edit your last message (empty composer)',
    group: 'Composer',
  },
  toggleAgentMode: {
    id: 'toggleAgentMode',
    keys: ['Mod', 'J'],
    label: 'Toggle agent mode',
    group: 'Composer',
  },
  spawnSession: {
    id: 'spawnSession',
    keys: ['Mod', 'Enter'],
    label: 'Spawn session / submit task',
    group: 'Sessions',
  },
} satisfies Record<string, ShortcutDef>;

export type ShortcutId = keyof typeof SHORTCUTS;

const GROUP_ORDER: ShortcutDef['group'][] = ['General', 'Navigation', 'Composer', 'Sessions'];

/** Shortcuts grouped and ordered for the cheatsheet. */
export function groupedShortcuts(): { group: ShortcutDef['group']; items: ShortcutDef[] }[] {
  const all = Object.values(SHORTCUTS) as ShortcutDef[];
  return GROUP_ORDER.map((group) => ({
    group,
    items: all.filter((s) => s.group === group),
  })).filter((g) => g.items.length > 0);
}
