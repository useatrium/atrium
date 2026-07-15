import type { Db, DbClient } from '../db.js';
import {
  sqlTypeList,
  SYNC_EVENT_TYPES as SYNC_EVENT_TYPE_VALUES,
  TIMELINE_EVENT_TYPES as TIMELINE_EVENT_TYPE_VALUES,
  TIMELINE_ROOT_EVENT_TYPES as TIMELINE_ROOT_EVENT_TYPE_VALUES,
} from '../event-types.js';
import { workspaceMemberExists } from '../membership.js';
import {
  foldEdit,
  toWireEvent,
  type AnnotationFold,
  type Channel,
  type EventDbRow,
  type UserRef,
  type WireEvent,
  type Workspace,
} from './wire.js';

// ---------------------------------------------------------------------------
// Reads (straight off the events table)
// ---------------------------------------------------------------------------

export async function foldAnnotations(db: Db | DbClient, handle: string): Promise<AnnotationFold> {
  const reactions = await db.query<{ emoji: string; user_ids: string[] }>(
    `SELECT emoji, array_agg(actor_id::text ORDER BY first_id) AS user_ids
       FROM (
         SELECT x.actor_id,
                x.payload->>'emoji' AS emoji,
                SUM(CASE WHEN x.type = 'reaction.added' THEN 1 ELSE -1 END) AS net,
                MIN(x.id) AS first_id
           FROM events x
          WHERE x.type IN ('reaction.added', 'reaction.removed')
            AND x.payload->>'target' = $1
          GROUP BY x.actor_id, x.payload->>'emoji'
       ) n
      WHERE n.net > 0
      GROUP BY emoji
      ORDER BY MIN(first_id)`,
    [handle],
  );
  return {
    reactions: reactions.rows.map((row) => ({
      emoji: row.emoji,
      userIds: row.user_ids,
    })),
  };
}

const MESSAGE_SELECT = `
  SELECT e.*,
         u.handle AS author_handle,
         u.display_name AS author_display_name,
         coalesce(ms.reply_count, 0)::int AS reply_count,
         coalesce(ms.last_reply_id, 0)::bigint AS last_reply_id,
         lr.id AS last_reply_preview_id,
         CASE
           WHEN lr.type IN ('session.replied', 'session.question_requested')
             THEN 'agent:' || coalesce(lr.payload->>'sessionId', lr.payload->>'session_id', 'unknown')
           ELSE lr.actor_id::text
         END AS last_reply_author_id,
         CASE
           WHEN lr.type IN ('session.replied', 'session.question_requested') THEN 'Agent'
           ELSE coalesce(lru.display_name, lru.handle)
         END AS last_reply_author_display_name,
         left(coalesce(lr_ms.edited_text, lr.payload->>'text', lr.payload->>'question', lr.payload->>'title', ''), 200)
           AS last_reply_text,
         lr.created_at AS last_reply_created_at,
         (lr.type IN ('session.replied', 'session.question_requested')) AS last_reply_agent_voice,
         lr.type AS last_reply_event_type,
         (e.payload->>'broadcast')::boolean AS broadcast,
         ms.edited_text AS edited_text,
         ms.suppressed_unfurls AS suppressed_unfurls,
         coalesce(ms.is_deleted, false) AS is_deleted,
         ms.reactions AS reactions,
         vt.status AS transcript_status,
         vt.text AS transcript_text,
         vt.lang AS transcript_lang
  FROM events e
  LEFT JOIN users u ON u.id = e.actor_id
  LEFT JOIN message_state ms ON ms.event_id = e.id
  LEFT JOIN events lr ON lr.id = ms.last_reply_id
  LEFT JOIN users lru ON lru.id = lr.actor_id
  LEFT JOIN message_state lr_ms ON lr_ms.event_id = ms.last_reply_id
  LEFT JOIN transcripts vt ON vt.event_id = e.id
`;

// Message modifier events are included so after_id
// catch-up heals changes made while a client was disconnected (live clients
// fold the same events from WS fanout).
const TIMELINE_EVENT_TYPES = sqlTypeList(TIMELINE_EVENT_TYPE_VALUES);
// `session.replied` is here because the agent's ANSWER is a first-class channel
// message: it is thread-rooted, so the `broadcast` predicate below still gates
// it, but the type has to be admitted first or the answer is filtered out of
// the feed before the flag is ever read.
const TIMELINE_ROOT_EVENT_TYPES = sqlTypeList(TIMELINE_ROOT_EVENT_TYPE_VALUES);

