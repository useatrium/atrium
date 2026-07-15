import { isDeepStrictEqual } from 'node:util';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { withTx } from './db.js';
import {
  appendEvent,
  deleteMessage,
  editMessage,
  postMessage,
  setReaction,
  suppressUnfurls,
  type WireEvent,
} from './events.js';
import { createTestPool, seedFixture, seedMember, truncateAll, type Fixture } from '../test/helpers.js';

interface FoldRow {
  event_id: number;
  edited_text: string | null;
  is_deleted: boolean;
  suppressed_unfurls: unknown;
  reactions: unknown;
  reply_count: number;
  last_reply_id: number | null;
}

interface Message {
  id: number;
  actorId: string;
  threadRootEventId: number | null;
}

interface ReactionTriple {
  targetEventId: number;
  actorId: string;
  emoji: string;
}

type Random = () => number;

const SEEDS = [1, 7, 42, 8675309, 0xdeadbeef] as const;
const OPERATIONS_PER_SEED = 150;
const EMOJIS = ['👍', '✅', '🎉', '❤️', '🤔'] as const;

// Modifier events refold their target; the remaining timeline events own rows.
// Keep this copied here as part of the independent oracle boundary too.
const MESSAGE_STATE_ROW_EVENT_TYPES = [
  'message.posted',
  'voice.transcribed',
  'session.spawned',
  'session.replied',
  'session.status_changed',
  'session.effort_changed',
  'session.completed',
  'session.archived',
  'session.unarchived',
  'session.seat_requested',
  'session.seat_changed',
  'session.question_requested',
  'session.question_answered',
  'session.question_resolved',
  'session.provider_auth_required',
  'session.github_auth_required',
  'session.provider_auth_resolved',
] as const;

