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
  nextCatchUpStep,
  resetToLatest,
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

  it('snapshot reset drops stale confirmed rows but keeps local and newer rows', () => {
    let t = mergeHistory(emptyTimeline, [wire(1, 'old')], { hasMoreBefore: true });
    t = addPending(t, pending('cm-pending', 'still sending'));
    t = addPending(t, pending('cm-failed', 'retry me'));
    t = markFailed(t, 'cm-failed');
    // A WS event can land between the snapshot fetch and its dispatch — it is
    // newer than the page and must survive the reset.
    t = applyEvent(t, wire(60, 'raced in live', { author: bob }));

    t = resetToLatest(t, [wire(50, 'latest')], { hasMoreBefore: true });

    // 'old' (id 1) is gone: the gap between it and the snapshot was never
    // fetched, and keeping it would render a silent hole.
    expect(t.main.map((m) => [m.text, m.status])).toEqual([
      ['latest', 'confirmed'],
      ['raced in live', 'confirmed'],
      ['still sending', 'pending'],
      ['retry me', 'failed'],
    ]);
    expect(t.hasMoreBefore).toBe(true);
    expect(t.lastEventId).toBe(60);
    // seenIds rebuilt from kept rows: paging back must re-apply id 1.
    expect(t.seenIds.has(1)).toBe(false);
    t = mergeHistory(t, [wire(1, 'old')], { hasMoreBefore: false });
    expect(t.main[0]!.text).toBe('old');
    expect(t.hasMoreBefore).toBe(false);
  });

  it('snapshot reset reconciles a pending row confirmed inside the page', () => {
    let t = mergeHistory(emptyTimeline, [wire(1, 'old')], { hasMoreBefore: true });
    t = addPending(t, pending('cm-1', 'mine'));

    t = resetToLatest(t, [wire(49, 'mine', { clientMsgId: 'cm-1' }), wire(50, 'latest', { author: bob })], {
      hasMoreBefore: true,
    });

    expect(t.main.map((m) => [m.text, m.status])).toEqual([
      ['mine', 'confirmed'],
      ['latest', 'confirmed'],
    ]);
  });
});

