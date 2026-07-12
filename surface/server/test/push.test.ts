// Push fanout: recipient resolution (DM partner / @mentions), live-viewer
// skip, and dead-token pruning. Expo HTTP API is faked.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { config } from '../src/config.js';
import { withTx } from '../src/db.js';
import { appendEvent, getOrCreateDm, getOrCreateGdm, postMessage, type WireEvent } from '../src/events.js';
import { WsHub, type HubSocket } from '../src/hub.js';
import {
  checkExpoPushReceipts,
  pushRecipientsFor,
  sendAuthRequiredPush,
  sendMissedCallPush,
  sendQuestionPush,
  sendMessagePush,
  sendSessionCompletedPush,
  sendSessionFailedPush,
} from '../src/push.js';
import { mentionedHandles } from '../src/mentions.js';
import type { WebPushPayload, WebPushSender, WebPushSubscription, WebPushUrgency } from '../src/webpush.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let benId: string;
let caraId: string;

beforeAll(async () => {
  pool = await createTestPool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  fx = await seedFixture(pool);
  const ben = await pool.query<{ id: string }>(
    `INSERT INTO users (handle, display_name) VALUES ('ben', 'Ben') RETURNING id`,
  );
  benId = ben.rows[0]!.id;
  const cara = await pool.query<{ id: string }>(
    `INSERT INTO users (handle, display_name) VALUES ('cara', 'Cara') RETURNING id`,
  );
  caraId = cara.rows[0]!.id;
});

function fakeSocket(): HubSocket {
  return { readyState: 1, send() {} };
}

async function registerToken(userId: string, token: string) {
  await pool.query(`INSERT INTO push_tokens (token, user_id, platform) VALUES ($1, $2, 'ios')`, [token, userId]);
}

async function registerWebPushToken(userId: string, endpoint: string, subscription: WebPushSubscription) {
  await pool.query(
    `INSERT INTO push_tokens (token, user_id, platform, kind, subscription)
     VALUES ($1, $2, 'web', 'webpush', $3)`,
    [endpoint, userId, subscription],
  );
}

function webPushSubscription(endpoint: string): WebPushSubscription {
  return {
    endpoint,
    keys: {
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg', // gitleaks:allow — public RFC 8291 Appendix A test vector
    },
  };
}

function fakeWebPushSender(
  records: Array<{
    subscription: WebPushSubscription;
    payload: WebPushPayload;
    urgency: WebPushUrgency;
  }>,
): WebPushSender {
  return {
    name: 'fake-webpush',
    async send(subscription, payload, options = {}) {
      records.push({ subscription, payload, urgency: options.urgency ?? 'normal' });
      return { status: 'sent' };
    },
  };
}