// This is a frozen, standalone copy of the legacy read-time fold. It intentionally
// does not import message-state.ts: importing the implementation to test the
// implementation would not provide an independent oracle.
const LEGACY_FOLD_ORACLE = `
  SELECT e.id AS event_id,
         edit.text AS edited_text,
         (del.id IS NOT NULL) AS is_deleted,
         suppression.suppressed_unfurls,
         rx.reactions,
         coalesce(r.reply_count, 0)::int AS reply_count,
         r.last_reply_id
  FROM events e
  LEFT JOIN LATERAL (
    SELECT count(*) AS reply_count, max(x.id) AS last_reply_id
    FROM events x
    WHERE x.thread_root_event_id = e.id
      AND x.type IN ('message.posted', 'session.replied', 'session.question_requested', 'session.question_answered', 'session.question_resolved')
      AND NOT EXISTS (
        SELECT 1 FROM events d
        WHERE d.type = 'message.deleted'
          AND d.payload->>'target' = ('evt_' || x.id::text)
      )
  ) r ON e.thread_root_event_id IS NULL
  LEFT JOIN events lr ON lr.id = r.last_reply_id
  LEFT JOIN LATERAL (
    SELECT x.payload->>'text' AS text
    FROM events x
    WHERE x.type = 'message.edited'
      AND x.payload->>'target' = ('evt_' || lr.id::text)
    ORDER BY x.id DESC
    LIMIT 1
  ) lr_edit ON true
  LEFT JOIN LATERAL (
    SELECT x.payload->>'text' AS text
    FROM events x
    WHERE x.type = 'message.edited'
      AND x.payload->>'target' = ('evt_' || e.id::text)
    ORDER BY x.id DESC
    LIMIT 1
  ) edit ON true
  LEFT JOIN LATERAL (
    SELECT x.payload->'suppressed' AS suppressed_unfurls
    FROM events x
    WHERE x.type = 'message.unfurls_suppressed'
      AND x.payload->>'target' = ('evt_' || e.id::text)
    ORDER BY x.id DESC
    LIMIT 1
  ) suppression ON true
  LEFT JOIN LATERAL (
    SELECT x.id
    FROM events x
    WHERE x.type = 'message.deleted'
      AND x.payload->>'target' = ('evt_' || e.id::text)
    LIMIT 1
  ) del ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('emoji', emoji, 'userIds', user_ids)) AS reactions
    FROM (
      SELECT emoji, json_agg(actor_id ORDER BY first_id) AS user_ids
      FROM (
        SELECT x.actor_id, x.payload->>'emoji' AS emoji,
               SUM(CASE WHEN x.type = 'reaction.added' THEN 1 ELSE -1 END) AS net,
               MIN(x.id) AS first_id
        FROM events x
        WHERE x.type IN ('reaction.added', 'reaction.removed')
          AND x.payload->>'target' = ('evt_' || e.id::text)
        GROUP BY x.actor_id, x.payload->>'emoji'
      ) n
      WHERE n.net > 0
      GROUP BY emoji
      ORDER BY MIN(first_id)
    ) agg
  ) rx ON true
  WHERE e.type = ANY($1::text[])
  ORDER BY e.id
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

function describeFailure(seed: number, opLog: string[], actual: unknown, expected: unknown): string {
  return [
    `message_state oracle mismatch for seed ${seed}`,
    `operations:\n${opLog.map((operation, index) => `${index + 1}. ${operation}`).join('\n')}`,
    `actual:\n${JSON.stringify(actual, null, 2)}`,
    `expected:\n${JSON.stringify(expected, null, 2)}`,
  ].join('\n\n');
}

async function assertProjectionMatchesOracle(seed: number, opLog: string[]): Promise<void> {
  const [oracle, projection, allStateIds] = await Promise.all([
    pool.query<FoldRow>(LEGACY_FOLD_ORACLE, [MESSAGE_STATE_ROW_EVENT_TYPES]),
    pool.query<FoldRow>(
      `SELECT event_id, edited_text, is_deleted, suppressed_unfurls, reactions, reply_count, last_reply_id
       FROM message_state
       ORDER BY event_id`,
    ),
    pool.query<{ event_id: number }>('SELECT event_id FROM message_state ORDER BY event_id'),
  ]);

  const timelineIds = oracle.rows.map((row) => row.event_id);
  const stateIds = allStateIds.rows.map((row) => row.event_id);
  if (!isDeepStrictEqual(stateIds, timelineIds)) {
    throw new Error(describeFailure(seed, opLog, stateIds, timelineIds));
  }

  for (let index = 0; index < oracle.rows.length; index++) {
    const actual = projection.rows[index];
    const expected = oracle.rows[index];
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(describeFailure(seed, opLog, actual, expected));
    }
  }
}

describe('message_state legacy-fold property', () => {
  it.each(SEEDS)('equals the raw-event fold after a deterministic random sequence (seed %s)', async (seed) => {
    const random = mulberry32(seed);
    const actors = [
      fixture.userId,
      await seedMember(pool, fixture.workspaceId, `bob-${seed}`, 'Bob'),
      await seedMember(pool, fixture.workspaceId, `carol-${seed}`, 'Carol'),
    ];
    const messages: Message[] = [];
    const opLog: string[] = [];
    const deleted = new Set<number>();
    let lastEditedTarget: number | null = null;
    let lastSuppressedTarget: number | null = null;
    let recentReaction: ReactionTriple | null = null;
    let serial = 0;

    const post = async (threadRootEventId: number | null): Promise<Message> => {
      const actorId = pick(random, actors);
      const event = await postMessage(pool, {
        workspaceId: fixture.workspaceId,
        channelId: fixture.channelId,
        actorId,
        text: `seed ${seed} message ${serial++}`,
        threadRootEventId,
      });
      const message = { id: event.id, actorId, threadRootEventId };
      messages.push(message);
      opLog.push(`post ${event.id}${threadRootEventId == null ? ' root' : ` reply-to ${threadRootEventId}`}`);
      return message;
    };

    const edit = async (target: Message): Promise<void> => {
      const event = await editMessage(pool, {
        targetEventId: target.id,
        actorId: target.actorId,
        text: `seed ${seed} edit ${serial++}`,
      });
      lastEditedTarget = target.id;
      opLog.push(`edit ${target.id} -> ${event.id}`);
    };

    const suppress = async (target: Message): Promise<void> => {
      const suppressed = [`https://example.test/${seed}/${serial++}`, `entry-${Math.floor(random() * 4)}`];
      const event = await suppressUnfurls(pool, {
        targetEventId: target.id,
        actorId: target.actorId,
        suppressed,
      });
      lastSuppressedTarget = target.id;
      opLog.push(`suppress ${target.id} -> ${event.id} ${JSON.stringify(suppressed)}`);
    };

    const removeMessage = async (target: Message): Promise<void> => {
      const event = await deleteMessage(pool, { targetEventId: target.id, actorId: target.actorId });
      deleted.add(target.id);
      opLog.push(`delete ${target.id} -> ${event.id}`);
    };

    const react = async (triple: ReactionTriple, action: 'add' | 'remove'): Promise<void> => {
      const result = await setReaction(pool, { ...triple, action });
      recentReaction = triple;
      opLog.push(
        `reaction ${action} ${triple.emoji} by ${triple.actorId} on ${triple.targetEventId}` +
          (result.applied ? ` -> ${result.event!.id}` : ' -> no-op'),
      );
    };

    // Every seed starts with adversarial cases that random choice alone could miss:
    // repeated folds, deletion of the current latest reply (and deletion again),
    // duplicate set operations, and add -> remove -> add for one reaction pair.
    const root = await post(null);
    await post(root.id);
    const latestReply = await post(root.id);
    await edit(latestReply);
    await edit(latestReply);
    await suppress(root);
    await suppress(root);
    await removeMessage(latestReply);
    await removeMessage(latestReply);
    const edgeReaction = { targetEventId: root.id, actorId: actors[1]!, emoji: '👍' };
    await react(edgeReaction, 'add');
    await react(edgeReaction, 'add');
    await react(edgeReaction, 'remove');
    await react(edgeReaction, 'remove');
    await react(edgeReaction, 'add');

    while (opLog.length < OPERATIONS_PER_SEED) {
      const roll = random() * 100;
      const roots = messages.filter((message) => message.threadRootEventId == null);
      if (roll < 16) {
        await post(null);
      } else if (roll < 32) {
        await post(pick(random, roots).id);
      } else if (roll < 42) {
        const threadRootEventId = random() < 0.65 ? pick(random, roots).id : null;
        const type = random() < 0.5 ? 'session.replied' : 'session.question_requested';
        const actorId = type === 'session.replied' ? null : pick(random, actors);
        const payload =
          type === 'session.replied'
            ? { session_id: `session-${seed}`, text: `agent reply ${serial++}`, broadcast: true }
            : {
                sessionId: `session-${seed}`,
                questionId: `question-${serial}`,
                question: `agent question ${serial++}`,
              };
        const event: WireEvent = await withTx(pool, (client) =>
          appendEvent(client, {
            workspaceId: fixture.workspaceId,
            channelId: fixture.channelId,
            threadRootEventId,
            type,
            actorId,
            payload,
          }),
        );
        opLog.push(
          `append ${type} ${event.id}${threadRootEventId == null ? ' root' : ` reply-to ${threadRootEventId}`}`,
        );
      } else if (roll < 57) {
        const previous = lastEditedTarget == null ? undefined : messages.find(({ id }) => id === lastEditedTarget);
        await edit(previous && random() < 0.35 ? previous : pick(random, messages));
      } else if (roll < 69) {
        const replies = messages.filter((message) => message.threadRootEventId != null);
        const visibleReplies = replies.filter((message) => !deleted.has(message.id));
        const deletedMessages = messages.filter((message) => deleted.has(message.id));
        const latestVisibleReply = visibleReplies.reduce<Message | null>(
          (latest, message) => (latest == null || message.id > latest.id ? message : latest),
          null,
        );
        const target =
          deletedMessages.length > 0 && random() < 0.2
            ? pick(random, deletedMessages)
            : latestVisibleReply && random() < 0.35
              ? latestVisibleReply
              : pick(random, messages);
        await removeMessage(target);
      } else if (roll < 79) {
        const previous =
          lastSuppressedTarget == null ? undefined : messages.find(({ id }) => id === lastSuppressedTarget);
        await suppress(previous && random() < 0.4 ? previous : pick(random, messages));
      } else {
        const triple =
          recentReaction && random() < 0.35
            ? recentReaction
            : {
                targetEventId: pick(random, messages).id,
                actorId: pick(random, actors),
                emoji: pick(random, EMOJIS),
              };
        await react(triple, random() < 0.55 ? 'add' : 'remove');
      }
    }

    await assertProjectionMatchesOracle(seed, opLog);
  }, 60_000);
});
