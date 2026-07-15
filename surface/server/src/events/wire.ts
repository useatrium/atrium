import { encodeEventHandle } from '@atrium/surface-client/handle';

import type { DbClient } from '../db.js';

export interface UserRef {
  id: string;
  handle: string;
  displayName: string;
}

/** Wire shape of an event, as fanned out over WS and returned from reads. */
export interface WireEvent {
  id: number;
  /** Change-feed watermark for rows materialized from message_state. */
  lastModifierId?: number;
  handle?: string;
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
  /** Newest visible reply, materialized for collapsed feed clusters. */
  lastReply?: {
    id: number;
    authorId: string;
    authorDisplayName: string;
    text: string;
    createdAt: string;
    agentVoice: boolean;
    eventType: string;
  };
  /** Thread reply should also be shown in the channel timeline. */
  broadcast?: boolean;
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

export interface EventDbRow {
  id: number;
  last_modifier_id?: number | null;
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
  last_reply_preview_id?: number | null;
  last_reply_author_id?: string | null;
  last_reply_author_display_name?: string | null;
  last_reply_text?: string | null;
  last_reply_created_at?: Date | null;
  last_reply_agent_voice?: boolean | null;
  last_reply_event_type?: string | null;
  broadcast?: boolean | null;
  transcript_status?: string | null;
  transcript_text?: string | null;
  transcript_lang?: string | null;
}

export function toWireEvent(row: EventDbRow): WireEvent {
  const ev: WireEvent = {
    id: row.id,
    handle: encodeEventHandle(row.id),
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
  if (row.last_modifier_id != null) ev.lastModifierId = Number(row.last_modifier_id);
  if (row.reply_count !== undefined) ev.replyCount = Number(row.reply_count);
  if (row.last_reply_id !== undefined) ev.lastReplyId = Number(row.last_reply_id);
  if (row.last_reply_preview_id != null && row.last_reply_created_at != null) {
    ev.lastReply = {
      id: Number(row.last_reply_preview_id),
      authorId: row.last_reply_author_id ?? 'unknown',
      authorDisplayName: row.last_reply_author_display_name ?? 'Unknown',
      text: row.last_reply_text ?? '',
      createdAt: new Date(row.last_reply_created_at).toISOString(),
      agentVoice: row.last_reply_agent_voice === true,
      eventType: row.last_reply_event_type ?? 'message.posted',
    };
  }
  if (row.broadcast === true || row.payload?.broadcast === true) ev.broadcast = true;
  return ev;
}

export async function attachAuthor(client: DbClient, row: EventDbRow): Promise<EventDbRow> {
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
export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
}

export interface Channel {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  /** Global archive state; null means visible/active. */
  archivedAt: string | null;
  /** Per-user state resolved for the requesting user. */
  pinned: boolean;
  kind: 'public' | 'private' | 'dm' | 'gdm';
  lastReadEventId?: number;
  latestEventId?: number;
  muted?: boolean;
  /** DM/GDM channels only: the member list. */
  members?: UserRef[];
  /** Private channels only: count of members, without shipping the full list. */
  memberCount?: number;
  /** True when at least one unread message explicitly mentioned this user. */
  mentionedSinceRead?: boolean;
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

export interface VoicePostMeta {
  durationMs: number;
  waveform?: number[];
}

export interface AnnotationReaction {
  emoji: string;
  userIds: string[];
}

export interface AnnotationFold {
  reactions: AnnotationReaction[];
}

export function foldEdit(
  row: EventDbRow & {
    edited_text?: string | null;
    suppressed_unfurls?: unknown;
    is_deleted?: boolean;
    reactions?: unknown;
  },
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
  if (Array.isArray(row.suppressed_unfurls)) {
    row.payload = { ...row.payload, suppressed_unfurls: row.suppressed_unfurls };
  }
  if (row.reactions != null) {
    row.payload = { ...row.payload, reactions: row.reactions };
  }
  if (row.payload.voice && typeof row.payload.voice === 'object' && !Array.isArray(row.payload.voice)) {
    const status =
      row.transcript_status === 'done' || row.transcript_status === 'failed' ? row.transcript_status : 'pending';
    const transcript: Record<string, unknown> = { status };
    if (row.transcript_text != null) transcript.text = row.transcript_text;
    if (row.transcript_lang != null) transcript.lang = row.transcript_lang;
    row.payload = {
      ...row.payload,
      voice: { ...(row.payload.voice as Record<string, unknown>), transcript },
    };
  }
  return row;
}
