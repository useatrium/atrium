import {
  decodeHandle as decodeBaseHandle,
  encodeEventHandle,
  encodeHandle as encodeBaseHandle,
  encodeRecordHandle,
  InvalidHandleError,
  tryDecodeHandle as tryDecodeBaseHandle,
  type EntryHandle as BaseEntryHandle,
} from '@atrium/surface-client/handle';
import type { EntryReferencesResponse, NormalizedEntry } from '@atrium/surface-client/entry-contracts';
export type { EntryReferencesResponse, NormalizedEntry } from '@atrium/surface-client/entry-contracts';
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

interface EventResolveRow {
  id: number;
  workspace_id: string;
  channel_id: string | null;
  channel_name: string | null;
  thread_root_event_id: number | null;
  type: string;
  actor_id: string | null;
  actor_display_name: string | null;
  payload: unknown;
  edited_text: string | null;
  is_deleted: boolean;
}

interface RecordResolveRow {
  entry_uid: string;
  workspace_id: string;
  channel_id: string;
  channel_name: string | null;
  session_id: string;
  session_title: string | null;
  kind: string;
  actor: string;
  text: string;
  meta: unknown;
}

interface ArtifactResolveRow {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  channel_name: string | null;
  path: string;
  tombstoned_at: Date | string | null;
}

interface EntryReferenceQueryRow {
  queried_handle: string;
  event_id: number;
  channel_id: string;
  thread_root_event_id: number | null;
  actor_label: string | null;
  excerpt: string;
  created_at: Date;
  ref_count: string | number;
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
            e.workspace_id::text,
            e.channel_id,
            c.name AS channel_name,
            e.thread_root_event_id,
            e.type,
            e.actor_id,
            u.display_name AS actor_display_name,
            e.payload,
            edit.text AS edited_text,
            (del.id IS NOT NULL) AS is_deleted
       FROM events e
       LEFT JOIN channels c ON c.id = e.channel_id
       LEFT JOIN users u ON u.id = e.actor_id
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
    actorLabel: row.actor_display_name ?? null,
    text: tombstoned ? '' : eventText(row, meta),
    meta,
    targetType: 'event',
    sourceRefs: [],
    tombstoned,
    location: {
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      channelName: row.channel_name,
      threadRootEventId: row.thread_root_event_id,
      sessionId: null,
      sessionTitle: null,
    },
  };
}