function okFetch(tickets?: unknown[]) {
  return vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const sent = JSON.parse(String((init as { body: string }).body)) as { to: string }[];
    return {
      ok: true,
      json: async () => ({ data: tickets ?? sent.map(() => ({ status: 'ok' })) }),
    } as Response;
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

async function postInChannel(channelId: string, text: string): Promise<WireEvent> {
  return postMessage(pool, {
    workspaceId: fx.workspaceId,
    channelId,
    actorId: fx.userId,
    text,
  });
}

async function postInChannelAs(
  channelId: string,
  actorId: string,
  text: string,
  threadRootEventId?: number,
): Promise<WireEvent> {
  return postMessage(pool, {
    workspaceId: fx.workspaceId,
    channelId,
    actorId,
    text,
    threadRootEventId: threadRootEventId ?? null,
  });
}

async function createPushSession(title: string): Promise<string> {
  const session = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by, driver_id)
     VALUES ($1, $2, $3, $4, 'running', $5, $5)
     RETURNING id`,
    [fx.workspaceId, fx.channelId, `push:${title}:${Date.now()}:${Math.random()}`, title, fx.userId],
  );
  return session.rows[0]!.id;
}

async function appendSessionEvent(
  type: string,
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<WireEvent> {
  return withTx(pool, (client) =>
    appendEvent(client, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      type,
      actorId: fx.userId,
      payload: { ...payload, sessionId },
    }),
  );
}

async function appendEndedCallEvent(
  channelId: string,
  participantIds: string[] = [fx.userId],
  declinedIds: string[] = [],
): Promise<WireEvent> {
  const callId = randomUUID();
  const startedAt = new Date().toISOString();
  await pool.query(
    `INSERT INTO calls (id, workspace_id, channel_id, initiator_id, room, status, started_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, 'ended', $6, now())`,
    [callId, fx.workspaceId, channelId, fx.userId, `call:${callId}`, startedAt],
  );
  for (const userId of participantIds) {
    await pool.query('INSERT INTO call_participants (call_id, user_id, left_at) VALUES ($1, $2, now())', [
      callId,
      userId,
    ]);
  }
  for (const userId of declinedIds) {
    await pool.query('INSERT INTO call_declines (call_id, user_id) VALUES ($1, $2)', [callId, userId]);
  }
  return withTx(pool, (client) =>
    appendEvent(client, {
      workspaceId: fx.workspaceId,
      channelId,
      type: 'call.ended',
      actorId: fx.userId,
      payload: {
        callId,
        initiatorId: fx.userId,
        startedAt,
        answered: participantIds.some((userId) => userId !== fx.userId),
      },
    }),
  );
}

describe('mentionedHandles', () => {
  it('extracts deduped lowercase handles', () => {
    expect(mentionedHandles('hey @Ben and @alice and @ben!')).toEqual(['ben', 'alice']);
    expect(mentionedHandles('no mentions here')).toEqual([]);
    expect(mentionedHandles('mid@word is not a mention of word')).toEqual([]);
  });
});

describe('pushRecipientsFor', () => {
  it('DM messages target the other member only', async () => {
    const { channel } = await getOrCreateDm(pool, {
      workspaceId: fx.workspaceId,
      userIdA: fx.userId,
      userIdB: benId,
    });
    const ev = await postInChannel(channel.id, 'hi ben');
    const { userIds, isDm } = await pushRecipientsFor(pool, ev);
    expect(isDm).toBe(true);
    expect(userIds).toEqual([benId]);
  });

  it('GDM messages target all other members as DM pushes', async () => {
    const { channel } = await getOrCreateGdm(pool, {
      workspaceId: fx.workspaceId,
      creatorId: fx.userId,
      userIds: [benId, caraId],
    });
    const ev = await postInChannel(channel.id, 'hi group');
    const recipients = await pushRecipientsFor(pool, ev);
    expect(recipients.isDm).toBe(true);
    expect(new Set(recipients.userIds)).toEqual(new Set([benId, caraId]));
    expect(recipients.recipients.every((r) => r.reason === 'dm')).toBe(true);
  });

  it('channel messages target @mentioned users, never the author', async () => {
    const mention = await postInChannel(fx.channelId, 'ping @ben and @alice (self)');
    const r1 = await pushRecipientsFor(pool, mention);
    expect(r1.userIds).toEqual([benId]);

    const plain = await postInChannel(fx.channelId, 'nothing for anyone');
    const r2 = await pushRecipientsFor(pool, plain);
    expect(r2.userIds).toEqual([]);
  });

  it('skips users who muted the channel', async () => {
    await pool.query('INSERT INTO channel_mutes (user_id, channel_id) VALUES ($1, $2)', [benId, fx.channelId]);
    const mention = await postInChannel(fx.channelId, 'ping @ben');
    const recipients = await pushRecipientsFor(pool, mention);
    expect(recipients.userIds).toEqual([]);
  });

  it('thread replies target prior authors, never the actor', async () => {
    const root = await postInChannelAs(fx.channelId, fx.userId, 'root');
    await postInChannelAs(fx.channelId, benId, 'prior reply', root.id);
    const reply = await postInChannelAs(fx.channelId, caraId, 'new reply', root.id);

    const recipients = await pushRecipientsFor(pool, reply);
    expect(new Set(recipients.userIds)).toEqual(new Set([fx.userId, benId]));
    expect(recipients.userIds).not.toContain(caraId);
    expect(recipients.recipients.every((r) => r.reason === 'thread')).toBe(true);
  });

  it('self replies do not notify the thread root author', async () => {
    const root = await postInChannelAs(fx.channelId, fx.userId, 'root');
    const reply = await postInChannelAs(fx.channelId, fx.userId, 'self reply', root.id);

    const recipients = await pushRecipientsFor(pool, reply);
    expect(recipients.userIds).toEqual([]);
  });

  it('@mentions in thread replies do not double-notify the root author', async () => {
    const root = await postInChannelAs(fx.channelId, fx.userId, 'root');
    const reply = await postInChannelAs(fx.channelId, benId, 'replying with @alice', root.id);

    const recipients = await pushRecipientsFor(pool, reply);
    expect(recipients.recipients).toEqual([{ userId: fx.userId, reason: 'mention' }]);
  });
});

describe('sendMissedCallPush', () => {
  it('sends Expo and web pushes to a never-joined DM callee', async () => {
    const { channel } = await getOrCreateDm(pool, {
      workspaceId: fx.workspaceId,
      userIdA: fx.userId,
      userIdB: benId,
    });
    await registerToken(benId, 'ExponentPushToken[ben-missed-call]');
    const subscription = webPushSubscription('https://push.example.test/subscriptions/ben-missed-call');
    await registerWebPushToken(benId, subscription.endpoint, subscription);
    const records: Array<{
      subscription: WebPushSubscription;
      payload: WebPushPayload;
      urgency: WebPushUrgency;
    }> = [];
    const fetchImpl = okFetch();
    const event = await appendEndedCallEvent(channel.id);

    await sendMissedCallPush(pool, new WsHub(), event, {
      fetchImpl,
      webPushSender: fakeWebPushSender(records),
    });

    const sent = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(sent).toEqual([
      expect.objectContaining({
        to: 'ExponentPushToken[ben-missed-call]',
        title: 'Missed call from Alice',
        body: 'Tap to call back',
        data: { channelId: channel.id, eventId: event.id },
      }),
    ]);
    expect(records).toEqual([
      expect.objectContaining({
        subscription,
        urgency: 'high',
        payload: expect.objectContaining({
          title: 'Missed call from Alice',
          tag: `call:${event.payload.callId}`,
          data: { channelId: channel.id, eventId: event.id },
        }),
      }),
    ]);
  });

  it('skips decliners, calls-disabled users, and muted channels', async () => {
    const { channel } = await getOrCreateDm(pool, {
      workspaceId: fx.workspaceId,
      userIdA: fx.userId,
      userIdB: benId,
    });
    await registerToken(benId, 'ExponentPushToken[ben-no-missed-call]');
    const hub = new WsHub();

    const declined = await appendEndedCallEvent(channel.id, [fx.userId], [benId]);
    const declinedFetch = okFetch();
    await sendMissedCallPush(pool, hub, declined, declinedFetch);
    expect(declinedFetch).not.toHaveBeenCalled();

    await pool.query(
      `UPDATE users
       SET prefs = jsonb_set(COALESCE(prefs, '{}'::jsonb), '{notifications}', $2::jsonb, true)
       WHERE id = $1`,
      [benId, JSON.stringify({ messages: 'mentions', sessions: true, calls: false })],
    );
    const callsDisabled = await appendEndedCallEvent(channel.id);
    const callsDisabledFetch = okFetch();
    await sendMissedCallPush(pool, hub, callsDisabled, callsDisabledFetch);
    expect(callsDisabledFetch).not.toHaveBeenCalled();

    await pool.query(
      `UPDATE users
       SET prefs = jsonb_set(COALESCE(prefs, '{}'::jsonb), '{notifications}', $2::jsonb, true)
       WHERE id = $1`,
      [benId, JSON.stringify({ messages: 'mentions', sessions: true, calls: true })],
    );
    await pool.query('INSERT INTO channel_mutes (user_id, channel_id) VALUES ($1, $2)', [benId, channel.id]);
    const muted = await appendEndedCallEvent(channel.id);
    const mutedFetch = okFetch();
    await sendMissedCallPush(pool, hub, muted, mutedFetch);
    expect(mutedFetch).not.toHaveBeenCalled();
  });
});

describe('sendMessagePush', () => {
  it('pushes to the mentioned user’s tokens', async () => {
    await registerToken(benId, 'ExponentPushToken[ben-1]');
    const hub = new WsHub();
    const fetchImpl = okFetch();
    const ev = await postInChannel(fx.channelId, 'ping @ben');
    await sendMessagePush(pool, hub, ev, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ExponentPushToken[ben-1]');
    expect(sent[0].title).toContain('mentioned you in #general');
    expect(sent[0].data.channelId).toBe(fx.channelId);
    expect(sent[0].data).not.toHaveProperty('threadRootId');
  });

  it('fans out mentioned messages to webpush tokens with badge counts', async () => {
    await pool.query('INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      fx.workspaceId,
      benId,
    ]);
    await postInChannel(fx.otherChannelId, 'unread elsewhere');
    const subscription = webPushSubscription('https://push.example.test/subscriptions/ben');
    await registerWebPushToken(benId, subscription.endpoint, subscription);
    const records: Array<{
      subscription: WebPushSubscription;
      payload: WebPushPayload;
      urgency: WebPushUrgency;
    }> = [];
    const hub = new WsHub();
    const ev = await postInChannel(fx.channelId, 'ping @ben');

    await sendMessagePush(pool, hub, ev, {
      fetchImpl: okFetch(),
      webPushSender: fakeWebPushSender(records),
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      subscription,
      urgency: 'high',
      payload: {
        title: 'Alice mentioned you in #general',
        body: 'ping @ben',
        tag: `channel:${fx.channelId}`,
        badge: 2,
        data: { channelId: fx.channelId, eventId: ev.id },
      },
    });
    expect(records[0]!.payload.data).not.toHaveProperty('threadRootId');
  });

  it('includes explicit all-message members and skips messages-off users', async () => {
    await pool.query(
      'INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING',
      [fx.workspaceId, benId, caraId],
    );
    await pool.query(
      `INSERT INTO channel_members (channel_id, user_id)
       VALUES ($1, $2), ($1, $3)
       ON CONFLICT DO NOTHING`,
      [fx.channelId, benId, caraId],
    );
    await pool.query(
      `UPDATE users
       SET prefs = jsonb_set(COALESCE(prefs, '{}'::jsonb), '{notifications}', $2::jsonb, true)
       WHERE id = $1`,
      [benId, JSON.stringify({ messages: 'all', sessions: true, calls: true })],
    );
    await pool.query(
      `UPDATE users
       SET prefs = jsonb_set(COALESCE(prefs, '{}'::jsonb), '{notifications}', $2::jsonb, true)
       WHERE id = $1`,
      [caraId, JSON.stringify({ messages: 'off', sessions: true, calls: true })],
    );
    await registerToken(benId, 'ExponentPushToken[ben-all]');
    await registerToken(caraId, 'ExponentPushToken[cara-off]');
    const hub = new WsHub();
    const fetchImpl = okFetch();
    const ev = await postInChannel(fx.channelId, 'plain channel message');

    const recipients = await pushRecipientsFor(pool, ev);
    expect(recipients.recipients).toEqual([{ userId: benId, reason: 'channel' }]);

    await sendMessagePush(pool, hub, ev, fetchImpl);
    const sent = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(sent.map((m: { to: string }) => m.to)).toEqual(['ExponentPushToken[ben-all]']);
    expect(sent[0].title).toBe('Alice in #general');
  });

  it('adds unread-channel badge counts to Expo pushes', async () => {
    await pool.query('INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      fx.workspaceId,
      benId,
    ]);
    await postInChannel(fx.otherChannelId, 'unread elsewhere');
    await registerToken(benId, 'ExponentPushToken[ben-badge]');
    const hub = new WsHub();
    const fetchImpl = okFetch();
    const ev = await postInChannel(fx.channelId, 'ping @ben');

    await sendMessagePush(pool, hub, ev, fetchImpl);

    const sent = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(sent[0]).toMatchObject({
      to: 'ExponentPushToken[ben-badge]',
      badge: 2,
      data: { channelId: fx.channelId, eventId: ev.id },
    });
  });

  it('skips users with a socket focused on the channel', async () => {
    await registerToken(benId, 'ExponentPushToken[ben-1]');
    const hub = new WsHub();
    const client = hub.addClient(fakeSocket(), { id: benId, handle: 'ben', displayName: 'Ben' });
    hub.setFocus(client, fx.channelId);
    const fetchImpl = okFetch();
    const ev = await postInChannel(fx.channelId, 'ping @ben');
    await sendMessagePush(pool, hub, ev, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('prunes tokens Expo reports as DeviceNotRegistered', async () => {
    await registerToken(benId, 'ExponentPushToken[dead]');
    const hub = new WsHub();
    const fetchImpl = okFetch([{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }]);
    const ev = await postInChannel(fx.channelId, 'ping @ben');
    await sendMessagePush(pool, hub, ev, fetchImpl);
    const left = await pool.query('SELECT token FROM push_tokens');
    expect(left.rows).toEqual([]);
  });

  it('pushes thread replies with replied-in titles', async () => {
    await registerToken(fx.userId, 'ExponentPushToken[root]');
    await registerToken(benId, 'ExponentPushToken[prior]');
    await registerToken(caraId, 'ExponentPushToken[actor]');
    const subscription = webPushSubscription('https://push.example.test/subscriptions/root');
    await registerWebPushToken(fx.userId, subscription.endpoint, subscription);
    const root = await postInChannelAs(fx.channelId, fx.userId, 'root');
    await postInChannelAs(fx.channelId, benId, 'prior reply', root.id);
    const reply = await postInChannelAs(fx.channelId, caraId, 'new reply', root.id);

    const hub = new WsHub();
    const fetchImpl = okFetch();
    const records: Array<{
      subscription: WebPushSubscription;
      payload: WebPushPayload;
      urgency: WebPushUrgency;
    }> = [];
    await sendMessagePush(pool, hub, reply, {
      fetchImpl,
      webPushSender: fakeWebPushSender(records),
    });

    const sent = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(sent.map((m: { to: string }) => m.to).sort()).toEqual([
      'ExponentPushToken[prior]',
      'ExponentPushToken[root]',
    ]);
    expect(sent.every((m: { title: string }) => m.title === 'Cara replied in #general')).toBe(true);
    expect(sent.every((m: { data: Record<string, unknown> }) => m.data.threadRootId === String(root.id))).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]!.payload.data).toMatchObject({
      channelId: fx.channelId,
      eventId: reply.id,
      threadRootId: String(root.id),
    });
  });

  it('receipt pruning deletes only DeviceNotRegistered tokens', async () => {
    await registerToken(fx.userId, 'ExponentPushToken[ok]');
    await registerToken(benId, 'ExponentPushToken[dead]');
    const fetchImpl = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({
          data: {
            okTicket: { status: 'ok' },
            deadTicket: {
              status: 'error',
              message: 'gone',
              details: { error: 'DeviceNotRegistered' },
            },
          },
        }),
      } as Response;
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

    await checkExpoPushReceipts(
      pool,
      [
        { id: 'okTicket', token: 'ExponentPushToken[ok]' },
        { id: 'deadTicket', token: 'ExponentPushToken[dead]' },
      ],
      fetchImpl,
    );

    const left = await pool.query<{ token: string }>('SELECT token FROM push_tokens ORDER BY token');
    expect(left.rows).toEqual([{ token: 'ExponentPushToken[ok]' }]);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({ ids: ['okTicket', 'deadTicket'] });
  });

  it('redact mode never sends message text to Expo', async () => {
    await registerToken(benId, 'ExponentPushToken[ben-1]');
    const oldRedact = config.pushRedactContent;
    config.pushRedactContent = true;
    try {
      const hub = new WsHub();
      const fetchImpl = okFetch();
      const ev = await postInChannel(fx.channelId, 'secret message for @ben');

      await sendMessagePush(pool, hub, ev, { fetchImpl });

      const sent = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
      expect(sent[0].body).toBe('New message');
      expect(JSON.stringify(sent)).not.toContain('secret message');
    } finally {
      config.pushRedactContent = oldRedact;
    }
  });
});

describe('sendQuestionPush', () => {
  async function questionEvent(text = 'Which deployment path should I take?'): Promise<WireEvent> {
    return withTx(pool, (client) =>
      appendEvent(client, {
        workspaceId: fx.workspaceId,
        channelId: fx.channelId,
        type: 'session.question_requested',
        actorId: fx.userId,
        payload: {
          sessionId: 'session-1',
          questionId: 'q-main',
          permalink: '/s/session-1',
          questions: [{ id: 'choice', header: 'Decision', question: text }],
        },
      }),
    );
  }

  it('pushes question requests to the session creator', async () => {
    await registerToken(fx.userId, 'ExponentPushToken[creator-1]');
    const hub = new WsHub();
    const fetchImpl = okFetch();
    const ev = await questionEvent('Which deployment path should I take?');

    await sendQuestionPush(pool, hub, ev, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'ExponentPushToken[creator-1]',
      title: 'An agent needs your input',
      body: 'Which deployment path should I take?',
      data: {
        channelId: fx.channelId,
        eventId: ev.id,
        permalink: '/s/session-1',
        sessionId: 'session-1',
        questionId: 'q-main',
      },
    });
  });

  it('names the session when it is available', async () => {
    await registerToken(fx.userId, 'ExponentPushToken[creator-titled]');
    const sessionId = await createPushSession('Deploy green');
    const ev = await appendSessionEvent('session.question_requested', sessionId, {
      questionId: 'q-main',
      permalink: `/s/${sessionId}`,
      questions: [{ id: 'choice', header: 'Decision', question: 'Which deployment path should I take?' }],
    });
    const hub = new WsHub();
    const fetchImpl = okFetch();

    await sendQuestionPush(pool, hub, ev, fetchImpl);

    const sent = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(sent[0].title).toBe('Deploy green needs your input');
  });

  it('skips the creator when focused on the question channel', async () => {
    await registerToken(fx.userId, 'ExponentPushToken[creator-1]');
    const hub = new WsHub();
    const client = hub.addClient(fakeSocket(), {
      id: fx.userId,
      handle: 'alice',
      displayName: 'Alice',
    });
    hub.setFocus(client, fx.channelId);
    const fetchImpl = okFetch();
    const ev = await questionEvent();

    await sendQuestionPush(pool, hub, ev, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips the creator when the channel is muted', async () => {
    await registerToken(fx.userId, 'ExponentPushToken[creator-1]');
    await pool.query('INSERT INTO channel_mutes (user_id, channel_id) VALUES ($1, $2)', [fx.userId, fx.channelId]);
    const hub = new WsHub();
    const fetchImpl = okFetch();
    const ev = await questionEvent();

    await sendQuestionPush(pool, hub, ev, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips question pushes when session notifications are disabled', async () => {
    await pool.query(
      `UPDATE users
       SET prefs = jsonb_set(COALESCE(prefs, '{}'::jsonb), '{notifications}', $2::jsonb, true)
       WHERE id = $1`,
      [fx.userId, JSON.stringify({ messages: 'dm_mention', sessions: false, calls: true })],
    );
    await registerToken(fx.userId, 'ExponentPushToken[creator-1]');
    const hub = new WsHub();
    const fetchImpl = okFetch();
    const ev = await questionEvent();

    await sendQuestionPush(pool, hub, ev, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('sendSessionCompletedPush', () => {
  async function completedEvent(): Promise<WireEvent> {
    return withTx(pool, (client) =>
      appendEvent(client, {
        workspaceId: fx.workspaceId,
        channelId: fx.channelId,
        type: 'session.completed',
        actorId: fx.userId,
        payload: {
          sessionId: 'session-1',
          status: 'completed',
          resultExcerpt: 'Done and ready to review.',
          permalink: '/s/session-1',
        },
      }),
    );
  }

  it('pushes session completion to the spawner', async () => {
    await registerToken(fx.userId, 'ExponentPushToken[creator-complete]');
    const hub = new WsHub();
    const fetchImpl = okFetch();
    const ev = await completedEvent();

    await sendSessionCompletedPush(pool, hub, ev, fetchImpl);

    const sent = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(sent[0]).toMatchObject({
      to: 'ExponentPushToken[creator-complete]',
      title: 'Session finished: session',
      body: 'Done and ready to review.',
      data: {
        channelId: fx.channelId,
        eventId: ev.id,
        permalink: '/s/session-1',
        sessionId: 'session-1',
      },
    });
  });

  it('skips session completion when session notifications are disabled', async () => {
    await pool.query(
      `UPDATE users
       SET prefs = jsonb_set(COALESCE(prefs, '{}'::jsonb), '{notifications}', $2::jsonb, true)
       WHERE id = $1`,
      [fx.userId, JSON.stringify({ messages: 'dm_mention', sessions: false, calls: true })],
    );
    await registerToken(fx.userId, 'ExponentPushToken[creator-complete]');
    const hub = new WsHub();
    const fetchImpl = okFetch();
    const ev = await completedEvent();

    await sendSessionCompletedPush(pool, hub, ev, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses failed copy for terminal failures while retaining a failure excerpt when allowed', async () => {
    await registerToken(fx.userId, 'ExponentPushToken[creator-failed]');
    const sessionId = await createPushSession('Broken rollout');
    const ev = await appendSessionEvent('session.completed', sessionId, {
      status: 'failed',
      resultExcerpt: 'The provider timed out.',
      permalink: `/s/${sessionId}`,
    });
    const hub = new WsHub();
    const oldRedact = config.pushRedactContent;

    try {
      config.pushRedactContent = false;
      const fetchWithExcerpt = okFetch();
      await sendSessionCompletedPush(pool, hub, ev, fetchWithExcerpt);
      const withExcerpt = JSON.parse(fetchWithExcerpt.mock.calls[0]![1]!.body as string);
      expect(withExcerpt[0]).toMatchObject({
        title: 'Session failed: Broken rollout',
        body: 'The provider timed out.',
      });

      config.pushRedactContent = true;
      const redactedFetch = okFetch();
      await sendSessionCompletedPush(pool, hub, ev, redactedFetch);
      const redacted = JSON.parse(redactedFetch.mock.calls[0]![1]!.body as string);
      expect(redacted[0]).toMatchObject({
        title: 'Session failed: Broken rollout',
        body: 'Session failed',
      });
    } finally {
      config.pushRedactContent = oldRedact;
    }
  });
});

describe('agent-state push senders', () => {
  it('pushes crash-path session failures with the session deep link', async () => {
    await registerToken(fx.userId, 'ExponentPushToken[creator-crash]');
    const sessionId = await createPushSession('Crash recovery');
    const ev = await appendSessionEvent('session.status_changed', sessionId, { status: 'failed' });
    const hub = new WsHub();
    const fetchImpl = okFetch();

    await sendSessionFailedPush(pool, hub, ev, fetchImpl);

    const sent = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(sent[0]).toMatchObject({
      to: 'ExponentPushToken[creator-crash]',
      title: 'Session failed: Crash recovery',
      body: 'The run crashed before finishing.',
      data: {
        channelId: fx.channelId,
        eventId: ev.id,
        permalink: `/s/${sessionId}`,
        sessionId,
      },
    });
  });

  it('pushes provider authentication blocks with the session deep link', async () => {
    await registerToken(fx.userId, 'ExponentPushToken[creator-auth]');
    const sessionId = await createPushSession('Private repository');
    const ev = await appendSessionEvent('session.github_auth_required', sessionId, {
      provider: 'github',
      reason: 'invalid_token',
    });
    const hub = new WsHub();
    const fetchImpl = okFetch();

    await sendAuthRequiredPush(pool, hub, ev, fetchImpl);

    const sent = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(sent[0]).toMatchObject({
      to: 'ExponentPushToken[creator-auth]',
      title: 'Private repository is blocked',
      body: 'Reconnect github to resume.',
      data: {
        channelId: fx.channelId,
        eventId: ev.id,
        permalink: `/s/${sessionId}`,
        sessionId,
      },
    });
  });
});

describe('private-channel push membership', () => {
  it('does not push a private-channel @mention to a non-member', async () => {
    const priv = await pool.query<{ id: string }>(
      `INSERT INTO channels (workspace_id, name, kind, created_by)
       VALUES ($1, 'sekrit', 'private', $2) RETURNING id`,
      [fx.workspaceId, fx.userId],
    );
    const channelId = priv.rows[0]!.id;
    await pool.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [channelId, fx.userId]);
    // ben is NOT a member but is @mentioned and has a push token.
    await registerToken(benId, 'ExponentPushToken[ben-nonmember]');
    const hub = new WsHub();
    const fetchImpl = okFetch();
    const ev = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId,
      actorId: fx.userId,
      text: 'secret plans @ben',
    });
    await sendMessagePush(pool, hub, ev, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