export interface MessagePage {
  events: WireEvent[];
  hasMore: boolean;
}

export interface SyncEventsPage {
  events: WireEvent[];
  nextCursor: number;
  limited: boolean;
}

/**
 * Channel timeline reads, newest-last.
 * - default / before_id: root messages only (thread replies excluded).
 * - after_id: ALL message events in the channel (including thread replies),
 *   so reconnecting clients can catch up on reply counts and open threads.
 */
export async function listChannelMessages(
  pool: Db,
  args: { channelId: string; beforeId?: number; afterId?: number; limit?: number },
): Promise<MessagePage> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const params: unknown[] = [args.channelId, limit + 1];
  let rows: EventDbRow[];
  if (args.afterId !== undefined) {
    params.push(args.afterId);
    const res = await pool.query<EventDbRow>(
      `${MESSAGE_SELECT}
       WHERE e.channel_id = $1 AND e.type IN ${TIMELINE_EVENT_TYPES} AND e.id > $3
       ORDER BY e.id ASC
       LIMIT $2`,
      params,
    );
    rows = res.rows;
    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    return { events: rows.map((r) => toWireEvent(foldEdit(r))), hasMore };
  }
  if (args.beforeId !== undefined) params.push(args.beforeId);
  const res = await pool.query<EventDbRow>(
    `${MESSAGE_SELECT}
     WHERE e.channel_id = $1
       AND e.type IN ${TIMELINE_ROOT_EVENT_TYPES}
       AND (e.thread_root_event_id IS NULL OR (e.payload->>'broadcast')::boolean IS TRUE)
       ${args.beforeId !== undefined ? 'AND e.id < $3' : ''}
     ORDER BY e.id DESC
     LIMIT $2`,
    params,
  );
  rows = res.rows;
  const hasMore = rows.length > limit;
  if (hasMore) rows = rows.slice(0, limit);
  rows.reverse(); // newest-last
  return { events: rows.map((r) => toWireEvent(foldEdit(r))), hasMore };
}

/** All replies in a thread, oldest-first. */
export async function listThreadMessages(pool: Db, args: { rootEventId: number }): Promise<{ events: WireEvent[] }> {
  const res = await pool.query<EventDbRow>(
    `${MESSAGE_SELECT}
     WHERE e.thread_root_event_id = $1 AND e.type IN ${TIMELINE_EVENT_TYPES}
     ORDER BY e.id ASC
     LIMIT $2`,
    [args.rootEventId, 1000],
  );
  return { events: res.rows.map((r) => toWireEvent(foldEdit(r))) };
}

// /sync mirrors the reducer-visible event families. Workspace-scoped
// workspace.created is intentionally excluded: there is no live fanout today
// and no client reducer consumes it.
const SYNC_EVENT_TYPES = sqlTypeList(SYNC_EVENT_TYPE_VALUES);

function syncVisibleCte(userUuidParam: string, userTextParam: string): string {
  const workspaceMember = workspaceMemberExists('e.workspace_id', userUuidParam);
  return `
  visible AS (
    SELECT e.id
    FROM events e
    LEFT JOIN channels c ON c.id = e.channel_id
    LEFT JOIN channel_members cm
      ON cm.channel_id = e.channel_id AND cm.user_id = ${userUuidParam}
    LEFT JOIN LATERAL (
      SELECT MAX(j.id) AS join_event_id
      FROM events j
      WHERE j.channel_id = e.channel_id
        AND j.type = 'channel.member_joined'
        AND j.payload->>'userId' = ${userTextParam}
    ) latest_join ON true
    WHERE e.type IN ${SYNC_EVENT_TYPES}
      AND (
        (c.kind = 'public' AND ${workspaceMember})
        OR (
          c.kind IN ('private', 'dm', 'gdm')
          AND cm.user_id IS NOT NULL
          AND e.id >= COALESCE(latest_join.join_event_id, 0)
        )
        OR (
          -- A user keeps seeing their own leave event after channel_members is removed.
          e.type = 'channel.member_left'
          AND e.payload->>'userId' = ${userTextParam}
        )
      )
  )
`;
}

