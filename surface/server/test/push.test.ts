// Push fanout: recipient resolution (DM partner / @mentions), live-viewer
// skip, and dead-token pruning. Expo HTTP API is faked.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { getOrCreateDm, postMessage, type WireEvent } from '../src/events.js';
import { WsHub, type HubSocket } from '../src/hub.js';
import { mentionedHandles, pushRecipientsFor, sendMessagePush } from '../src/push.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let benId: string;

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
});
