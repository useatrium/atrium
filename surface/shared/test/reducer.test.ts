import { describe, expect, it } from 'vitest';
import {
  addPending,
  applyEvent,
  appReducer,
  emptyTimeline,
  initialAppState,
  markFailed,
  mergeHistory,
  mergeThread,
  type ChatMessage,
  type WireEvent,
} from '../src/index';

const alice = { id: 'u-alice', handle: 'alice', displayName: 'Alice' };
const bob = { id: 'u-bob', handle: 'bob', displayName: 'Bob' };
const CH = 'ch-1';

function wire(
  id: number,
  text: string,
  opts: { clientMsgId?: string; threadRoot?: number; author?: typeof alice; replyCount?: number; lastReplyId?: number } = {},
): WireEvent {
  return {
    id,
    workspaceId: 'ws-1',
    channelId: CH,
    threadRootEventId: opts.threadRoot ?? null,
    type: 'message.posted',
    actorId: (opts.author ?? alice).id,
    payload: { text, ...(opts.clientMsgId ? { client_msg_id: opts.clientMsgId } : {}) },
    createdAt: new Date(id * 1000).toISOString(),
    author: opts.author ?? alice,
    ...(opts.replyCount !== undefined ? { replyCount: opts.replyCount } : {}),
    ...(opts.lastReplyId !== undefined ? { lastReplyId: opts.lastReplyId } : {}),
  };
}

function pending(clientMsgId: string, text: string, threadRoot: number | null = null): ChatMessage {
  return {
    id: null,
    clientMsgId,
    channelId: CH,
    threadRootEventId: threadRoot,
    text,
    edited: false,
    author: alice,
    createdAt: new Date().toISOString(),
    replyCount: 0,
    lastReplyId: 0,
    status: 'pending',
  };
}

describe('optimistic send reconciliation', () => {
  it('replaces the pending message by client_msg_id — no dupe, no flicker', () => {
    let t = addPending(emptyTimeline, pending('cm-1', 'hello'));
    expect(t.main).toHaveLength(1);
    expect(t.main[0]!.status).toBe('pending');

    t = applyEvent(t, wire(10, 'hello', { clientMsgId: 'cm-1' }));
    expect(t.main).toHaveLength(1);
    expect(t.main[0]!.status).toBe('confirmed');
    expect(t.main[0]!.id).toBe(10);
    expect(t.lastEventId).toBe(10);
  });

  it('is idempotent: POST response + WS event for the same id apply once', () => {
    let t = addPending(emptyTimeline, pending('cm-1', 'hello'));
    const ev = wire(10, 'hello', { clientMsgId: 'cm-1' });
    t = applyEvent(t, ev); // POST response
    t = applyEvent(t, ev); // WS fanout of the same event
    expect(t.main).toHaveLength(1);
  });

  it('keeps my pending at the bottom while other users’ messages land', () => {
    let t = addPending(emptyTimeline, pending('cm-1', 'mine'));
    t = applyEvent(t, wire(11, 'from bob', { author: bob }));
    expect(t.main.map((m) => m.text)).toEqual(['from bob', 'mine']);
    t = applyEvent(t, wire(12, 'mine', { clientMsgId: 'cm-1' }));
    expect(t.main.map((m) => m.text)).toEqual(['from bob', 'mine']);
    expect(t.main[1]!.id).toBe(12);
  });

  it('marks failed sends and removes them from pending on markFailed', () => {
    let t = addPending(emptyTimeline, pending('cm-x', 'doomed'));
    t = markFailed(t, 'cm-x');
    expect(t.main[0]!.status).toBe('failed');
    // a late server echo for the same clientMsgId still reconciles
    t = applyEvent(t, wire(20, 'doomed', { clientMsgId: 'cm-x' }));
    expect(t.main).toHaveLength(1);
    expect(t.main[0]!.status).toBe('confirmed');
  });
});

describe('event ordering and dedupe', () => {
  it('sorts out-of-order deliveries by event id', () => {
    let t = applyEvent(emptyTimeline, wire(7, 'seven'));
    t = applyEvent(t, wire(5, 'five'));
    expect(t.main.map((m) => m.id)).toEqual([5, 7]);
    expect(t.lastEventId).toBe(7);
  });

  it('ignores duplicate event ids', () => {
    let t = applyEvent(emptyTimeline, wire(5, 'five'));
    t = applyEvent(t, wire(5, 'five'));
    expect(t.main).toHaveLength(1);
  });

  it('non-message events only advance lastEventId', () => {
    const ev: WireEvent = { ...wire(9, ''), type: 'channel.created', payload: { name: 'x' } };
    const t = applyEvent(emptyTimeline, ev);
    expect(t.main).toHaveLength(0);
    expect(t.lastEventId).toBe(9);
  });
});