/**
 * Unified workspace sync stream. Visibility intentionally follows current
 * membership for private/DM channels, with the user's join event as the lower
 * bound when one exists, so /sync guarantees forward continuity without
 * backfilling pre-join history.
 */
export async function listVisibleSyncEvents(
  db: Db | DbClient,
  args: { userId: string; after: number; limit: number },
): Promise<SyncEventsPage> {
  const maxCursor = await db.query<{ max_id: number }>(
    `WITH ${syncVisibleCte('$1', '$2')}
     SELECT COALESCE((SELECT id FROM visible ORDER BY id DESC LIMIT 1), 0)::bigint AS max_id`,
    [args.userId, args.userId],
  );
  const nextCursor = Number(maxCursor.rows[0]?.max_id ?? 0);

  const probe = await db.query<{ id: number }>(
    `WITH ${syncVisibleCte('$1', '$4')}
     SELECT id
     FROM visible
     WHERE id > $2
     ORDER BY id ASC
     LIMIT $3`,
    [args.userId, args.after, args.limit + 1, args.userId],
  );
  if (probe.rows.length > args.limit) {
    return { events: [], nextCursor, limited: true };
  }

  const res = await db.query<EventDbRow>(
    `WITH ${syncVisibleCte('$1', '$4')}
     ${MESSAGE_SELECT}
     JOIN visible v ON v.id = e.id
     WHERE e.id > $2
     ORDER BY e.id ASC
     LIMIT $3`,
    [args.userId, args.after, args.limit, args.userId],
  );
  return {
    events: res.rows.map((r) => toWireEvent(foldEdit(r))),
    nextCursor,
    limited: false,
  };
}
export interface SearchHit {
  event: WireEvent;
  channelName: string;
}

/**
 * Full-text search over messages. Matches the posted text OR any edited
 * revision (so edits that introduce a term are findable); deleted messages
 * never surface. Newest first.
 */
export async function searchMessages(
  pool: Db,
  args: { query: string; userId: string; limit?: number },
): Promise<SearchHit[]> {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
  const res = await pool.query<EventDbRow & { channel_name: string }>(
    `WITH hits AS (
       SELECT DISTINCT CASE WHEN x.type = 'message.posted' THEN x.id
                            ELSE substring(x.payload->>'target' FROM 5)::bigint END AS msg_id
       FROM events x
       WHERE x.type IN ('message.posted', 'message.edited')
         AND to_tsvector('english', coalesce(x.payload->>'text', ''))
             @@ websearch_to_tsquery('english', $1)
     )
     SELECT m.*, c.name AS channel_name
     FROM (
       ${MESSAGE_SELECT}
       WHERE e.type = 'message.posted'
         AND e.id IN (SELECT msg_id FROM hits WHERE msg_id IS NOT NULL)
         AND NOT coalesce(ms.is_deleted, false)
       ORDER BY e.id DESC
       LIMIT $2
     ) m
     JOIN channels c ON c.id = m.channel_id
    WHERE (c.kind = 'public' AND ${workspaceMemberExists('c.workspace_id', '$3')})
        OR EXISTS (SELECT 1 FROM channel_members cm
                   WHERE cm.channel_id = c.id AND cm.user_id = $3)
     ORDER BY m.id DESC`,
    [args.query, limit, args.userId],
  );
  return res.rows.map((r) => ({
    event: toWireEvent(foldEdit(r)),
    channelName: r.channel_name,
  }));
}

export async function listWorkspaces(pool: Db): Promise<Workspace[]> {
  const res = await pool.query<{ id: string; name: string; created_at: Date }>(
    'SELECT * FROM workspaces ORDER BY created_at ASC',
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function listChannels(pool: Db, userId: string, workspaceId?: string): Promise<Channel[]> {
  const res = workspaceId
    ? await pool.query(
        `SELECT c.* FROM channels c
         WHERE c.workspace_id = $1
           AND c.kind = 'public'
           AND ${workspaceMemberExists('c.workspace_id', '$2')}
         ORDER BY name ASC`,
        [workspaceId, userId],
      )
    : await pool.query(
        `SELECT c.* FROM channels c
         WHERE c.kind = 'public'
           AND ${workspaceMemberExists('c.workspace_id', '$1')}
         ORDER BY name ASC`,
        [userId],
      );
  return res.rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    createdAt: new Date(r.created_at).toISOString(),
    archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
    pinned: false,
    kind: 'public' as const,
  }));
}

