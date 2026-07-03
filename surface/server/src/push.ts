// Expo push delivery: DMs notify the other member, channel messages notify
// @mentioned users and thread participants. Fire-and-forget from the message
// route — a push failure must never fail a send.

import type { Db } from './db.js';
import type { WsHub } from './hub.js';
import type { WireEvent } from './events.js';
import { config } from './config.js';
import { mentionedHandles } from './mentions.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const CHUNK = 100; // Expo's max messages per request
const RECEIPT_DELAY_MS = 15 * 60 * 1000;

type PushReason = 'dm' | 'mention' | 'thread';

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

async function dropMutedRecipients(
  pool: Db,
  channelId: string,
  recipients: Map<string, PushReason>,
): Promise<void> {
  if (recipients.size === 0) return;
  const muted = await pool.query<{ user_id: string }>(
    `SELECT user_id
     FROM channel_mutes
     WHERE channel_id = $1 AND user_id = ANY($2::uuid[])`,
    [channelId, [...recipients.keys()]],
  );
  for (const row of muted.rows) recipients.delete(row.user_id);
}

/** Private channels: a mention/thread recipient who isn't a member must not
 *  receive an out-of-band push containing the message text. */
async function dropNonMembers(
  pool: Db,
  channelId: string,
  recipients: Map<string, PushReason>,
): Promise<void> {
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
  const ch = await pool.query<{ name: string; kind: string }>(
    'SELECT name, kind FROM channels WHERE id = $1',
    [ev.channelId],
  );
  const row = ch.rows[0];
  if (!row) return { userIds: [], channelName: '', isDm: false, recipients: [] };

  const recipients = new Map<string, PushReason>();
  if (row.kind === 'dm' || row.kind === 'gdm') {
    const members = await pool.query<{ user_id: string }>(
      'SELECT user_id FROM channel_members WHERE channel_id = $1',
      [ev.channelId],
    );
    for (const member of members.rows) {
      addRecipient(recipients, member.user_id, ev.actorId, 'dm');
    }
    await dropMutedRecipients(pool, ev.channelId, recipients);
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
    const users = await pool.query<{ id: string }>(
      'SELECT id FROM users WHERE handle = ANY($1::text[])',
      [handles],
    );
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

  // Private channels: never push to a non-member (mention/thread of a handle
  // outside the channel would otherwise leak the message text out of band).
  if (row.kind === 'private') {
    await dropNonMembers(pool, ev.channelId, recipients);
  }
  await dropMutedRecipients(pool, ev.channelId, recipients);
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

function sendMessagePushOptions(
  fetchOrOpts: typeof fetch | SendMessagePushOptions,
): Required<SendMessagePushOptions> {
  if (typeof fetchOrOpts === 'function') {
    return { fetchImpl: fetchOrOpts, receiptDelayMs: RECEIPT_DELAY_MS };
  }
  return {
    fetchImpl: fetchOrOpts.fetchImpl ?? fetch,
    receiptDelayMs: fetchOrOpts.receiptDelayMs ?? RECEIPT_DELAY_MS,
  };
}

function titleFor(reason: PushReason, author: string, channelName: string): string {
  if (reason === 'dm') return author;
  if (reason === 'mention') return `${author} mentioned you in #${channelName}`;
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

function scheduleReceiptCheck(
  pool: Db,
  tickets: ExpoReceiptTicket[],
  fetchImpl: typeof fetch,
  delayMs: number,
): void {
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
  data: Record<string, unknown>;
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
    const dead = chunk
      .filter((_, j) => tickets[j]?.details?.error === 'DeviceNotRegistered')
      .map((m) => m.to);
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
  const tokens = await pool.query<{ token: string; user_id: string }>(
    "SELECT token, user_id FROM push_tokens WHERE user_id = ANY($1::uuid[]) AND kind = 'expo'",
    [[...reasonByUserId.keys()]],
  );
  if (tokens.rows.length === 0) return;

  const { fetchImpl, receiptDelayMs } = sendMessagePushOptions(fetchOrOpts);
  const author = event.author?.displayName ?? 'Someone';
  const text = typeof event.payload?.text === 'string' ? event.payload.text : '';
  const body = config.pushRedactContent ? 'New message' : (text || '(attachment)').slice(0, 140);
  const messages = tokens.rows.map((r) => ({
    to: r.token,
    title: titleFor(reasonByUserId.get(r.user_id) ?? 'thread', author, channelName),
    body,
    sound: 'default' as const,
    data: { channelId: event.channelId, eventId: event.id },
  }));

  await sendExpoPushes(pool, messages, fetchImpl, receiptDelayMs);
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

  const tokens = await pool.query<{ token: string }>(
    "SELECT token FROM push_tokens WHERE user_id = $1 AND kind = 'expo'",
    [event.actorId],
  );
  if (tokens.rows.length === 0) return;

  const { fetchImpl, receiptDelayMs } = sendMessagePushOptions(fetchOrOpts);
  const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : '';
  const questionId = typeof event.payload.questionId === 'string' ? event.payload.questionId : '';
  const permalink =
    typeof event.payload.permalink === 'string' ? event.payload.permalink : `/s/${sessionId}`;
  const body = firstQuestionText(event.payload).slice(0, 140);
  const messages = tokens.rows.map((r) => ({
    to: r.token,
    title: 'Centaur needs your input',
    body,
    sound: 'default' as const,
    data: {
      channelId: event.channelId,
      eventId: event.id,
      permalink,
      sessionId,
      questionId,
    },
  }));

  await sendExpoPushes(pool, messages, fetchImpl, receiptDelayMs);
}
