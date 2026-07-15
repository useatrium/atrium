import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import {
  addChannelMember,
  createChannel,
  listChannelMessages,
  listVisibleSyncEvents,
  postMessage,
  type WireEvent,
} from '../src/events.js';
import { createTestPool, seedEvent, seedFixture, seedMember, truncateAll, type Fixture } from './helpers.js';

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

async function post(text: string, threadRootEventId?: number) {
  return postMessage(pool, {
    workspaceId: fx.workspaceId,
    channelId: fx.channelId,
    actorId: fx.userId,
    text,
    threadRootEventId: threadRootEventId ?? null,
  });
}

async function modifier(type: string, targetId: number, payload: Record<string, unknown> = {}): Promise<number> {
  return seedEvent(pool, {
    workspaceId: fx.workspaceId,
    channelId: fx.channelId,
    type,
    actorId: fx.userId,
    payload: { target: `evt_${targetId}`, ...payload },
  });
}

async function foldedFeeds(after: number, limit = 100) {
  const [channel, sync] = await Promise.all([
    listChannelMessages(pool, { channelId: fx.channelId, afterId: after, limit, folded: true }),
    listVisibleSyncEvents(pool, { userId: fx.userId, after, limit, folded: true }),
  ]);
  return [channel.events, sync.events] as const;
}

function expectNoRawModifiers(events: WireEvent[]): void {
  expect(events.map((event) => event.type)).not.toEqual(
    expect.arrayContaining([
      'message.edited',
      'message.deleted',
      'message.unfurls_suppressed',
      'reaction.added',
      'reaction.removed',
    ]),
  );
}

