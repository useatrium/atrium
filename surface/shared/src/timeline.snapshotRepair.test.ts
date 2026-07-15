import { describe, expect, it } from 'vitest';
import { applyEvent, emptyTimeline, mergeHistory, mergeThread, resetToLatest, type WireEvent } from './timeline';

const me = { id: 'u1', handle: 'tester', displayName: 'Tester' };

function postedEvent(
  id: number,
  text: string,
  opts: {
    threadRootEventId?: number;
    replyCount?: number;
    lastReplyId?: number;
    lastModifierId?: number;
    edited?: boolean;
  } = {},
): WireEvent {
  return {
    id,
    workspaceId: 'w1',
    channelId: 'c1',
    threadRootEventId: opts.threadRootEventId ?? null,
    type: 'message.posted',
    actorId: me.id,
    payload: { text, ...(opts.edited === true ? { edited: true } : {}) },
    createdAt: '2026-07-12T00:00:00.000Z',
    author: me,
    ...(opts.replyCount != null ? { replyCount: opts.replyCount } : {}),
    ...(opts.lastReplyId != null ? { lastReplyId: opts.lastReplyId } : {}),
    ...(opts.lastModifierId != null ? { lastModifierId: opts.lastModifierId } : {}),
  };
}

function repairedTimeline(reply: WireEvent) {
  let t = mergeHistory(emptyTimeline, [postedEvent(10, 'root ask')], { hasMoreBefore: false });
  t = mergeThread(t, 10, [reply]);
  return resetToLatest(t, [postedEvent(10, 'root ask', { replyCount: 1, lastReplyId: 12 }), postedEvent(13, 'newer')], {
    hasMoreBefore: false,
  });
}

describe('duplicate thread reply after limited-sync snapshot repair', () => {
  it('re-fetching an open thread after resetToLatest does not duplicate replies', () => {
    const reply = postedEvent(12, 'agent reply', { threadRootEventId: 10 });
    let t = repairedTimeline(reply);

    expect(t.threads[10]!.map((m) => m.id)).toEqual([12]);
    t = mergeThread(t, 10, [reply]);

    expect(t.threads[10]!.map((m) => m.id)).toEqual([12]);
    expect(t.main.find((m) => m.id === 10)?.replyCount).toBe(1);
  });

  it('raw catch-up redelivery after resetToLatest does not duplicate replies', () => {
    const reply = postedEvent(12, 'agent reply', { threadRootEventId: 10 });
    let t = repairedTimeline(reply);
    t = applyEvent(t, reply);

    expect(t.threads[10]!.map((m) => m.id)).toEqual([12]);
  });

  it('does not clobber a folded edit with a raw redelivery', () => {
    const editedReply = postedEvent(12, 'edited agent reply', {
      threadRootEventId: 10,
      lastModifierId: 20,
      edited: true,
    });
    let t = repairedTimeline(editedReply);
    t = applyEvent(t, postedEvent(12, 'original agent reply', { threadRootEventId: 10 }));

    expect(t.threads[10]).toHaveLength(1);
    expect(t.threads[10]![0]).toMatchObject({
      id: 12,
      text: 'edited agent reply',
      edited: true,
      lastModifierId: 20,
    });
  });

  it('replaces an existing reply with a newer materialized refresh', () => {
    const staleReply = postedEvent(12, 'stale agent reply', {
      threadRootEventId: 10,
      lastModifierId: 20,
    });
    let t = repairedTimeline(staleReply);
    t = mergeThread(t, 10, [
      postedEvent(12, 'newly edited agent reply', {
        threadRootEventId: 10,
        lastModifierId: 21,
        edited: true,
      }),
    ]);

    expect(t.threads[10]).toHaveLength(1);
    expect(t.threads[10]![0]).toMatchObject({
      id: 12,
      text: 'newly edited agent reply',
      edited: true,
      lastModifierId: 21,
    });
    expect(t.main.find((m) => m.id === 10)?.replyCount).toBe(1);
  });
});
