import {
  ApiError,
  parseEntryReferenceMap,
  type EntryReferenceLatest,
  type EntryReferenceMap,
  type EntryReferenceSummary,
} from '@atrium/surface-client';
import type { Session } from './session';

export type EntryReference = EntryReferenceLatest;
export type { EntryReferenceMap, EntryReferenceSummary };

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

    return parseEntryReferenceMap(await res.json());
  };
}
