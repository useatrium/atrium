import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyEvent, emptyTimeline, type ChannelTimeline, type WireEvent } from '../src/index';

const CH = 'ch-prop';
const WS = 'ws-prop';
const users = [
  { id: 'u-a', handle: 'alice', displayName: 'Alice' },
  { id: 'u-b', handle: 'bob', displayName: 'Bob' },
] as const;
const emoji = ['👍', '🎉', '✅'] as const;

type Command =
  | { kind: 'post'; author: number; text: string }
  | { kind: 'edit'; target: number; text: string }
  | { kind: 'delete'; target: number }
  | { kind: 'reaction'; target: number; user: number; emoji: number; action: 'add' | 'remove' }
  | { kind: 'session.spawned'; author: number; title: string }
  | { kind: 'session.question_requested'; target: number; question: string }
  | { kind: 'session.question_answered'; target: number; user: number }
  | { kind: 'session.question_resolved'; target: number; reason: 'answered' | 'cancelled' | 'empty' };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    kind: fc.constant('post'),
    author: fc.integer({ min: 0, max: users.length - 1 }),
    text: fc.string({ minLength: 1, maxLength: 24 }),
  }),
  fc.record({
    kind: fc.constant('edit'),
    target: fc.nat(12),
    text: fc.string({ minLength: 1, maxLength: 24 }),
  }),
  fc.record({
    kind: fc.constant('delete'),
    target: fc.nat(12),
  }),
  fc.record({
    kind: fc.constant('reaction'),
    target: fc.nat(12),
    user: fc.integer({ min: 0, max: users.length - 1 }),
    emoji: fc.integer({ min: 0, max: emoji.length - 1 }),
    action: fc.constantFrom('add' as const, 'remove' as const),
  }),
  fc.record({
    kind: fc.constant('session.spawned'),
    author: fc.integer({ min: 0, max: users.length - 1 }),
    title: fc.string({ minLength: 1, maxLength: 32 }),
  }),
  fc.record({
    kind: fc.constant('session.question_requested'),
    target: fc.nat(12),
    question: fc.string({ minLength: 1, maxLength: 48 }),
  }),
  fc.record({
    kind: fc.constant('session.question_answered'),
    target: fc.nat(12),
    user: fc.integer({ min: 0, max: users.length - 1 }),
  }),
  fc.record({
    kind: fc.constant('session.question_resolved'),
    target: fc.nat(12),
    reason: fc.constantFrom('answered' as const, 'cancelled' as const, 'empty' as const),
  }),
);

describe('reducer convergence', () => {
  it('converges under duplicated WS/catch-up/POST deliveries', () => {
    fc.assert(
      fc.property(
        fc.array(commandArb, { minLength: 1, maxLength: 30 }),
        fc.array(fc.nat(100), { minLength: 1, maxLength: 60 }),
        (commands, noise) => {
          const events = buildEvents(commands);
          fc.pre(events.some((ev) => ev.type === 'message.posted' || ev.type === 'session.spawned'));

          const canonical = applyAll(emptyTimeline, events);
          const delivered = applyAll(emptyTimeline, noisyDelivery(events, noise));

          expect(snapshot(delivered)).toEqual(snapshot(canonical));
        },
      ),
      { numRuns: 80 },
    );
  });

  it('converges when folded rows interleave with raw events', () => {
    const posted: WireEvent = {
      id: 1,
      workspaceId: WS,
      channelId: CH,
      threadRootEventId: null,
      type: 'message.posted',
      actorId: users[0].id,
      payload: { text: 'original' },
      createdAt: new Date(1000).toISOString(),
      author: users[0],
    };
    const edited: WireEvent = {
      ...posted,
      id: 2,
      type: 'message.edited',
      payload: { target: 'evt_1', text: 'edited' },
      createdAt: new Date(2000).toISOString(),
    };
    const reacted: WireEvent = {
      ...posted,
      id: 3,
      type: 'reaction.added',
      actorId: users[1].id,
      payload: { target: 'evt_1', emoji: '👍' },
      createdAt: new Date(3000).toISOString(),
      author: users[1],
    };
    const foldedThroughReaction: WireEvent = {
      ...posted,
      payload: { text: 'edited', edited: true, reactions: [{ emoji: '👍', userIds: [users[1].id] }] },
      lastModifierId: 3,
    };
    const staleFold: WireEvent = {
      ...posted,
      payload: { text: 'edited', edited: true },
      lastModifierId: 2,
    };
    const canonical = applyAll(emptyTimeline, [posted, edited, reacted]);

    const deliveries = [
      [foldedThroughReaction, posted, edited, reacted],
      [posted, edited, foldedThroughReaction, reacted],
      [posted, edited, reacted, foldedThroughReaction],
      [posted, edited, reacted, staleFold],
    ];
    for (const delivery of deliveries) {
      expect(snapshot(applyAll(emptyTimeline, delivery))).toEqual(snapshot(canonical));
    }
  });
});

