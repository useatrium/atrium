import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createChannel, listChannelsFor } from './events.js';
import { mentionedHandles, mentionTargetUserIds, persistMentions } from './mentions.js';
import { createTestPool, seedFixture, seedMember, truncateAll, type Fixture } from '../test/helpers.js';

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

async function insertMessage(channelId: string, text: string, actorId = fx.userId): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO events (workspace_id, channel_id, type, actor_id, payload)
     VALUES ($1, $2, 'message.posted', $3, jsonb_build_object('text', $4::text))
     RETURNING id`,
    [fx.workspaceId, channelId, actorId, text],
  );
  return result.rows[0]!.id;
}

async function persist(
  channelId: string,
  text: string,
  presenceIds: string[] = [],
  actorId: string | null = fx.userId,
): Promise<number> {
  const eventId = await insertMessage(channelId, text, actorId ?? fx.userId);
  await persistMentions(pool, {
    eventId,
    channelId,
    text,
    actorId,
    onlineUserIds: () => presenceIds,
  });
  return eventId;
}

async function mentionRows(eventId: number): Promise<Array<{ user_id: string; kind: string }>> {
  const result = await pool.query<{ user_id: string; kind: string }>(
    'SELECT user_id, kind FROM mentions WHERE event_id = $1 ORDER BY user_id',
    [eventId],
  );
  return result.rows;
}

describe('mentionedHandles', () => {
  it('extracts handles at valid left boundaries', () => {
    expect(mentionedHandles('@alice please pair with (@Ben), @bob!')).toEqual(['alice', 'ben', 'bob']);
  });

  it('does not treat email addresses or embedded @ signs as mentions', () => {
    expect(mentionedHandles('gary@example.com mid@word')).toEqual([]);
  });

  it('dedupes handles after lowercasing', () => {
    expect(mentionedHandles('@Ben @ben @BEN')).toEqual(['ben']);
  });
});

describe('mentionTargetUserIds', () => {
  it('dedupes resolved users and excludes the actor id', () => {
    expect(
      mentionTargetUserIds([{ id: 'mentioned-user' }, { id: 'actor-user' }, { id: 'mentioned-user' }], 'actor-user'),
    ).toEqual(['mentioned-user']);
  });
});

describe('persistMentions', () => {
  it('persists valid token and legacy targets while skipping an unknown UUID', async () => {
    const bobId = await seedMember(pool, fx.workspaceId, 'bob');
    const carolId = await seedMember(pool, fx.workspaceId, 'carol');
    const eventId = await persist(fx.channelId, `<@${bobId}> <@${randomUUID()}> @carol`);

    expect(await mentionRows(eventId)).toEqual([bobId, carolId].sort().map((user_id) => ({ user_id, kind: 'direct' })));
  });

  it('expands channel mentions and keeps direct above channel above here', async () => {
    const bobId = await seedMember(pool, fx.workspaceId, 'bob');
    const carolId = await seedMember(pool, fx.workspaceId, 'carol');
    const eventId = await persist(fx.channelId, `<@${bobId}> <!channel> <!here>`, [carolId]);

    expect(await mentionRows(eventId)).toEqual(
      [
        { user_id: bobId, kind: 'direct' },
        { user_id: carolId, kind: 'channel' },
      ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
    );
  });

  it('expands here only to present channel members and excludes the author', async () => {
    const bobId = await seedMember(pool, fx.workspaceId, 'bob');
    const outsider = await pool.query<{ id: string }>(
      `INSERT INTO users (handle, display_name) VALUES ('outsider', 'Outsider') RETURNING id`,
    );
    const eventId = await persist(fx.channelId, '<!here>', [fx.userId, bobId, outsider.rows[0]!.id]);

    expect(await mentionRows(eventId)).toEqual([{ user_id: bobId, kind: 'here' }]);
  });

  it('drops direct targets outside a private channel', async () => {
    const memberId = await seedMember(pool, fx.workspaceId, 'member');
    const outsiderId = await seedMember(pool, fx.workspaceId, 'outsider');
    const { channel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: 'private-room',
      actorId: fx.userId,
      private: true,
    });
    await pool.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [channel.id, memberId]);
    const eventId = await persist(channel.id, `<@${memberId}> <@${outsiderId}>`);

    expect(await mentionRows(eventId)).toEqual([{ user_id: memberId, kind: 'direct' }]);
  });

  it('sets mentionedSinceRead for another member after a channel mention', async () => {
    const bobId = await seedMember(pool, fx.workspaceId, 'bob');
    await persist(fx.channelId, '<!channel>');

    const channel = (await listChannelsFor(pool, bobId)).find((item) => item.id === fx.channelId);
    expect(channel?.mentionedSinceRead).toBe(true);
  });
});
