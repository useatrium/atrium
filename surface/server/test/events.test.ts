import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { postMessage } from '../src/events.js';
import { WsHub, type HubSocket } from '../src/hub.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;

beforeAll(async () => {
  pool = await createTestPool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  fx = await seedFixture(pool);
});

function fakeSocket(): HubSocket & { received: any[] } {
  const received: any[] = [];
  return {
    readyState: 1,
    received,
    send(data: string) {
      received.push(JSON.parse(data));
    },
  };
}

describe('event insert', () => {
  it('assigns strictly increasing ids and echoes client_msg_id', async () => {
    const a = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'first',
      clientMsgId: 'cmid-1',
    });
    const b = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'second',
      clientMsgId: 'cmid-2',
    });
    expect(b.id).toBeGreaterThan(a.id);
    expect(a.type).toBe('message.posted');
    expect(a.payload.client_msg_id).toBe('cmid-1');
    expect(a.payload.text).toBe('first');
    expect(a.author?.handle).toBe('alice');
  });

  it('rejects replies to missing or cross-channel roots, and nested replies', async () => {
    await expect(
      postMessage(pool, {
        workspaceId: fx.workspaceId,
        channelId: fx.channelId,
        actorId: fx.userId,
        text: 'reply to nothing',
        threadRootEventId: 999999,
      }),
    ).rejects.toMatchObject({ code: 'thread_root_not_found' });

    const root = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'root',
    });
    await expect(
      postMessage(pool, {
        workspaceId: fx.workspaceId,
        channelId: fx.otherChannelId,
        actorId: fx.userId,
        text: 'cross-channel reply',
        threadRootEventId: root.id,
      }),
    ).rejects.toMatchObject({ code: 'thread_channel_mismatch' });

    const reply = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'reply',
      threadRootEventId: root.id,
    });
    await expect(
      postMessage(pool, {
        workspaceId: fx.workspaceId,
        channelId: fx.channelId,
        actorId: fx.userId,
        text: 'nested',
        threadRootEventId: reply.id,
      }),
    ).rejects.toMatchObject({ code: 'nested_thread' });
  });
});

describe('fanout ordering', () => {
  it('delivers events to subscribed sockets in insert order, and only to them', async () => {
    const hub = new WsHub();
    const subscriber = fakeSocket();
    const otherChannelSub = fakeSocket();
    const subClient = hub.addClient(subscriber, { id: 'u1', handle: 'a', displayName: 'A' });
    const otherClient = hub.addClient(otherChannelSub, { id: 'u2', handle: 'b', displayName: 'B' });
    hub.subscribe(subClient, [fx.channelId]);
    hub.subscribe(otherClient, [fx.otherChannelId]);
    subscriber.received.length = 0; // drop presence snapshots
    otherChannelSub.received.length = 0;

    const inserted: number[] = [];
    for (let i = 0; i < 5; i++) {
      const ev = await postMessage(pool, {
        workspaceId: fx.workspaceId,
        channelId: fx.channelId,
        actorId: fx.userId,
        text: `msg ${i}`,
        clientMsgId: `cm-${i}`,
      });
      hub.publishEvent(ev);
      inserted.push(ev.id);
    }

    const got = subscriber.received.filter((m) => m.type === 'event').map((m) => m.event.id);
    expect(got).toEqual(inserted);
    for (let i = 1; i < got.length; i++) expect(got[i]).toBeGreaterThan(got[i - 1]);
    expect(otherChannelSub.received.filter((m) => m.type === 'event')).toHaveLength(0);
  });

  it('tracks channel presence by focus (viewing), not subscription, and clears on disconnect', async () => {
    const hub = new WsHub();
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    const c1 = hub.addClient(s1, { id: 'u1', handle: 'alice', displayName: 'Alice' });
    const c2 = hub.addClient(s2, { id: 'u2', handle: 'bob', displayName: 'Bob' });

    // Everyone subscribes to every channel for event fanout — subscription
    // alone must NOT count as presence (it made all counts identical noise).
    hub.subscribe(c1, [fx.channelId, fx.otherChannelId]);
    hub.subscribe(c2, [fx.channelId, fx.otherChannelId]);
    expect(hub.presenceFor(fx.channelId)).toEqual([]);

    hub.setFocus(c1, fx.channelId);
    hub.setFocus(c2, fx.channelId);
    expect(hub.presenceFor(fx.channelId).map((u) => u.handle)).toEqual(['alice', 'bob']);
    const lastPresence = s1.received.filter((m) => m.type === 'presence').at(-1);
    expect(lastPresence.users.map((u: any) => u.handle)).toEqual(['alice', 'bob']);

    // Switching focus moves presence between channels.
    hub.setFocus(c2, fx.otherChannelId);
    expect(hub.presenceFor(fx.channelId).map((u) => u.handle)).toEqual(['alice']);
    expect(hub.presenceFor(fx.otherChannelId).map((u) => u.handle)).toEqual(['bob']);

    // session:* keys stay subscription-based: pane open = watching.
    hub.subscribe(c2, [fx.channelId, fx.otherChannelId, 'session:s1']);
    expect(hub.isUserPresent('session:s1', 'u2')).toBe(true);
    expect(hub.presenceFor('session:s1').map((u) => u.handle)).toEqual(['bob']);

    hub.removeClient(c2);
    expect(hub.presenceFor(fx.otherChannelId)).toEqual([]);
    expect(hub.presenceFor('session:s1')).toEqual([]);
    expect(hub.presenceFor(fx.channelId).map((u) => u.handle)).toEqual(['alice']);
    const afterLeave = s1.received.filter((m) => m.type === 'presence').at(-1);
    expect(afterLeave).toBeTruthy();
  });
});
