import type { Db } from './db.js';

export interface PersistMentionsArgs {
  eventId: number;
  channelId: string | null;
  text: string;
  actorId: string | null;
}

/** Handles are [a-z0-9][a-z0-9_-]*, so a plain regex extraction is safe. */
export function mentionedHandles(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/@([a-z0-9][a-z0-9_-]{1,31})/gi)) {
    out.add(m[1]!.toLowerCase());
  }
  return [...out];
}

export function mentionTargetUserIds(
  users: Iterable<{ id: string }>,
  actorId: string | null,
): string[] {
  const out = new Set<string>();
  for (const user of users) {
    if (user.id !== actorId) out.add(user.id);
  }
  return [...out];
}

export async function persistMentions(
  pool: Db,
  { eventId, channelId, text, actorId }: PersistMentionsArgs,
): Promise<void> {
  if (!channelId) return;
  const handles = mentionedHandles(text);
  if (handles.length === 0) return;

  const users = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE handle = ANY($1::text[])',
    [handles],
  );
  const userIds = mentionTargetUserIds(users.rows, actorId);
  if (userIds.length === 0) return;

  await pool.query(
    `INSERT INTO mentions (event_id, channel_id, user_id)
     SELECT $1::bigint, $2::uuid, u.user_id
     FROM unnest($3::uuid[]) AS u(user_id)
     ON CONFLICT DO NOTHING`,
    [eventId, channelId, userIds],
  );
}