async function resolveRecordEntry(
  db: Db,
  entryUid: string,
  userId: string,
): Promise<NormalizedEntry | null> {
  const res = await db.query<RecordResolveRow>(
    `SELECT r.entry_uid,
            s.workspace_id::text,
            s.channel_id::text,
            c.name AS channel_name,
            s.id AS session_id,
            s.title AS session_title,
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
    actorLabel: row.actor,
    text: row.text,
    meta,
    targetType: 'record',
    sourceRefs: sourceRefsFromMeta(meta),
    tombstoned: meta.tombstoned === true || meta.deleted === true,
    location: {
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      channelName: row.channel_name,
      threadRootEventId: null,
      sessionId: row.session_id,
      sessionTitle: row.session_title,
    },
  };
}

async function resolveArtifactEntry(
  db: Db,
  artifactId: string,
  userId: string,
): Promise<NormalizedEntry | null> {
  const res = await db.query<ArtifactResolveRow>(
    `SELECT a.id::text,
            a.workspace_id::text,
            a.channel_id::text,
            c.name AS channel_name,
            a.path,
            a.tombstoned_at
       FROM artifacts a
       LEFT JOIN channels c ON c.id = a.channel_id
      WHERE a.id = $1`,
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
    actorLabel: null,
    text: artifactName(row.path),
    meta,
    targetType: 'artifact',
    sourceRefs: [],
    tombstoned,
    location: {
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      channelName: row.channel_name,
      threadRootEventId: null,
      sessionId: null,
      sessionTitle: null,
    },
  };
}

export async function queryEntryReferences(
  db: Db,
  handles: string[],
  userId: string,
): Promise<EntryReferencesResponse> {
  if (handles.length === 0) return { references: {} };
  const uniqueHandles = Array.from(new Set(handles));
  const res = await db.query<EntryReferenceQueryRow>(
    `WITH input AS (
       SELECT unnest($1::text[]) AS handle
     ),
     candidates AS (
       -- Start from both GIN-indexed ref columns, then re-check the root
       -- against its latest edit below. That preserves latest-text-wins
       -- semantics while avoiding a full scan for handles introduced by edits.
       SELECT input.handle AS queried_handle, e.id AS event_id
         FROM input
         JOIN events e
           ON e.type = 'message.posted'
          AND e.payload->'entry_refs' @> to_jsonb(ARRAY[input.handle]::text[])
       UNION
       SELECT input.handle AS queried_handle, root.id AS event_id
         FROM input
         JOIN events edit_match
           ON edit_match.type = 'message.edited'
          AND edit_match.payload->'entry_refs' @> to_jsonb(ARRAY[input.handle]::text[])
         JOIN events root
           ON root.type = 'message.posted'
          AND root.id = CASE
                WHEN edit_match.payload->>'target' ~ '^evt_[0-9]+$'
                THEN substring(edit_match.payload->>'target' FROM 5)::bigint
              END
     ),
     visible_refs AS (
       SELECT candidates.queried_handle,
              e.id AS event_id,
              e.channel_id::text AS channel_id,
              e.thread_root_event_id,
              u.display_name AS actor_label,
              substring(
                COALESCE(
                  CASE WHEN latest_edit.id IS NOT NULL THEN latest_edit.payload->>'text' ELSE e.payload->>'text' END,
                  ''
                )
                from 1 for 140
              ) AS excerpt,
              e.created_at,
              count(*) OVER (PARTITION BY candidates.queried_handle) AS ref_count,
              row_number() OVER (PARTITION BY candidates.queried_handle ORDER BY e.created_at DESC, e.id DESC) AS rn
         FROM candidates
         JOIN events e ON e.id = candidates.event_id
         LEFT JOIN LATERAL (
           SELECT x.id, x.payload
             FROM events x
            WHERE x.type = 'message.edited'
              AND x.payload->>'target' = ('evt_' || e.id::text)
            ORDER BY x.id DESC
            LIMIT 1
         ) latest_edit ON true
         JOIN channels c ON c.id = e.channel_id
         LEFT JOIN users u ON u.id = e.actor_id
        WHERE COALESCE(
                CASE
                  WHEN latest_edit.id IS NOT NULL THEN latest_edit.payload->'entry_refs'
                  ELSE e.payload->'entry_refs'
                END,
                '[]'::jsonb
              ) @> to_jsonb(ARRAY[candidates.queried_handle]::text[])
          AND NOT EXISTS (
                SELECT 1 FROM events d
                 WHERE d.type = 'message.deleted'
                   AND d.payload->>'target' = ('evt_' || e.id::text)
              )
          AND ((c.kind = 'public' AND ${workspaceMemberExists('c.workspace_id', '$2')})
            OR EXISTS (SELECT 1 FROM channel_members cm
                        WHERE cm.channel_id = c.id AND cm.user_id = $2))
     )
     SELECT queried_handle,
            event_id,
            channel_id,
            thread_root_event_id,
            actor_label,
            excerpt,
            created_at,
            ref_count
       FROM visible_refs
      WHERE rn <= 3
      ORDER BY queried_handle ASC, created_at DESC, event_id DESC`,
    [uniqueHandles, userId],
  );

  const references: EntryReferencesResponse['references'] = {};
  for (const row of res.rows) {
    const bucket =
      references[row.queried_handle] ??
      (references[row.queried_handle] = {
        count: Number(row.ref_count),
        latest: [],
      });
    bucket.latest.push({
      eventId: Number(row.event_id),
      handle: encodeEventHandle(Number(row.event_id)),
      channelId: row.channel_id,
      threadRootEventId: row.thread_root_event_id == null ? null : Number(row.thread_root_event_id),
      actorLabel: row.actor_label,
      excerpt: row.excerpt,
      ts: new Date(row.created_at).toISOString(),
    });
  }
  return { references };
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
