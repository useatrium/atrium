import type { Db, DbClient } from '../db.js';
import { withTx } from '../db.js';
import { encodeEventHandle, encodeHandle, tryDecodeHandle } from '../entries.js';
import { MESSAGE_STATE_EVENT_TYPES, projectMessageEvent } from '../message-state.js';
import { userRefFromRow } from '../user-ref.js';
import { listChannelsFor, listWorkspaces, membersForChannel } from './read.js';
import {
  attachAuthor,
  DomainError,
  toWireEvent,
  type AttachmentMeta,
  type Channel,
  type EventDbRow,
  type UserRef,
  type VoicePostMeta,
  type WireEvent,
  type Workspace,
} from './wire.js';

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
  const row = res.rows[0]!;
  if (MESSAGE_STATE_EVENT_TYPES.has(row.type)) await projectMessageEvent(client, row.id);
  return row;
}

export async function appendEvent(client: DbClient, args: InsertEventArgs): Promise<WireEvent> {
  return toWireEvent(await attachAuthor(client, await insertEvent(client, args)));
}

// ---------------------------------------------------------------------------
// Commands (event insert + read-model update in one transaction)
// ---------------------------------------------------------------------------

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
      }>('INSERT INTO channels (workspace_id, name, kind, created_by) VALUES ($1, $2, $3, $4) RETURNING *', [
        args.workspaceId,
        args.name,
        args.private ? 'private' : 'public',
        args.actorId ?? null,
      ]);
      const row = ch.rows[0]!;
      if (row.kind === 'private' && args.actorId) {
        await client.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [row.id, args.actorId]);
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
          archivedAt: null,
          pinned: false,
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

const ENTRY_LINK_RE = /(?:https?:\/\/[^/\s?#]+)?\/e\/([A-Za-z0-9_-]+)/g;

export function extractEntryRefs(text: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(ENTRY_LINK_RE)) {
    const raw = match[1];
    if (!raw) continue;
    const decoded = tryDecodeHandle(raw);
    if (!decoded) continue;
    const handle = encodeHandle(decoded);
    if (seen.has(handle)) continue;
    seen.add(handle);
    refs.push(handle);
    if (refs.length >= 10) break;
  }
  return refs;
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
    broadcast?: boolean;
    attachments?: AttachmentMeta[];
    voice?: VoicePostMeta;
  },
): Promise<PostedMessage> {
  // Idempotency: the mobile offline outbox retries sends whose response was
  // lost, reusing the clientMsgId — return the already-committed event
  // instead of duplicating (the events_client_msg_dedupe unique index covers
  // the concurrent-retry race).
  const findExisting = async (db: Db | DbClient): Promise<PostedMessage | null> => {
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
        }>('SELECT channel_id, thread_root_event_id, type FROM events WHERE id = $1', [args.threadRootEventId]);
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
      // This is the shared message executor used by every posting surface.
      // Revive inside the same transaction so the durable lifecycle event is
      // ordered before the message that caused it.
      const revivedChannel = await client.query<{ workspace_id: string }>(
        `UPDATE channels
         SET archived_at = NULL
         WHERE id = $1 AND archived_at IS NOT NULL
         RETURNING workspace_id`,
        [args.channelId],
      );
      const channelUnarchivedEvent = revivedChannel.rows[0]
        ? await appendEvent(client, {
            workspaceId: revivedChannel.rows[0].workspace_id,
            channelId: args.channelId,
            type: 'channel.unarchived',
            actorId: args.actorId,
            payload: { channelId: args.channelId, archivedAt: null },
          })
        : null;
      const payload: Record<string, unknown> = { text: args.text };
      const entryRefs = extractEntryRefs(args.text);
      if (entryRefs.length > 0) payload.entry_refs = entryRefs;
      if (args.clientMsgId) payload.client_msg_id = args.clientMsgId;
      if (args.threadRootEventId != null && args.broadcast === true) payload.broadcast = true;
      if (args.attachments && args.attachments.length > 0) payload.attachments = args.attachments;
      if (args.voice) {
        if (!Number.isFinite(args.voice.durationMs)) {
          throw new DomainError(400, 'bad_voice', 'voice.durationMs must be finite');
        }
        // The single attachment is the audio (the route validated this).
        const audio = args.attachments?.length === 1 ? args.attachments[0] : undefined;
        if (!audio) {
          throw new DomainError(400, 'bad_voice', 'voice messages require one audio attachment');
        }
        const waveform = args.voice.waveform
          ?.slice(0, 256)
          .map((value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)));
        payload.voice = {
          fileId: audio.id,
          durationMs: args.voice.durationMs,
          ...(waveform && waveform.length > 0 ? { waveform } : {}),
        };
      }
      const ev = await insertEvent(client, {
        workspaceId: args.workspaceId,
        channelId: args.channelId,
        threadRootEventId: args.threadRootEventId ?? null,
        type: 'message.posted',
        actorId: args.actorId,
        payload,
      });
      if (args.voice) {
        const voice = payload.voice as { fileId: string };
        await client.query(
          `INSERT INTO transcripts (file_id, event_id, workspace_id, channel_id, status)
           VALUES ($1, $2, $3, $4, 'pending')`,
          [voice.fileId, ev.id, args.workspaceId, args.channelId],
        );
      }
      const message = toWireEvent(await attachAuthor(client, ev));
      return channelUnarchivedEvent ? { ...message, channelUnarchivedEvent } : message;
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

