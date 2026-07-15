import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { withTx } from './db.js';
import { deleteMessage, editMessage, postMessage, setReaction, suppressUnfurls } from './events.js';
import { refoldMessage } from './message-state.js';
import { createTestPool, seedFixture, seedMember, truncateAll, type Fixture } from '../test/helpers.js';

interface MessageStateRow {
  event_id: number;
  edited_text: string | null;
  is_deleted: boolean;
  suppressed_unfurls: unknown;
  reactions: unknown;
  reply_count: number;
  last_reply_id: number | null;
  last_modifier_id: number;
}

let pool: pg.Pool;
let fixture: Fixture;

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  fixture = await seedFixture(pool);
});

async function state(eventId: number): Promise<MessageStateRow> {
  const result = await pool.query<MessageStateRow>('SELECT * FROM message_state WHERE event_id = $1', [eventId]);
  return result.rows[0]!;
}

async function post(text: string, threadRootEventId?: number) {
  return postMessage(pool, {
    workspaceId: fixture.workspaceId,
    channelId: fixture.channelId,
    actorId: fixture.userId,
    text,
    threadRootEventId,
  });
}

describe('message_state projection', () => {
  it('creates state for a posted message', async () => {
    const message = await post('hello');

    expect(await state(message.id)).toMatchObject({
      event_id: message.id,
      last_modifier_id: message.id,
    });
  });

  it('keeps the newest message edit', async () => {
    const message = await post('original');
    await editMessage(pool, { targetEventId: message.id, actorId: fixture.userId, text: 'first edit' });
    const latest = await editMessage(pool, {
      targetEventId: message.id,
      actorId: fixture.userId,
      text: 'second edit',
    });

    expect(await state(message.id)).toMatchObject({
      edited_text: 'second edit',
      last_modifier_id: latest.id,
    });
  });

  it('moves the root latest reply backward when the latest reply is deleted', async () => {
    const root = await post('root');
    const firstReply = await post('first reply', root.id);
    const latestReply = await post('latest reply', root.id);

    expect(await state(root.id)).toMatchObject({ reply_count: 2, last_reply_id: latestReply.id });

    await deleteMessage(pool, { targetEventId: latestReply.id, actorId: fixture.userId });

    expect(await state(root.id)).toMatchObject({ reply_count: 1, last_reply_id: firstReply.id });
  });

  it('advances the root watermark when a reply is edited', async () => {
    const root = await post('root');
    const reply = await post('reply', root.id);
    const edit = await editMessage(pool, {
      targetEventId: reply.id,
      actorId: fixture.userId,
      text: 'edited reply',
    });

    expect(await state(root.id)).toMatchObject({ last_modifier_id: edit.id });
  });

  it('stores the exact net reaction shape and actor order', async () => {
    const message = await post('react here');
    const secondUserId = await seedMember(pool, fixture.workspaceId, 'bob', 'Bob');

    await setReaction(pool, {
      targetEventId: message.id,
      actorId: fixture.userId,
      emoji: '👍',
      action: 'add',
    });
    await setReaction(pool, { targetEventId: message.id, actorId: secondUserId, emoji: '👍', action: 'add' });
    await setReaction(pool, {
      targetEventId: message.id,
      actorId: fixture.userId,
      emoji: '👍',
      action: 'remove',
    });

    expect((await state(message.id)).reactions).toEqual([{ emoji: '👍', userIds: [secondUserId] }]);
  });

  it('stores the latest suppressed unfurl set', async () => {
    const message = await post('https://example.com');
    await suppressUnfurls(pool, {
      targetEventId: message.id,
      actorId: fixture.userId,
      suppressed: ['https://example.com'],
    });

    expect((await state(message.id)).suppressed_unfurls).toEqual(['https://example.com']);
  });

  it('refuses a stale fold behind the stored watermark', async () => {
    const message = await post('hello');
    await pool.query('UPDATE message_state SET last_modifier_id = 999999999 WHERE event_id = $1', [message.id]);

    await withTx(pool, (client) => refoldMessage(client, message.id));

    expect(await state(message.id)).toMatchObject({
      edited_text: null,
      last_modifier_id: 999999999,
    });
  });

  it('projects a raw-SQL reply with the same root fold as the API writer', async () => {
    const root = await post('root');

    const replyId = await withTx(pool, async (client) => {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO events (workspace_id, channel_id, thread_root_event_id, type, actor_id, payload)
         VALUES ($1, $2, $3, 'message.posted', $4, $5)
         RETURNING id`,
        [fixture.workspaceId, fixture.channelId, root.id, fixture.userId, JSON.stringify({ text: 'raw reply' })],
      );
      const id = inserted.rows[0]!.id;
      await client.query('SELECT project_message_event($1)', [id]);
      return id;
    });

    expect(await state(root.id)).toMatchObject({
      reply_count: 1,
      last_reply_id: replyId,
      last_modifier_id: replyId,
    });
    expect(await state(replyId)).toMatchObject({
      event_id: replyId,
      reply_count: 0,
      last_reply_id: null,
      last_modifier_id: replyId,
    });
  });
});
