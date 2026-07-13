import type { SessionItem, ToolCallItem } from './reducer.js';

export type SideEffectCategory = 'network' | 'package' | 'git' | 'filesystem' | 'process' | 'shell';
export type SideEffectRisk = 'danger' | 'caution' | 'normal';

export interface SideEffect {
  id: string;
  command: string;
  category: SideEffectCategory;
  risk: SideEffectRisk;
  toolName: string;
  sourceEventIds: number[];
}

const SHELL_TOOLS = new Set(['Bash', 'command']);
const CATEGORY_ORDER: SideEffectCategory[] = ['network', 'package', 'git', 'filesystem', 'process', 'shell'];

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function normalized(command: string): string {
  return command.trim().replace(/\s+/g, ' ').toLowerCase();
}

function commandStartsWith(command: string, pattern: string): boolean {
  return new RegExp(`(^|[;&|]\\s*)(?:sudo\\s+)?${pattern}\\b`, 'i').test(command);
}

function isNetwork(command: string): boolean {
  return commandStartsWith(command, '(curl|wget|nc|ssh|scp|ping|http)');
}

function isPackage(command: string): boolean {
  return (
    commandStartsWith(command, '(npm|pnpm|yarn)\\s+(install|add|i|remove|uninstall)') ||
    commandStartsWith(command, 'npm\\s+publish') ||
    commandStartsWith(command, '(pip|pip3)\\s+(install|remove|uninstall)') ||
    commandStartsWith(command, '(cargo|gem|brew)\\s+(install|add|i|remove|uninstall)') ||
    commandStartsWith(command, 'go\\s+(get|install)')
  );
}

function isGit(command: string): boolean {
  return commandStartsWith(command, 'git');
}

function isFilesystem(command: string): boolean {
  return commandStartsWith(command, '(rm|mv|cp|mkdir|touch|chmod|chown|ln|dd)');
}

function isProcess(command: string): boolean {
  return commandStartsWith(command, '(kill|pkill|docker|systemctl|launchctl)');
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
  return CATEGORY_ORDER.find((category) => checks[category](command)) ?? 'shell';
}

/** `rm` is danger only with BOTH recursive AND force, in any flag form
 * (combined `-rf`, split `-r -f`, or long `--recursive --force`). */
function isRmRf(command: string): boolean {
  if (!/\brm\b/i.test(command)) return false;
  for (const match of command.matchAll(/\brm\b([^\n;&|]*)/gi)) {
    const args = match[1] ?? '';
    const recursive = /(?:^|\s)-[a-z]*r[a-z]*\b|--recursive\b/i.test(args);
    const force = /(?:^|\s)-[a-z]*f[a-z]*\b|--force\b/i.test(args);
    if (recursive && force) return true;
  }
  return false;
}

interface HeredocDelimiter {
  value: string;
  stripTabs: boolean;
}

function heredocDelimiters(line: string): HeredocDelimiter[] {
  const delimiters: HeredocDelimiter[] = [];
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\' && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '#' && (index === 0 || /[\s;&|()]/.test(line[index - 1] ?? ''))) break;
    if (char !== '<' || line[index + 1] !== '<' || line[index + 2] === '<') continue;

    let cursor = index + 2;
    const stripTabs = line[cursor] === '-';
    if (stripTabs) cursor += 1;
    while (/\s/.test(line[cursor] ?? '')) cursor += 1;

    let value = '';
    const delimiterQuote = line[cursor];
    if (delimiterQuote === "'" || delimiterQuote === '"') {
      cursor += 1;
      while (cursor < line.length && line[cursor] !== delimiterQuote) {
        if (line[cursor] === '\\' && delimiterQuote === '"' && cursor + 1 < line.length) cursor += 1;
        value += line[cursor] ?? '';
        cursor += 1;
      }
    } else {
      while (cursor < line.length && !/[\s;&|<>]/.test(line[cursor] ?? '')) {
        if (line[cursor] === '\\' && cursor + 1 < line.length) cursor += 1;
        value += line[cursor] ?? '';
        cursor += 1;
      }
    }
    if (value) delimiters.push({ value, stripTabs });
    index = cursor;
  }

  return delimiters;
}