/** Internal post result. HTTP routes fan out `channelUnarchivedEvent` before
 * returning the normal message event to clients. */
export interface PostedMessage extends WireEvent {
  channelUnarchivedEvent?: WireEvent;
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

interface OwnedMessageTarget {
  workspace_id: string;
  channel_id: string | null;
  thread_root_event_id: number | null;
  actor_id: string | null;
}

async function ownedMessageTarget(
  client: DbClient,
  targetEventId: number,
  actorId: string,
  action: 'edit' | 'delete' | 'suppress unfurls on',
): Promise<OwnedMessageTarget> {
  const target = await client.query<OwnedMessageTarget & { type: string }>(
    'SELECT workspace_id, channel_id, thread_root_event_id, type, actor_id FROM events WHERE id = $1',
    [targetEventId],
  );
  const row = target.rows[0];
  if (!row || row.type !== 'message.posted') {
    throw new DomainError(404, 'message_not_found', 'message not found');
  }
  if (row.actor_id !== actorId) {
    throw new DomainError(403, 'forbidden', `only the author may ${action} a message`);
  }
  return row;
}

export async function editMessageTx(
  client: DbClient,
  args: { targetEventId: number; actorId: string; text: string },
): Promise<WireEvent> {
  const t = await ownedMessageTarget(client, args.targetEventId, args.actorId, 'edit');
  const payload: Record<string, unknown> = { target: encodeEventHandle(args.targetEventId), text: args.text };
  const entryRefs = extractEntryRefs(args.text);
  if (entryRefs.length > 0) payload.entry_refs = entryRefs;
  const ev = await insertEvent(client, {
    workspaceId: t.workspace_id,
    channelId: t.channel_id,
    threadRootEventId: t.thread_root_event_id,
    type: 'message.edited',
    actorId: args.actorId,
    payload,
  });
  return toWireEvent(await attachAuthor(client, ev));
}

/** Append the complete current unfurl suppression set for a message. */
export async function suppressUnfurls(
  pool: Db,
  args: { targetEventId: number; actorId: string; suppressed: string[] },
): Promise<WireEvent> {
  return withTx(pool, (client) => suppressUnfurlsTx(client, args));
}

export async function suppressUnfurlsTx(
  client: DbClient,
  args: { targetEventId: number; actorId: string; suppressed: string[] },
): Promise<WireEvent> {
  const t = await ownedMessageTarget(client, args.targetEventId, args.actorId, 'suppress unfurls on');
  const ev = await insertEvent(client, {
    workspaceId: t.workspace_id,
    channelId: t.channel_id,
    threadRootEventId: t.thread_root_event_id,
    type: 'message.unfurls_suppressed',
    actorId: args.actorId,
    payload: { target: encodeEventHandle(args.targetEventId), suppressed: args.suppressed },
  });
  return toWireEvent(await attachAuthor(client, ev));
}

/**
 * Append a message.deleted tombstone for an existing message.posted. Reads
 * fold it by stripping the text and flagging deleted=true; clients hide the
 * row (or render a tombstone when the message anchors a thread).
 */
export async function deleteMessage(pool: Db, args: { targetEventId: number; actorId: string }): Promise<WireEvent> {
  return withTx(pool, (client) => deleteMessageTx(client, args));
}

export async function deleteMessageTx(
  client: DbClient,
  args: { targetEventId: number; actorId: string },
): Promise<WireEvent> {
  const t = await ownedMessageTarget(client, args.targetEventId, args.actorId, 'delete');
  const ev = await insertEvent(client, {
    workspaceId: t.workspace_id,
    channelId: t.channel_id,
    threadRootEventId: t.thread_root_event_id,
    type: 'message.deleted',
    actorId: args.actorId,
    payload: { target: encodeEventHandle(args.targetEventId) },
  });
  return toWireEvent(await attachAuthor(client, ev));
}

/** Emojis a message can be reacted with — keep in sync with the web client's
 * REACTION_EMOJI (components/MessageRow.tsx). */
export const REACTION_EMOJI = [
  '👍',
  '👎',
  '✅',
  '❌',
  '👀',
  '🎉',
  '❤️',
  '😂',
  '😄',
  '😅',
  '😊',
  '😍',
  '🤔',
  '🤯',
  '😱',
  '😢',
  '😭',
  '😡',
  '🙏',
  '👏',
  '🙌',
  '💪',
  '🤝',
  '👋',
  '🫡',
  '🤷',
  '🤦',
  '💀',
  '🔥',
  '✨',
  '⭐',
  '💯',
  '🚀',
  '🐛',
  '🔧',
  '🛠️',
  '⚙️',
  '💡',
  '📌',
  '📎',
  '📝',
  '✏️',
  '🔍',
  '⏳',
  '⏰',
  '📅',
  '☕',
  '🍕',
  '🎯',
  '🏁',
  '🚧',
  '⚠️',
  '🚨',
  '❓',
  '❗',
  '➕',
  '💬',
  '🧵',
  '🤖',
  '🧠',
  '💸',
  '📈',
  '📉',
  '🎂',
] as const;

export type ReactionAction = 'add' | 'remove';

export interface ReactionResult {
  event: WireEvent | null;
  applied: boolean;
}

interface EntryAnnotationScope {
  workspaceId: string;
  channelId: string;
  threadRootEventId: number | null;
}

async function resolveAnnotationScopeTx(client: DbClient, handle: string): Promise<EntryAnnotationScope> {
  const decoded = tryDecodeHandle(handle);
  if (!decoded) {
    throw new DomainError(400, 'bad_handle', 'invalid entry handle');
  }
  switch (decoded.type) {
    case 'event': {
      const res = await client.query<{
        workspace_id: string;
        channel_id: string | null;
        thread_root_event_id: number | null;
      }>('SELECT workspace_id, channel_id, thread_root_event_id FROM events WHERE id = $1', [decoded.eventId]);
      const row = res.rows[0];
      if (!row?.channel_id) {
        throw new DomainError(404, 'entry_not_found', 'entry not found');
      }
      return {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        threadRootEventId: row.thread_root_event_id,
      };
    }
    case 'record': {
      const res = await client.query<{
        workspace_id: string;
        channel_id: string;
      }>(
        `SELECT s.workspace_id, s.channel_id
           FROM session_records r
           JOIN sessions s ON s.id = r.session_id
          WHERE r.entry_uid = $1
          ORDER BY r.ts DESC, r.session_id ASC, r.seq ASC
          LIMIT 1`,
        [decoded.entryUid],
      );
      const row = res.rows[0];
      if (!row) {
        throw new DomainError(404, 'entry_not_found', 'entry not found');
      }
      return {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        threadRootEventId: null,
      };
    }
    case 'artifact': {
      const res = await client.query<{
        workspace_id: string;
        channel_id: string | null;
      }>(
        `SELECT workspace_id, channel_id
           FROM artifacts
          WHERE id = $1`,
        [decoded.artifactId],
      );
      const row = res.rows[0];
      if (!row?.channel_id) {
        throw new DomainError(404, 'entry_not_found', 'entry not found');
      }
      return {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        threadRootEventId: null,
      };
    }
  }
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
  const targetHandle = encodeEventHandle(args.targetEventId);
  const net = await client.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN type = 'reaction.added' THEN 1 ELSE -1 END), 0) AS net
     FROM events
     WHERE type IN ('reaction.added', 'reaction.removed')
       AND payload->>'target' = $1
       AND actor_id = $2
       AND payload->>'emoji' = $3`,
    [targetHandle, args.actorId, args.emoji],
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
    payload: { target: targetHandle, emoji: args.emoji },
  });
  return { event: toWireEvent(await attachAuthor(client, ev)), applied: true };
}

export async function setEntryReactionTx(
  client: DbClient,
  args: { handle: string; actorId: string; emoji: string; action: ReactionAction },
): Promise<ReactionResult> {
  if (!(REACTION_EMOJI as readonly string[]).includes(args.emoji)) {
    throw new DomainError(400, 'invalid_emoji', 'unsupported reaction emoji');
  }
  const decoded = tryDecodeHandle(args.handle);
  if (!decoded) {
    throw new DomainError(400, 'bad_handle', 'invalid entry handle');
  }
  if (decoded.type === 'event') {
    return setReactionTx(client, {
      targetEventId: decoded.eventId,
      actorId: args.actorId,
      emoji: args.emoji,
      action: args.action,
    });
  }

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [args.handle]);
  const scope = await resolveAnnotationScopeTx(client, args.handle);
  const net = await client.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN type = 'reaction.added' THEN 1 ELSE -1 END), 0) AS net
     FROM events
     WHERE type IN ('reaction.added', 'reaction.removed')
       AND payload->>'target' = $1
       AND actor_id = $2
       AND payload->>'emoji' = $3`,
    [args.handle, args.actorId, args.emoji],
  );
  const present = Number(net.rows[0]?.net ?? 0) > 0;
  if ((args.action === 'add' && present) || (args.action === 'remove' && !present)) {
    return { event: null, applied: false };
  }
  const ev = await insertEvent(client, {
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    threadRootEventId: scope.threadRootEventId,
    type: args.action === 'add' ? 'reaction.added' : 'reaction.removed',
    actorId: args.actorId,
    payload: { target: args.handle, emoji: args.emoji },
  });
  return { event: toWireEvent(await attachAuthor(client, ev)), applied: true };
}

