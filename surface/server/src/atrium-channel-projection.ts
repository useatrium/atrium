import type { Db } from './db.js';
import { encodeEventHandle } from './entries.js';
import { workspaceMemberExists } from './membership.js';

export interface ChannelListDocRow {
  id: string;
  name: string;
  kind: 'public' | 'private' | 'dm' | 'gdm';
  active: boolean;
  lastEventId: number;
}

export interface ChannelMemberDocRow {
  id: string;
  handle: string;
  displayName: string;
}

export interface ChannelDocInfo extends ChannelListDocRow {
  members: ChannelMemberDocRow[];
  driver: ChannelMemberDocRow | null;
}

export interface ChannelChatMessage {
  id: number;
  handle: string;
  authorName: string;
  authorHandle: string | null;
  text: string;
  createdAt: Date;
  threadRootEventId: number | null;
  /** Persisted `session.replied` events are authored by the session, not a user. */
  isAgent?: boolean;
}

export interface ChannelChatProjection {
  messages: ChannelChatMessage[];
  historyMutated: boolean;
}

export const CHANNEL_CHAT_MAX_BYTES = 2_000_000;
// Bump this in the same commit as any channel renderer format change.
export const CHANNEL_RENDER_VERSION = '1';
export const CHANNEL_EPOCH = `channel:${CHANNEL_RENDER_VERSION}`;

function readableChannelWhere(userExpr: string, activeChannelExpr: string): string {
  return `(
    (
      (c.kind = 'public' AND ${workspaceMemberExists('c.workspace_id', userExpr)})
      OR EXISTS (SELECT 1 FROM channel_members cm
                 WHERE cm.channel_id = c.id AND cm.user_id = ${userExpr})
      OR EXISTS (SELECT 1 FROM sessions own
                 WHERE own.channel_id = c.id AND own.spawned_by = ${userExpr})
    )
    AND (c.kind NOT IN ('dm', 'gdm') OR c.id = ${activeChannelExpr})
  )`;
}

export async function loadReadableChannels(
  pool: Db,
  viewer: { userId: string; activeChannelId: string },
): Promise<ChannelListDocRow[]> {
  const res = await pool.query<{
    id: string;
    name: string;
    kind: 'public' | 'private' | 'dm' | 'gdm';
    active: boolean;
    last_event_id: string | number | null;
  }>(
    `SELECT c.id::text,
            c.name,
            c.kind,
            (c.id = $2::uuid) AS active,
            COALESCE(latest.last_event_id, 0) AS last_event_id
       FROM channels c
       LEFT JOIN LATERAL (
         SELECT MAX(e.id) AS last_event_id
           FROM events e
          WHERE e.channel_id = c.id
       ) latest ON true
      WHERE ${readableChannelWhere('$1', '$2::uuid')}
      ORDER BY active DESC, COALESCE(latest.last_event_id, 0) DESC, c.name ASC`,
    [viewer.userId, viewer.activeChannelId],
  );
  return res.rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    active: row.active,
    lastEventId: Number(row.last_event_id ?? 0),
  }));
}

export async function loadChannelDocInfo(
  pool: Db,
  viewer: {
    userId: string;
    activeChannelId: string;
    driver: ChannelMemberDocRow | null;
  },
  channelId: string,
): Promise<ChannelDocInfo | null> {
  const channel = await pool.query<{
    id: string;
    name: string;
    kind: 'public' | 'private' | 'dm' | 'gdm';
    active: boolean;
    last_event_id: string | number | null;
  }>(
    `SELECT c.id::text,
            c.name,
            c.kind,
            (c.id = $3::uuid) AS active,
            COALESCE(latest.last_event_id, 0) AS last_event_id
       FROM channels c
       LEFT JOIN LATERAL (
         SELECT MAX(e.id) AS last_event_id
           FROM events e
          WHERE e.channel_id = c.id
       ) latest ON true
      WHERE c.id = $1::uuid
        AND ${readableChannelWhere('$2', '$3::uuid')}
      LIMIT 1`,
    [channelId, viewer.userId, viewer.activeChannelId],
  );
  const row = channel.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    active: row.active,
    lastEventId: Number(row.last_event_id ?? 0),
    members: await loadChannelMembers(pool, row.id, row.kind),
    driver: viewer.driver,
  };
}

