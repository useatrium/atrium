export const AGENT_PREFIX = '@agent';

/** True while the composer text begins with "@agent" (drives the hint chip). */
export function looksLikeAgentCommand(text: string): boolean {
  return text.startsWith(AGENT_PREFIX);
}

/** Extract the task from "@agent <task>", or null if this is a plain message. */
export function parseAgentTask(text: string): string | null {
  if (!text.startsWith(`${AGENT_PREFIX} `)) return null;
  const task = text.slice(AGENT_PREFIX.length + 1).trim();
  return task.length > 0 ? task : null;
}