describe('folded catch-up change feed', () => {
  it('reships changed old roots and replies with folded edit, reaction, reply-count, and tombstone state', async () => {
    const root = await post('original root');
    const reply = await post('reply', root.id);

    const editId = await modifier('message.edited', root.id, { text: 'edited root' });
    for (const events of await foldedFeeds(reply.id)) {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: root.id,
        lastModifierId: editId,
        payload: { text: 'edited root', edited: true },
      });
      expectNoRawModifiers(events);
    }

    const reactionId = await modifier('reaction.added', reply.id, { emoji: '👍' });
    for (const events of await foldedFeeds(editId)) {
      expect(events.map((event) => event.id)).toEqual([root.id, reply.id]);
      expect(events.every((event) => event.lastModifierId === reactionId)).toBe(true);
      expect(events.find((event) => event.id === root.id)?.replyCount).toBe(1);
      expect(events.find((event) => event.id === reply.id)?.payload.reactions).toEqual([
        { emoji: '👍', userIds: [fx.userId] },
      ]);
      expectNoRawModifiers(events);
    }

    const deleteId = await modifier('message.deleted', reply.id);
    for (const events of await foldedFeeds(reactionId)) {
      expect(events.map((event) => event.id)).toEqual([root.id, reply.id]);
      expect(events.every((event) => event.lastModifierId === deleteId)).toBe(true);
      expect(events.find((event) => event.id === root.id)?.replyCount).toBe(0);
      expect(events.find((event) => event.id === reply.id)?.payload).toMatchObject({
        text: '',
        deleted: true,
      });
      expectNoRawModifiers(events);
    }
  });

  it('ships voice.transcribed raw exactly once rather than duplicating its message-state row', async () => {
    const voice = await post('voice target');
    const transcriptId = await seedEvent(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      type: 'voice.transcribed',
      actorId: null,
      payload: { target: `evt_${voice.id}`, transcript: { status: 'done', text: 'hello' } },
    });

    for (const events of await foldedFeeds(voice.id)) {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ id: transcriptId, type: 'voice.transcribed' });
    }
  });

  it('extends a channel page across a tied change id and pages the rest without gaps or duplicates', async () => {
    const root = await post('root');
    const reply = await post('reply', root.id);
    const reactionId = await modifier('reaction.added', reply.id, { emoji: '👀' });
    await seedEvent(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      type: 'voice.transcribed',
      actorId: null,
      payload: { target: `evt_${root.id}`, transcript: { status: 'done', text: 'done' } },
    });

    const unlimited = await listChannelMessages(pool, {
      channelId: fx.channelId,
      afterId: reply.id,
      limit: 100,
      folded: true,
    });
    const first = await listChannelMessages(pool, {
      channelId: fx.channelId,
      afterId: reply.id,
      limit: 1,
      folded: true,
    });
    expect(first.events.map((event) => event.id)).toEqual([root.id, reply.id]);
    expect(first.events.every((event) => event.lastModifierId === reactionId)).toBe(true);
    expect(first.nextCursor).toBe(reactionId);
    expect(first.hasMore).toBe(true);

    const paged = [...first.events];
    let cursor = first.nextCursor!;
    while (true) {
      const page = await listChannelMessages(pool, {
        channelId: fx.channelId,
        afterId: cursor,
        limit: 1,
        folded: true,
      });
      expect(page.nextCursor).toBeGreaterThanOrEqual(cursor);
      paged.push(...page.events);
      cursor = page.nextCursor!;
      if (!page.hasMore) break;
    }

    expect(paged.map((event) => event.id)).toEqual(unlimited.events.map((event) => event.id));
    expect(new Set(paged.map((event) => event.id)).size).toBe(paged.length);

    const sync = await listVisibleSyncEvents(pool, {
      userId: fx.userId,
      after: reply.id,
      limit: 1,
      folded: true,
    });
    expect(sync).toMatchObject({ events: [], limited: true });
  });

  it('keeps legacy catch-up byte shape and route behavior unless wire=folded is requested', async () => {
    const root = await post('original');
    const editId = await modifier('message.edited', root.id, { text: 'edited' });
    const app = await buildApp({
      pool,
      rateLimit: false,
      sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
    });
    await app.ready();
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { handle: 'alice', displayName: 'Alice' },
      });
      expect(login.statusCode).toBe(200);
      const cookie = login.headers['set-cookie'] as string;

      const legacyChannelExpected = await listChannelMessages(pool, {
        channelId: fx.channelId,
        afterId: root.id,
      });
      const legacyChannel = await app.inject({
        method: 'GET',
        url: `/api/channels/${fx.channelId}/messages?after_id=${root.id}`,
        headers: { cookie },
      });
      expect(legacyChannel.statusCode).toBe(200);
      expect(legacyChannel.json()).toEqual(legacyChannelExpected);
      expect(legacyChannel.json()).not.toHaveProperty('nextCursor');
      expect(legacyChannel.json().events).toHaveLength(1);
      expect(legacyChannel.json().events[0]).toMatchObject({ id: editId, type: 'message.edited' });
      expect(legacyChannel.json().events[0]).not.toHaveProperty('lastModifierId');

      const foldedChannel = await app.inject({
        method: 'GET',
        url: `/api/channels/${fx.channelId}/messages?after_id=${root.id}&wire=folded`,
        headers: { cookie },
      });
      expect(foldedChannel.statusCode).toBe(200);
      expect(foldedChannel.json()).toMatchObject({ hasMore: false, nextCursor: editId });
      expect(foldedChannel.json().events).toHaveLength(1);
      expect(foldedChannel.json().events[0]).toMatchObject({
        id: root.id,
        lastModifierId: editId,
        payload: { text: 'edited', edited: true },
      });

      const legacySyncExpected = await listVisibleSyncEvents(pool, {
        userId: fx.userId,
        after: root.id,
        limit: 100,
      });
      const legacySync = await app.inject({
        method: 'GET',
        url: `/api/sync?after=${root.id}&limit=100`,
        headers: { cookie },
      });
      expect(legacySync.statusCode).toBe(200);
      expect(legacySync.json()).toMatchObject(legacySyncExpected);
      expect(legacySync.json().events[0]).toMatchObject({ id: editId, type: 'message.edited' });
      expect(legacySync.json().events[0]).not.toHaveProperty('lastModifierId');

      const foldedSync = await app.inject({
        method: 'GET',
        url: `/api/sync?after=${root.id}&limit=100&wire=folded`,
        headers: { cookie },
      });
      expect(foldedSync.statusCode).toBe(200);
      expect(foldedSync.json()).toMatchObject({ nextCursor: editId, limited: false });
      expect(foldedSync.json().events).toHaveLength(1);
      expect(foldedSync.json().events[0]).toMatchObject({ id: root.id, lastModifierId: editId });
    } finally {
      await app.close();
    }
  });

  it('applies private membership and the join-event lower bound to folded sync rows', async () => {
    const bob = await seedMember(pool, fx.workspaceId, 'bob', 'Bob');
    const carol = await seedMember(pool, fx.workspaceId, 'carol', 'Carol');
    const { channel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: 'private-folded',
      actorId: fx.userId,
      private: true,
    });
    const preJoinChanged = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: channel.id,
      actorId: fx.userId,
      text: 'before join, changed later',
    });
    const preJoinUnchanged = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: channel.id,
      actorId: fx.userId,
      text: 'before join, unchanged',
    });
    const joined = await addChannelMember(pool, { channelId: channel.id, actorId: fx.userId, userId: bob });
    expect(joined).not.toBeNull();
    const editId = await seedEvent(pool, {
      workspaceId: fx.workspaceId,
      channelId: channel.id,
      type: 'message.edited',
      actorId: fx.userId,
      payload: { target: `evt_${preJoinChanged.id}`, text: 'visible after join' },
    });

    const bobSync = await listVisibleSyncEvents(pool, { userId: bob, after: 0, limit: 100, folded: true });
    expect(bobSync.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: joined!.event.id, type: 'channel.member_joined' }),
        expect.objectContaining({ id: preJoinChanged.id, lastModifierId: editId }),
      ]),
    );
    expect(bobSync.events.some((event) => event.id === preJoinUnchanged.id)).toBe(false);

    const carolSync = await listVisibleSyncEvents(pool, { userId: carol, after: 0, limit: 100, folded: true });
    expect(carolSync.events.some((event) => event.channelId === channel.id)).toBe(false);
  });

  it('keeps cursors monotonic on empty feeds and probes reply-expanded feed cardinality', async () => {
    const roots = await Promise.all(Array.from({ length: 4 }, (_, index) => post(`root ${index}`)));
    const cursor = roots.at(-1)!.id;
    const replies = [];
    for (const [index, root] of roots.entries()) replies.push(await post(`reply ${index}`, root.id));

    const limited = await listVisibleSyncEvents(pool, {
      userId: fx.userId,
      after: cursor,
      limit: roots.length,
      folded: true,
    });
    expect(limited.events).toEqual([]);
    expect(limited.limited).toBe(true);
    expect(limited.nextCursor).toBe(replies.at(-1)!.id);

    const channelEmpty = await listChannelMessages(pool, {
      channelId: fx.channelId,
      afterId: limited.nextCursor,
      folded: true,
    });
    expect(channelEmpty).toEqual({ events: [], hasMore: false, nextCursor: limited.nextCursor });

    const syncEmpty = await listVisibleSyncEvents(pool, {
      userId: fx.userId,
      after: limited.nextCursor,
      limit: 100,
      folded: true,
    });
    expect(syncEmpty).toMatchObject({ events: [], limited: false, nextCursor: limited.nextCursor });
  });
});
