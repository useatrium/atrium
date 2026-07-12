import type { Db } from './db.js';
import { extractMentionTokens, type SpecialMention } from '@atrium/surface-client/mentions';

export type MentionKind = 'direct' | SpecialMention;

interface ChannelIdentity {
  kind: string;
  workspaceId: string;
}

export interface PersistMentionsArgs {
  eventId: number;
  channelId: string | null;
  text: string;
  actorId: string | null;
  presenceFor: (channelId: string) => Array<{ id: string }>;
}

/** Handles are [a-z0-9][a-z0-9_-]*, so a plain regex extraction is safe. */
export function mentionedHandles(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^a-z0-9_-])@([a-z0-9][a-z0-9_-]{1,31})(?![a-z0-9_-])/gi)) {
    out.add(m[1]!.toLowerCase());
  }
  return [...out];
}

export async function resolveDirectMentionUserIds(pool: Db, text: string): Promise<string[]> {
  const { userIds } = extractMentionTokens(text);
  const handles = mentionedHandles(text);
  if (userIds.length === 0 && handles.length === 0) return [];

  const users = await pool.query<{ id: string }>(
    `SELECT id FROM users
     WHERE id = ANY($1::uuid[]) OR handle = ANY($2::text[])`,
    [userIds, handles],
  );
  return [...new Set(users.rows.map((user) => user.id))];
}

export async function memberUserIdsForChannel(
  pool: Db,
  channelId: string,
  { kind, workspaceId }: ChannelIdentity,
): Promise<string[]> {
  const members =
    kind === 'public'
      ? await pool.query<{ user_id: string }>('SELECT user_id FROM workspace_members WHERE workspace_id = $1', [
          workspaceId,
        ])
      : await pool.query<{ user_id: string }>('SELECT user_id FROM channel_members WHERE channel_id = $1', [channelId]);
  return members.rows.map((member) => member.user_id);
}

export function mentionTargetUserIds(users: Iterable<{ id: string }>, actorId: string | null): string[] {
  const out = new Set<string>();
  for (const user of users) {
    if (user.id !== actorId) out.add(user.id);
  }
  return [...out];
}

export async function persistMentions(
  pool: Db,
  { eventId, channelId, text, actorId, presenceFor }: PersistMentionsArgs,
): Promise<void> {
  if (!channelId) return;
  const tokens = extractMentionTokens(text);
  const handles = mentionedHandles(text);
  if (tokens.userIds.length === 0 && tokens.specials.length === 0 && handles.length === 0) return;

  const channel = await pool.query<{ kind: string; workspace_id: string }>(
    'SELECT kind, workspace_id FROM channels WHERE id = $1',
    [channelId],
  );
  const channelRow = channel.rows[0];
  if (!channelRow) return;

  const directUserIds = mentionTargetUserIds(
    (await resolveDirectMentionUserIds(pool, text)).map((id) => ({ id })),
    actorId,
  );
  const kinds = new Map<string, MentionKind>();
  for (const userId of directUserIds) kinds.set(userId, 'direct');

  const expandsSpecials = channelRow.kind !== 'dm' && channelRow.kind !== 'gdm' && tokens.specials.length > 0;
  const needsMembers = channelRow.kind === 'private' || expandsSpecials;
  const memberIds = needsMembers
    ? await memberUserIdsForChannel(pool, channelId, {
        kind: channelRow.kind,
        workspaceId: channelRow.workspace_id,
      })
    : [];
  const members = new Set(memberIds);

  if (channelRow.kind === 'private') {
    for (const userId of kinds.keys()) {
      if (!members.has(userId)) kinds.delete(userId);
    }
  }

  if (expandsSpecials && tokens.specials.includes('channel')) {
    for (const userId of memberIds) {
      if (userId !== actorId && !kinds.has(userId)) kinds.set(userId, 'channel');
    }
  }
  if (expandsSpecials && tokens.specials.includes('here')) {
    for (const { id } of presenceFor(channelId)) {
      if (id !== actorId && members.has(id) && !kinds.has(id)) kinds.set(id, 'here');
    }
  }

  if (kinds.size === 0) return;
  const rows = [...kinds];

  await pool.query(
    `INSERT INTO mentions (event_id, channel_id, user_id, kind)
     SELECT $1::bigint, $2::uuid, u.user_id, u.kind
     FROM unnest($3::uuid[], $4::text[]) AS u(user_id, kind)
     ON CONFLICT (event_id, user_id) DO UPDATE
       SET kind = CASE
         WHEN mentions.kind = 'direct' OR EXCLUDED.kind = 'direct' THEN 'direct'
         WHEN mentions.kind = 'channel' OR EXCLUDED.kind = 'channel' THEN 'channel'
         ELSE 'here'
       END`,
    [eventId, channelId, rows.map(([userId]) => userId), rows.map(([, kind]) => kind)],
  );
}