function hasTruncatingRedirectOnLine(line: string): boolean {
  let quote: "'" | '"' | null = null;
  let inConditional = false;
  let arithmeticDepth = 0;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\' && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '#' && (index === 0 || /[\s;&|()]/.test(line[index - 1] ?? ''))) break;
    if (inConditional) {
      if (char === ']' && line[index + 1] === ']') {
        inConditional = false;
        index += 1;
      }
      continue;
    }
    if (arithmeticDepth > 0) {
      if (char === '(' && line[index + 1] === '(') {
        arithmeticDepth += 1;
        index += 1;
      } else if (char === ')' && line[index + 1] === ')') {
        arithmeticDepth -= 1;
        index += 1;
      }
      continue;
    }
    if (char === '[' && line[index + 1] === '[') {
      inConditional = true;
      index += 1;
      continue;
    }
    if (char === '(' && line[index + 1] === '(') {
      arithmeticDepth = 1;
      index += 1;
      continue;
    }
    if (char !== '>') continue;

    const next = line[index + 1];
    if (next === '>') {
      index += 1;
      continue;
    }
    if (next === '&' || next === '(' || next === '=' || line[index - 1] === '<') continue;

    let tokenStart = index;
    while (tokenStart > 0 && !/[\s;&|()<>]/.test(line[tokenStart - 1] ?? '')) tokenStart -= 1;
    const tokenPrefix = line.slice(tokenStart, index);
    // Values such as `--select=a>b` and revision-like `a..b>c` are noisy and
    // ambiguous enough that this heuristic intentionally leaves them alone.
    if (tokenPrefix.startsWith('-') || tokenPrefix.includes('..')) continue;

    let targetStart = index + (next === '|' ? 2 : 1);
    while (/\s/.test(line[targetStart] ?? '')) targetStart += 1;
    if (targetStart < line.length && !/[;&|)]/.test(line[targetStart] ?? '')) return true;
  }

  return false;
}

function hasTruncatingRedirect(command: string): boolean {
  const pendingHeredocs: HeredocDelimiter[] = [];
  for (const line of command.split(/\r?\n/)) {
    const pending = pendingHeredocs[0];
    if (pending) {
      const candidate = pending.stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === pending.value) pendingHeredocs.shift();
      continue;
    }
    if (hasTruncatingRedirectOnLine(line)) return true;
    pendingHeredocs.push(...heredocDelimiters(line));
  }
  return false;
}

function isDdWithOutput(command: string): boolean {
  return /(^|[;&|]\s*)(?:sudo\s+)?dd\b[^\n;&|]*\bof\s*=/i.test(command);
}

function isXargsRm(command: string): boolean {
  return /(^|[;&|]\s*)xargs\b(?:\s+(?:-[^\s]+|--[^\s]+))*(?:\s+--)?\s+(?:sudo\s+)?rm\b/i.test(command);
}

// Heuristic, not a shell parser or security control. It covers common destructive
// tools and direct truncating redirects. Expansion/eval, redirects nested inside
// quoted command substitutions, and obscure destructive tools remain out of scope;
// absence of a danger result must not be interpreted as proof of safety.
function isDanger(command: string): boolean {
  return (
    isRmRf(command) ||
    hasTruncatingRedirect(command) ||
    /\bsudo\s/i.test(command) || // any elevation = attention (intentional)
    isDdWithOutput(command) ||
    commandStartsWith(command, 'mkfs(?:\\.[a-z0-9_-]+)?') ||
    commandStartsWith(command, '(shred|truncate)') ||
    /(^|[;&|]\s*)find\b[^\n;&|]*-delete\b/i.test(command) ||
    isXargsRm(command) ||
    /:\(\)\{/.test(command) ||
    /\bchmod\s+(?:-[^\s]*r[^\s]*\s+)?0?777\b/i.test(command) ||
    /\bgit\s+reset\b[^\n;&|]*--hard\b/i.test(command) ||
    /\bgit\s+clean\b(?=[^\n;&|]*(?:\s-[a-z]*f[a-z]*\b|\s--force\b))/i.test(command) ||
    /\bgit\s+push\b[^\n;&|]*(?:--force(?!-with-lease)|-f)\b/i.test(command) ||
    /\bmv\b[^\n;&|]*\s\/\s*(?:$|[;&|])/i.test(command) ||
    /\b(curl|wget)\b[^\n;&]*\|\s*(?:sh|bash|zsh|dash|python3?|node|perl|ruby)\b/i.test(command) ||
    /\bnpm\s+publish\b/i.test(command) ||
    /\bkubectl\s+delete\b/i.test(command) ||
    /\bdrop\s+(table|database)\b/i.test(command)
  );
}

function isCaution(command: string): boolean {
  return isNetwork(command) || /\bgit\s+(push|commit)\b/i.test(command) || isPackage(command) || isProcess(command);
}

/**
 * Heuristically labels noteworthy command shapes for UI attention. A `normal`
 * result means no known pattern matched; it is not a guarantee that a command is safe.
 */
export function classifyCommand(command: string): { category: SideEffectCategory; risk: SideEffectRisk } {
  const text = normalized(command);
  const risk: SideEffectRisk = isDanger(command) ? 'danger' : isCaution(text) ? 'caution' : 'normal';
  return { category: categoryFor(text), risk };
}

export function collectSideEffects(items: SessionItem[]): SideEffect[] {
  const out: SideEffect[] = [];
  for (const item of items) {
    if (item.type !== 'tool_call' || !SHELL_TOOLS.has(item.name)) continue;
    const command = str((item as ToolCallItem).input['command'])?.trim();
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
