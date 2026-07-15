import { describe, expect, it } from 'vitest';
import { appReducer, initialAppState, type AppState } from './appState.js';
import type { Channel } from './api.js';

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

describe('server-read-cursor', () => {
  it('advances channel and remote cursors monotonically without touching unread', () => {
    const state = { ...seed(), unread: { c1: true as const } };
    const advanced = appReducer(state, {
      type: 'server-read-cursor',
      channelId: 'c1',
      lastReadEventId: 15,
    });
    expect(advanced.channels[0]?.lastReadEventId).toBe(15);
    expect(advanced.remoteReadCursors.c1).toBe(15);
    expect(advanced.unread.c1).toBe(true);

    const regressed = appReducer(advanced, {
      type: 'server-read-cursor',
      channelId: 'c1',
      lastReadEventId: 12,
    });
    expect(regressed.channels[0]?.lastReadEventId).toBe(15);
    expect(regressed.remoteReadCursors.c1).toBe(15);
    expect(regressed.unread.c1).toBe(true);
  });

  it('does not advance the remote cursor when the channel cursor already equals the value', () => {
    const next = appReducer(seed(15), {
      type: 'server-read-cursor',
      channelId: 'c1',
      lastReadEventId: 15,
    });
    expect(next.channels[0]?.lastReadEventId).toBe(15);
    expect(next.remoteReadCursors.c1).toBeUndefined();
  });

  it('records the remote cursor when the channel is missing from state', () => {
    const next = appReducer(initialAppState, {
      type: 'server-read-cursor',
      channelId: 'missing',
      lastReadEventId: 7,
    });
    expect(next.channels).toEqual([]);
    expect(next.remoteReadCursors.missing).toBe(7);
    expect(next.unread).toEqual({});
  });
});
