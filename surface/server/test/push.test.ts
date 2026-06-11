// Push fanout: recipient resolution (DM partner / @mentions), live-viewer
// skip, and dead-token pruning. Expo HTTP API is faked.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { config } from '../src/config.js';
import { getOrCreateDm, postMessage, type WireEvent } from '../src/events.js';
import { WsHub, type HubSocket } from '../src/hub.js';
import {
  checkExpoPushReceipts,
  mentionedHandles,
  pushRecipientsFor,
  sendMessagePush,
} from '../src/push.js';
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
  await pool.query(
    `INSERT INTO push_tokens (token, user_id, platform) VALUES ($1, $2, 'ios')`,
    [token, userId],
  );
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

describe('mentionedHandles', () => {
  it('extracts deduped lowercase handles', () => {
    expect(mentionedHandles('hey @Ben and @alice and @ben!')).toEqual(['ben', 'alice']);
    expect(mentionedHandles('no mentions here')).toEqual([]);
    expect(mentionedHandles('mid@word is not a mention of word')).toEqual(['word']);
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

  it('channel messages target @mentioned users, never the author', async () => {
    const mention = await postInChannel(fx.channelId, 'ping @ben and @alice (self)');
    const r1 = await pushRecipientsFor(pool, mention);
    expect(r1.userIds).toEqual([benId]);

    const plain = await postInChannel(fx.channelId, 'nothing for anyone');
    const r2 = await pushRecipientsFor(pool, plain);
    expect(r2.userIds).toEqual([]);
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
    const fetchImpl = okFetch([
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ]);
    const ev = await postInChannel(fx.channelId, 'ping @ben');
    await sendMessagePush(pool, hub, ev, fetchImpl);
    const left = await pool.query('SELECT token FROM push_tokens');
    expect(left.rows).toEqual([]);
  });

  it('pushes thread replies with replied-in titles', async () => {
    await registerToken(fx.userId, 'ExponentPushToken[root]');
    await registerToken(benId, 'ExponentPushToken[prior]');
    await registerToken(caraId, 'ExponentPushToken[actor]');
    const root = await postInChannelAs(fx.channelId, fx.userId, 'root');
    await postInChannelAs(fx.channelId, benId, 'prior reply', root.id);
    const reply = await postInChannelAs(fx.channelId, caraId, 'new reply', root.id);

    const hub = new WsHub();
    const fetchImpl = okFetch();
    await sendMessagePush(pool, hub, reply, fetchImpl);

    const sent = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(sent.map((m: { to: string }) => m.to).sort()).toEqual([
      'ExponentPushToken[prior]',
      'ExponentPushToken[root]',
    ]);
    expect(sent.every((m: { title: string }) => m.title === 'Cara replied in #general')).toBe(true);
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

    await checkExpoPushReceipts(pool, [
      { id: 'okTicket', token: 'ExponentPushToken[ok]' },
      { id: 'deadTicket', token: 'ExponentPushToken[dead]' },
    ], fetchImpl);

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