function buildEvents(commands: Command[]): WireEvent[] {
  const events: WireEvent[] = [];
  const postIds: number[] = [];
  const sessions: Array<{
    rootId: number;
    sessionId: string;
    spawnedBy: number;
    pendingQuestionId?: string;
    questionSeq: number;
  }> = [];
  const reactions = new Set<string>();
  let id = 1;

  for (const command of commands) {
    if (command.kind === 'post') {
      const author = users[command.author]!;
      events.push({
        id: id++,
        workspaceId: WS,
        channelId: CH,
        threadRootEventId: null,
        type: 'message.posted',
        actorId: author.id,
        payload: { text: command.text },
        createdAt: new Date(id * 1000).toISOString(),
        author,
      });
      postIds.push(id - 1);
      continue;
    }

    if (command.kind === 'session.spawned') {
      const author = users[command.author]!;
      const sessionId = `sess-${id}`;
      events.push({
        id: id++,
        workspaceId: WS,
        channelId: CH,
        threadRootEventId: null,
        type: 'session.spawned',
        actorId: author.id,
        payload: {
          sessionId,
          title: command.title,
          harness: 'claude-code',
          by: author.id,
        },
        createdAt: new Date(id * 1000).toISOString(),
        author,
      });
      sessions.push({
        rootId: id - 1,
        sessionId,
        spawnedBy: command.author,
        questionSeq: 0,
      });
      continue;
    }

    if (
      command.kind === 'session.question_requested' ||
      command.kind === 'session.question_answered' ||
      command.kind === 'session.question_resolved'
    ) {
      if (sessions.length === 0) continue;
      const session = sessions[command.target % sessions.length]!;
      const actor = users[session.spawnedBy]!;
      if (command.kind === 'session.question_requested') {
        if (session.pendingQuestionId) continue;
        session.questionSeq += 1;
        const questionId = `q-${session.sessionId}-${session.questionSeq}`;
        session.pendingQuestionId = questionId;
        events.push({
          id: id++,
          workspaceId: WS,
          channelId: CH,
          threadRootEventId: session.rootId,
          type: 'session.question_requested',
          actorId: actor.id,
          payload: {
            sessionId: session.sessionId,
            questionId,
            questions: [
              {
                id: 'choice',
                header: 'Decision',
                question: command.question,
                options: [
                  { label: 'Fast', description: 'Ship the smallest change' },
                  { label: 'Careful', description: 'Run the full suite first' },
                ],
              },
            ],
            permalink: `/s/${session.sessionId}`,
          },
          createdAt: new Date(id * 1000).toISOString(),
          author: actor,
        });
        continue;
      }

      if (!session.pendingQuestionId) continue;
      const questionId = session.pendingQuestionId;
      if (command.kind === 'session.question_answered') {
        const by = users[command.user]!;
        events.push({
          id: id++,
          workspaceId: WS,
          channelId: CH,
          threadRootEventId: session.rootId,
          type: 'session.question_answered',
          actorId: by.id,
          payload: {
            sessionId: session.sessionId,
            questionId,
            by: by.id,
            answers: [{ id: 'choice', header: 'Decision', answers: ['Fast'], count: 1 }],
          },
          createdAt: new Date(id * 1000).toISOString(),
          author: by,
        });
      } else {
        events.push({
          id: id++,
          workspaceId: WS,
          channelId: CH,
          threadRootEventId: session.rootId,
          type: 'session.question_resolved',
          actorId: actor.id,
          payload: {
            sessionId: session.sessionId,
            questionId,
            reason: command.reason,
          },
          createdAt: new Date(id * 1000).toISOString(),
          author: actor,
        });
      }
      delete session.pendingQuestionId;
      continue;
    }

    if (postIds.length === 0) continue;
    const target = postIds[command.target % postIds.length]!;
    if (command.kind === 'edit') {
      events.push({
        id: id++,
        workspaceId: WS,
        channelId: CH,
        threadRootEventId: null,
        type: 'message.edited',
        actorId: users[0].id,
        payload: { target: `evt_${target}`, text: command.text },
        createdAt: new Date(id * 1000).toISOString(),
        author: users[0],
      });
      continue;
    }
    if (command.kind === 'delete') {
      events.push({
        id: id++,
        workspaceId: WS,
        channelId: CH,
        threadRootEventId: null,
        type: 'message.deleted',
        actorId: users[0].id,
        payload: { target: `evt_${target}` },
        createdAt: new Date(id * 1000).toISOString(),
        author: users[0],
      });
      continue;
    }

    const by = users[command.user]!;
    const e = emoji[command.emoji]!;
    const key = `${target}:${by.id}:${e}`;
    const present = reactions.has(key);
    if ((command.action === 'add' && present) || (command.action === 'remove' && !present)) {
      continue;
    }
    if (command.action === 'add') reactions.add(key);
    else reactions.delete(key);
    events.push({
      id: id++,
      workspaceId: WS,
      channelId: CH,
      threadRootEventId: null,
      type: command.action === 'add' ? 'reaction.added' : 'reaction.removed',
      actorId: by.id,
      payload: { target: `evt_${target}`, emoji: e },
      createdAt: new Date(id * 1000).toISOString(),
      author: by,
    });
  }

  return events;
}

