import { tryDecodeHandle } from '@atrium/surface-client/handle';
import { isUnfurlableUrl } from '@atrium/surface-client';
import {
  internalLinkKey,
  parseInternalLinkUrl,
  threadEntryHandle,
  type InternalLinkRef,
} from '@atrium/surface-client/internal-links';

const MAX_ENTRY_LINKS = 3;
const ENTRY_LINK_RE = /https?:\/\/[^\s<>()]+|\/e\/[^\s<>()]+/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/;
const ARTIFACT_HANDLE_RE = /^art_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface EntryLinkMatch {
  raw: string;
  candidate: string;
  handle: string;
  index: number;
  end: number;
}

export interface PartitionedEntryLinks {
  bodyText: string;
  standaloneHandles: string[];
  allHandles: string[];
  internalLinks: InternalLinkRef[];
  externalUrls: string[];
}

export function isEntryHandle(handle: string): boolean {
  return tryDecodeHandle(handle) != null || ARTIFACT_HANDLE_RE.test(handle);
}

function stripTrailingPunctuation(value: string): string {
  let next = value.replace(TRAILING_PUNCTUATION_RE, '');
  while (/[)\]}]$/.test(next)) {
    const opens = (next.match(/[([{]/g) ?? []).length;
    const closes = (next.match(/[)\]}]/g) ?? []).length;
    if (closes <= opens) break;
    next = next.slice(0, -1);
  }
  return next;
}

function handleFromPath(pathname: string): string | null {
  const match = /^\/e\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] ?? '');
  } catch {
    return null;
  }
}

export function entryHandleFromLinkCandidate(candidate: string): string | null {
  const raw = stripTrailingPunctuation(candidate);
  if (raw.startsWith('/e/')) {
    const [path] = raw.split(/[?#]/, 1);
    return handleFromPath(path ?? raw);
  }

  try {
    const url = new URL(raw);
    return handleFromPath(url.pathname);
  } catch {
    return null;
  }
}

export function findEntryLinkMatches(text: string, limit = Number.POSITIVE_INFINITY): EntryLinkMatch[] {
  if (!text || limit <= 0) return [];

  const matches: EntryLinkMatch[] = [];
  for (const rawMatch of text.matchAll(ENTRY_LINK_RE)) {
    const raw = rawMatch[0] ?? '';
    const candidate = stripTrailingPunctuation(raw);
    const handle = entryHandleFromLinkCandidate(candidate);
    if (!handle || !isEntryHandle(handle)) continue;
    const index = rawMatch.index ?? 0;
    matches.push({ raw, candidate, handle, index, end: index + raw.length });
    if (matches.length >= limit) break;
  }

  return matches;
}

export function extractEntryLinkHandles(text: string, _serverUrl: string, limit = MAX_ENTRY_LINKS): string[] {
  if (!text || limit <= 0) return [];

  const handles: string[] = [];
  const seen = new Set<string>();

  for (const { handle } of findEntryLinkMatches(text)) {
    if (seen.has(handle)) continue;
    seen.add(handle);
    handles.push(handle);
    if (handles.length >= limit) break;
  }

  return handles;
}

export function partitionEntryLinks(text: string, _serverUrl: string, limit = MAX_ENTRY_LINKS): PartitionedEntryLinks {
  if (!text) return { bodyText: '', standaloneHandles: [], allHandles: [], internalLinks: [], externalUrls: [] };

  const bodyLines: string[] = [];
  const standaloneHandles: string[] = [];
  const seen = new Set<string>();
  const allHandles: string[] = [];
  const internalLinks: InternalLinkRef[] = [];
  const externalUrls: string[] = [];
  const seenInternalLinks = new Set<string>();
  const seenExternalUrls = new Set<string>();

  for (const rawMatch of text.matchAll(ENTRY_LINK_RE)) {
    const candidate = stripTrailingPunctuation(rawMatch[0] ?? '');
    const entryHandle = entryHandleFromLinkCandidate(candidate);
    if (entryHandle != null) {
      if (isEntryHandle(entryHandle) && !seen.has(entryHandle)) {
        seen.add(entryHandle);
        allHandles.push(entryHandle);
      }
      continue;
    }

    // Internal-link parsing must win over the generic URL classifier: our own
    // absolute URLs are otherwise valid external-unfurl candidates.
    const internalRef = parseInternalLinkUrl(candidate);
    if (internalRef) {
      if (internalRef.kind === 'thread') {
        const handle = threadEntryHandle(internalRef);
        if (!seen.has(handle)) {
          seen.add(handle);
          allHandles.push(handle);
        }
      } else {
        const key = internalLinkKey(internalRef);
        if (!seenInternalLinks.has(key)) {
          seenInternalLinks.add(key);
          internalLinks.push(internalRef);
        }
      }
      continue;
    }

    if (!isUnfurlableUrl(candidate)) continue;
    if (seenExternalUrls.has(candidate)) continue;
    seenExternalUrls.add(candidate);
    externalUrls.push(candidate);
  }

  seen.clear();

  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    const matches = findEntryLinkMatches(trimmed, 2);
    const match = matches[0];
    const standalone =
      matches.length === 1 &&
      match != null &&
      match.index === 0 &&
      /^[.,;:!?]*$/.test(trimmed.slice(match.candidate.length));

    if (!standalone) {
      bodyLines.push(line);
      continue;
    }

    const handle = match.handle;
    if (!seen.has(handle) && standaloneHandles.length < limit) {
      seen.add(handle);
      standaloneHandles.push(handle);
    }
  }

  return { bodyText: bodyLines.join('\n'), standaloneHandles, allHandles, internalLinks, externalUrls };
}

export function unsuppressedEntryHandles(handles: readonly string[], suppressed: readonly string[] = []): string[] {
  if (suppressed.length === 0) return [...handles];
  const hidden = new Set(suppressed);
  return handles.filter((handle) => !hidden.has(handle));
}

export function unsuppressedInternalLinks(
  refs: readonly InternalLinkRef[],
  suppressed: readonly string[] = [],
): InternalLinkRef[] {
  if (suppressed.length === 0) return [...refs];
  const hidden = new Set(suppressed);
  return refs.filter((ref) => !hidden.has(internalLinkKey(ref)));
}
