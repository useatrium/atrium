import {
  decodeHandle as decodeBaseHandle,
  encodeEventHandle,
  encodeHandle as encodeBaseHandle,
  encodeRecordHandle,
  InvalidHandleError,
  tryDecodeHandle as tryDecodeBaseHandle,
  type EntryHandle as BaseEntryHandle,
} from '@atrium/surface-client/handle';
export {
  encodeEventHandle,
  encodeRecordHandle,
  eventIdFromTarget,
  InvalidHandleError,
} from '@atrium/surface-client/handle';

// === Lane C: resolve ===

import type { Db } from './db.js';
import { canAccessChannel } from './events.js';
import { workspaceMemberExists } from './membership.js';

export type ArtifactEntryHandle = { type: 'artifact'; artifactId: string };
export type EntryHandle = BaseEntryHandle | ArtifactEntryHandle;
export type EntryHandleType = EntryHandle['type'];

const ART_PREFIX = 'art_';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeArtifactHandle(artifactId: string): string {
  if (!UUID_RE.test(artifactId)) {
    throw new InvalidHandleError(artifactId, 'artifact id must be a UUID');
  }
  return `${ART_PREFIX}${artifactId}`;
}

export function encodeHandle(handle: EntryHandle): string {
  return handle.type === 'artifact' ? encodeArtifactHandle(handle.artifactId) : encodeBaseHandle(handle);
}

export function decodeHandle(handle: string): EntryHandle {
  if (typeof handle === 'string' && handle.startsWith(ART_PREFIX)) {
    const artifactId = handle.slice(ART_PREFIX.length);
    if (!UUID_RE.test(artifactId)) {
      throw new InvalidHandleError(handle, 'art_ body must be a UUID');
    }
    return { type: 'artifact', artifactId };
  }
  return decodeBaseHandle(handle);
}

export function tryDecodeHandle(handle: string): EntryHandle | null {
  if (typeof handle === 'string' && handle.startsWith(ART_PREFIX)) {
    try {
      return decodeHandle(handle);
    } catch {
      return null;
    }
  }
  return tryDecodeBaseHandle(handle);
}

export type NormalizedEntryTargetType = 'event' | 'record' | 'artifact';

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

interface ArtifactResolveRow {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  path: string;
  tombstoned_at: Date | string | null;
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
    case 'artifact':
      return resolveArtifactEntry(db, decoded.artifactId, userId);
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
            AND x.payload->>'target' = ('evt_' || e.id::text)
          ORDER BY x.id DESC
          LIMIT 1
       ) edit ON e.type = 'message.posted'
       LEFT JOIN LATERAL (
         SELECT x.id
          FROM events x
          WHERE x.type = 'message.deleted'
            AND x.payload->>'target' = ('evt_' || e.id::text)
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

async function resolveArtifactEntry(
  db: Db,
  artifactId: string,
  userId: string,
): Promise<NormalizedEntry | null> {
  const res = await db.query<ArtifactResolveRow>(
    `SELECT id::text,
            workspace_id::text,
            channel_id::text,
            path,
            tombstoned_at
       FROM artifacts
      WHERE id = $1`,
    [artifactId],
  );
  const row = res.rows[0];
  if (!row?.channel_id) return null;

  const { ArtifactLedger } = await import('./artifact-ledger.js');
  const access = await new ArtifactLedger(db).artifactReadableByUser(artifactId, userId);
  if (!access) return null;

  const tombstoned = row.tombstoned_at != null || access.tombstoned;
  const meta = {
    artifactId: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    path: row.path,
  };
  return {
    handle: encodeArtifactHandle(row.id),
    kind: 'artifact',
    actor: null,
    text: artifactName(row.path),
    meta,
    targetType: 'artifact',
    sourceRefs: [],
    tombstoned,
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

function artifactName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}
