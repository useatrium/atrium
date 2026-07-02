// Per-harness reasoning-effort vocabularies — the single source of truth for
// server validation and the web composer picker. Dependency-free so the
// server can consume it via the `./effort` subpath export (nodenext-safe,
// like ./handle).

/** Levels each harness accepts. Codex mirrors its ReasoningEffort enum
 * (`turn/start.effort`, validated again upstream); claude mirrors the CLI
 * `--effort` values (the runtime applies a change by respawning the harness
 * child with `--resume`, so even the session-only `max` applies cleanly).
 * Amp has no effort knob. */
export const HARNESS_EFFORT_LEVELS: Record<string, readonly string[]> = {
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
};

/** Levels the composer picker offers (codex `none` omitted — turning
 * reasoning off entirely is a config decision, not a steer-time nudge). */
export const HARNESS_EFFORT_PICKER_OPTIONS: Record<string, readonly string[]> = {
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
};

const ALL_EFFORT_LEVELS = new Set(Object.values(HARNESS_EFFORT_LEVELS).flat());

export function isSessionEffortLevel(value: unknown): value is string {
  return typeof value === 'string' && ALL_EFFORT_LEVELS.has(value);
}
