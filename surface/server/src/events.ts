import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';
import { workspaceMemberExists } from './membership.js';

export interface UserRef {
  id: string;
  handle: string;
  displayName: string;
}

/** Wire shape of an event, as fanned out over WS and returned from reads. */
export interface WireEvent {
  id: number;
  workspaceId: string;
  channelId: string | null;
  threadRootEventId: number | null;
  type: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  author: UserRef | null;
  /** Only present on timeline/thread reads of message.posted events. */
  replyCount?: number;
  /** Highest reply event id counted in replyCount (0 if none). */
  lastReplyId?: number;
}

export class DomainError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface EventDbRow {
  id: number;
  workspace_id: string;
  channel_id: string | null;
  thread_root_event_id: number | null;
  type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
  author_handle?: string | null;
  author_display_name?: string | null;
  reply_count?: number;
  last_reply_id?: number;
}

function toWireEvent(row: EventDbRow): WireEvent {
  const ev: WireEvent = {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    threadRootEventId: row.thread_root_event_id,
    type: row.type,
    actorId: row.actor_id,
    payload: row.payload,
    createdAt: new Date(row.created_at).toISOString(),
    author:
      row.actor_id && row.author_handle
        ? {
            id: row.actor_id,
            handle: row.author_handle,
            displayName: row.author_display_name ?? row.author_handle,
          }
        : null,
  };
  if (row.reply_count !== undefined) ev.replyCount = Number(row.reply_count);
  if (row.last_reply_id !== undefined) ev.lastReplyId = Number(row.last_reply_id);
  return ev;
}

interface InsertEventArgs {
  workspaceId: string;
  channelId?: string | null;
  threadRootEventId?: number | null;
  type: string;
  actorId?: string | null;
  payload?: Record<string, unknown>;
}