/** Public channels plus the user's private channels/DMs/GDMs. */
export async function listChannelsFor(pool: Db | DbClient, userId: string): Promise<Channel[]> {
  const res = await pool.query<{
    id: string;
    workspace_id: string;
    name: string;
    created_at: Date;
    archived_at: Date | null;
    kind: 'public' | 'private' | 'dm' | 'gdm';
    last_read_event_id: string;
    latest_event_id: string;
    muted: boolean;
    pinned: boolean;
    member_count: string;
    mentioned_since_read: boolean;
  }>(
    `SELECT c.*,
            COALESCE(rc.last_read_event_id, 0) AS last_read_event_id,
            COALESCE(latest.latest_event_id, 0) AS latest_event_id,
            (cm.user_id IS NOT NULL) AS muted,
            (cp.user_id IS NOT NULL) AS pinned,
            COALESCE(member_counts.member_count, 0) AS member_count,
            -- === mentions-activity additions ===
            COALESCE(mentions_since_read.mentioned_since_read, false) AS mentioned_since_read
     FROM channels c
     LEFT JOIN channel_read_cursors rc
       ON rc.channel_id = c.id AND rc.user_id = $1
     LEFT JOIN channel_mutes cm
       ON cm.channel_id = c.id AND cm.user_id = $1
     LEFT JOIN channel_pins cp
       ON cp.channel_id = c.id AND cp.user_id = $1
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS member_count
       FROM channel_members m
       WHERE m.channel_id = c.id
     ) member_counts ON c.kind IN ('private', 'gdm')
     LEFT JOIN LATERAL (
       SELECT MAX(e.id) AS latest_event_id
       FROM events e
       WHERE e.channel_id = c.id
         -- The agent's answer is an ordinary channel message, so it marks the
         -- channel unread like one. Leaving it out would land the very thing
         -- you asked for below the fold with nothing to say it had arrived.
         AND e.type IN ('message.posted', 'session.spawned', 'session.replied')
         AND (e.thread_root_event_id IS NULL OR (e.payload->>'broadcast')::boolean IS TRUE)
     ) latest ON true
     -- === mentions-activity additions ===
     LEFT JOIN LATERAL (
       SELECT true AS mentioned_since_read
       FROM mentions mn
       WHERE mn.channel_id = c.id
         AND mn.user_id = $1
         AND mn.event_id > COALESCE(rc.last_read_event_id, 0)
       LIMIT 1
     ) mentions_since_read ON true
     WHERE (c.kind = 'public' AND ${workspaceMemberExists('c.workspace_id', '$1')})
        OR EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.user_id = $1)
     ORDER BY c.name ASC`,
    [userId],
  );
  const memberListIds = res.rows.filter((r) => r.kind === 'dm' || r.kind === 'gdm').map((r) => r.id);
  const membersByChannel = new Map<string, UserRef[]>();
  if (memberListIds.length > 0) {
    const members = await pool.query<{
      channel_id: string;
      id: string;
      handle: string;
      display_name: string;
    }>(
      `SELECT m.channel_id, u.id, u.handle, u.display_name
       FROM channel_members m JOIN users u ON u.id = m.user_id
       WHERE m.channel_id = ANY($1::uuid[])
       ORDER BY u.handle ASC`,
      [memberListIds],
    );
    for (const row of members.rows) {
      const list = membersByChannel.get(row.channel_id) ?? [];
      list.push({ id: row.id, handle: row.handle, displayName: row.display_name });
      membersByChannel.set(row.channel_id, list);
    }
  }
  return res.rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    createdAt: new Date(r.created_at).toISOString(),
    archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
    pinned: r.pinned,
    kind: r.kind,
    lastReadEventId: Number(r.last_read_event_id),
    latestEventId: Number(r.latest_event_id),
    muted: r.muted,
    // === mentions-activity additions ===
    mentionedSinceRead: r.mentioned_since_read,
    ...(r.kind === 'dm' || r.kind === 'gdm' ? { members: membersByChannel.get(r.id) ?? [] } : {}),
    ...(r.kind === 'private' ? { memberCount: Number(r.member_count) } : {}),
  }));
}

