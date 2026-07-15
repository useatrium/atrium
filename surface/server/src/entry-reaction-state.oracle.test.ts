import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { config } from './config.js';
import { signSession } from './cookie.js';
import { withTx } from './db.js';
import { encodeArtifactHandle, encodeEventHandle, encodeRecordHandle } from './entries.js';
import { refoldEntryReactions } from './entry-reaction-state.js';
import { postMessage } from './events.js';
import { createTestPool, seedEvent, seedFixture, seedMember, truncateAll, type Fixture } from '../test/helpers.js';

interface ProjectedRow {
  reactions: unknown;
  last_reaction_id: number;
}

type Random = () => number;

const OPERATIONS = 120;
const EMOJIS = ['👍', '✅', '🎉', '❤️', '🤔'] as const;

// Frozen standalone copy of the retired read-time fold. It intentionally does
// not import the projection implementation: this query is the independent
// oracle for ordering and net-count semantics.
const LEGACY_ANNOTATION_FOLD_ORACLE = `
  SELECT emoji, array_agg(actor_id::text ORDER BY first_id) AS user_ids
    FROM (
      SELECT x.actor_id,
             x.payload->>'emoji' AS emoji,
             SUM(CASE WHEN x.type = 'reaction.added' THEN 1 ELSE -1 END) AS net,
             MIN(x.id) AS first_id
        FROM events x
       WHERE x.type IN ('reaction.added', 'reaction.removed')
         AND x.payload->>'target' = $1
       GROUP BY x.actor_id, x.payload->>'emoji'
    ) n
   WHERE n.net > 0
   GROUP BY emoji
   ORDER BY MIN(first_id)
`;

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
  // entry_reaction_state deliberately has no FK/GC, so test event-id resets do
  // not remove it through CASCADE as they do message_state.
  await pool.query('TRUNCATE entry_reaction_state');
  fixture = await seedFixture(pool);
});

function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: Random, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

async function appendReaction(
  target: string,
  actorId: string,
  emoji: string,
  action: 'add' | 'remove',
): Promise<number> {
  return seedEvent(pool, {
    workspaceId: fixture.workspaceId,
    channelId: fixture.channelId,
    type: action === 'add' ? 'reaction.added' : 'reaction.removed',
    actorId,
    payload: { target, emoji },
  });
}

async function oracleFold(target: string): Promise<unknown[]> {
  const result = await pool.query<{ emoji: string; user_ids: string[] }>(LEGACY_ANNOTATION_FOLD_ORACLE, [target]);
  return result.rows.map((row) => ({ emoji: row.emoji, userIds: row.user_ids }));
}

async function projectedFold(target: string): Promise<ProjectedRow | undefined> {
  if (target.startsWith('evt_')) {
    const result = await pool.query<ProjectedRow>(
      'SELECT reactions, last_modifier_id AS last_reaction_id FROM message_state WHERE event_id = $1',
      [target.slice(4)],
    );
    return result.rows[0];
  }
  const result = await pool.query<ProjectedRow>(
    'SELECT reactions, last_reaction_id FROM entry_reaction_state WHERE target = $1',
    [target],
  );
  return result.rows[0];
}

async function expectProjectionMatchesOracle(target: string, operations: string[]): Promise<void> {
  const [expected, row] = await Promise.all([oracleFold(target), projectedFold(target)]);
  if (!row || !isDeepStrictEqual(row.reactions ?? [], expected)) {
    throw new Error(
      [
        `entry reaction projection mismatch for ${target}`,
        `operations:\n${operations.join('\n')}`,
        `actual:\n${JSON.stringify(row, null, 2)}`,
        `expected:\n${JSON.stringify(expected, null, 2)}`,
      ].join('\n\n'),
    );
  }
}

async function insertSessionRecord(entryUid: string): Promise<{ sessionId: string }> {
  const session = await pool.query<{ id: string }>(
    `INSERT INTO sessions
       (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by)
     VALUES ($1, $2, $3, 'codex', 'Projection target', 'completed', $4)
     RETURNING id`,
    [fixture.workspaceId, fixture.channelId, `entry-reaction:${randomUUID()}`, fixture.userId],
  );
  const sessionId = session.rows[0]!.id;
  await pool.query(
    `INSERT INTO session_records
       (session_id, entry_uid, event_id, seq, kind, actor, driver, view_tier, text, meta, ts)
     VALUES ($1, $2, 1, 0, 'message', 'agent', 'codex', 'lean', 'record text', '{}'::jsonb, $3::timestamptz)`,
    [sessionId, entryUid, '2026-01-01T00:00:00.000Z'],
  );
  return { sessionId };
}