async function loadChannelMembers(
  pool: Db,
  channelId: string,
  kind: ChannelDocInfo['kind'],
): Promise<ChannelMemberDocRow[]> {
  const res = await pool.query<{ id: string; handle: string; display_name: string }>(
    kind === 'public'
      ? `SELECT u.id, u.handle, u.display_name
           FROM channels c
           JOIN workspace_members wm ON wm.workspace_id = c.workspace_id
           JOIN users u ON u.id = wm.user_id
          WHERE c.id = $1::uuid
          ORDER BY lower(u.display_name), u.handle`
      : `SELECT u.id, u.handle, u.display_name
           FROM channel_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.channel_id = $1::uuid
          ORDER BY lower(u.display_name), u.handle`,
    [channelId],
  );
  return res.rows.map((row) => ({ id: row.id, handle: row.handle, displayName: row.display_name }));
}

export async function loadChannelChatMessages(pool: Db, channelId: string): Promise<ChannelChatMessage[]> {
  return (await loadChannelChatProjection(pool, channelId)).messages;
}

export async function loadChannelChatProjection(
  pool: Db,
  channelId: string,
  sinceEventId?: number,
): Promise<ChannelChatProjection> {
  const res = await pool.query<{
    id: string | number;
    thread_root_event_id: string | number | null;
    event_type: string;
    actor_id: string | null;
    payload_text: string | null;
    payload_title: string | null;
    edited_text: string | null;
    is_deleted: boolean;
    created_at: Date;
    author_handle: string | null;
    author_display_name: string | null;
    reply_session_title: string | null;
  }>(
    `SELECT e.id,
            e.thread_root_event_id,
            e.type AS event_type,
            e.actor_id,
            e.payload->>'text' AS payload_text,
            e.payload->>'title' AS payload_title,
            edit.text AS edited_text,
            (del.id IS NOT NULL) AS is_deleted,
            e.created_at,
            u.handle AS author_handle,
            u.display_name AS author_display_name,
            replied_session.title AS reply_session_title
       FROM events e
       LEFT JOIN users u ON u.id = e.actor_id
       LEFT JOIN sessions replied_session ON replied_session.id::text = e.payload->>'session_id'
       LEFT JOIN LATERAL (
         SELECT x.payload->>'text' AS text
           FROM events x
          WHERE x.type = 'message.edited'
            AND x.payload->>'target' = ('evt_' || e.id::text)
          ORDER BY x.id DESC
          LIMIT 1
       ) edit ON true
       LEFT JOIN LATERAL (
         SELECT x.id
           FROM events x
          WHERE x.type = 'message.deleted'
            AND x.payload->>'target' = ('evt_' || e.id::text)
          LIMIT 1
       ) del ON true
      WHERE e.channel_id = $1::uuid
        AND e.type IN ('message.posted', 'message.edited', 'message.deleted', 'session.spawned', 'session.replied')
      ORDER BY e.id ASC`,
    [channelId],
  );
  const historyMutated =
    sinceEventId != null &&
    res.rows.some(
      (row) =>
        Number(row.id) > sinceEventId && (row.event_type === 'message.edited' || row.event_type === 'message.deleted'),
    );
  const messages = res.rows
    .filter(
      (row) =>
        !row.is_deleted &&
        (row.event_type === 'message.posted' ||
          row.event_type === 'session.spawned' ||
          row.event_type === 'session.replied'),
    )
    .map((row) => {
      const id = Number(row.id);
      const isAgent = row.event_type === 'session.replied';
      const authorName = isAgent
        ? (row.reply_session_title ?? 'agent')
        : (row.author_display_name ?? row.author_handle ?? row.actor_id ?? 'unknown');
      return {
        id,
        handle: encodeEventHandle(id),
        authorName,
        authorHandle: isAgent ? null : row.author_handle,
        text:
          row.event_type === 'session.spawned'
            ? (row.payload_title ?? 'Agent session')
            : (row.edited_text ?? row.payload_text ?? ''),
        createdAt: new Date(row.created_at),
        threadRootEventId: row.thread_root_event_id == null ? null : Number(row.thread_root_event_id),
        ...(isAgent ? { isAgent: true } : {}),
      };
    });
  return { messages, historyMutated };
}

