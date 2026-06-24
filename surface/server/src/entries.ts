// Universal entry handle codec.
//
// A handle is a typed string that resolves to exactly one entry across the two
// stores Atrium keeps conversation in:
//
//   evt_<bigserial>   -> events row           (chat entry)
//   rec_<entry_uid>   -> session_records row   (transcript entry)
//   run_<...>         -> child / sub-agent run (RESERVED — P3, not implemented)
//
// Design (see notes/addressable-entries-and-annotations.md):
//   - `evt_*` is a TRANSPARENT, derivable handle: `evt_<events.id>` (decision H8).
//     Only the chat half; events.id is already a stable immutable key, so there is
//     nothing to gain from wrapping it. Authz at resolve is the access control.
//   - `rec_*` wraps the derived, replay-stable `entry_uid` (opaque to callers).
//   - The same handle is the resolve-route id, the copy-link target, the agent
//     reference, and the MCP resource id — one concept, four uses.

export type EntryHandle =
  | { type: 'event'; eventId: number }
  | { type: 'record'; entryUid: string };

export type EntryHandleType = EntryHandle['type'];

const EVT_PREFIX = 'evt_';
const REC_PREFIX = 'rec_';
const RUN_PREFIX = 'run_';

// `entry_uid` and the encoded handle both travel in a URL path segment
// (`/api/entries/:handle`), so the opaque body must be URL-safe. The projection
// derives entry_uids from this alphabet; the codec enforces it on both sides.
const URL_SAFE = /^[A-Za-z0-9_-]+$/;

export class InvalidHandleError extends Error {
  constructor(handle: string, reason: string) {
    super(`invalid entry handle ${JSON.stringify(handle)}: ${reason}`);
    this.name = 'InvalidHandleError';
  }
}

/** `evt_<id>` for a chat entry. Throws on a non-finite / non-integer id. */
export function encodeEventHandle(eventId: number): string {
  if (!Number.isSafeInteger(eventId) || eventId < 0) {
    throw new InvalidHandleError(String(eventId), 'event id must be a non-negative safe integer');
  }
  return `${EVT_PREFIX}${eventId}`;
}

/** `rec_<entry_uid>` for a transcript entry. Throws on an empty / non-URL-safe uid. */
export function encodeRecordHandle(entryUid: string): string {
  if (!entryUid || !URL_SAFE.test(entryUid)) {
    throw new InvalidHandleError(entryUid, 'entry_uid must be a non-empty URL-safe token');
  }
  return `${REC_PREFIX}${entryUid}`;
}

/** Encode the typed shape back into its handle string. */
export function encodeHandle(handle: EntryHandle): string {
  switch (handle.type) {
    case 'event':
      return encodeEventHandle(handle.eventId);
    case 'record':
      return encodeRecordHandle(handle.entryUid);
  }
}

/**
 * Decode a handle into its typed shape. Throws `InvalidHandleError` on anything
 * malformed, unknown, or reserved-but-unimplemented (`run_*`). Use
 * {@link tryDecodeHandle} at request boundaries to map failures to a 400.
 */
export function decodeHandle(handle: string): EntryHandle {
  if (typeof handle !== 'string' || handle.length === 0) {
    throw new InvalidHandleError(String(handle), 'empty');
  }

  if (handle.startsWith(EVT_PREFIX)) {
    const body = handle.slice(EVT_PREFIX.length);
    if (!/^\d+$/.test(body)) {
      throw new InvalidHandleError(handle, 'evt_ body must be digits');
    }
    const eventId = Number(body);
    if (!Number.isSafeInteger(eventId)) {
      throw new InvalidHandleError(handle, 'evt_ id out of safe-integer range');
    }
    return { type: 'event', eventId };
  }

  if (handle.startsWith(REC_PREFIX)) {
    const entryUid = handle.slice(REC_PREFIX.length);
    if (!URL_SAFE.test(entryUid)) {
      throw new InvalidHandleError(handle, 'rec_ body must be a URL-safe token');
    }
    return { type: 'record', entryUid };
  }

  if (handle.startsWith(RUN_PREFIX)) {
    // Reserved for child / sub-agent run identity (P3). Intentionally a distinct,
    // explicit error so callers don't confuse "not yet implemented" with "malformed".
    throw new InvalidHandleError(handle, 'run_ handles are reserved and not implemented (P3)');
  }

  throw new InvalidHandleError(handle, 'unknown handle prefix');
}

/** Non-throwing variant — returns null instead of throwing. */
export function tryDecodeHandle(handle: string): EntryHandle | null {
  try {
    return decodeHandle(handle);
  } catch {
    return null;
  }
}

// === Lane C: resolve ===

