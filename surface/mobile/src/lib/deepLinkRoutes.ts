import type { Href } from 'expo-router';
import type { NormalizedEntry } from '@atrium/surface-client';

export type RouteParamValue = string | string[] | undefined;
export type RouteParams = Record<string, RouteParamValue>;

const INBOUND_QUERY_KEYS = ['entry', 'threadRoot', 'file'] as const;

export function firstRouteParam(value: RouteParamValue): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export function inboundQueryParams(params: RouteParams): Record<string, string> {
  const query: Record<string, string> = {};
  for (const key of INBOUND_QUERY_KEYS) {
    const value = firstRouteParam(params[key]);
    if (value) query[key] = value;
  }
  return query;
}

export function destinationForEntry(entry: NormalizedEntry): Href | null {
  if (entry.targetType === 'record') {
    const sessionId = entry.location.sessionId;
    if (!sessionId) return null;
    return {
      pathname: '/session/[id]',
      params: { id: sessionId, entry: entry.handle },
    } as Href;
  }

  if (entry.targetType === 'artifact') {
    const artifactId = artifactIdForEntry(entry);
    if (!artifactId) return null;
    return {
      pathname: '/files',
      params: { file: artifactId },
    } as Href;
  }

  const channelId = entry.location.channelId;
  if (!channelId) return null;

  const threadRootEventId = threadRootEventIdForEntry(entry);
  if (threadRootEventId != null) {
    return {
      pathname: '/thread/[rootId]',
      params: {
        rootId: String(threadRootEventId),
        channelId,
        entry: entry.handle,
      },
    } as Href;
  }

  return {
    pathname: '/channel/[id]',
    params: { id: channelId, entry: entry.handle },
  } as Href;
}

function threadRootEventIdForEntry(entry: NormalizedEntry): number | null {
  if (entry.targetType !== 'event') return null;
  const value = entry.location.threadRootEventId;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function artifactIdForEntry(entry: NormalizedEntry): string | null {
  if (entry.targetType !== 'artifact') return null;
  return entry.handle.startsWith('art_') ? entry.handle.slice(4) : null;
}