/** True when the user may read/post in the channel (public, or member-only kinds). */
export async function canAccessChannel(
  pool: Pick<Db | DbClient, 'query'>,
  userId: string,
  channelId: string,
): Promise<boolean> {
  const res = await pool.query<{ kind: string; member: boolean }>(
    `SELECT c.kind,
            CASE WHEN c.kind = 'public' THEN ${workspaceMemberExists('c.workspace_id', '$2')}
                 ELSE EXISTS (SELECT 1 FROM channel_members m
                              WHERE m.channel_id = c.id AND m.user_id = $2)
            END AS member
     FROM channels c WHERE c.id = $1`,
    [channelId, userId],
  );
  const row = res.rows[0];
  if (!row) return false;
  return row.member;
}

/**
 * May this user fetch this file? Files are uploaded before they're attached,
 * so the uploader always can; otherwise access follows the channel(s) the file
 * is attached to (so a member who left a private channel can no longer pull
 * its attachments). File ids are unguessable UUIDv4s, so this is defense in
 * depth against a leaked/retained id, not the primary boundary.
 */
export async function canAccessFile(pool: Db, userId: string, fileId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) return false;
  // Cast columns to text (not the params) so $1/$2 stay unambiguously text —
  // casting a param to ::uuid makes Postgres infer it as uuid everywhere,
  // which then breaks the text `a->>'id' = $1` comparison.
  const res = await pool.query<{ ok: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM files f WHERE f.id::text = $1 AND f.uploader_id::text = $2)
       OR EXISTS (
         SELECT 1 FROM events e
         JOIN channels c ON c.id = e.channel_id
         WHERE e.type = 'message.posted'
           AND ((c.kind = 'public'
                AND EXISTS (SELECT 1 FROM workspace_members wm
                            WHERE wm.workspace_id = c.workspace_id AND wm.user_id::text = $2))
                OR EXISTS (SELECT 1 FROM channel_members m
                           WHERE m.channel_id = c.id AND m.user_id::text = $2))
           AND jsonb_typeof(e.payload->'attachments') = 'array'
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.payload->'attachments') a
                       WHERE a->>'id' = $1)
       )
     ) AS ok`,
    [fileId, userId],
  );
  return res.rows[0]?.ok === true;
}

export async function listUsers(pool: Db, userId: string): Promise<UserRef[]> {
  const res = await pool.query<{ id: string; handle: string; display_name: string }>(
    `SELECT DISTINCT u.id, u.handle, u.display_name
     FROM users u
     JOIN workspace_members theirs ON theirs.user_id = u.id
     JOIN workspace_members mine
       ON mine.workspace_id = theirs.workspace_id AND mine.user_id = $1
     ORDER BY u.handle ASC`,
    [userId],
  );
  return res.rows.map((r) => ({ id: r.id, handle: r.handle, displayName: r.display_name }));
}

export async function membersForChannel(client: Db | DbClient, channelId: string): Promise<UserRef[]> {
  const members = await client.query<{ id: string; handle: string; display_name: string }>(
    `SELECT u.id, u.handle, u.display_name
     FROM channel_members m JOIN users u ON u.id = m.user_id
     WHERE m.channel_id = $1
     ORDER BY u.handle ASC`,
    [channelId],
  );
  return members.rows.map((r) => ({ id: r.id, handle: r.handle, displayName: r.display_name }));
}

export async function listChannelMembers(
  pool: Db,
  args: { channelId: string; userId: string },
): Promise<{ channel: Pick<Channel, 'id' | 'kind'>; members: UserRef[] } | null> {
  const access = await pool.query<{ kind: Channel['kind']; member: boolean }>(
    `SELECT c.kind,
            EXISTS (SELECT 1 FROM channel_members m
                    WHERE m.channel_id = c.id AND m.user_id = $2) AS member
     FROM channels c
     WHERE c.id = $1`,
    [args.channelId, args.userId],
  );
  const row = access.rows[0];
  if (!row || row.kind === 'public' || !row.member) return null;
  return {
    channel: { id: args.channelId, kind: row.kind },
    members: await membersForChannel(pool, args.channelId),
  };
}
