import { ArtifactLedger } from './artifact-ledger.js';
import { artifactPathInRoots, readableArtifactRootsForSession } from './artifact-scope.js';
import type { Db, DbClient } from './db.js';
import { encodeHandle, resolveEntry, tryDecodeHandle } from './entries.js';
import { getObjectBytes } from './s3.js';

const ENTRY_LINK_RE = /(?:https?:\/\/[^/\s?#]+)?\/e\/([A-Za-z0-9_-]+)/g;
const APPENDIX_BUDGET_BYTES = 6144;
const MAX_EXCERPT_CHARS = 300;
const CHEAP_ARTIFACT_BYTES = 16 * 1024;
const APPENDIX_HEADER = '---\nReferenced entries:';

export type ReferencedEntryAppendixItem =
  | { kind: 'local-file'; originalLink: string; path: string }
  | {
      kind: 'excerpt';
      originalLink: string;
      actorLabel: string | null;
      entryKind: string;
      text: string;
    }
  | { kind: 'inaccessible'; originalLink: string; workspace?: boolean };

interface EntryLink {
  originalLink: string;
  handle: string;
}

export function extractEntryLinks(text: string): EntryLink[] {
  const links: EntryLink[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(ENTRY_LINK_RE)) {
    const raw = match[1];
    const originalLink = match[0];
    if (!raw || !originalLink) continue;
    const decoded = tryDecodeHandle(raw);
    if (!decoded) continue;
    const handle = encodeHandle(decoded);
    if (seen.has(handle)) continue;
    seen.add(handle);
    links.push({ originalLink, handle });
  }
  return links;
}

export async function appendReferencedEntriesAppendix(
  db: Db | DbClient,
  args: { sessionId: string; userId: string; text: string },
): Promise<string> {
  if (args.text.includes(`\n\n${APPENDIX_HEADER}`)) return args.text;
  const links = extractEntryLinks(args.text);
  if (links.length === 0) return args.text;

  const scope = await readableArtifactRootsForSession(db, args.sessionId, args.userId);
  const items: ReferencedEntryAppendixItem[] = [];
  for (const link of links) {
    const entry = await resolveEntry(db as Db, link.handle, args.userId).catch(() => null);
    if (!entry) {
      items.push({ kind: 'inaccessible', originalLink: link.originalLink });
      continue;
    }

    if (entry.targetType === 'artifact') {
      const path = typeof entry.meta.path === 'string' ? entry.meta.path : '';
      if (!entry.tombstoned && path && artifactPathInRoots(path, scope.readableRoots)) {
        items.push({ kind: 'local-file', originalLink: link.originalLink, path });
        continue;
      }
      const artifactText = !entry.tombstoned ? await cheapArtifactText(db, entry.meta.artifactId) : null;
      if (artifactText) {
        items.push({
          kind: 'excerpt',
          originalLink: link.originalLink,
          actorLabel: null,
          entryKind: 'artifact',
          text: artifactText,
        });
      } else {
        items.push({ kind: 'inaccessible', originalLink: link.originalLink, workspace: true });
      }
      continue;
    }

    items.push({
      kind: 'excerpt',
      originalLink: link.originalLink,
      actorLabel: entry.actorLabel,
      entryKind: readableEntryKind(entry.kind),
      text: entry.tombstoned ? '' : entry.text,
    });
  }

  return appendReferencedEntriesAppendixText(args.text, items);
}

export function appendReferencedEntriesAppendixText(
  text: string,
  items: readonly ReferencedEntryAppendixItem[],
): string {
  const appendix = composeReferencedEntriesAppendix(items);
  return appendix ? `${text}\n\n${appendix}` : text;
}

export function composeReferencedEntriesAppendix(
  items: readonly ReferencedEntryAppendixItem[],
  budgetBytes = APPENDIX_BUDGET_BYTES,
): string | null {
  if (items.length === 0) return null;

  let excerptLimit = MAX_EXCERPT_CHARS;
  while (excerptLimit > 40 && byteLength(renderAppendix(items, excerptLimit, [])) > budgetBytes) {
    excerptLimit = Math.max(40, Math.floor(excerptLimit * 0.7));
  }

  const included: ReferencedEntryAppendixItem[] = [];
  const omitted: ReferencedEntryAppendixItem[] = [];
  for (const item of items) {
    const next = [...included, item];
    const omittedAfterNext = [...omitted];
    const candidate = renderAppendix(next, excerptLimit, omittedAfterNext);
    if (byteLength(candidate) <= budgetBytes) {
      included.push(item);
    } else {
      omitted.push(item);
    }
  }

  let appendix = renderAppendix(included, excerptLimit, omitted);
  while (byteLength(appendix) > budgetBytes && included.length > 0) {
    omitted.unshift(included.pop()!);
    appendix = renderAppendix(included, excerptLimit, omitted);
  }
  return byteLength(appendix) <= budgetBytes ? appendix : null;
}

function renderAppendix(
  items: readonly ReferencedEntryAppendixItem[],
  excerptLimit: number,
  omitted: readonly ReferencedEntryAppendixItem[],
): string {
  const lines = [APPENDIX_HEADER];
  for (const item of items) lines.push(renderItem(item, excerptLimit));
  if (omitted.length > 0) lines.push(renderOmittedLine(omitted));
  return lines.join('\n');
}

function renderItem(item: ReferencedEntryAppendixItem, excerptLimit: number): string {
  switch (item.kind) {
    case 'local-file':
      return `- ${item.originalLink} → local file: ${item.path}`;
    case 'inaccessible':
      return `- ${item.originalLink}: (${item.workspace ? 'not accessible in this workspace' : 'not accessible'})`;
    case 'excerpt': {
      const who = item.actorLabel ? `${item.actorLabel}, ${item.entryKind}` : item.entryKind;
      return `- ${item.originalLink} (${who}): "${excerpt(item.text, excerptLimit)}"`;
    }
  }
}

function renderOmittedLine(items: readonly ReferencedEntryAppendixItem[]): string {
  const shown = items
    .slice(0, 2)
    .map((item) => item.originalLink)
    .join(', ');
  return `(${items.length} more omitted: ${shown}${items.length > 2 ? ', …' : ''})`;
}

function excerpt(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const sliced = compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…` : compact;
  return sliced.replace(/["\\]/g, (char) => `\\${char}`);
}

function readableEntryKind(kind: string): string {
  if (kind === 'message.posted' || kind === 'message') return 'message';
  return kind;
}

async function cheapArtifactText(db: Db | DbClient, artifactId: unknown): Promise<string | null> {
  if (typeof artifactId !== 'string') return null;
  const version = await new ArtifactLedger(db as Db).resolveVersionByArtifactId(artifactId, { pointer: 'latest' });
  if (!version || version.kind === 'deleted' || version.tombstoned) return null;
  if (!version.isText || !version.s3Key || Number(version.sizeBytes ?? 0) > CHEAP_ARTIFACT_BYTES) return null;
  return (await getObjectBytes(version.s3Key)).toString(version.textEncoding === 'utf16le' ? 'utf16le' : 'utf8');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
