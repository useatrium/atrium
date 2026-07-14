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

  it('returns persisted root question events in fresh and paged history', async () => {
    const before = await post('before question');
    const questionId = 'question-1';
    const inserted = await pool.query<{ id: string; type: string }>(
      `INSERT INTO events (workspace_id, channel_id, type, actor_id, payload)
       SELECT $1, $2, type, $3, payload
       FROM jsonb_to_recordset($4::jsonb) AS event(type text, payload jsonb)
       RETURNING id::text, type`,
      [
        fx.workspaceId,
        fx.channelId,
        fx.userId,
        JSON.stringify([
          {
            type: 'session.question_requested',
            payload: { sessionId: 'session-1', questionId, questions: [{ id: 'choice', question: 'Choose?' }] },
          },
          {
            type: 'session.question_answered',
            payload: {
              sessionId: 'session-1',
              questionId,
              answers: [{ id: 'choice', header: 'Choice', answers: ['A'], count: 1 }],
            },
          },
          {
            type: 'session.question_resolved',
            payload: { sessionId: 'session-1', questionId, reason: 'answered' },
          },
        ]),
      ],
    );

    const latest = await listChannelMessages(pool, { channelId: fx.channelId, limit: 2 });
    expect(latest.events.map((event) => event.type)).toEqual([
      'session.question_answered',
      'session.question_resolved',
    ]);
    expect(latest.hasMore).toBe(true);

    const earlier = await listChannelMessages(pool, {
      channelId: fx.channelId,
      beforeId: latest.events[0]!.id,
      limit: 2,
    });
    expect(earlier.events.map((event) => event.type)).toEqual(['message.posted', 'session.question_requested']);
    expect(earlier.events[0]!.id).toBe(before.id);
    expect(earlier.events[1]!.id).toBe(
      Number(inserted.rows.find((event) => event.type === 'session.question_requested')!.id),
    );
    expect(earlier.hasMore).toBe(false);
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
      [fx.workspaceId, fx.channelId, fx.userId, JSON.stringify({ target: `evt_${m.id}`, text: 'edited!' })],
    );
    const page = await listChannelMessages(pool, { channelId: fx.channelId });
    const row = page.events.find((e) => e.id === m.id)!;
    expect(row.payload.text).toBe('edited!');
    expect(row.payload.edited).toBe(true);
  });
});

// The agent's ANSWER is a first-class channel message: `session.replied` is
// thread-rooted, so it needs BOTH the broadcast flag and a place in the feed
// query's type whitelist. It had the flag and not the whitelist, and the answer
// silently never reached the channel — green unit tests and all.
describe('the agent answer reaches the channel feed', () => {
  async function appendReply(threadRootEventId: number, text: string, broadcast: boolean) {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO events (workspace_id, channel_id, thread_root_event_id, type, actor_id, payload)
       VALUES ($1, $2, $3, 'session.replied', NULL, $4::jsonb)
       RETURNING id`,
      [
        fx.workspaceId,
        fx.channelId,
        threadRootEventId,
        JSON.stringify({ session_id: 's-1', text, ...(broadcast ? { broadcast: true } : {}) }),
      ],
    );
    return rows[0]!.id;
  }

  it('includes a broadcast session.replied in the channel feed', async () => {
    const root = await post('kick off the agent');
    const replyId = await appendReply(root.id, 'Done — shipped the dashboard.', true);

    const { events } = await listChannelMessages(pool, { channelId: fx.channelId, limit: 50 });
    const reply = events.find((e) => e.id === replyId);
    expect(reply, 'the answer must appear in the channel, not only in the thread').toBeTruthy();
    expect(reply?.type).toBe('session.replied');
  });

  it('still keeps a NON-broadcast session.replied out of the channel feed', async () => {
    const root = await post('kick off a quiet agent');
    const replyId = await appendReply(root.id, 'internal turn recap', false);

    const { events } = await listChannelMessages(pool, { channelId: fx.channelId, limit: 50 });
    expect(events.some((e) => e.id === replyId)).toBe(false);
  });
});
