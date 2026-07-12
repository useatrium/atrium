/** Composer sigil that temporarily summons an agent before first-class agent
 * mode replaces this compatibility path. */
export const SUMMON_SIGIL = '!!';

/** True while the composer text begins with the summon sigil. */
export function looksLikeSummonSigil(text: string): boolean {
  return text.startsWith(SUMMON_SIGIL);
}

/** Extract the task from `!! task` or `!!task`, or return null for a plain or
 * incomplete message. */
export function parseSummonSigil(text: string): { task: string } | null {
  if (!text.startsWith(SUMMON_SIGIL)) return null;
  const task = text.slice(SUMMON_SIGIL.length).trim();
  return task.length > 0 ? { task } : null;
}