export async function appendVoiceTranscribedEventTx(
  client: DbClient,
  args: {
    targetEventId: number;
    transcript: { status: 'pending' | 'processing' | 'done' | 'failed'; text?: string; lang?: string };
  },
): Promise<WireEvent> {
  const target = await client.query<{
    workspace_id: string;
    channel_id: string | null;
    thread_root_event_id: number | null;
    type: string;
  }>('SELECT workspace_id, channel_id, thread_root_event_id, type FROM events WHERE id = $1', [args.targetEventId]);
  const t = target.rows[0];
  if (!t || t.type !== 'message.posted') {
    throw new DomainError(404, 'message_not_found', 'message not found');
  }
  const transcript: Record<string, unknown> = { status: args.transcript.status };
  if (args.transcript.text != null) transcript.text = args.transcript.text;
  if (args.transcript.lang != null) transcript.lang = args.transcript.lang;
  return appendEvent(client, {
    workspaceId: t.workspace_id,
    channelId: t.channel_id,
    threadRootEventId: t.thread_root_event_id,
    type: 'voice.transcribed',
    actorId: null,
    payload: { target: encodeEventHandle(args.targetEventId), transcript },
  });
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
    archived_at: Date | null;
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
  const user = await client.query<{
    id: string;
    handle: string;
    display_name: string;
    avatar_s3_key: string | null;
    avatar_version: number;
  }>(
    'SELECT id, handle, display_name, avatar_s3_key, avatar_version FROM users WHERE id = $1',
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
  const member = userRefFromRow(u);
  const members = row.kind === 'gdm' ? await membersForChannel(client, args.channelId) : undefined;
  const count = await client.query<{ count: string }>('SELECT COUNT(*) FROM channel_members WHERE channel_id = $1', [
    args.channelId,
  ]);
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
      archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
      pinned: false,
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
        await client.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [channelId, userId]);
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
  const users = await pool.query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1::uuid[])', [memberIds]);
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
        await client.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [channelId, userId]);
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