/** Append one event inside an existing transaction. */
async function insertEvent(client: DbClient, args: InsertEventArgs): Promise<EventDbRow> {
  const res = await client.query<EventDbRow>(
    `INSERT INTO events (workspace_id, channel_id, thread_root_event_id, type, actor_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      args.workspaceId,
      args.channelId ?? null,
      args.threadRootEventId ?? null,
      args.type,
      args.actorId ?? null,
      JSON.stringify(args.payload ?? {}),
    ],
  );
  return res.rows[0]!;
}

export async function appendEvent(client: DbClient, args: InsertEventArgs): Promise<WireEvent> {
  return toWireEvent(await attachAuthor(client, await insertEvent(client, args)));
}

async function attachAuthor(client: DbClient, row: EventDbRow): Promise<EventDbRow> {
  if (!row.actor_id) return row;
  const u = await client.query<{ handle: string; display_name: string }>(
    'SELECT handle, display_name FROM users WHERE id = $1',
    [row.actor_id],
  );
  if (u.rows[0]) {
    row.author_handle = u.rows[0].handle;
    row.author_display_name = u.rows[0].display_name;
  }
  return row;
}

// ---------------------------------------------------------------------------
// Commands (event insert + read-model update in one transaction)
// ---------------------------------------------------------------------------

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
}

export async function createWorkspace(
  pool: Db,
  args: { name: string; actorId?: string | null },
): Promise<{ workspace: Workspace; event: WireEvent }> {
  return withTx(pool, async (client) => {
    const ws = await client.query<{ id: string; name: string; created_at: Date }>(
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING *',
      [args.name],
    );
    const row = ws.rows[0]!;
    const ev = await insertEvent(client, {
      workspaceId: row.id,
      type: 'workspace.created',
      actorId: args.actorId ?? null,
      payload: { name: row.name },
    });
    return {
      workspace: {
        id: row.id,
        name: row.name,
        createdAt: new Date(row.created_at).toISOString(),
      },
      event: toWireEvent(await attachAuthor(client, ev)),
    };
  });
}

export interface Channel {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  kind: 'public' | 'private' | 'dm' | 'gdm';
  lastReadEventId?: number;
  latestEventId?: number;
  muted?: boolean;
  /** DM/GDM channels only: the member list. */
  members?: UserRef[];
  /** Private channels only: count of members, without shipping the full list. */
  memberCount?: number;
}

export async function createChannel(
  pool: Db,
  args: { workspaceId: string; name: string; actorId?: string | null; private?: boolean },
): Promise<{ channel: Channel; event: WireEvent }> {
  try {
    return await withTx(pool, async (client) => {
      const ch = await client.query<{
        id: string;
        workspace_id: string;
        name: string;
        created_at: Date;
        kind: 'public' | 'private';
      }>(
        'INSERT INTO channels (workspace_id, name, kind, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
        [args.workspaceId, args.name, args.private ? 'private' : 'public', args.actorId ?? null],
      );
      const row = ch.rows[0]!;
      if (row.kind === 'private' && args.actorId) {
        await client.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [
          row.id,
          args.actorId,
        ]);
      }
      const ev = await insertEvent(client, {
        workspaceId: args.workspaceId,
        channelId: row.id,
        type: 'channel.created',
        actorId: args.actorId ?? null,
        payload: { name: row.name },
      });
      return {
        channel: {
          id: row.id,
          workspaceId: row.workspace_id,
          name: row.name,
          createdAt: new Date(row.created_at).toISOString(),
          kind: row.kind,
          ...(row.kind === 'private' ? { memberCount: args.actorId ? 1 : 0 } : {}),
        },
        event: toWireEvent(await attachAuthor(client, ev)),
      };
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new DomainError(409, 'channel_exists', `channel "${args.name}" already exists`);
    }
    throw err;
  }
}

/** Attachment metadata embedded in message payloads (body lives in S3). */
export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  width?: number;
  height?: number;
}

export async function postMessage(
  pool: Db,
  args: {
    workspaceId: string;
    channelId: string;
    actorId: string;
    text: string;
    clientMsgId?: string | null;
    threadRootEventId?: number | null;
    attachments?: AttachmentMeta[];
  },
): Promise<WireEvent> {
  // Idempotency: the mobile offline outbox retries sends whose response was
  // lost, reusing the clientMsgId — return the already-committed event
  // instead of duplicating (the events_client_msg_dedupe unique index covers
  // the concurrent-retry race).
  const findExisting = async (db: Db | DbClient): Promise<WireEvent | null> => {
    if (!args.clientMsgId) return null;
    const res = await db.query<EventDbRow>(
      `SELECT * FROM events
       WHERE type = 'message.posted' AND actor_id = $1 AND channel_id = $2
         AND payload->>'client_msg_id' = $3`,
      [args.actorId, args.channelId, args.clientMsgId],
    );
    const row = res.rows[0];
    return row ? toWireEvent(await attachAuthor(db as DbClient, row)) : null;
  };

  try {
    return await withTx(pool, async (client) => {
      const existing = await findExisting(client);
      if (existing) return existing;
      if (args.threadRootEventId != null) {
        const root = await client.query<{
          channel_id: string | null;
          thread_root_event_id: number | null;
          type: string;
        }>(
          'SELECT channel_id, thread_root_event_id, type FROM events WHERE id = $1',
          [args.threadRootEventId],
        );
        const r = root.rows[0];
        if (!r || (r.type !== 'message.posted' && r.type !== 'session.spawned')) {
          throw new DomainError(404, 'thread_root_not_found', 'thread root message not found');
        }
        if (r.channel_id !== args.channelId) {
          throw new DomainError(400, 'thread_channel_mismatch', 'thread root belongs to another channel');
        }
        if (r.thread_root_event_id != null) {
          throw new DomainError(400, 'nested_thread', 'cannot reply to a reply; threads are one level deep');
        }
      }
      const payload: Record<string, unknown> = { text: args.text };
      if (args.clientMsgId) payload.client_msg_id = args.clientMsgId;
      if (args.attachments && args.attachments.length > 0) payload.attachments = args.attachments;
      const ev = await insertEvent(client, {
        workspaceId: args.workspaceId,
        channelId: args.channelId,
        threadRootEventId: args.threadRootEventId ?? null,
        type: 'message.posted',
        actorId: args.actorId,
        payload,
      });
      return toWireEvent(await attachAuthor(client, ev));
    });
  } catch (err) {
    // Lost the insert race to a concurrent retry — the winner's row is the answer.
    if ((err as { code?: string }).code === '23505') {
      const winner = await findExisting(pool);
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Append a message.edited event for an existing message.posted. Reads fold
 * the latest edit into the message text (see MESSAGE_SELECT); live clients
 * fold the fanned-out event directly.
 */
export async function editMessage(
  pool: Db,
  args: { targetEventId: number; actorId: string; text: string },
): Promise<WireEvent> {
  return withTx(pool, (client) => editMessageTx(client, args));
}

export async function editMessageTx(
  client: DbClient,
  args: { targetEventId: number; actorId: string; text: string },
): Promise<WireEvent> {
  const target = await client.query<{
    workspace_id: string;
    channel_id: string | null;
    thread_root_event_id: number | null;
    type: string;
    actor_id: string | null;
  }>(
    'SELECT workspace_id, channel_id, thread_root_event_id, type, actor_id FROM events WHERE id = $1',
    [args.targetEventId],
  );
  const t = target.rows[0];
  if (!t || t.type !== 'message.posted') {
    throw new DomainError(404, 'message_not_found', 'message not found');
  }
  if (t.actor_id !== args.actorId) {
    throw new DomainError(403, 'forbidden', 'only the author may edit a message');
  }
  const ev = await insertEvent(client, {
    workspaceId: t.workspace_id,
    channelId: t.channel_id,
    threadRootEventId: t.thread_root_event_id,
    type: 'message.edited',
    actorId: args.actorId,
    payload: { target_event_id: args.targetEventId, text: args.text },
  });
  return toWireEvent(await attachAuthor(client, ev));
}

/**
 * Append a message.deleted tombstone for an existing message.posted. Reads
 * fold it by stripping the text and flagging deleted=true; clients hide the
 * row (or render a tombstone when the message anchors a thread).
 */
export async function deleteMessage(
  pool: Db,
  args: { targetEventId: number; actorId: string },
): Promise<WireEvent> {
  return withTx(pool, (client) => deleteMessageTx(client, args));
}

export async function deleteMessageTx(
  client: DbClient,
  args: { targetEventId: number; actorId: string },
): Promise<WireEvent> {
  const target = await client.query<{
    workspace_id: string;
    channel_id: string | null;
    thread_root_event_id: number | null;
    type: string;
    actor_id: string | null;
  }>(
    'SELECT workspace_id, channel_id, thread_root_event_id, type, actor_id FROM events WHERE id = $1',
    [args.targetEventId],
  );
  const t = target.rows[0];
  if (!t || t.type !== 'message.posted') {
    throw new DomainError(404, 'message_not_found', 'message not found');
  }
  if (t.actor_id !== args.actorId) {
    throw new DomainError(403, 'forbidden', 'only the author may delete a message');
  }
  const ev = await insertEvent(client, {
    workspaceId: t.workspace_id,
    channelId: t.channel_id,
    threadRootEventId: t.thread_root_event_id,
    type: 'message.deleted',
    actorId: args.actorId,
    payload: { target_event_id: args.targetEventId },
  });
  return toWireEvent(await attachAuthor(client, ev));
}

/** Emojis a message can be reacted with — keep in sync with the web client's
 * REACTION_EMOJI (components/MessageRow.tsx). */
export const REACTION_EMOJI = [
  '👍', '👎', '✅', '❌', '👀', '🎉', '❤️', '😂',
  '😄', '😅', '😊', '😍', '🤔', '🤯', '😱', '😢',
  '😭', '😡', '🙏', '👏', '🙌', '💪', '🤝', '👋',
  '🫡', '🤷', '🤦', '💀', '🔥', '✨', '⭐', '💯',
  '🚀', '🐛', '🔧', '🛠️', '⚙️', '💡', '📌', '📎',
  '📝', '✏️', '🔍', '⏳', '⏰', '📅', '☕', '🍕',
  '🎯', '🏁', '🚧', '⚠️', '🚨', '❓', '❗', '➕',
  '💬', '🧵', '🤖', '🧠', '💸', '📈', '📉', '🎂',
] as const;

export type ReactionAction = 'add' | 'remove';

export interface ReactionResult {
  event: WireEvent | null;
  applied: boolean;
}

/**
 * Apply an explicit reaction set operation. Re-applying the same set state is
 * a successful no-op, which makes retry schedules safe without a toggle shim.
 */
export async function setReaction(
  pool: Db,
  args: { targetEventId: number; actorId: string; emoji: string; action: ReactionAction },
): Promise<ReactionResult> {
  if (!(REACTION_EMOJI as readonly string[]).includes(args.emoji)) {
    throw new DomainError(400, 'invalid_emoji', 'unsupported reaction emoji');
  }
  return withTx(pool, (client) => setReactionTx(client, args));
}

export async function setReactionTx(
  client: DbClient,
  args: { targetEventId: number; actorId: string; emoji: string; action: ReactionAction },
): Promise<ReactionResult> {
  if (!(REACTION_EMOJI as readonly string[]).includes(args.emoji)) {
    throw new DomainError(400, 'invalid_emoji', 'unsupported reaction emoji');
  }
  const target = await client.query<{
    workspace_id: string;
    channel_id: string | null;
    thread_root_event_id: number | null;
    type: string;
  }>(
    // Lock the target message before folding reaction events so same-message
    // reaction writes serialize and the per-user net cannot go negative.
    'SELECT workspace_id, channel_id, thread_root_event_id, type FROM events WHERE id = $1 FOR UPDATE',
    [args.targetEventId],
  );
  const t = target.rows[0];
  if (!t || t.type !== 'message.posted') {
    throw new DomainError(404, 'message_not_found', 'message not found');
  }
  const net = await client.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN type = 'reaction.added' THEN 1 ELSE -1 END), 0) AS net
     FROM events
     WHERE type IN ('reaction.added', 'reaction.removed')
       AND (payload->>'target_event_id')::bigint = $1
       AND actor_id = $2
       AND payload->>'emoji' = $3`,
    [args.targetEventId, args.actorId, args.emoji],
  );
  const present = Number(net.rows[0]?.net ?? 0) > 0;
  if ((args.action === 'add' && present) || (args.action === 'remove' && !present)) {
    return { event: null, applied: false };
  }
  const ev = await insertEvent(client, {
    workspaceId: t.workspace_id,
    channelId: t.channel_id,
    threadRootEventId: t.thread_root_event_id,
    type: args.action === 'add' ? 'reaction.added' : 'reaction.removed',
    actorId: args.actorId,
    payload: { target_event_id: args.targetEventId, emoji: args.emoji },
  });
  return { event: toWireEvent(await attachAuthor(client, ev)), applied: true };
}

