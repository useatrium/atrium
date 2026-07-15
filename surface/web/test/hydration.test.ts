import { describe, expect, it, vi } from 'vitest';
import { appReducer, initialAppState, type AppAction, type Channel, type WireEvent } from '@atrium/surface-client';
import { hydrateCachedTimelines } from '../src/hydration';

function wire(id: number, channelId = 'ch-1'): WireEvent {
  return {
    id,
    workspaceId: 'ws-1',
    channelId,
    threadRootEventId: null,
    type: 'message.posted',
    actorId: 'u-1',
    payload: { text: `message ${id}` },
    createdAt: new Date(id * 1000).toISOString(),
    author: { id: 'u-1', handle: 'ada', displayName: 'Ada' },
  };
}

function modifier(id: number, targetEventId: number, type = 'message.edited'): WireEvent {
  return {
    ...wire(id),
    type,
    payload: { text: `edited ${targetEventId}`, target: `evt_${targetEventId}` },
  };
}

function emptyDelta() {
  return Promise.resolve({ events: [], hasMore: false });
}

function channel(id: string, name: string, latestEventId: number, lastReadEventId: number): Channel {
  return {
    id,
    workspaceId: 'ws-1',
    name,
    createdAt: new Date(0).toISOString(),
    kind: 'public',
    latestEventId,
    lastReadEventId,
    archivedAt: null,
    pinned: false,
  };
}

