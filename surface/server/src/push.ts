// Expo push delivery: DMs notify the other member, channel messages notify
// @mentioned users. Fire-and-forget from the message route — a push failure
// must never fail a send.

import type { Db } from './db.js';
import type { WsHub } from './hub.js';
import type { WireEvent } from './events.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK = 100; // Expo's max messages per request

/** Handles are [a-z0-9][a-z0-9_-]*, so a plain regex extraction is safe. */
export function mentionedHandles(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/@([a-z0-9][a-z0-9_-]{1,31})/gi)) {
    out.add(m[1]!.toLowerCase());
  }
  return [...out];
}

/** User ids to push for a message: DM partner(s), or @mentioned users. */
export async function pushRecipientsFor(
  pool: Db,
  ev: Pick<WireEvent, 'channelId' | 'actorId' | 'payload'>,
): Promise<{ userIds: string[]; channelName: string; isDm: boolean }> {
  if (!ev.channelId) return { userIds: [], channelName: '', isDm: false };
  const ch = await pool.query<{ name: string; kind: string }>(
    'SELECT name, kind FROM channels WHERE id = $1',
    [ev.channelId],
  );
  const row = ch.rows[0];
  if (!row) return { userIds: [], channelName: '', isDm: false };

  if (row.kind === 'dm') {
    const members = await pool.query<{ user_id: string }>(
      'SELECT user_id FROM channel_members WHERE channel_id = $1',
      [ev.channelId],
    );
    return {
      userIds: members.rows.map((r) => r.user_id).filter((id) => id !== ev.actorId),
      channelName: row.name,
      isDm: true,
    };
  }

  const text = typeof ev.payload?.text === 'string' ? ev.payload.text : '';
  const handles = mentionedHandles(text);
  if (handles.length === 0) return { userIds: [], channelName: row.name, isDm: false };
  const users = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE handle = ANY($1::text[])',
    [handles],
  );
  return {
    userIds: users.rows.map((r) => r.id).filter((id) => id !== ev.actorId),
    channelName: row.name,
    isDm: false,
  };
}

interface ExpoTicket {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

/**
 * Send the push fanout for a freshly posted message. Users with a socket
 * focused on the channel are reading it live and are skipped. Tokens Expo
 * reports as DeviceNotRegistered are pruned.
 */
export async function sendMessagePush(
  pool: Db,
  hub: WsHub,
  event: WireEvent,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const { userIds, channelName, isDm } = await pushRecipientsFor(pool, event);
  const targets = userIds.filter(
    (id) => !(event.channelId && hub.isUserPresent(event.channelId, id)),
  );
  if (targets.length === 0) return;

  const tokens = await pool.query<{ token: string }>(
    'SELECT token FROM push_tokens WHERE user_id = ANY($1::uuid[])',
    [targets],
  );
  if (tokens.rows.length === 0) return;

  const author = event.author?.displayName ?? 'Someone';
  const text = typeof event.payload?.text === 'string' ? event.payload.text : '';
  const body = (text || '(attachment)').slice(0, 140);
  const title = isDm ? author : `${author} mentioned you in #${channelName}`;
  const messages = tokens.rows.map((r) => ({
    to: r.token,
    title,
    body,
    sound: 'default' as const,
    data: { channelId: event.channelId, eventId: event.id },
  }));

  for (let i = 0; i < messages.length; i += CHUNK) {
    const chunk = messages.slice(i, i + CHUNK);
    let tickets: ExpoTicket[];
    try {
      const res = await fetchImpl(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chunk),
      });
      if (!res.ok) continue; // transient Expo failure — badges still cover it
      tickets = ((await res.json()) as { data?: ExpoTicket[] }).data ?? [];
    } catch {
      continue;
    }
    const dead = chunk
      .filter((_, j) => tickets[j]?.details?.error === 'DeviceNotRegistered')
      .map((m) => m.to);
    if (dead.length > 0) {
      await pool.query('DELETE FROM push_tokens WHERE token = ANY($1::text[])', [dead]);
    }
  }
}
