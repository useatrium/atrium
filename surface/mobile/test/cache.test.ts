import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEventCache,
  MAX_EVENTS_PER_CHANNEL,
  type CachedTimeline,
  type CacheSnapshot,
  type CacheStorage,
  type DraftSnapshot,
  type DraftSnapshotEntry,
} from '../src/lib/cache';
import type { Channel, QueuedOp, WireEvent } from '@atrium/surface-client';

class MemoryStorage implements CacheStorage {
  snapshot: CacheSnapshot = { channels: null, timelines: {}, syncCursor: 0 };
  ops: QueuedOp[] = [];
  drafts = new Map<string, DraftSnapshotEntry>();
  timelineWrites = 0;

  async loadSnapshot(): Promise<CacheSnapshot> {
    return structuredClone(this.snapshot);
  }

  async saveChannels(channels: Channel[]): Promise<void> {
    this.snapshot.channels = structuredClone(channels);
  }

  async saveTimeline(channelId: string, timeline: CachedTimeline): Promise<void> {
    this.timelineWrites += 1;
    this.snapshot.timelines[channelId] = structuredClone(timeline);
  }

  async saveSyncCursor(cursor: number): Promise<void> {
    this.snapshot.syncCursor = cursor;
  }

  async listOps(): Promise<QueuedOp[]> {
    return structuredClone(this.ops);
  }

  async putOp(op: QueuedOp): Promise<void> {
    this.ops = this.ops.filter((current) => current.opId !== op.opId);
    this.ops.push(structuredClone(op));
  }

  async removeOp(opId: string): Promise<void> {
    this.ops = this.ops.filter((op) => op.opId !== opId);
  }

  async getDraft(key: string): Promise<string | null> {
    return this.drafts.get(key)?.text ?? null;
  }

  async getDraftEntry(key: string): Promise<DraftSnapshotEntry | null> {
    return this.drafts.get(key) ?? null;
  }

  async listDrafts(): Promise<DraftSnapshot> {
    return Object.fromEntries(this.drafts);
  }

  async setDraft(key: string, text: string, updatedAt?: string): Promise<void> {
    if (text.length === 0) this.drafts.delete(key);
    else this.drafts.set(key, { text, updatedAt: updatedAt ?? new Date().toISOString() });
  }

  async clearCache(): Promise<void> {
    this.snapshot = { channels: null, timelines: {}, syncCursor: 0 };
    this.ops = [];
    this.drafts.clear();
  }
}

function channel(id: string): Channel {
  return {
    id,
    workspaceId: 'workspace-1',
    name: id,
    createdAt: '2026-06-11T12:00:00.000Z',
  };
}

function event(id: number, channelId = 'channel-1'): WireEvent {
  return {
    id,
    workspaceId: 'workspace-1',
    channelId,
    threadRootEventId: null,
    type: 'message.posted',
    actorId: 'user-1',
    payload: { text: `message ${id}` },
    createdAt: '2026-06-11T12:00:00.000Z',
    author: { id: 'user-1', handle: 'gary', displayName: 'Gary' },
  };
}

describe('event cache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips channels and cached timelines through storage', async () => {
    const storage = new MemoryStorage();
    const cache = createEventCache(storage);
    const channels = [channel('general')];
    const events = [event(1), event(2)];

    await cache.saveChannels(channels);
    await cache.saveTimeline('general', events, true);

    const reloaded = createEventCache(storage);
    await expect(reloaded.loadSnapshot()).resolves.toEqual({
      channels,
      timelines: {
        general: { events, hasMore: true },
      },
      syncCursor: 0,
    });
  });

  it('caps each channel at the newest 300 events on write', async () => {
    const storage = new MemoryStorage();
    const cache = createEventCache(storage);
    const events = Array.from({ length: MAX_EVENTS_PER_CHANNEL + 25 }, (_, i) => event(i + 1));

    await cache.saveTimeline('channel-1', events, false);

    const saved = storage.snapshot.timelines['channel-1'];
    expect(saved?.events).toHaveLength(MAX_EVENTS_PER_CHANNEL);
    expect(saved?.events[0]?.id).toBe(26);
    expect(saved?.events.at(-1)?.id).toBe(325);
  });

  it('debounces event flushes per channel', async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const cache = createEventCache(storage, 500);

    cache.enqueueEvents('channel-1', [event(1)]);
    cache.enqueueEvents('channel-1', [event(2)]);

    await vi.advanceTimersByTimeAsync(499);
    expect(storage.timelineWrites).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(storage.timelineWrites).toBe(1);
    expect(storage.snapshot.timelines['channel-1']).toEqual({
      events: [event(1), event(2)],
      hasMore: false,
    });
  });

  it('persists the sync cursor monotonically', async () => {
    const storage = new MemoryStorage();
    const cache = createEventCache(storage);

    await cache.saveSyncCursor(10);
    await cache.saveSyncCursor(4);

    const reloaded = createEventCache(storage);
    await expect(reloaded.loadSnapshot()).resolves.toMatchObject({ syncCursor: 10 });
  });

  it('removes cached drafts when set to empty text', async () => {
    const storage = new MemoryStorage();
    const cache = createEventCache(storage);

    await cache.setDraft('channel:one', 'stale', '2026-06-11T12:00:00.000Z');
    await expect(cache.getDraft('channel:one')).resolves.toBe('stale');

    await cache.setDraft('channel:one', '');

    await expect(cache.getDraft('channel:one')).resolves.toBeNull();
    await expect(cache.listDrafts()).resolves.toEqual({});
  });

  it('does not persist a cursor ahead of pending timeline flushes', async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const cache = createEventCache(storage, 500);

    cache.enqueueEvents('channel-1', [event(11)]);
    await cache.saveSyncCursor(11);

    expect(storage.snapshot.syncCursor).toBe(0);
    expect(storage.timelineWrites).toBe(0);

    await vi.advanceTimersByTimeAsync(500);

    expect(storage.timelineWrites).toBe(1);
    expect(storage.snapshot.syncCursor).toBe(11);
  });
});