export function renderChannelMarkdown(info: ChannelDocInfo): string {
  const lines = [
    `# ${info.name}`,
    '',
    `- id: ${info.id}`,
    `- kind: ${info.kind}`,
    `- active for this session: ${info.active ? 'yes' : 'no'}`,
    `- last activity event: ${info.lastEventId || 'none'}`,
    `- this session driver: ${info.driver ? formatMember(info.driver) : 'none'}`,
    '',
    '## Members',
    '',
  ];
  if (info.members.length === 0) {
    lines.push('- none');
  } else {
    for (const member of info.members) lines.push(`- ${formatMember(member)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderChannelChatMarkdown(messages: ChannelChatMessage[], maxBytes = CHANNEL_CHAT_MAX_BYTES): string {
  const groups = groupThreadedMessages(messages).map(renderMessageGroup);
  let bytes = 0;
  let firstIncluded = groups.length;
  for (let i = groups.length - 1; i >= 0; i--) {
    const groupBytes = Buffer.byteLength(groups[i]!);
    if (firstIncluded < groups.length && bytes + groupBytes > maxBytes) break;
    bytes += groupBytes;
    firstIncluded = i;
    if (bytes > maxBytes) break;
  }
  const included = groups.slice(firstIncluded);
  const omitted = messages.length - included.reduce((sum, group) => sum + countAuthorLines(group), 0);
  if (omitted > 0) {
    included.unshift(`...older messages elided (${omitted})...\n\n`);
  }
  return included.join('');
}

export function renderChannelChatDelta(
  messages: ChannelChatMessage[],
  sinceEventId: number,
  maxBytes = CHANNEL_CHAT_MAX_BYTES,
): { body: string; preservesHistory: boolean } {
  const previous = renderChannelChatMarkdown(
    messages.filter((message) => message.id <= sinceEventId),
    maxBytes,
  );
  const body = renderChannelChatMarkdown(
    messages.filter((message) => message.id > sinceEventId),
    Number.POSITIVE_INFINITY,
  );
  const current = renderChannelChatMarkdown(messages, maxBytes);
  return { body, preservesHistory: current === previous + body };
}

function groupThreadedMessages(messages: ChannelChatMessage[]): ChannelChatMessage[][] {
  const roots: ChannelChatMessage[][] = [];
  const rootIndex = new Map<number, ChannelChatMessage[]>();
  for (const message of messages) {
    if (message.threadRootEventId == null) {
      const group = [message];
      roots.push(group);
      rootIndex.set(message.id, group);
      continue;
    }
    const group = rootIndex.get(message.threadRootEventId);
    if (group) {
      group.push(message);
    } else {
      const orphan = [message];
      roots.push(orphan);
      rootIndex.set(message.id, orphan);
    }
  }
  return roots;
}

function renderMessageGroup(group: ChannelChatMessage[]): string {
  const [root, ...replies] = group;
  if (!root) return '';
  const lines = [`${authorLine(root, formatFullMinute(root.createdAt))}`, ...formatBody(root.text, '')];
  for (const reply of replies) {
    lines.push(
      '',
      `  ↳ ${authorLine(reply, formatReplyMinute(root.createdAt, reply.createdAt))}`,
      ...formatBody(reply.text, '  '),
    );
  }
  return `${lines.join('\n')}\n\n`;
}

function authorLine(message: ChannelChatMessage, timestamp: string): string {
  if (message.isAgent) {
    return `**${message.authorName} (agent)** · ${timestamp} ⟨/e/${message.handle}⟩`;
  }
  const handle = message.authorHandle ? ` (@${message.authorHandle})` : '';
  return `**${message.authorName}**${handle} · ${timestamp} ⟨/e/${message.handle}⟩`;
}

function formatBody(text: string, indent: string): string[] {
  const lines = text.length > 0 ? text.split(/\r?\n/) : [''];
  return lines.map((line) => `${indent}${line}`);
}

function formatFullMinute(date: Date): string {
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

function formatReplyMinute(root: Date, reply: Date): string {
  const rootDay = root.toISOString().slice(0, 10);
  const replyIso = reply.toISOString();
  return replyIso.startsWith(rootDay) ? replyIso.slice(11, 16) : formatFullMinute(reply);
}

function formatMember(member: ChannelMemberDocRow): string {
  return `${member.displayName} (@${member.handle})`;
}

function countAuthorLines(group: string): number {
  return (group.match(/^\s*(?:↳ )?\*\*/gm) ?? []).length;
}
