import { ApiError } from '@atrium/surface-client';
import type { Session } from './session';

export interface ResolvedEntry {
  handle: string;
  kind: string;
  actor: string;
  text: string;
  targetType: 'event' | 'record' | 'artifact';
  tombstoned: boolean;
  location: {
    workspaceId: string;
    channelId: string | null;
    channelName: string | null;
    sessionId: string | null;
    sessionTitle: string | null;
  };
}

export type EntryResolver = (handle: string) => Promise<ResolvedEntry | null>;
export type ArtifactContentResolver = (artifactId: string) => Promise<string | null>;

const ARTIFACT_CONTENT_LIMIT = 64 * 1024;

function isResolvedEntry(value: unknown): value is ResolvedEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const location = raw.location;
  if (!location || typeof location !== 'object' || Array.isArray(location)) return false;
  const loc = location as Record<string, unknown>;
  return (
    typeof raw.handle === 'string' &&
    typeof raw.kind === 'string' &&
    typeof raw.actor === 'string' &&
    typeof raw.text === 'string' &&
    (raw.targetType === 'event' || raw.targetType === 'record' || raw.targetType === 'artifact') &&
    typeof raw.tombstoned === 'boolean' &&
    typeof loc.workspaceId === 'string' &&
    (typeof loc.channelId === 'string' || loc.channelId === null) &&
    (typeof loc.channelName === 'string' || loc.channelName === null) &&
    (typeof loc.sessionId === 'string' || loc.sessionId === null) &&
    (typeof loc.sessionTitle === 'string' || loc.sessionTitle === null)
  );
}

export function createEntryResolver(session: Session): EntryResolver {
  const cache = new Map<string, Promise<ResolvedEntry | null>>();
  const baseUrl = session.serverUrl.replace(/\/+$/, '');
  const authorization = `Bearer ${session.token}`;

  return (handle: string) => {
    const cached = cache.get(handle);
    if (cached) return cached;

    const request = fetch(`${baseUrl}/api/entries/${encodeURIComponent(handle)}`, {
      credentials: 'same-origin',
      headers: { authorization },
    })
      .then(async (res) => {
        if (!res.ok) {
          let code = 'http_error';
          let message = res.statusText;
          try {
            const body = await res.json();
            code = body.error ?? code;
            message = body.message ?? message;
          } catch {
            /* non-JSON error body */
          }
          throw new ApiError(res.status, code, message);
        }
        const body = await res.json();
        return isResolvedEntry(body) ? body : null;
      })
      .catch(() => null);

    cache.set(handle, request);
    return request;
  };
}

export function createArtifactContentResolver(session: Session): ArtifactContentResolver {
  const cache = new Map<string, Promise<string | null>>();
  const baseUrl = session.serverUrl.replace(/\/+$/, '');
  const authorization = `Bearer ${session.token}`;

  return (artifactId: string) => {
    const cached = cache.get(artifactId);
    if (cached) return cached;

    const request = fetch(`${baseUrl}/api/files/artifact/${encodeURIComponent(artifactId)}/content`, {
      credentials: 'same-origin',
      headers: { authorization },
    })
      .then(async (res) => {
        if (!res.ok) {
          let code = 'http_error';
          let message = res.statusText;
          try {
            const body = await res.json();
            code = body.error ?? code;
            message = body.message ?? message;
          } catch {
            /* non-JSON error body */
          }
          throw new ApiError(res.status, code, message);
        }
        const text = await res.text();
        return text.length > ARTIFACT_CONTENT_LIMIT ? text.slice(0, ARTIFACT_CONTENT_LIMIT) : text;
      })
      .catch(() => null);

    cache.set(artifactId, request);
    return request;
  };
}
