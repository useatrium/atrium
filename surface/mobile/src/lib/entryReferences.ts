import { ApiError } from '@atrium/surface-client';
import type { Session } from './session';

export interface EntryReference {
  eventId: number;
  handle: string;
  channelId: string;
  threadRootEventId: number | null;
  actorLabel: string | null;
  excerpt: string;
  ts: string;
}

export interface EntryReferenceSummary {
  count: number;
  latest: EntryReference[];
}

export type EntryReferenceMap = Record<string, EntryReferenceSummary>;

function isEntryReference(value: unknown): value is EntryReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.eventId === 'number' &&
    Number.isSafeInteger(raw.eventId) &&
    typeof raw.handle === 'string' &&
    typeof raw.channelId === 'string' &&
    (typeof raw.threadRootEventId === 'number' || raw.threadRootEventId === null) &&
    (raw.threadRootEventId === null || Number.isSafeInteger(raw.threadRootEventId)) &&
    (typeof raw.actorLabel === 'string' || raw.actorLabel === null) &&
    typeof raw.excerpt === 'string' &&
    typeof raw.ts === 'string'
  );
}

function isEntryReferenceSummary(value: unknown): value is EntryReferenceSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.count === 'number' &&
    Number.isSafeInteger(raw.count) &&
    raw.count >= 0 &&
    Array.isArray(raw.latest) &&
    raw.latest.every(isEntryReference)
  );
}

function parseReferenceMap(value: unknown): EntryReferenceMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const references = raw.references;
  if (!references || typeof references !== 'object' || Array.isArray(references)) return {};

  const parsed: EntryReferenceMap = {};
  for (const [handle, summary] of Object.entries(references)) {
    if (isEntryReferenceSummary(summary)) parsed[handle] = summary;
  }
  return parsed;
}

export function createEntryReferenceQuery(session: Session) {
  const baseUrl = session.serverUrl.replace(/\/+$/, '');
  const authorization = `Bearer ${session.token}`;

  return async (handles: string[]): Promise<EntryReferenceMap> => {
    const unique = [...new Set(handles)].filter(Boolean);
    if (unique.length === 0) return {};

    const res = await fetch(`${baseUrl}/api/entries/references/query`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ handles: unique }),
    });

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

    return parseReferenceMap(await res.json());
  };
}
