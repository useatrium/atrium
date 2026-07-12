// Expo push delivery: DMs notify the other member, channel messages notify
// @mentioned users and thread participants. Fire-and-forget from the message
// route — a push failure must never fail a send.

import type { Db } from './db.js';
import type { WsHub } from './hub.js';
import type { WireEvent } from './events.js';
import { config } from './config.js';
import { mentionedHandles } from './mentions.js';
import {
  getWebPushSender,
  type WebPushPayload,
  type WebPushSender,
  type WebPushSubscription,
  type WebPushUrgency,
} from './webpush.js';
import { normalizeNotificationPrefs, type NotificationPrefs } from '@atrium/surface-client/prefs';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const CHUNK = 100; // Expo's max messages per request
const RECEIPT_DELAY_MS = 15 * 60 * 1000;

type PushReason = 'dm' | 'mention' | 'thread' | 'channel';

interface PushRecipient {
  userId: string;
  reason: PushReason;
}

interface PushRecipientResult {
  userIds: string[];
  channelName: string;
  isDm: boolean;
  recipients: PushRecipient[];
}

interface SendMessagePushOptions {
  fetchImpl?: typeof fetch;
  receiptDelayMs?: number;
  webPushSender?: WebPushSender;
}

export interface ExpoReceiptTicket {
  id: string;
  token: string;
}

function addRecipient(
  recipients: Map<string, PushReason>,
  userId: string | null,
  actorId: string | null,
  reason: PushReason,
): void {
  if (!userId || userId === actorId || recipients.has(userId)) return;
  recipients.set(userId, reason);
}

async function dropMutedRecipients(pool: Db, channelId: string, recipients: Map<string, PushReason>): Promise<void> {
  if (recipients.size === 0) return;
  const muted = await pool.query<{ user_id: string }>(
    `SELECT user_id
     FROM channel_mutes
     WHERE channel_id = $1 AND user_id = ANY($2::uuid[])`,
    [channelId, [...recipients.keys()]],
  );
  for (const row of muted.rows) recipients.delete(row.user_id);
}

async function notificationPrefsFor(pool: Db, userIds: string[]): Promise<Map<string, NotificationPrefs>> {
  if (userIds.length === 0) return new Map();
  const prefs = await pool.query<{ id: string; prefs: unknown }>(
    'SELECT id, prefs FROM users WHERE id = ANY($1::uuid[])',
    [userIds],
  );
  return new Map(
    prefs.rows.map((row) => {
      const raw = (typeof row.prefs === 'object' && row.prefs !== null ? row.prefs : {}) as {
        notifications?: unknown;
      };
      return [row.id, normalizeNotificationPrefs(raw.notifications)];
    }),
  );
}

async function dropMessagePrefsOff(pool: Db, recipients: Map<string, PushReason>): Promise<void> {
  if (recipients.size === 0) return;
  const prefs = await notificationPrefsFor(pool, [...recipients.keys()]);
  for (const userId of [...recipients.keys()]) {
    if (prefs.get(userId)?.messages === 'off') recipients.delete(userId);
  }
}

/** Private channels: a mention/thread recipient who isn't a member must not
 *  receive an out-of-band push containing the message text. */
