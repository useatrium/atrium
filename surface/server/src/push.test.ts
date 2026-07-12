import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { pushRecipientsFor, titleFor } from './push.js';
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

function hubWithPresence(ids: string[]) {
  return {
    onlineUserIds: () => new Set(ids),
  };
}

describe('pushRecipientsFor group mentions', () => {
  it('uses direct mention precedence over mention_all', async () => {
    const bobId = await seedMember(pool, fx.workspaceId, 'bob');
    const carolId = await seedMember(pool, fx.workspaceId, 'carol');
    const result = await pushRecipientsFor(pool, hubWithPresence([]), {
      channelId: fx.channelId,
      actorId: fx.userId,
      payload: { text: `<@${bobId}> <!channel>` },
    });

    expect(result.recipients.sort((a, b) => a.userId.localeCompare(b.userId))).toEqual(
      [
        { userId: bobId, reason: 'mention' },
        { userId: carolId, reason: 'mention_all' },
      ].sort((a, b) => a.userId.localeCompare(b.userId)),
    );
  });

  it('limits here to present members', async () => {
    const bobId = await seedMember(pool, fx.workspaceId, 'bob');
    const carolId = await seedMember(pool, fx.workspaceId, 'carol');
    const outsider = await pool.query<{ id: string }>(
      `INSERT INTO users (handle, display_name) VALUES ('outsider', 'Outsider') RETURNING id`,
    );
    const result = await pushRecipientsFor(pool, hubWithPresence([bobId, outsider.rows[0]!.id]), {
      channelId: fx.channelId,
      actorId: fx.userId,
      payload: { text: '<!here>' },
    });

    expect(result.recipients).toEqual([{ userId: bobId, reason: 'mention_all' }]);
    expect(result.userIds).not.toContain(carolId);
  });

  it('allows mention_all under the default dm_mention pref and drops it when messages are off', async () => {
    const bobId = await seedMember(pool, fx.workspaceId, 'bob');
    const event = { channelId: fx.channelId, actorId: fx.userId, payload: { text: '<!channel>' } };

    expect((await pushRecipientsFor(pool, hubWithPresence([]), event)).userIds).toContain(bobId);

    await pool.query(
      `UPDATE users
       SET prefs = jsonb_build_object('notifications', jsonb_build_object('messages', 'off'))
       WHERE id = $1`,
      [bobId],
    );
    expect((await pushRecipientsFor(pool, hubWithPresence([]), event)).userIds).not.toContain(bobId);
  });
});

describe('titleFor', () => {
  it('describes a group mention', () => {
    expect(titleFor('mention_all', 'Alice', 'general')).toBe('Alice mentioned everyone in #general');
  });
});
