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
  | { kind: 'reaction'; target: number; user: number; emoji: number; action: 'add' | 'remove' };

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
);

describe('reducer convergence', () => {
  it('converges under duplicated WS/catch-up/POST deliveries', () => {
    fc.assert(
      fc.property(
        fc.array(commandArb, { minLength: 1, maxLength: 30 }),
        fc.array(fc.nat(100), { minLength: 1, maxLength: 60 }),
        (commands, noise) => {
          const events = buildEvents(commands);
          fc.pre(events.some((ev) => ev.type === 'message.posted'));

          const canonical = applyAll(emptyTimeline, events);
          const delivered = applyAll(emptyTimeline, noisyDelivery(events, noise));

          expect(snapshot(delivered)).toEqual(snapshot(canonical));
        },
      ),
      { numRuns: 80 },
    );
  });
});

function buildEvents(commands: Command[]): WireEvent[] {
  const events: WireEvent[] = [];
  const postIds: number[] = [];
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
        payload: { target_event_id: target, text: command.text },
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
        payload: { target_event_id: target },
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
      payload: { target_event_id: target, emoji: e },
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
      reactions: (m.reactions ?? []).map((r) => ({ emoji: r.emoji, userIds: r.userIds })),
    })),
  };
}