async function dropNonMembers(pool: Db, channelId: string, recipients: Map<string, PushReason>): Promise<void> {
  if (recipients.size === 0) return;
  const members = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM channel_members
     WHERE channel_id = $1 AND user_id = ANY($2::uuid[])`,
    [channelId, [...recipients.keys()]],
  );
  const allowed = new Set(members.rows.map((r) => r.user_id));
  for (const userId of [...recipients.keys()]) {
    if (!allowed.has(userId)) recipients.delete(userId);
  }
}

/** User ids to push for a message: DM partner(s), @mentioned users, or thread participants. */
export async function pushRecipientsFor(
  pool: Db,
  ev: Pick<WireEvent, 'channelId' | 'actorId' | 'payload'> & {
    threadRootEventId?: number | null;
  },
): Promise<PushRecipientResult> {
  if (!ev.channelId) return { userIds: [], channelName: '', isDm: false, recipients: [] };
  const ch = await pool.query<{ name: string; kind: string }>('SELECT name, kind FROM channels WHERE id = $1', [
    ev.channelId,
  ]);
  const row = ch.rows[0];
  if (!row) return { userIds: [], channelName: '', isDm: false, recipients: [] };

  const recipients = new Map<string, PushReason>();
  if (row.kind === 'dm' || row.kind === 'gdm') {
    const members = await pool.query<{ user_id: string }>('SELECT user_id FROM channel_members WHERE channel_id = $1', [
      ev.channelId,
    ]);
    for (const member of members.rows) {
      addRecipient(recipients, member.user_id, ev.actorId, 'dm');
    }
    await dropMutedRecipients(pool, ev.channelId, recipients);
    await dropMessagePrefsOff(pool, recipients);
    return {
      userIds: [...recipients.keys()],
      channelName: row.name,
      isDm: true,
      recipients: [...recipients].map(([userId, reason]) => ({ userId, reason })),
    };
  }

  const text = typeof ev.payload?.text === 'string' ? ev.payload.text : '';
  const handles = mentionedHandles(text);
  if (handles.length > 0) {
    const users = await pool.query<{ id: string }>('SELECT id FROM users WHERE handle = ANY($1::text[])', [handles]);
    for (const user of users.rows) {
      addRecipient(recipients, user.id, ev.actorId, 'mention');
    }
  }

  if (ev.threadRootEventId != null) {
    const authors = await pool.query<{ actor_id: string | null }>(
      `SELECT DISTINCT actor_id
       FROM events
       WHERE (id = $1 OR thread_root_event_id = $1)
         AND type IN ('message.posted', 'session.spawned')`,
      [ev.threadRootEventId],
    );
    for (const author of authors.rows) {
      addRecipient(recipients, author.actor_id, ev.actorId, 'thread');
    }
  }

  const allMessageMembers = await pool.query<{ user_id: string }>(
    `SELECT cm.user_id
     FROM channel_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.channel_id = $1
       AND cm.user_id <> $2
       AND u.prefs->'notifications'->>'messages' = 'all'`,
    [ev.channelId, ev.actorId],
  );
  for (const member of allMessageMembers.rows) {
    addRecipient(recipients, member.user_id, ev.actorId, 'channel');
  }

  // Private channels: never push to a non-member (mention/thread of a handle
  // outside the channel would otherwise leak the message text out of band).
  if (row.kind === 'private') {
    await dropNonMembers(pool, ev.channelId, recipients);
  }
  await dropMutedRecipients(pool, ev.channelId, recipients);
  await dropMessagePrefsOff(pool, recipients);
  return {
    userIds: [...recipients.keys()],
    channelName: row.name,
    isDm: false,
    recipients: [...recipients].map(([userId, reason]) => ({ userId, reason })),
  };
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoReceipt {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

function sendMessagePushOptions(fetchOrOpts: typeof fetch | SendMessagePushOptions): Required<SendMessagePushOptions> {
  if (typeof fetchOrOpts === 'function') {
    return {
      fetchImpl: fetchOrOpts,
      receiptDelayMs: RECEIPT_DELAY_MS,
      webPushSender: getWebPushSender(config, fetchOrOpts),
    };
  }
  const fetchImpl = fetchOrOpts.fetchImpl ?? fetch;
  return {
    fetchImpl,
    receiptDelayMs: fetchOrOpts.receiptDelayMs ?? RECEIPT_DELAY_MS,
    webPushSender: fetchOrOpts.webPushSender ?? getWebPushSender(config, fetchImpl),
  };
}

function titleFor(reason: PushReason, author: string, channelName: string): string {
  if (reason === 'dm') return author;
  if (reason === 'mention') return `${author} mentioned you in #${channelName}`;
  if (reason === 'channel') return `${author} in #${channelName}`;
  return `${author} replied in #${channelName}`;
}

