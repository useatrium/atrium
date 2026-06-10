import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';

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
}

export async function createChannel(
  pool: Db,
  args: { workspaceId: string; name: string; actorId?: string | null },
): Promise<{ channel: Channel; event: WireEvent }> {
  try {
    return await withTx(pool, async (client) => {
      const ch = await client.query<{
        id: string;
        workspace_id: string;
        name: string;
        created_at: Date;
      }>(
        'INSERT INTO channels (workspace_id, name, created_by) VALUES ($1, $2, $3) RETURNING *',
        [args.workspaceId, args.name, args.actorId ?? null],
      );
      const row = ch.rows[0]!;
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

export async function postMessage(
  pool: Db,
  args: {
    workspaceId: string;
    channelId: string;
    actorId: string;
    text: string;
    clientMsgId?: string | null;
    threadRootEventId?: number | null;
  },
): Promise<WireEvent> {
  return withTx(pool, async (client) => {
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
      if (!r || r.type !== 'message.posted') {
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
         edit.text AS edited_text
  FROM events e
  LEFT JOIN users u ON u.id = e.actor_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS reply_count, max(x.id) AS last_reply_id
    FROM events x
    WHERE x.thread_root_event_id = e.id AND x.type = 'message.posted'
  ) r ON e.thread_root_event_id IS NULL
  LEFT JOIN LATERAL (
    SELECT x.payload->>'text' AS text
    FROM events x
    WHERE x.type = 'message.edited'
      AND (x.payload->>'target_event_id')::bigint = e.id
    ORDER BY x.id DESC
    LIMIT 1
  ) edit ON true
`;

function foldEdit(row: EventDbRow & { edited_text?: string | null }): EventDbRow {
  if (row.edited_text != null && row.type === 'message.posted') {
    row.payload = { ...row.payload, text: row.edited_text, edited: true };
  }
  return row;
}

export interface MessagePage {
  events: WireEvent[];
  hasMore: boolean;
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
       WHERE e.channel_id = $1 AND e.type = 'message.posted' AND e.id > $3
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
       AND e.type = 'message.posted'
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
     WHERE e.thread_root_event_id = $1 AND e.type = 'message.posted'
     ORDER BY e.id ASC
     LIMIT $2`,
    [args.rootEventId, 1000],
  );
  return { events: res.rows.map((r) => toWireEvent(foldEdit(r))) };
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

export async function listChannels(pool: Db, workspaceId?: string): Promise<Channel[]> {
  const res = workspaceId
    ? await pool.query(
        'SELECT * FROM channels WHERE workspace_id = $1 ORDER BY name ASC',
        [workspaceId],
      )
    : await pool.query('SELECT * FROM channels ORDER BY name ASC');
  return res.rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** Idempotent first-boot bootstrap: workspace "atrium" with #general. */
export async function ensureDefaultWorkspace(pool: Db): Promise<Workspace> {
  const existing = await listWorkspaces(pool);
  if (existing.length > 0) return existing[0]!;
  const { workspace } = await createWorkspace(pool, { name: 'atrium' });
  await createChannel(pool, { workspaceId: workspace.id, name: 'general' });
  return workspace;
}