async function authCookie(userId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO auth_sessions (user_id, expires_at)
     VALUES ($1, now() + interval '30 days')
     RETURNING id`,
    [userId],
  );
  return `${config.sessionCookie}=${signSession(result.rows[0]!.id, config.sessionSecret)}`;
}

describe('entry_reaction_state legacy-fold property', () => {
  it('matches the frozen fold across adversarial and seeded random operations for evt_/rec_/art_', async () => {
    const random = mulberry32(0x81e17);
    const actors = [
      fixture.userId,
      await seedMember(pool, fixture.workspaceId, 'entry-oracle-bob', 'Bob'),
      await seedMember(pool, fixture.workspaceId, 'entry-oracle-carol', 'Carol'),
    ];
    const firstMessage = await postMessage(pool, {
      workspaceId: fixture.workspaceId,
      channelId: fixture.channelId,
      actorId: fixture.userId,
      text: 'event reaction target one',
    });
    const secondMessage = await postMessage(pool, {
      workspaceId: fixture.workspaceId,
      channelId: fixture.channelId,
      actorId: fixture.userId,
      text: 'event reaction target two',
    });
    const targets = [
      encodeEventHandle(firstMessage.id),
      encodeEventHandle(secondMessage.id),
      encodeRecordHandle('entry_reaction_oracle_one'),
      encodeRecordHandle('entry_reaction_oracle_two'),
      encodeArtifactHandle(randomUUID()),
      encodeArtifactHandle(randomUUID()),
    ];
    const operations: string[] = [];
    const apply = async (target: string, actorId: string, emoji: string, action: 'add' | 'remove') => {
      const id = await appendReaction(target, actorId, emoji, action);
      operations.push(`${id}: ${action} ${emoji} by ${actorId} on ${target}`);
    };

    // Hard-coded cases the random sequence is not trusted to cover.
    const edgeTarget = targets[2]!;
    await apply(edgeTarget, actors[0]!, '👍', 'add');
    await apply(edgeTarget, actors[0]!, '👍', 'remove');
    await apply(edgeTarget, actors[0]!, '👍', 'add');
    await apply(edgeTarget, actors[1]!, '✅', 'remove');
    await apply(edgeTarget, actors[1]!, '🎉', 'add');
    await apply(edgeTarget, actors[1]!, '🎉', 'add');
    await apply(edgeTarget, actors[2]!, '👍', 'add');
    await apply(edgeTarget, actors[1]!, '👍', 'add');
    await apply(edgeTarget, actors[2]!, '👍', 'remove');

    while (operations.length < OPERATIONS) {
      await apply(
        pick(random, targets),
        pick(random, actors),
        pick(random, EMOJIS),
        random() < 0.54 ? 'add' : 'remove',
      );
    }

    for (const target of targets) await expectProjectionMatchesOracle(target, operations);
  }, 30_000);

  it('projects a raw SQL insert when project_message_event is invoked explicitly', async () => {
    const target = encodeRecordHandle('entry_reaction_raw_sql');
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO events (workspace_id, channel_id, type, actor_id, payload)
       VALUES ($1, $2, 'reaction.added', $3, $4::jsonb)
       RETURNING id`,
      [fixture.workspaceId, fixture.channelId, fixture.userId, JSON.stringify({ target, emoji: '✅' })],
    );
    expect(await projectedFold(target)).toBeUndefined();

    await pool.query('SELECT project_message_event($1)', [inserted.rows[0]!.id]);

    await expectProjectionMatchesOracle(target, ['raw SQL insert + explicit projection']);
  });

  it('refuses a stale refold whose watermark is behind the stored row', async () => {
    const target = encodeArtifactHandle(randomUUID());
    await appendReaction(target, fixture.userId, '❤️', 'add');
    const before = await projectedFold(target);
    expect(before).toBeDefined();
    const sentinel = [{ emoji: '🤔', userIds: [fixture.userId] }];
    await pool.query('UPDATE entry_reaction_state SET reactions = $1, last_reaction_id = $2 WHERE target = $3', [
      JSON.stringify(sentinel),
      before!.last_reaction_id + 10_000,
      target,
    ]);

    await withTx(pool, (client) => refoldEntryReactions(client, target));

    expect(await projectedFold(target)).toEqual({
      reactions: sentinel,
      last_reaction_id: before!.last_reaction_id + 10_000,
    });
  });

  it('survives session_records regeneration and still resolves through the annotations route', async () => {
    const entryUid = 'entry_reaction_regeneration';
    const handle = encodeRecordHandle(entryUid);
    const { sessionId } = await insertSessionRecord(entryUid);
    await appendReaction(handle, fixture.userId, '🎉', 'add');

    await pool.query('DELETE FROM session_records WHERE session_id = $1 AND entry_uid = $2', [sessionId, entryUid]);
    await pool.query(
      `INSERT INTO session_records
         (session_id, entry_uid, event_id, seq, kind, actor, driver, view_tier, text, meta, ts)
       VALUES ($1, $2, 2, 0, 'message', 'agent', 'codex', 'lean', 'regenerated text', '{}'::jsonb,
               $3::timestamptz)`,
      [sessionId, entryUid, '2026-01-02T00:00:00.000Z'],
    );

    const app = await buildApp({
      pool,
      calls: false,
      sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/entries/${handle}/annotations`,
        headers: { cookie: await authCookie(fixture.userId) },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ reactions: [{ emoji: '🎉', userIds: [fixture.userId] }] });
      expect(response.json()).not.toHaveProperty('comments');
    } finally {
      await app.close();
    }
  });
});