function firstQuestionText(payload: Record<string, unknown>): string {
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  const first = questions[0];
  if (!first || typeof first !== 'object') return 'Open Atrium to respond.';
  const q = first as { question?: unknown; header?: unknown };
  if (typeof q.question === 'string' && q.question.trim()) return q.question;
  if (typeof q.header === 'string' && q.header.trim()) return q.header;
  return 'Open Atrium to respond.';
}

async function sessionTitleFor(pool: Db, sessionId: string): Promise<string | null> {
  if (!sessionId) return null;
  const session = await pool.query<{ title: string }>('SELECT title FROM sessions WHERE id::text = $1', [sessionId]);
  return session.rows[0]?.title?.trim() || null;
}

export async function pruneTokens(pool: Db, tokens: string[]): Promise<void> {
  if (tokens.length > 0) {
    await pool.query('DELETE FROM push_tokens WHERE token = ANY($1::text[])', [tokens]);
  }
}

export async function checkExpoPushReceipts(
  pool: Db,
  tickets: ExpoReceiptTicket[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (tickets.length === 0) return;
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket.token]));
  const res = await fetchImpl(EXPO_RECEIPTS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [...byId.keys()] }),
  });
  if (!res.ok) return;
  const data = ((await res.json()) as { data?: Record<string, ExpoReceipt> }).data ?? {};
  const dead = Object.entries(data)
    .filter(([, receipt]) => receipt.details?.error === 'DeviceNotRegistered')
    .map(([id]) => byId.get(id))
    .filter((token): token is string => Boolean(token));
  await pruneTokens(pool, dead);
}

// Outstanding receipt-check timers, tracked so shutdown can drain them and so
// they don't accumulate unboundedly under sustained push load.
const receiptTimers = new Set<ReturnType<typeof setTimeout>>();

/** Cancel all pending receipt checks (call on server shutdown). */
export function clearReceiptTimers(): void {
  for (const t of receiptTimers) clearTimeout(t);
  receiptTimers.clear();
}

function scheduleReceiptCheck(pool: Db, tickets: ExpoReceiptTicket[], fetchImpl: typeof fetch, delayMs: number): void {
  if (tickets.length === 0) return;
  const timer = setTimeout(() => {
    receiptTimers.delete(timer);
    void checkExpoPushReceipts(pool, tickets, fetchImpl).catch(() => {});
  }, delayMs);
  timer.unref?.();
  receiptTimers.add(timer);
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  badge: number;
  data: Record<string, unknown>;
}

interface PushTokenRow {
  token: string;
  user_id: string;
  kind: 'expo' | 'webpush';
  subscription: WebPushSubscription | null;
}

