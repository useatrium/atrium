import type { ToolCallItem } from './reducer.js';

export interface ToolDescriptor {
  kind: 'file-edit' | 'command' | 'read' | 'search' | 'web' | 'todo' | 'plan' | 'generic';
  title: string;
  subtitle?: string;
  language?: string;
  defaultExpanded: boolean;
}

export function toolDisplay(item: ToolCallItem): ToolDescriptor {
  const name = item.name.trim();
  const normalized = name.toLowerCase();

  if (normalized === 'bash' || normalized === 'command') {
    return descriptor('command', commandTitle(item), undefined, 'bash');
  }

  if (normalized === 'read' || normalized === 'cat') {
    return descriptor('read', name || item.name, pathFromInput(item));
  }

  if (normalized === 'grep' || normalized === 'glob' || normalized === 'rg') {
    return descriptor('search', name || item.name, searchSubtitle(item));
  }

  if (isFileEditTool(normalized)) {
    return descriptor('file-edit', name || item.name, pathFromInput(item));
  }

  if (normalized === 'webfetch' || normalized === 'websearch') {
    return descriptor('web', name || item.name, webSubtitle(item));
  }

  if (normalized === 'todowrite' || normalized === 'todoread') {
    return descriptor('todo', name || item.name);
  }

  if (normalized === 'exitplanmode') {
    return descriptor('plan', name || item.name);
  }

  return descriptor('generic', item.name);
}

function descriptor(kind: ToolDescriptor['kind'], title: string, subtitle?: string, language?: string): ToolDescriptor {
  return {
    kind,
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(language ? { language } : {}),
    defaultExpanded: false,
  };
}

function commandTitle(item: ToolCallItem): string {
  const command = stringField(item, 'command') ?? stringField(item, 'cmd');
  if (command) {
    return firstLine(command);
  }

  const fallback = firstLine(JSON.stringify(item.input));
  return fallback || item.name;
}

function searchSubtitle(item: ToolCallItem): string | undefined {
  return stringField(item, 'pattern') ?? stringField(item, 'query') ?? stringField(item, 'glob') ?? pathFromInput(item);
}

function webSubtitle(item: ToolCallItem): string | undefined {
  return stringField(item, 'url') ?? stringField(item, 'query');
}

function pathFromInput(item: ToolCallItem): string | undefined {
  return stringField(item, 'file_path') ?? stringField(item, 'path') ?? stringField(item, 'notebook_path');
}

function stringField(item: ToolCallItem, key: string): string | undefined {
  const value = item.input[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

function isFileEditTool(normalized: string): boolean {
  return (
    normalized === 'edit' ||
    normalized === 'write' ||
    normalized === 'multiedit' ||
    normalized === 'notebookedit' ||
    normalized === 'applypatch' ||
    normalized.startsWith('str_replace') ||
    normalized === 'create_file'
  );
}
