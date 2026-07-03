import { api } from '../api';
import { encodeRecordHandle, tryDecodeHandle } from '@atrium/surface-client/handle';

export type EntryQuoteTargetType = 'event' | 'record' | 'artifact';

export interface ResolvedEntryQuote {
  handle: string;
  kind: string;
  actor: string;
  actorLabel: string | null;
  text: string;
  targetType: EntryQuoteTargetType;
  tombstoned: boolean;
  location: {
    workspaceId: string;
    channelId: string | null;
    channelName: string | null;
    sessionId: string | null;
    sessionTitle: string | null;
  };
}

const ENTRY_LINK_CANDIDATE = /(?:https?:\/\/[^\s<>"']+|\/e\/[^\s<>"']+)/g;
const ART_PREFIX = 'art_';
const TRAILING_LINK_PUNCTUATION = /[),.;:!?]+$/;
const resolveCache = new Map<string, Promise<ResolvedEntryQuote | null>>();

function trimLinkCandidate(candidate: string): string {
  return candidate.replace(TRAILING_LINK_PUNCTUATION, '');
}

function isValidEntryHandle(handle: string): boolean {
  if (tryDecodeHandle(handle)) return true;
  if (!handle.startsWith(ART_PREFIX)) return false;

  const artifactId = handle.slice(ART_PREFIX.length);
  try {
    encodeRecordHandle(artifactId);
    return true;
  } catch {
    return false;
  }
}

function handleFromEntryUrl(candidate: string, currentOrigin: string): string | null {
  let url: URL;
  try {
    url = candidate.startsWith('/e/')
      ? new URL(candidate, currentOrigin)
      : new URL(candidate);
  } catch {
    return null;
  }

  if (url.origin !== currentOrigin) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'e') return null;

  let handle: string;
  try {
    handle = decodeURIComponent(parts[1] ?? '');
  } catch {
    return null;
  }

  return isValidEntryHandle(handle) ? handle : null;
}

export function extractEntryHandles(text: string, currentOrigin = window.location.origin): string[] {
  const handles: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(ENTRY_LINK_CANDIDATE)) {
    const candidate = trimLinkCandidate(match[0]);
    const handle = handleFromEntryUrl(candidate, currentOrigin);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    handles.push(handle);
  }

  return handles;
}

export function resolveEntryQuote(handle: string): Promise<ResolvedEntryQuote | null> {
  const cached = resolveCache.get(handle);
  if (cached) return cached;

  const request: Promise<ResolvedEntryQuote | null> = api
    .resolveEntry(handle)
    .then((entry) => entry as ResolvedEntryQuote)
    .catch(() => null);

  resolveCache.set(handle, request);
  return request;
}

export function clearEntryResolveCacheForTests(): void {
  resolveCache.clear();
}