async function unreadChannelCountFor(pool: Db, userId: string): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM channels c
     LEFT JOIN channel_read_cursors rc
       ON rc.channel_id = c.id AND rc.user_id = $1
     LEFT JOIN channel_mutes mute
       ON mute.channel_id = c.id AND mute.user_id = $1
     LEFT JOIN LATERAL (
       SELECT MAX(e.id) AS latest_event_id
       FROM events e
       WHERE e.channel_id = c.id
         AND e.type IN ('message.posted', 'session.spawned')
     ) latest ON true
     WHERE mute.user_id IS NULL
       AND COALESCE(latest.latest_event_id, 0) > COALESCE(rc.last_read_event_id, 0)
       AND (
         (c.kind = 'public'
          AND EXISTS (
            SELECT 1 FROM workspace_members wm
            WHERE wm.workspace_id = c.workspace_id AND wm.user_id = $1
          ))
         OR EXISTS (
           SELECT 1 FROM channel_members m
           WHERE m.channel_id = c.id AND m.user_id = $1
         )
       )`,
    [userId],
  );
  return Number(res.rows[0]?.count ?? 0);
}

async function unreadCountsFor(pool: Db, userIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  await Promise.all(
    [...new Set(userIds)].map(async (userId) => {
      counts.set(userId, await unreadChannelCountFor(pool, userId));
    }),
  );
  return counts;
}

async function sendExpoPushes(
  pool: Db,
  messages: ExpoPushMessage[],
  fetchImpl: typeof fetch,
  receiptDelayMs: number,
): Promise<void> {
  const receiptTickets: ExpoReceiptTicket[] = [];
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
    const dead = chunk.filter((_, j) => tickets[j]?.details?.error === 'DeviceNotRegistered').map((m) => m.to);
    await pruneTokens(pool, dead);

    for (let j = 0; j < chunk.length; j += 1) {
      const ticketId = tickets[j]?.id;
      if (tickets[j]?.status === 'ok' && ticketId) {
        receiptTickets.push({ id: ticketId, token: chunk[j]!.to });
      }
    }
  }
  scheduleReceiptCheck(pool, receiptTickets, fetchImpl, receiptDelayMs);
}

async function sendWebPushes(
  pool: Db,
  sender: WebPushSender,
  messages: Array<{
    token: string;
    subscription: WebPushSubscription;
    payload: WebPushPayload;
    urgency: WebPushUrgency;
  }>,
): Promise<void> {
  if (messages.length === 0 || sender.name === 'noop') return;
  const results = await Promise.all(
    messages.map(async (message) => {
      const result = await sender.send(message.subscription, message.payload, {
        urgency: message.urgency,
      });
      if (result.status === 'failed') {
        console.warn('webpush delivery failed', { endpoint: message.token, error: result.error });
      }
      return result.status === 'dead' ? message.token : null;
    }),
  );
  await pruneTokens(
    pool,
    results.filter((token): token is string => token !== null),
  );
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
  fetchOrOpts: typeof fetch | SendMessagePushOptions = fetch,
): Promise<void> {
  const { recipients, channelName } = await pushRecipientsFor(pool, event);
  const targets = recipients.filter(
    (recipient) => !(event.channelId && hub.isUserPresent(event.channelId, recipient.userId)),
  );
  if (targets.length === 0) return;

  const reasonByUserId = new Map(targets.map((recipient) => [recipient.userId, recipient.reason]));
  const tokens = await pool.query<PushTokenRow>(
    `SELECT token, user_id, kind, subscription
     FROM push_tokens
     WHERE user_id = ANY($1::uuid[]) AND kind IN ('expo', 'webpush')`,
    [[...reasonByUserId.keys()]],
  );
  if (tokens.rows.length === 0) return;

  const { fetchImpl, receiptDelayMs, webPushSender } = sendMessagePushOptions(fetchOrOpts);
  const author = event.author?.displayName ?? 'Someone';
  const text = typeof event.payload?.text === 'string' ? event.payload.text : '';
  const body = config.pushRedactContent ? 'New message' : (text || '(attachment)').slice(0, 140);
  const badges = await unreadCountsFor(pool, [...reasonByUserId.keys()]);
  const messageData: Record<string, unknown> = {
    channelId: event.channelId,
    eventId: event.id,
    ...(event.threadRootEventId != null ? { threadRootId: String(event.threadRootEventId) } : {}),
  };
  const payloadFor = (userId: string, title: string): WebPushPayload => ({
    title,
    body,
    tag: `channel:${event.channelId ?? ''}`,
    badge: badges.get(userId) ?? 0,
    data: messageData,
  });
  const expoMessages = tokens.rows
    .filter((r) => r.kind === 'expo')
    .map((r) => ({
      to: r.token,
      title: titleFor(reasonByUserId.get(r.user_id) ?? 'thread', author, channelName),
      body,
      sound: 'default' as const,
      badge: badges.get(r.user_id) ?? 0,
      data: messageData,
    }));
  const webMessages = tokens.rows
    .filter((r) => r.kind === 'webpush' && r.subscription)
    .map((r) => {
      const reason = reasonByUserId.get(r.user_id) ?? 'thread';
      const title = titleFor(reason, author, channelName);
      return {
        token: r.token,
        subscription: r.subscription!,
        payload: payloadFor(r.user_id, title),
        urgency: (reason === 'mention' ? 'high' : 'normal') as WebPushUrgency,
      };
    });

  await sendExpoPushes(pool, expoMessages, fetchImpl, receiptDelayMs);
  await sendWebPushes(pool, webPushSender, webMessages);
}

export async function sendQuestionPush(
  pool: Db,
  hub: WsHub,
  event: WireEvent,
  fetchOrOpts: typeof fetch | SendMessagePushOptions = fetch,
): Promise<void> {
  if (!event.channelId || !event.actorId) return;
  const recipients = new Map<string, PushReason>([[event.actorId, 'thread']]);
  await dropMutedRecipients(pool, event.channelId, recipients);
  if (recipients.size === 0 || hub.isUserPresent(event.channelId, event.actorId)) return;
  const prefs = await notificationPrefsFor(pool, [event.actorId]);
  if (prefs.get(event.actorId)?.sessions === false) return;

  const tokens = await pool.query<PushTokenRow>(
    `SELECT token, user_id, kind, subscription
     FROM push_tokens
     WHERE user_id = $1 AND kind IN ('expo', 'webpush')`,
    [event.actorId],
  );
  if (tokens.rows.length === 0) return;

  const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : '';
  const questionId = typeof event.payload.questionId === 'string' ? event.payload.questionId : '';
  const permalink = typeof event.payload.permalink === 'string' ? event.payload.permalink : `/s/${sessionId}`;
  const sessionTitle = await sessionTitleFor(pool, sessionId);
  const body = firstQuestionText(event.payload).slice(0, 140);
  const badge = await unreadChannelCountFor(pool, event.actorId);
  const data = {
    channelId: event.channelId,
    eventId: event.id,
    permalink,
    sessionId,
    questionId,
  };
  await sendSingleUserPushes(pool, tokens.rows, fetchOrOpts, {
    title: sessionTitle ? `${sessionTitle} needs your input` : 'An agent needs your input',
    body,
    tag: `session:${sessionId || event.id}`,
    badge,
    data,
  });
}

export async function sendSessionCompletedPush(
  pool: Db,
  hub: WsHub,
  event: WireEvent,
  fetchOrOpts: typeof fetch | SendMessagePushOptions = fetch,
): Promise<void> {
  if (!event.channelId || !event.actorId) return;
  if (hub.isUserPresent(event.channelId, event.actorId)) return;
  const recipients = new Map<string, PushReason>([[event.actorId, 'thread']]);
  await dropMutedRecipients(pool, event.channelId, recipients);
  if (recipients.size === 0) return;
  const prefs = await notificationPrefsFor(pool, [event.actorId]);
  if (prefs.get(event.actorId)?.sessions === false) return;

  const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : '';
  const sessionTitle = (await sessionTitleFor(pool, sessionId)) ?? 'session';
  const tokens = await pool.query<PushTokenRow>(
    `SELECT token, user_id, kind, subscription
     FROM push_tokens
     WHERE user_id = $1 AND kind IN ('expo', 'webpush')`,
    [event.actorId],
  );
  if (tokens.rows.length === 0) return;

  const failed = event.payload.status === 'failed';
  const body = config.pushRedactContent
    ? failed
      ? 'Session failed'
      : 'Session finished'
    : typeof event.payload.resultExcerpt === 'string' && event.payload.resultExcerpt.trim()
      ? event.payload.resultExcerpt.slice(0, 140)
      : 'Open Atrium to review.';
  const permalink = typeof event.payload.permalink === 'string' ? event.payload.permalink : `/s/${sessionId}`;
  const title = `${failed ? 'Session failed' : 'Session finished'}: ${sessionTitle}`;
  const badge = await unreadChannelCountFor(pool, event.actorId);
  const data = { channelId: event.channelId, eventId: event.id, permalink, sessionId };
  await sendSingleUserPushes(pool, tokens.rows, fetchOrOpts, {
    title,
    body,
    tag: `session:${sessionId || event.id}`,
    badge,
    data,
  });
}

export async function sendSessionFailedPush(
  pool: Db,
  hub: WsHub,
  event: WireEvent,
  fetchOrOpts: typeof fetch | SendMessagePushOptions = fetch,
): Promise<void> {
  if (!event.channelId || !event.actorId || event.payload.status !== 'failed') return;
  if (hub.isUserPresent(event.channelId, event.actorId)) return;
  const recipients = new Map<string, PushReason>([[event.actorId, 'thread']]);
  await dropMutedRecipients(pool, event.channelId, recipients);
  if (recipients.size === 0) return;
  const prefs = await notificationPrefsFor(pool, [event.actorId]);
  if (prefs.get(event.actorId)?.sessions === false) return;

  const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : '';
  const sessionTitle = (await sessionTitleFor(pool, sessionId)) ?? 'session';
  const tokens = await pool.query<PushTokenRow>(
    `SELECT token, user_id, kind, subscription
     FROM push_tokens
     WHERE user_id = $1 AND kind IN ('expo', 'webpush')`,
    [event.actorId],
  );
  if (tokens.rows.length === 0) return;

  const permalink = typeof event.payload.permalink === 'string' ? event.payload.permalink : `/s/${sessionId}`;
  const badge = await unreadChannelCountFor(pool, event.actorId);
  const data = { channelId: event.channelId, eventId: event.id, permalink, sessionId };
  await sendSingleUserPushes(pool, tokens.rows, fetchOrOpts, {
    title: `Session failed: ${sessionTitle}`,
    body: 'The run crashed before finishing.',
    tag: `session:${sessionId || event.id}`,
    badge,
    data,
  });
}

export async function sendAuthRequiredPush(
  pool: Db,
  hub: WsHub,
  event: WireEvent,
  fetchOrOpts: typeof fetch | SendMessagePushOptions = fetch,
): Promise<void> {
  if (!event.channelId || !event.actorId) return;
  if (hub.isUserPresent(event.channelId, event.actorId)) return;
  const recipients = new Map<string, PushReason>([[event.actorId, 'thread']]);
  await dropMutedRecipients(pool, event.channelId, recipients);
  if (recipients.size === 0) return;
  const prefs = await notificationPrefsFor(pool, [event.actorId]);
  if (prefs.get(event.actorId)?.sessions === false) return;

  const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : '';
  const sessionTitle = (await sessionTitleFor(pool, sessionId)) ?? 'session';
  const tokens = await pool.query<PushTokenRow>(
    `SELECT token, user_id, kind, subscription
     FROM push_tokens
     WHERE user_id = $1 AND kind IN ('expo', 'webpush')`,
    [event.actorId],
  );
  if (tokens.rows.length === 0) return;

  const provider =
    typeof event.payload.provider === 'string' && event.payload.provider.trim()
      ? event.payload.provider
      : 'the provider';
  const permalink = typeof event.payload.permalink === 'string' ? event.payload.permalink : `/s/${sessionId}`;
  const badge = await unreadChannelCountFor(pool, event.actorId);
  const data = { channelId: event.channelId, eventId: event.id, permalink, sessionId };
  await sendSingleUserPushes(pool, tokens.rows, fetchOrOpts, {
    title: `${sessionTitle} is blocked`,
    body: `Reconnect ${provider} to resume.`,
    tag: `session:${sessionId || event.id}`,
    badge,
    data,
  });
}

async function sendSingleUserPushes(
  pool: Db,
  tokens: PushTokenRow[],
  fetchOrOpts: typeof fetch | SendMessagePushOptions,
  payload: WebPushPayload,
): Promise<void> {
  const { fetchImpl, receiptDelayMs, webPushSender } = sendMessagePushOptions(fetchOrOpts);
  const expoMessages = tokens
    .filter((row) => row.kind === 'expo')
    .map((row) => ({
      to: row.token,
      title: payload.title,
      body: payload.body,
      sound: 'default' as const,
      badge: payload.badge,
      data: payload.data,
    }));
  const webMessages = tokens
    .filter((row) => row.kind === 'webpush' && row.subscription)
    .map((row) => ({
      token: row.token,
      subscription: row.subscription!,
      payload,
      urgency: 'normal' as WebPushUrgency,
    }));
  await sendExpoPushes(pool, expoMessages, fetchImpl, receiptDelayMs);
  await sendWebPushes(pool, webPushSender, webMessages);
}
