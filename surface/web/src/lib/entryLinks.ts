import { api } from '../api';
import { encodeRecordHandle, tryDecodeHandle } from '@atrium/surface-client/handle';

export type EntryQuoteTargetType = 'event' | 'record' | 'artifact';

export interface ResolvedEntryQuote {
  handle: string;
  kind: string;
  actor: string;
  actorLabel: string | null;
  text: string;
  meta: Record<string, unknown>;
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

export interface EntryLinkCandidate {
  original: string;
  candidate: string;
  trailing: string;
  handle: string;
  index: number;
}

function currentOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
}

function splitLinkCandidate(candidate: string): { candidate: string; trailing: string } {
  const trimmed = candidate.replace(TRAILING_LINK_PUNCTUATION, '');
  return { candidate: trimmed, trailing: candidate.slice(trimmed.length) };
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

export function handleFromEntryUrl(candidate: string, origin = currentOrigin()): string | null {
  let url: URL;
  try {
    url = candidate.startsWith('/e/')
      ? new URL(candidate, origin)
      : new URL(candidate);
  } catch {
    return null;
  }

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

export function findEntryLinkCandidates(text: string, origin = currentOrigin()): EntryLinkCandidate[] {
  const candidates: EntryLinkCandidate[] = [];

  for (const match of text.matchAll(ENTRY_LINK_CANDIDATE)) {
    const original = match[0];
    const index = match.index ?? 0;
    const split = splitLinkCandidate(original);
    const handle = handleFromEntryUrl(split.candidate, origin);
    if (!handle) continue;
    candidates.push({
      original,
      candidate: split.candidate,
      trailing: split.trailing,
      handle,
      index,
    });
  }

  return candidates;
}

export function extractEntryHandles(text: string, origin = currentOrigin()): string[] {
  const handles: string[] = [];
  const seen = new Set<string>();

  for (const { handle } of findEntryLinkCandidates(text, origin)) {
    if (seen.has(handle)) continue;
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
