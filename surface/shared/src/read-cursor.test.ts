import { describe, expect, it } from 'vitest';
import { appReducer, initialAppState, newestConfirmedMainEventId, type AppState } from './appState.js';
import type { Channel } from './api.js';
import type { WireEvent } from './timeline.js';

function seed(lastRead = 10, latest = 20): AppState {
  const channel: Channel = {
    id: 'c1',
    workspaceId: 'w1',
    name: 'general',
    createdAt: '2026-01-01T00:00:00Z',
    archivedAt: null,
    pinned: false,
    lastReadEventId: lastRead,
    latestEventId: latest,
  };
  return appReducer(initialAppState, { type: 'channels-loaded', channels: [channel] });
}

function wire(id: number, type = 'message.posted'): WireEvent {
  return {
    id,
    workspaceId: 'w1',
    channelId: 'c1',
    threadRootEventId: null,
    type,
    actorId: 'u2',
    payload: type === 'message.posted' ? { text: `message ${id}` } : { target: 'evt_16', emoji: '👍' },
    createdAt: new Date(id * 1000).toISOString(),
    author: { id: 'u2', handle: 'bea', displayName: 'Bea' },
  };
}

describe('read-cursor source tracking', () => {
  it('a self read advances the cursor but NOT remoteReadCursors', () => {
    const next = appReducer(seed(), { type: 'read-cursor', channelId: 'c1', lastReadEventId: 20 });
    expect(next.channels[0]?.lastReadEventId).toBe(20);
    expect(next.remoteReadCursors.c1).toBeUndefined();
  });

  it('an explicit self source behaves the same', () => {
    const next = appReducer(seed(), {
      type: 'read-cursor',
      channelId: 'c1',
      lastReadEventId: 20,
      source: 'self',
    });
    expect(next.remoteReadCursors.c1).toBeUndefined();
  });

  it('a remote read advances both the cursor and remoteReadCursors', () => {
    const next = appReducer(seed(), {
      type: 'read-cursor',
      channelId: 'c1',
      lastReadEventId: 20,
      source: 'remote',
    });
    expect(next.channels[0]?.lastReadEventId).toBe(20);
    expect(next.remoteReadCursors.c1).toBe(20);
  });

  it('remoteReadCursors is monotonic — a lower remote read does not regress it', () => {
    const first = appReducer(seed(), {
      type: 'read-cursor',
      channelId: 'c1',
      lastReadEventId: 20,
      source: 'remote',
    });
    const second = appReducer(first, {
      type: 'read-cursor',
      channelId: 'c1',
      lastReadEventId: 15,
      source: 'remote',
    });
    expect(second.remoteReadCursors.c1).toBe(20);
  });

  it('a later self read does not clear a prior remote cursor', () => {
    const remote = appReducer(seed(), {
      type: 'read-cursor',
      channelId: 'c1',
      lastReadEventId: 18,
      source: 'remote',
    });
    const self = appReducer(remote, { type: 'read-cursor', channelId: 'c1', lastReadEventId: 20 });
    expect(self.remoteReadCursors.c1).toBe(18);
    expect(self.channels[0]?.lastReadEventId).toBe(20);
  });
});