function noisyDelivery(events: WireEvent[], noise: number[]): WireEvent[] {
  const out: WireEvent[] = [];
  let i = 0;
  let n = 0;
  while (i < events.length) {
    const chunkSize = (noise[n++ % noise.length]! % 4) + 1;
    const chunk = events.slice(i, i + chunkSize);
    const overlap = noise[n++ % noise.length]! % 3;
    if (overlap > 0) out.push(...events.slice(Math.max(0, i - overlap), i));
    if (noise[n++ % noise.length]! % 2 === 0) out.push(...chunk);
    for (const ev of chunk) {
      out.push(ev);
      if (noise[n++ % noise.length]! % 3 === 0) out.push(ev);
    }
    if (noise[n++ % noise.length]! % 2 === 0) out.push(...chunk);
    i += chunk.length;
  }
  return out;
}

function applyAll(start: ChannelTimeline, events: WireEvent[]): ChannelTimeline {
  return events.reduce((timeline, event) => applyEvent(timeline, event), start);
}

function snapshot(timeline: ChannelTimeline) {
  return {
    lastEventId: timeline.lastEventId,
    main: timeline.main.map((m) => ({
      id: m.id,
      text: m.text,
      edited: m.edited,
      deleted: m.deleted === true,
      replyCount: m.replyCount,
      lastReplyId: m.lastReplyId,
      lastModifierId: m.lastModifierId ?? 0,
      sessionId: m.sessionId,
      sessionEventType: m.sessionEventType,
      reactions: (m.reactions ?? []).map((r) => ({ emoji: r.emoji, userIds: r.userIds })),
    })),
    threads: Object.fromEntries(
      Object.entries(timeline.threads).map(([rootId, thread]) => [
        rootId,
        thread.map((m) => ({
          id: m.id,
          text: m.text,
          sessionId: m.sessionId,
          sessionEventType: m.sessionEventType,
        })),
      ]),
    ),
  };
}