import type { Db } from './db.js';
import { canAccessChannel } from './events.js';
import { workspaceMemberExists } from './membership.js';

export type NormalizedEntryTargetType = 'event' | 'record';

export interface NormalizedEntry {
  handle: string;
  kind: string;
  actor: string | null;
  text: string;
  meta: Record<string, unknown>;
  targetType: NormalizedEntryTargetType;
  sourceRefs: string[];
  tombstoned: boolean;
}

interface EventResolveRow {
  id: number;
  channel_id: string | null;
  type: string;
  actor_id: string | null;
  payload: unknown;
  edited_text: string | null;
  is_deleted: boolean;
}

interface RecordResolveRow {
  entry_uid: string;
  kind: string;
  actor: string;
  text: string;
  meta: unknown;
}

export function visibleSessionPredicate(userParam: string): string {
  return `((c.kind = 'public' AND ${workspaceMemberExists('c.workspace_id', userParam)})
          OR s.spawned_by = ${userParam}
          OR EXISTS (SELECT 1 FROM channel_members cm
                     WHERE cm.channel_id = c.id AND cm.user_id = ${userParam}))`;
}

export async function resolveEntry(
  db: Db,
  handle: string,
  userId: string,
): Promise<NormalizedEntry | null> {
  const decoded = decodeHandle(handle);
  switch (decoded.type) {
    case 'event':
      return resolveEventEntry(db, decoded.eventId, userId);
    case 'record':
      return resolveRecordEntry(db, decoded.entryUid, userId);
  }
}

async function resolveEventEntry(
  db: Db,
  eventId: number,
  userId: string,
): Promise<NormalizedEntry | null> {
  const res = await db.query<EventResolveRow>(
    `SELECT e.id,
            e.channel_id,
            e.type,
            e.actor_id,
            e.payload,
            edit.text AS edited_text,
            (del.id IS NOT NULL) AS is_deleted
       FROM events e
       LEFT JOIN LATERAL (
         SELECT x.payload->>'text' AS text
           FROM events x
          WHERE x.type = 'message.edited'
            AND (x.payload->>'target_event_id')::bigint = e.id
          ORDER BY x.id DESC
          LIMIT 1
       ) edit ON e.type = 'message.posted'
       LEFT JOIN LATERAL (
         SELECT x.id
           FROM events x
          WHERE x.type = 'message.deleted'
            AND (x.payload->>'target_event_id')::bigint = e.id
          LIMIT 1
       ) del ON e.type = 'message.posted'
      WHERE e.id = $1`,
    [eventId],
  );
  const row = res.rows[0];
  if (!row?.channel_id) return null;
  if (!(await canAccessChannel(db, userId, row.channel_id))) return null;

  const meta = normalizeObject(row.payload);
  const tombstoned = row.type === 'message.deleted' || meta.deleted === true || row.is_deleted;
  return {
    handle: encodeEventHandle(row.id),
    kind: row.type,
    actor: row.actor_id,
    text: tombstoned ? '' : eventText(row, meta),
    meta,
    targetType: 'event',
    sourceRefs: [],
    tombstoned,
  };
}

async function resolveRecordEntry(
  db: Db,
  entryUid: string,
  userId: string,
): Promise<NormalizedEntry | null> {
  const res = await db.query<RecordResolveRow>(
    `SELECT r.entry_uid,
            r.kind,
            r.actor,
            r.text,
            r.meta
       FROM session_records r
       JOIN sessions s ON s.id = r.session_id
       JOIN channels c ON c.id = s.channel_id
      WHERE r.entry_uid = $1
        AND ${visibleSessionPredicate('$2')}
      ORDER BY r.ts DESC, r.session_id ASC, r.seq ASC
      LIMIT 1`,
    [entryUid, userId],
  );
  const row = res.rows[0];
  if (!row) return null;

  const meta = normalizeObject(row.meta);
  return {
    handle: encodeRecordHandle(row.entry_uid),
    kind: row.kind,
    actor: row.actor,
    text: row.text,
    meta,
    targetType: 'record',
    sourceRefs: sourceRefsFromMeta(meta),
    tombstoned: meta.tombstoned === true || meta.deleted === true,
  };
}

function eventText(row: EventResolveRow, meta: Record<string, unknown>): string {
  if (row.type === 'message.posted' && row.edited_text != null) return row.edited_text;
  return typeof meta.text === 'string' ? meta.text : '';
}

function sourceRefsFromMeta(meta: Record<string, unknown>): string[] {
  const sourceEventIds = meta.sourceEventIds;
  if (!Array.isArray(sourceEventIds)) return [];
  return sourceEventIds
    .filter((value) => typeof value === 'string' || typeof value === 'number')
    .map((value) => String(value));
}

function normalizeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