describe('threads and reply counts', () => {
  it('increments root replyCount for live replies, deduped by lastReplyId', () => {
    let t = applyEvent(emptyTimeline, wire(1, 'root', { replyCount: 0, lastReplyId: 0 }));
    t = applyEvent(t, wire(2, 'r1', { threadRoot: 1 }));
    t = applyEvent(t, wire(3, 'r2', { threadRoot: 1 }));
    expect(t.main[0]!.replyCount).toBe(2);
    expect(t.main[0]!.lastReplyId).toBe(3);
  });

  it('does not double-count replies already included in a fetched root', () => {
    // catch-up batch: root fetched with replyCount=2 (already counts ids 2,3)
    let t = applyEvent(emptyTimeline, wire(1, 'root', { replyCount: 2, lastReplyId: 3 }));
    t = applyEvent(t, wire(2, 'r1', { threadRoot: 1 }));
    t = applyEvent(t, wire(3, 'r2', { threadRoot: 1 }));
    expect(t.main[0]!.replyCount).toBe(2);
    t = applyEvent(t, wire(4, 'r3 — genuinely new', { threadRoot: 1 }));
    expect(t.main[0]!.replyCount).toBe(3);
  });

  it('inserts replies into loaded threads and reconciles pending replies', () => {
    let t = applyEvent(emptyTimeline, wire(1, 'root'));
    t = mergeThread(t, 1, [wire(2, 'r1', { threadRoot: 1 })]);
    expect(t.threads[1]!.map((m) => m.text)).toEqual(['r1']);

    t = addPending(t, pending('cm-r', 'my reply', 1));
    expect(t.threads[1]!).toHaveLength(2);
    t = applyEvent(t, wire(3, 'my reply', { clientMsgId: 'cm-r', threadRoot: 1 }));
    expect(t.threads[1]!).toHaveLength(2);
    expect(t.threads[1]!.at(-1)!.id).toBe(3);
    expect(t.main[0]!.replyCount).toBe(2);
  });
});

describe('history pagination merge', () => {
  it('prepends older pages without duplicating and tracks hasMoreBefore', () => {
    let t = mergeHistory(emptyTimeline, [wire(5, 'm5'), wire(6, 'm6')], { hasMoreBefore: true });
    expect(t.loaded).toBe(true);
    expect(t.hasMoreBefore).toBe(true);
    t = mergeHistory(t, [wire(3, 'm3'), wire(4, 'm4'), wire(5, 'm5')], { hasMoreBefore: false });
    expect(t.main.map((m) => m.id)).toEqual([3, 4, 5, 6]);
    expect(t.hasMoreBefore).toBe(false);
    expect(t.lastEventId).toBe(6);
  });

  it('applies message.edited to loaded messages', () => {
    let t = mergeHistory(emptyTimeline, [wire(5, 'original')], { hasMoreBefore: false });
    const edit: WireEvent = {
      ...wire(8, ''),
      type: 'message.edited',
      payload: { target_event_id: 5, text: 'edited!' },
    };
    t = applyEvent(t, edit);
    expect(t.main[0]!.text).toBe('edited!');
    expect(t.main[0]!.edited).toBe(true);
  });
});

describe('app unread read cursors', () => {
  it('derives initial unread from channel counters without inventing mention badges', () => {
    const state = appReducer(
      { ...initialAppState, unread: { 'ch-mention': 'mention' } },
      {
        type: 'channels-loaded',
        channels: [
          {
            id: 'ch-read',
            workspaceId: 'ws-1',
            name: 'read',
            createdAt: new Date(0).toISOString(),
            kind: 'public',
            latestEventId: 7,
            lastReadEventId: 7,
          },
          {
            id: 'ch-unread',
            workspaceId: 'ws-1',
            name: 'unread',
            createdAt: new Date(0).toISOString(),
            kind: 'public',
            latestEventId: 8,
            lastReadEventId: 3,
          },
          {
            id: 'ch-mention',
            workspaceId: 'ws-1',
            name: 'mention',
            createdAt: new Date(0).toISOString(),
            kind: 'public',
            latestEventId: 2,
            lastReadEventId: 2,
          },
        ],
      },
    );

    expect(state.unread['ch-read']).toBe(false);
    expect(state.unread['ch-unread']).toBe(true);
    expect(state.unread['ch-mention']).toBe('mention');
  });

  it('read-cursor clears unread for the channel', () => {
    const state = appReducer(
      { ...initialAppState, unread: { [CH]: 'mention' } },
      { type: 'read-cursor', channelId: CH, lastReadEventId: 10 },
    );

    expect(state.unread[CH]).toBe(false);
  });
});