// ---------------------------------------------------------------------------
// Reads (straight off the events table)
// ---------------------------------------------------------------------------

const MESSAGE_SELECT = `
  SELECT e.*,
         u.handle AS author_handle,
         u.display_name AS author_display_name,
         coalesce(r.reply_count, 0)::int AS reply_count,
         coalesce(r.last_reply_id, 0)::bigint AS last_reply_id,
         edit.text AS edited_text,
         (del.id IS NOT NULL) AS is_deleted,
         rx.reactions AS reactions
  FROM events e
  LEFT JOIN users u ON u.id = e.actor_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS reply_count, max(x.id) AS last_reply_id
    FROM events x
    WHERE x.thread_root_event_id = e.id
      AND x.type IN ('message.posted', 'session.question_requested', 'session.question_answered', 'session.question_resolved')
      AND NOT EXISTS (
        SELECT 1 FROM events d
        WHERE d.type = 'message.deleted'
          AND (d.payload->>'target_event_id')::bigint = x.id
      )
  ) r ON e.thread_root_event_id IS NULL
  LEFT JOIN LATERAL (
    SELECT x.payload->>'text' AS text
    FROM events x
    WHERE x.type = 'message.edited'
      AND (x.payload->>'target_event_id')::bigint = e.id
    ORDER BY x.id DESC
    LIMIT 1
  ) edit ON true
  LEFT JOIN LATERAL (
    SELECT x.id
    FROM events x
    WHERE x.type = 'message.deleted'
      AND (x.payload->>'target_event_id')::bigint = e.id
    LIMIT 1
  ) del ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('emoji', emoji, 'userIds', user_ids)) AS reactions
    FROM (
      SELECT emoji, json_agg(actor_id ORDER BY first_id) AS user_ids
      FROM (
        SELECT x.actor_id, x.payload->>'emoji' AS emoji,
               SUM(CASE WHEN x.type = 'reaction.added' THEN 1 ELSE -1 END) AS net,
               MIN(x.id) AS first_id
        FROM events x
        WHERE x.type IN ('reaction.added', 'reaction.removed')
          AND (x.payload->>'target_event_id')::bigint = e.id
        GROUP BY x.actor_id, x.payload->>'emoji'
      ) n
      WHERE n.net > 0
      GROUP BY emoji
      ORDER BY MIN(first_id)
    ) agg
  ) rx ON true
`;