describe('catch-up fallback decision', () => {
  it('caps after_id paging and falls back to the latest page when still behind', () => {
    expect(nextCatchUpStep({ hasMore: false, pagesFetched: 5 })).toBe('done');
    expect(nextCatchUpStep({ hasMore: true, pagesFetched: 4 })).toBe('continue');
    expect(nextCatchUpStep({ hasMore: true, pagesFetched: 5 })).toBe('refetch-latest');
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

  it('channels-loaded keeps muted channels unbadged', () => {
    const state = appReducer(initialAppState, {
      type: 'channels-loaded',
      channels: [
        {
          id: CH,
          workspaceId: 'ws-1',
          name: 'muted',
          createdAt: new Date(0).toISOString(),
          kind: 'public',
          latestEventId: 10,
          lastReadEventId: 0,
          muted: true,
        },
      ],
    });

    expect(state.unread[CH]).toBe(false);
  });

  it('muted channels never gain unread from live events', () => {
    const loaded = appReducer(initialAppState, {
      type: 'channels-loaded',
      channels: [
        {
          id: CH,
          workspaceId: 'ws-1',
          name: 'muted',
          createdAt: new Date(0).toISOString(),
          kind: 'public',
          muted: true,
        },
      ],
    });
    const state = appReducer(loaded, { type: 'server-event', event: wire(12, 'ping @alice') });

    expect(state.unread[CH]).toBe(false);
  });

  it('unmuting re-derives unread from the cold counters', () => {
    const loaded = appReducer(initialAppState, {
      type: 'channels-loaded',
      channels: [
        {
          id: CH,
          workspaceId: 'ws-1',
          name: 'was-muted',
          createdAt: new Date(0).toISOString(),
          kind: 'public',
          latestEventId: 10,
          lastReadEventId: 3,
          muted: true,
        },
      ],
    });
    expect(loaded.unread[CH]).toBe(false);

    // Messages arrived while muted (suppressed); unmute must surface them.
    const unmuted = appReducer(loaded, { type: 'mute-changed', channelId: CH, muted: false });
    expect(unmuted.unread[CH]).toBe(true);

    // ...and unmuting a fully-read channel stays quiet.
    const read = appReducer(unmuted, { type: 'read-cursor', channelId: CH, lastReadEventId: 10 });
    const muted = appReducer(
      {
        ...read,
        channels: read.channels.map((c) => (c.id === CH ? { ...c, lastReadEventId: 10 } : c)),
      },
      { type: 'mute-changed', channelId: CH, muted: true },
    );
    const unmutedAgain = appReducer(muted, { type: 'mute-changed', channelId: CH, muted: false });
    expect(unmutedAgain.unread[CH]).toBe(false);
  });

  it('group DM messages badge as mentions', () => {
    const loaded = appReducer(
      { ...initialAppState, activeChannelId: null },
      {
        type: 'channels-loaded',
        channels: [
          {
            id: CH,
            workspaceId: 'ws-1',
            name: 'gdm',
            createdAt: new Date(0).toISOString(),
            kind: 'gdm',
            members: [alice, bob],
          },
        ],
      },
    );
    const unfocused = appReducer(loaded, { type: 'select-channel', channelId: null });
    const state = appReducer(unfocused, { type: 'server-event', event: wire(12, 'plain', { author: bob }) });
    expect(state.unread[CH]).toBe('mention');
  });
});

describe('channel removal', () => {
  it('removes channel state and clears active timeline', () => {
    const loaded = appReducer(
      {
        ...initialAppState,
        activeChannelId: CH,
        unread: { [CH]: 'mention' },
        timelines: { [CH]: mergeHistory(emptyTimeline, [wire(1, 'hi')], { hasMoreBefore: false }) },
      },
      {
        type: 'channels-loaded',
        channels: [
          {
            id: CH,
            workspaceId: 'ws-1',
            name: 'private',
            createdAt: new Date(0).toISOString(),
            kind: 'private',
          },
        ],
      },
    );
    const state = appReducer(loaded, { type: 'channel-removed', channelId: CH });
    expect(state.channels).toEqual([]);
    expect(state.timelines[CH]).toBeUndefined();
    expect(state.unread[CH]).toBeUndefined();
    expect(state.activeChannelId).toBeNull();
  });
});
describe('session spawn reconciliation', () => {
  it('session.spawned with client_spawn_id reconciles the optimistic row when the POST response was lost', () => {
    const tempId = 'pending:lost-post';
    let t = addPending(emptyTimeline, {
      id: null,
      clientMsgId: tempId,
      channelId: CH,
      threadRootEventId: null,
      text: 'do the thing',
      edited: false,
      author: alice,
      createdAt: new Date(1000).toISOString(),
      replyCount: 0,
      lastReplyId: 0,
      status: 'pending',
      sessionId: tempId,
    });
    expect(t.main).toHaveLength(1);

    // The WS event lands but the POST response never did.
    t = applyEvent(t, {
      id: 42,
      workspaceId: 'ws-1',
      channelId: CH,
      threadRootEventId: null,
      type: 'session.spawned',
      actorId: alice.id,
      payload: { sessionId: 'sess-real', title: 'do the thing', client_spawn_id: tempId },
      createdAt: new Date(2000).toISOString(),
      author: alice,
    });
    expect(t.main).toHaveLength(1); // replaced, not duplicated
    expect(t.main[0]!.sessionId).toBe('sess-real');
    expect(t.main[0]!.status).toBe('confirmed');
  });

});

describe('live cold-counter advancement (unread divider depends on it)', () => {
  const loadedWith = (over: Record<string, unknown> = {}) =>
    appReducer(initialAppState, {
      type: 'channels-loaded',
      channels: [
        {
          id: CH,
          workspaceId: 'ws-1',
          name: 'general',
          createdAt: new Date(0).toISOString(),
          kind: 'public' as const,
          latestEventId: 5,
          lastReadEventId: 5,
          ...over,
        },
        {
          id: 'ch-active',
          workspaceId: 'ws-1',
          name: 'active',
          createdAt: new Date(0).toISOString(),
          kind: 'public' as const,
          latestEventId: 1,
          lastReadEventId: 1,
        },
      ],
    });

  it('a live message bumps channels[].latestEventId past the cold value', () => {
    // 'active' sorts first alphabetically and there is no #general fallback
    // ambiguity: select ch-active so CH counts as a background channel.
    let state = appReducer(loadedWith(), { type: 'select-channel', channelId: 'ch-active' });
    state = appReducer(state, { type: 'server-event', event: wire(9, 'fresh') });
    const ch = state.channels.find((c) => c.id === CH)!;
    expect(ch.latestEventId).toBe(9);
    expect(state.unread[CH]).toBe(true);
  });

  it('mock events never advance the counter', () => {
    let state = appReducer(loadedWith(), { type: 'select-channel', channelId: 'ch-active' });
    state = appReducer(state, {
      type: 'server-event',
      event: { ...wire(9, 'mocked'), mock: true },
    });
    expect(state.channels.find((c) => c.id === CH)!.latestEventId).toBe(5);
  });

  it('read-cursor advances channels[].lastReadEventId monotonically', () => {
    let state = loadedWith({ lastReadEventId: 3 });
    state = appReducer(state, { type: 'read-cursor', channelId: CH, lastReadEventId: 8 });
    expect(state.channels.find((c) => c.id === CH)!.lastReadEventId).toBe(8);
    // Stale cursor must not regress it.
    state = appReducer(state, { type: 'read-cursor', channelId: CH, lastReadEventId: 4 });
    expect(state.channels.find((c) => c.id === CH)!.lastReadEventId).toBe(8);
    expect(state.unread[CH]).toBe(false);
  });
});