describe('history response read cursor', () => {
  it('advances channel and remote cursors monotonically without touching unread', () => {
    const state = { ...seed(), unread: { c1: true as const } };
    const advanced = appReducer(state, {
      type: 'history-loaded',
      channelId: 'c1',
      events: [],
      hasMore: false,
      readCursor: 15,
    });
    expect(advanced.channels[0]?.lastReadEventId).toBe(15);
    expect(advanced.remoteReadCursors.c1).toBe(15);
    expect(advanced.unread.c1).toBe(true);

    const regressed = appReducer(advanced, {
      type: 'history-loaded',
      channelId: 'c1',
      events: [],
      hasMore: false,
      readCursor: 12,
    });
    expect(regressed.channels[0]?.lastReadEventId).toBe(15);
    expect(regressed.remoteReadCursors.c1).toBe(15);
    expect(regressed.unread.c1).toBe(true);
  });

  it('does not advance the remote cursor when the channel cursor already equals the value', () => {
    const next = appReducer(seed(15), {
      type: 'history-reset',
      channelId: 'c1',
      events: [],
      hasMore: false,
      readCursor: 15,
    });
    expect(next.channels[0]?.lastReadEventId).toBe(15);
    expect(next.remoteReadCursors.c1).toBeUndefined();
  });

  it('records the remote cursor when the channel is missing from state', () => {
    const next = appReducer(initialAppState, {
      type: 'history-loaded',
      channelId: 'missing',
      events: [],
      hasMore: false,
      readCursor: 7,
    });
    expect(next.channels).toEqual([]);
    expect(next.remoteReadCursors.missing).toBe(7);
    expect(next.unread).toEqual({});
  });

  it('applies the cursor before events so a genuinely newer delta re-marks unread', () => {
    let state = appReducer(seed(10, 10), { type: 'select-channel', channelId: null });
    state = { ...state, unread: { c1: false } };
    const next = appReducer(state, {
      type: 'history-loaded',
      channelId: 'c1',
      events: [wire(16)],
      hasMore: false,
      readCursor: 15,
      catchupCursor: 10,
      origin: 'channel-delta',
    });

    expect(next.channels[0]?.lastReadEventId).toBe(15);
    expect(next.remoteReadCursors.c1).toBe(15);
    expect(next.unread.c1).toBe(true);
  });

  it('advances an empty warm-delta cursor without replacing the loaded timeline', () => {
    const loaded = appReducer(seed(), {
      type: 'history-loaded',
      channelId: 'c1',
      events: [wire(16)],
      hasMore: false,
    });
    const timelines = loaded.timelines;
    const next = appReducer(loaded, {
      type: 'history-loaded',
      channelId: 'c1',
      events: [],
      hasMore: false,
      readCursor: 18,
      origin: 'channel-delta',
    });

    expect(next.timelines).toBe(timelines);
    expect(next.channels[0]?.lastReadEventId).toBe(18);
  });

  it('an empty INITIAL load with a zero cursor still marks the channel loaded', () => {
    // Regression: an empty channel's first history page carries readCursor: 0.
    // Short-circuiting on it left timeline.loaded false forever, which stalled
    // the divider freeze on that channel and stranded the PREVIOUS channel's
    // frozen divider state (real e2e failure: reopen showed no divider).
    const next = appReducer(seed(), {
      type: 'history-loaded',
      channelId: 'c1',
      events: [],
      hasMore: false,
      readCursor: 0,
    });

    expect(next.timelines.c1?.loaded).toBe(true);
    expect(next.channels[0]?.lastReadEventId).toBe(10);
  });
});

describe('monotonic channel snapshots', () => {
  it('does not regress read/latest counters and derives cold unread from the merged values', () => {
    const current = seed(15, 20);
    const snapshot = { ...current.channels[0]!, lastReadEventId: 5, latestEventId: 10 };
    const next = appReducer(current, { type: 'channels-loaded', channels: [snapshot] });

    expect(next.channels[0]).toMatchObject({ lastReadEventId: 15, latestEventId: 20 });
    expect(next.unread.c1).toBe(true);
  });
});

describe('newestConfirmedMainEventId', () => {
  it('ignores a trailing invisible modifier and unconfirmed rows', () => {
    let state = appReducer(seed(), {
      type: 'history-loaded',
      channelId: 'c1',
      events: [wire(16), wire(20, 'reaction.added')],
      hasMore: false,
    });
    state = appReducer(state, {
      type: 'send-pending',
      channelId: 'c1',
      message: {
        id: null,
        clientMsgId: 'pending-1',
        channelId: 'c1',
        threadRootEventId: null,
        text: 'pending',
        createdAt: new Date().toISOString(),
        author: { id: 'u1', handle: 'ada', displayName: 'Ada' },
        status: 'pending',
        edited: false,
        replyCount: 0,
        lastReplyId: 0,
      },
    });

    expect(state.timelines.c1?.lastEventId).toBe(20);
    expect(newestConfirmedMainEventId(state.timelines.c1)).toBe(16);
    expect(newestConfirmedMainEventId(undefined)).toBe(0);
  });
});