// message.edited / message.deleted / reaction.* are included so after_id
// catch-up heals changes made while a client was disconnected (live clients
// fold the same events from WS fanout).
const TIMELINE_EVENT_TYPES =
  "('message.posted', 'message.edited', 'message.deleted', 'reaction.added', 'reaction.removed', 'session.spawned', 'session.status_changed', 'session.completed', 'session.seat_requested', 'session.seat_changed', 'session.question_requested', 'session.question_answered', 'session.question_resolved')";

function foldEdit(
  row: EventDbRow & { edited_text?: string | null; is_deleted?: boolean; reactions?: unknown },
): EventDbRow {
  if (row.type !== 'message.posted') return row;
  if (row.is_deleted) {
    // Tombstone: never ship deleted text back to clients.
    row.payload = { ...row.payload, text: '', deleted: true };
    delete (row.payload as { client_msg_id?: unknown }).client_msg_id;
    return row;
  }
  if (row.edited_text != null) {
    row.payload = { ...row.payload, text: row.edited_text, edited: true };
  }
  if (row.reactions != null) {
    row.payload = { ...row.payload, reactions: row.reactions };
  }
  return row;
}

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
       AND e.type IN ('message.posted', 'session.spawned')
       AND e.thread_root_event_id IS NULL
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
export async function listThreadMessages(
  pool: Db,
  args: { rootEventId: number },
): Promise<{ events: WireEvent[] }> {
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
const SYNC_EVENT_TYPES =
  "('message.posted', 'message.edited', 'message.deleted', 'reaction.added', 'reaction.removed', 'session.spawned', 'session.status_changed', 'session.completed', 'session.seat_requested', 'session.seat_changed', 'session.question_requested', 'session.question_answered', 'session.question_resolved', 'channel.created', 'channel.member_joined', 'channel.member_left')";

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
                            ELSE (x.payload->>'target_event_id')::bigint END AS msg_id
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
         AND del.id IS NULL
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

export async function listChannels(
  pool: Db,
  userId: string,
  workspaceId?: string,
): Promise<Channel[]> {
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
    kind: 'public' | 'private' | 'dm' | 'gdm';
    last_read_event_id: string;
    latest_event_id: string;
    muted: boolean;
    member_count: string;
  }>(
    `SELECT c.*,
            COALESCE(rc.last_read_event_id, 0) AS last_read_event_id,
            COALESCE(latest.latest_event_id, 0) AS latest_event_id,
            (cm.user_id IS NOT NULL) AS muted,
            COALESCE(member_counts.member_count, 0) AS member_count
     FROM channels c
     LEFT JOIN channel_read_cursors rc
       ON rc.channel_id = c.id AND rc.user_id = $1
     LEFT JOIN channel_mutes cm
       ON cm.channel_id = c.id AND cm.user_id = $1
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS member_count
       FROM channel_members m
       WHERE m.channel_id = c.id
     ) member_counts ON c.kind IN ('private', 'gdm')
     LEFT JOIN LATERAL (
       SELECT MAX(e.id) AS latest_event_id
       FROM events e
       WHERE e.channel_id = c.id
         AND e.type IN ('message.posted', 'session.spawned')
     ) latest ON true
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
    kind: r.kind,
    lastReadEventId: Number(r.last_read_event_id),
    latestEventId: Number(r.latest_event_id),
    muted: r.muted,
    ...(r.kind === 'dm' || r.kind === 'gdm' ? { members: membersByChannel.get(r.id) ?? [] } : {}),
    ...(r.kind === 'private' ? { memberCount: Number(r.member_count) } : {}),
  }));
}

/** True when the user may read/post in the channel (public, or member-only kinds). */
export async function canAccessChannel(
  pool: Db,
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

async function membersForChannel(client: Db | DbClient, channelId: string): Promise<UserRef[]> {
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

export async function addChannelMember(
  pool: Db,
  args: { channelId: string; actorId: string; userId: string },
): Promise<{ channel: Channel; member: UserRef; event: WireEvent } | null> {
  return withTx(pool, (client) => addChannelMemberTx(client, args));
}

export async function addChannelMemberTx(
  client: DbClient,
  args: { channelId: string; actorId: string; userId: string },
): Promise<{ channel: Channel; member: UserRef; event: WireEvent } | null> {
  const ch = await client.query<{
    id: string;
    workspace_id: string;
    name: string;
    created_at: Date;
    kind: Channel['kind'];
    member: boolean;
  }>(
    `SELECT c.*,
            EXISTS (SELECT 1 FROM channel_members m
                    WHERE m.channel_id = c.id AND m.user_id = $2) AS member
     FROM channels c
     WHERE c.id = $1`,
    [args.channelId, args.actorId],
  );
  const row = ch.rows[0];
  if (!row || row.kind === 'public' || row.kind === 'dm' || !row.member) return null;
  const user = await client.query<{ id: string; handle: string; display_name: string }>(
    'SELECT id, handle, display_name FROM users WHERE id = $1',
    [args.userId],
  );
  const u = user.rows[0];
  if (!u) throw new DomainError(404, 'user_not_found', 'user not found');
  await client.query(
    `INSERT INTO channel_members (channel_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [args.channelId, args.userId],
  );
  const member = { id: u.id, handle: u.handle, displayName: u.display_name };
  const members = row.kind === 'gdm' ? await membersForChannel(client, args.channelId) : undefined;
  const count = await client.query<{ count: string }>(
    'SELECT COUNT(*) FROM channel_members WHERE channel_id = $1',
    [args.channelId],
  );
  const ev = await insertEvent(client, {
    workspaceId: row.workspace_id,
    channelId: row.id,
    type: 'channel.member_joined',
    actorId: args.actorId,
    payload: { userId: member.id, displayName: member.displayName },
  });
  return {
    channel: {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      createdAt: new Date(row.created_at).toISOString(),
      kind: row.kind,
      ...(row.kind === 'gdm' ? { members } : { memberCount: Number(count.rows[0]!.count) }),
    },
    member,
    event: toWireEvent(await attachAuthor(client, ev)),
  };
}

export async function leaveChannel(
  pool: Db,
  args: { channelId: string; userId: string },
): Promise<{ event: WireEvent } | null> {
  return withTx(pool, (client) => leaveChannelTx(client, args));
}

export async function leaveChannelTx(
  client: DbClient,
  args: { channelId: string; userId: string },
): Promise<{ event: WireEvent } | null> {
  const ch = await client.query<{
    workspace_id: string;
    kind: Channel['kind'];
    member: boolean;
    display_name: string;
  }>(
    `SELECT c.workspace_id, c.kind,
            EXISTS (SELECT 1 FROM channel_members m
                    WHERE m.channel_id = c.id AND m.user_id = $2) AS member,
            u.display_name
     FROM channels c CROSS JOIN users u
     WHERE c.id = $1 AND u.id = $2`,
    [args.channelId, args.userId],
  );
  const row = ch.rows[0];
  if (!row || row.kind === 'public' || !row.member) return null;
  if (row.kind === 'dm') throw new DomainError(400, 'cannot_leave_dm', 'cannot leave a DM');
  await client.query('DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2', [
    args.channelId,
    args.userId,
  ]);
  const ev = await insertEvent(client, {
    workspaceId: row.workspace_id,
    channelId: args.channelId,
    type: 'channel.member_left',
    actorId: args.userId,
    payload: { userId: args.userId, displayName: row.display_name },
  });
  return { event: toWireEvent(await attachAuthor(client, ev)) };
}

/**
 * Find or create the DM channel between two users (self-DM allowed). The
 * deterministic name + the (workspace_id, name) unique constraint make this
 * idempotent under races.
 */
export async function getOrCreateDm(
  pool: Db,
  args: { workspaceId: string; userIdA: string; userIdB: string },
): Promise<{ channel: Channel; created: boolean }> {
  const pair = [args.userIdA, args.userIdB].sort();
  const name = `dm:${pair[0]}:${pair[1]}`;
  const load = async (): Promise<Channel | null> => {
    const channels = await listChannelsFor(pool, args.userIdA);
    return channels.find((c) => c.name === name) ?? null;
  };
  const existing = await load();
  if (existing) return { channel: existing, created: false };
  try {
    await withTx(pool, async (client) => {
      const ch = await client.query<{ id: string }>(
        "INSERT INTO channels (workspace_id, name, kind, created_by) VALUES ($1, $2, 'dm', $3) RETURNING id",
        [args.workspaceId, name, args.userIdA],
      );
      const channelId = ch.rows[0]!.id;
      for (const userId of new Set(pair)) {
        await client.query(
          'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)',
          [channelId, userId],
        );
      }
    });
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') throw err; // lost a race: fall through
  }
  const channel = await load();
  if (!channel) throw new DomainError(500, 'dm_create_failed', 'could not create DM');
  return { channel, created: true };
}

export async function getOrCreateGdm(
  pool: Db,
  args: { workspaceId: string; creatorId: string; userIds: string[] },
): Promise<{ channel: Channel; created: boolean }> {
  const memberIds = [...new Set([args.creatorId, ...args.userIds])].sort();
  if (memberIds.length < 3 || memberIds.length > 9) {
    throw new DomainError(400, 'bad_request', 'group DMs require 3-9 total members');
  }
  const users = await pool.query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1::uuid[])', [
    memberIds,
  ]);
  if (users.rows.length !== memberIds.length) {
    throw new DomainError(404, 'user_not_found', 'user not found');
  }
  const loadExact = async (): Promise<Channel | null> => {
    const existing = await pool.query<{ channel_id: string }>(
      `SELECT m.channel_id
       FROM channel_members m JOIN channels c ON c.id = m.channel_id
       WHERE c.kind = 'gdm'
       GROUP BY m.channel_id
       HAVING array_agg(m.user_id ORDER BY m.user_id) = $1::uuid[]`,
      [memberIds],
    );
    const channelId = existing.rows[0]?.channel_id;
    if (!channelId) return null;
    return (await listChannelsFor(pool, args.creatorId)).find((c) => c.id === channelId) ?? null;
  };
  const existing = await loadExact();
  if (existing) return { channel: existing, created: false };
  const name = `gdm:${memberIds.join(':')}`;
  try {
    await withTx(pool, async (client) => {
      const ch = await client.query<{ id: string }>(
        "INSERT INTO channels (workspace_id, name, kind, created_by) VALUES ($1, $2, 'gdm', $3) RETURNING id",
        [args.workspaceId, name, args.creatorId],
      );
      const channelId = ch.rows[0]!.id;
      for (const userId of memberIds) {
        await client.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [
          channelId,
          userId,
        ]);
      }
    });
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') throw err;
  }
  const channel = await loadExact();
  if (!channel) throw new DomainError(500, 'gdm_create_failed', 'could not create group DM');
  return { channel, created: true };
}

/** Idempotent first-boot bootstrap: workspace "atrium" with #general. */
export async function ensureDefaultWorkspace(pool: Db): Promise<Workspace> {
  const existing = await listWorkspaces(pool);
  if (existing.length > 0) return existing[0]!;
  const { workspace } = await createWorkspace(pool, { name: 'atrium' });
  await createChannel(pool, { workspaceId: workspace.id, name: 'general' });
  return workspace;
}