describe('cached timeline hydration', () => {
  it('repairs a cached timeline whose last event is behind the persisted cursor', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const latest = { events: [wire(9)], hasMore: true, readCursor: 8 };
    const fetchLatest = vi.fn(async () => latest);
    const onRepaired = vi.fn();

    await hydrateCachedTimelines({
      timelines: { 'ch-1': { events: [wire(4)], hasMore: false } },
      syncCursor: 8,
      dispatch,
      fetchLatest,
      fetchDelta: emptyDelta,
      onRepaired,
    });

    expect(fetchLatest).toHaveBeenCalledWith('ch-1');
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: 'server-read-cursor', channelId: 'ch-1', lastReadEventId: 8 },
      {
        type: 'history-reset',
        channelId: 'ch-1',
        events: latest.events,
        hasMore: latest.hasMore,
      },
    ]);
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'history-loaded' }));
    expect(onRepaired).toHaveBeenCalledWith('ch-1', latest);
  });

  it('falls back to the cached events when the repair refetch fails', async () => {
    // Regression: this branch used to dispatch NOTHING and never retry, so a
    // failed repair left the channel with no history at all — a blank channel,
    // and a deep-linked thread whose root could never be resolved, until the
    // user reloaded again. It failed silently (a console.warn). Degraded beats
    // blank: the stale cache is strictly more than nothing, and the live stream
    // reconciles from there.
    const dispatch = vi.fn<(action: AppAction) => void>();
    const cached = { events: [wire(4)], hasMore: false };
    const fetchLatest = vi.fn(async () => {
      throw new Error('Could not reach the server');
    });
    const onRepairFailed = vi.fn();

    await hydrateCachedTimelines({
      timelines: { 'ch-1': cached },
      syncCursor: 8, // ahead of the cache, so a repair is attempted
      dispatch,
      fetchLatest,
      fetchDelta: emptyDelta,
      onRepairFailed,
    });

    expect(fetchLatest).toHaveBeenCalledWith('ch-1');
    expect(dispatch).toHaveBeenCalledWith({
      type: 'history-loaded',
      channelId: 'ch-1',
      events: cached.events,
      hasMore: cached.hasMore,
    });
    expect(onRepairFailed).toHaveBeenCalledWith('ch-1', expect.any(Error));
  });

  it('dispatches nothing when the repair fails after the view is disposed', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const fetchLatest = vi.fn(async () => {
      throw new Error('Could not reach the server');
    });

    await hydrateCachedTimelines({
      timelines: { 'ch-1': { events: [wire(4)], hasMore: false } },
      syncCursor: 8,
      dispatch,
      fetchLatest,
      fetchDelta: emptyDelta,
      isDisposed: () => true,
    });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('hydrates cached timelines directly when they are not behind the cursor', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const fetchLatest = vi.fn();
    const fetchDelta = vi.fn(emptyDelta);
    const events = [wire(8)];

    await hydrateCachedTimelines({
      timelines: { 'ch-1': { events, hasMore: false } },
      syncCursor: 8,
      dispatch,
      fetchLatest,
      fetchDelta,
    });

    expect(fetchLatest).not.toHaveBeenCalled();
    expect(fetchDelta).toHaveBeenCalledWith('ch-1', 8);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'history-loaded',
      channelId: 'ch-1',
      events,
      hasMore: false,
    });
  });

  it('repairs cached modifier events whose target row is missing', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();
    const latest = { events: [wire(13), modifier(16, 13)], hasMore: false };
    const fetchLatest = vi.fn(async () => latest);
    const onRepaired = vi.fn();

    await hydrateCachedTimelines({
      timelines: { 'ch-1': { events: [modifier(15, 13, 'reaction.added'), modifier(16, 13)], hasMore: false } },
      syncCursor: 16,
      dispatch,
      fetchLatest,
      fetchDelta: emptyDelta,
      onRepaired,
    });

    expect(fetchLatest).toHaveBeenCalledWith('ch-1');
    expect(dispatch).toHaveBeenCalledWith({
      type: 'history-reset',
      channelId: 'ch-1',
      events: latest.events,
      hasMore: latest.hasMore,
    });
    expect(onRepaired).toHaveBeenCalledWith('ch-1', latest);
  });

  it('heals an edited and reacted cached row from a folded delta and advances from nextCursor', async () => {
    let state = initialAppState;
    const dispatch = vi.fn((action: AppAction) => {
      state = appReducer(state, action);
    });
    const folded: WireEvent = {
      ...wire(4),
      payload: {
        text: 'edited while away',
        edited: true,
        reactions: [{ emoji: '👍', userIds: ['u-2'] }],
      },
      lastModifierId: 11,
    };
    const fetchDelta = vi.fn(async () => ({ events: [folded], hasMore: false, nextCursor: 12, readCursor: 4 }));

    await hydrateCachedTimelines({
      timelines: { 'ch-1': { events: [wire(4)], hasMore: false } },
      syncCursor: 4,
      dispatch,
      fetchLatest: vi.fn(),
      fetchDelta,
    });

    expect(fetchDelta).toHaveBeenCalledWith('ch-1', 4);
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: 'server-read-cursor',
      channelId: 'ch-1',
      lastReadEventId: 4,
    });
    expect(dispatch).toHaveBeenNthCalledWith(3, {
      type: 'history-loaded',
      channelId: 'ch-1',
      events: [folded],
      hasMore: false,
      nextCursor: 12,
      catchupCursor: 4,
      origin: 'channel-delta',
    });
    expect(state.timelines['ch-1']?.main[0]).toMatchObject({
      id: 4,
      text: 'edited while away',
      edited: true,
      reactions: [{ emoji: '👍', userIds: ['u-2'] }],
      lastModifierId: 11,
    });
    expect(state.timelines['ch-1']?.lastEventId).toBe(12);
  });

  it('keeps applying a legacy raw modifier delta when nextCursor is absent', async () => {
    let state = initialAppState;
    const dispatch = vi.fn((action: AppAction) => {
      state = appReducer(state, action);
    });
    const edit = modifier(5, 4);

    await hydrateCachedTimelines({
      timelines: { 'ch-1': { events: [wire(4)], hasMore: false } },
      syncCursor: 4,
      dispatch,
      fetchLatest: vi.fn(),
      fetchDelta: vi.fn(async () => ({ events: [edit], hasMore: false })),
    });

    expect(state.timelines['ch-1']?.main[0]).toMatchObject({
      id: 4,
      text: 'edited 4',
      edited: true,
      lastModifierId: 5,
    });
    expect(state.timelines['ch-1']?.lastEventId).toBe(5);
  });

  it('merges a warm delta thread reply into its root and derives unread activity', async () => {
    let state = appReducer(initialAppState, {
      type: 'channels-loaded',
      channels: [channel('ch-1', 'project', 4, 4), channel('ch-active', 'general', 1, 1)],
    });
    state = appReducer(state, { type: 'select-channel', channelId: 'ch-active' });
    const dispatch = vi.fn((action: AppAction) => {
      state = appReducer(state, action);
    });
    const reply: WireEvent = {
      ...wire(5),
      threadRootEventId: 4,
      actorId: 'u-2',
      payload: { text: 'reply while closed' },
      author: { id: 'u-2', handle: 'bea', displayName: 'Bea' },
    };
    const fetchDelta = vi.fn(async () => ({ events: [reply], hasMore: false }));

    await hydrateCachedTimelines({
      timelines: { 'ch-1': { events: [wire(4)], hasMore: false } },
      syncCursor: 4,
      dispatch,
      fetchLatest: vi.fn(),
      fetchDelta,
    });

    expect(fetchDelta).toHaveBeenCalledWith('ch-1', 4);
    const root = state.timelines['ch-1']?.main.find((message) => message.id === 4);
    expect(root).toMatchObject({
      replyCount: 1,
      lastReplyId: 5,
      lastReply: { id: 5, text: 'reply while closed' },
    });
    expect(state.unread['ch-1']).toBe(true);
    // The per-channel response must not skip the workspace sync past id 4.
    expect(state.syncCursor).toBe(4);
  });

  it('leaves hydrated state byte-identical when the warm delta is empty', async () => {
    let state = initialAppState;
    let stateBeforeDelta = state;
    const dispatch = vi.fn((action: AppAction) => {
      state = appReducer(state, action);
    });
    const fetchDelta = vi.fn(async () => {
      stateBeforeDelta = state;
      return { events: [], hasMore: false };
    });

    await hydrateCachedTimelines({
      timelines: { 'ch-1': { events: [wire(4)], hasMore: false } },
      syncCursor: 4,
      dispatch,
      fetchLatest: vi.fn(),
      fetchDelta,
    });

    expect(state).toBe(stateBeforeDelta);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('adopts the server read cursor before a warm delta, including an empty delta', async () => {
    const dispatch = vi.fn<(action: AppAction) => void>();

    await hydrateCachedTimelines({
      timelines: { 'ch-1': { events: [wire(4)], hasMore: false } },
      syncCursor: 4,
      dispatch,
      fetchLatest: vi.fn(),
      fetchDelta: vi.fn(async () => ({ events: [], hasMore: false, readCursor: 9 })),
    });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: 'history-loaded', channelId: 'ch-1', events: [wire(4)], hasMore: false },
      { type: 'server-read-cursor', channelId: 'ch-1', lastReadEventId: 9 },
    ]);
  });

  it('keeps cached hydration complete when the warm delta fetch rejects', async () => {
    let state = initialAppState;
    const dispatch = vi.fn((action: AppAction) => {
      state = appReducer(state, action);
    });
    const failure = new Error('delta unavailable');
    const onDeltaFailed = vi.fn();

    await expect(
      hydrateCachedTimelines({
        timelines: { 'ch-1': { events: [wire(4)], hasMore: false } },
        syncCursor: 4,
        dispatch,
        fetchLatest: vi.fn(),
        fetchDelta: vi.fn(async () => {
          throw failure;
        }),
        onDeltaFailed,
      }),
    ).resolves.toBeUndefined();

    expect(state.timelines['ch-1']?.loaded).toBe(true);
    expect(state.timelines['ch-1']?.main.map((message) => message.id)).toEqual([4]);
    expect(onDeltaFailed).toHaveBeenCalledWith('ch-1', failure);
  });
});
