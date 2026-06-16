import type { SessionItem, ToolCallItem } from "./reducer.js";

export type SideEffectCategory = "network" | "package" | "git" | "filesystem" | "process" | "shell";
export type SideEffectRisk = "danger" | "caution" | "normal";

export interface SideEffect {
  id: string;
  command: string;
  category: SideEffectCategory;
  risk: SideEffectRisk;
  toolName: string;
  sourceEventIds: number[];
}

const SHELL_TOOLS = new Set(["Bash", "command"]);
const CATEGORY_ORDER: SideEffectCategory[] = ["network", "package", "git", "filesystem", "process", "shell"];

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalized(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

function commandStartsWith(command: string, pattern: string): boolean {
  return new RegExp(`(^|[;&|]\\s*)(?:sudo\\s+)?${pattern}\\b`, "i").test(command);
}

function isNetwork(command: string): boolean {
  return commandStartsWith(command, "(curl|wget|nc|ssh|scp|ping|http)");
}

function isPackage(command: string): boolean {
  return (
    commandStartsWith(command, "(npm|pnpm|yarn)\\s+(install|add|i|remove|uninstall)") ||
    commandStartsWith(command, "npm\\s+publish") ||
    commandStartsWith(command, "(pip|pip3)\\s+(install|remove|uninstall)") ||
    commandStartsWith(command, "(cargo|gem|brew)\\s+(install|add|i|remove|uninstall)") ||
    commandStartsWith(command, "go\\s+(get|install)")
  );
}

function isGit(command: string): boolean {
  return commandStartsWith(command, "git");
}

function isFilesystem(command: string): boolean {
  return commandStartsWith(command, "(rm|mv|cp|mkdir|touch|chmod|chown|ln|dd)");
}

function isProcess(command: string): boolean {
  return commandStartsWith(command, "(kill|pkill|docker|systemctl|launchctl)");
}

function categoryFor(command: string): SideEffectCategory {
  const checks: Record<SideEffectCategory, (command: string) => boolean> = {
    network: isNetwork,
    package: isPackage,
    git: isGit,
    filesystem: isFilesystem,
    process: isProcess,
    shell: () => true,
  };
  return CATEGORY_ORDER.find((category) => checks[category](command)) ?? "shell";
}

/** `rm` is danger only with BOTH recursive AND force, in any flag form
 * (combined `-rf`, split `-r -f`, or long `--recursive --force`). */
function isRmRf(command: string): boolean {
  if (!/\brm\b/i.test(command)) return false;
  const recursive = /(?:^|\s)-[a-z]*r|--recursive\b/i.test(command);
  const force = /(?:^|\s)-[a-z]*f|--force\b/i.test(command);
  return recursive && force;
}

// Heuristic, not a security control. Known gaps left unflagged to avoid noise:
// plain `> file` truncation and obscure destructive tools.
function isDanger(command: string): boolean {
  return (
    isRmRf(command) ||
    /\bsudo\s/i.test(command) || // any elevation = attention (intentional)
    commandStartsWith(command, "dd") ||
    /\bmkfs\b/i.test(command) ||
    commandStartsWith(command, "(shred|truncate)") ||
    /(^|[;&|]\s*)find\b[^\n;&|]*-delete\b/i.test(command) ||
    /:\(\)\{/.test(command) ||
    /\bchmod\s+(?:-[^\s]*r[^\s]*\s+)?0?777\b/i.test(command) ||
    /\bgit\s+push\b[^\n;&|]*(?:--force(?!-with-lease)|-f)\b/i.test(command) ||
    />\s*\/dev\/sd/i.test(command) ||
    /\bmv\b[^\n;&|]*\s\/\s*(?:$|[;&|])/i.test(command) ||
    /\b(curl|wget)\b[^\n;&]*\|\s*(?:sh|bash|zsh|dash|python3?|node|perl|ruby)\b/i.test(command) ||
    /\bnpm\s+publish\b/i.test(command) ||
    /\bkubectl\s+delete\b/i.test(command) ||
    /\bdrop\s+(table|database)\b/i.test(command)
  );
}

function isCaution(command: string): boolean {
  return (
    isNetwork(command) ||
    /\bgit\s+(push|commit)\b/i.test(command) ||
    /\bgit\s+reset\s+--hard\b/i.test(command) ||
    isPackage(command) ||
    isProcess(command)
  );
}

export function classifyCommand(command: string): { category: SideEffectCategory; risk: SideEffectRisk } {
  const text = normalized(command);
  const risk: SideEffectRisk = isDanger(text) ? "danger" : isCaution(text) ? "caution" : "normal";
  return { category: categoryFor(text), risk };
}

export function collectSideEffects(items: SessionItem[]): SideEffect[] {
  const out: SideEffect[] = [];
  for (const item of items) {
    if (item.type !== "tool_call" || !SHELL_TOOLS.has(item.name)) continue;
    const command = str((item as ToolCallItem).input["command"])?.trim();
    if (!command) continue;
    const { category, risk } = classifyCommand(command);
    out.push({
      id: item.id,
      command,
      category,
      risk,
      toolName: item.name,
      sourceEventIds: [...item.sourceEventIds],
    });
  }
  return out;
}

export function sideEffectCount(effects: SideEffect[]): number {
  return effects.length;
}
