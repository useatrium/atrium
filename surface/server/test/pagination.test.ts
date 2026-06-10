import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { listChannelMessages, listThreadMessages, postMessage } from '../src/events.js';
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

async function post(text: string, threadRootEventId?: number) {
  return postMessage(pool, {
    workspaceId: fx.workspaceId,
    channelId: fx.channelId,
    actorId: fx.userId,
    text,
    threadRootEventId: threadRootEventId ?? null,
  });
}

describe('channel message pagination', () => {
  it('returns newest-last with before_id windows', async () => {
    const ids: number[] = [];
    for (let i = 1; i <= 9; i++) ids.push((await post(`m${i}`)).id);

    const page1 = await listChannelMessages(pool, { channelId: fx.channelId, limit: 4 });
    expect(page1.events.map((e) => e.id)).toEqual(ids.slice(5)); // m6..m9, newest-last
    expect(page1.hasMore).toBe(true);

    const page2 = await listChannelMessages(pool, {
      channelId: fx.channelId,
      beforeId: page1.events[0]!.id,
      limit: 4,
    });
    expect(page2.events.map((e) => e.id)).toEqual(ids.slice(1, 5)); // m2..m5
    expect(page2.hasMore).toBe(true);

    const page3 = await listChannelMessages(pool, {
      channelId: fx.channelId,
      beforeId: page2.events[0]!.id,
      limit: 4,
    });
    expect(page3.events.map((e) => e.id)).toEqual(ids.slice(0, 1)); // m1
    expect(page3.hasMore).toBe(false);
  });

  it('after_id returns subsequent events ascending, including thread replies', async () => {
    const m1 = await post('m1');
    const m2 = await post('m2');
    const r1 = await post('reply to m1', m1.id);
    const m3 = await post('m3');

    const catchUp = await listChannelMessages(pool, {
      channelId: fx.channelId,
      afterId: m2.id,
    });
    expect(catchUp.events.map((e) => e.id)).toEqual([r1.id, m3.id]);
    expect(catchUp.events[0]!.threadRootEventId).toBe(m1.id);
    expect(catchUp.hasMore).toBe(false);
  });

  it('excludes thread replies from the default timeline but counts them on the root', async () => {
    const root = await post('root');
    await post('noise before replies');
    const reply1 = await post('r1', root.id);
    const reply2 = await post('r2', root.id);

    const page = await listChannelMessages(pool, { channelId: fx.channelId });
    expect(page.events).toHaveLength(2);
    const rootRow = page.events.find((e) => e.id === root.id)!;
    expect(rootRow.replyCount).toBe(2);
    expect(rootRow.lastReplyId).toBe(reply2.id);

    const thread = await listThreadMessages(pool, { rootEventId: root.id });
    expect(thread.events.map((e) => e.id)).toEqual([reply1.id, reply2.id]);
    expect(thread.events.every((e) => e.threadRootEventId === root.id)).toBe(true);
  });

  it('clamps limit and handles empty channels', async () => {
    const empty = await listChannelMessages(pool, { channelId: fx.otherChannelId, limit: 9999 });
    expect(empty.events).toEqual([]);
    expect(empty.hasMore).toBe(false);
  });

  it('folds message.edited into reads', async () => {
    const m = await post('original');
    await pool.query(
      `INSERT INTO events (workspace_id, channel_id, type, actor_id, payload)
       VALUES ($1, $2, 'message.edited', $3, $4)`,
      [fx.workspaceId, fx.channelId, fx.userId, JSON.stringify({ target_event_id: m.id, text: 'edited!' })],
    );
    const page = await listChannelMessages(pool, { channelId: fx.channelId });
    const row = page.events.find((e) => e.id === m.id)!;
    expect(row.payload.text).toBe('edited!');
    expect(row.payload.edited).toBe(true);
  });
});
