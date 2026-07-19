import { describe, expect, it } from 'vitest';
import { formatChord, formatChordString, groupedShortcuts, matchesChord, SHORTCUTS } from './shortcuts';

describe('formatChord', () => {
  it('uses mac glyphs when mac=true', () => {
    expect(formatChord(['Mod', 'K'], true)).toEqual(['⌘', 'K']);
    expect(formatChord(['Shift', 'Enter'], true)).toEqual(['⇧', '⏎']);
    expect(formatChord(['Escape'], true)).toEqual(['Esc']);
  });

  it('uses word modifiers when mac=false', () => {
    expect(formatChord(['Mod', 'K'], false)).toEqual(['Ctrl', 'K']);
    expect(formatChord(['Alt', 'ArrowUp'], false)).toEqual(['Alt', '↑']);
  });

  it('joins into a display string per platform', () => {
    expect(formatChordString(['Mod', 'K'], true)).toBe('⌘K');
    expect(formatChordString(['Mod', 'K'], false)).toBe('Ctrl+K');
  });
});

describe('matchesChord', () => {
  const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: '', ...init }) as KeyboardEvent;

  it('matches Mod+K to EITHER Cmd or Ctrl (platform-agnostic)', () => {
    expect(matchesChord(ev({ metaKey: true, key: 'k' }), ['Mod', 'K'])).toBe(true);
    expect(matchesChord(ev({ ctrlKey: true, key: 'k' }), ['Mod', 'K'])).toBe(true);
    // no modifier -> no match
    expect(matchesChord(ev({ key: 'k' }), ['Mod', 'K'])).toBe(false);
  });

  it('requires exact modifier state', () => {
    // plain Enter must NOT match when a modifier is held
    expect(matchesChord(ev({ key: 'Enter' }), ['Enter'])).toBe(true);
    expect(matchesChord(ev({ shiftKey: true, key: 'Enter' }), ['Enter'])).toBe(false);
    expect(matchesChord(ev({ shiftKey: true, key: 'Enter' }), ['Shift', 'Enter'])).toBe(true);
    // a plain Enter chord must not fire when Cmd/Ctrl is held
    expect(matchesChord(ev({ metaKey: true, key: 'Enter' }), ['Enter'])).toBe(false);
  });

  it('matches the ? help shortcut regardless of shift (? is Shift+/)', () => {
    // Real keyboards report shiftKey=true when producing '?'; both must match.
    expect(matchesChord(ev({ key: '?', shiftKey: true }), SHORTCUTS.shortcutsHelp.keys)).toBe(true);
    expect(matchesChord(ev({ key: '?' }), SHORTCUTS.shortcutsHelp.keys)).toBe(true);
    // A modifier + ? should not trigger the bare help shortcut.
    expect(matchesChord(ev({ key: '?', metaKey: true }), SHORTCUTS.shortcutsHelp.keys)).toBe(false);
  });

  it('matches Mod+. (agent dock toggle) on either Cmd or Ctrl and not bare "."', () => {
    expect(SHORTCUTS.toggleAgentDock.keys).toEqual(['Mod', '.']);
    expect(matchesChord(ev({ metaKey: true, key: '.' }), SHORTCUTS.toggleAgentDock.keys)).toBe(true);
    expect(matchesChord(ev({ ctrlKey: true, key: '.' }), SHORTCUTS.toggleAgentDock.keys)).toBe(true);
    // no modifier -> no match (so it stays out of the way while typing a period)
    expect(matchesChord(ev({ key: '.' }), SHORTCUTS.toggleAgentDock.keys)).toBe(false);
    // does not collide with the command palette (Mod+K)
    expect(matchesChord(ev({ metaKey: true, key: 'k' }), SHORTCUTS.toggleAgentDock.keys)).toBe(false);
    expect(matchesChord(ev({ metaKey: true, key: '.' }), SHORTCUTS.commandPalette.keys)).toBe(false);
  });
});

describe('groupedShortcuts', () => {
  it('returns non-empty groups in a stable order and covers every shortcut', () => {
    const groups = groupedShortcuts();
    expect(groups.map((g) => g.group)).toEqual(['General', 'Navigation', 'Composer', 'Sessions']);
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    expect(total).toBe(Object.keys(SHORTCUTS).length);
  });

  it('surfaces the agent-dock toggle so the ShortcutsHelp cheatsheet renders it', () => {
    // ShortcutsHelp maps groupedShortcuts() directly, so registry membership is
    // all the dialog needs to pick up the new chord.
    const navigation = groupedShortcuts().find((g) => g.group === 'Navigation');
    expect(navigation?.items.some((s) => s.id === 'toggleAgentDock' && s.label === 'Toggle agent dock')).toBe(true);
  });
});
