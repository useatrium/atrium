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
