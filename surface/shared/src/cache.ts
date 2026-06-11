import type { Channel } from './api';
import type { QueuedOp } from './opQueue';
import type { WireEvent } from './timeline';

export const MAX_EVENTS_PER_CHANNEL = 300;
export const DEFAULT_CACHE_FLUSH_MS = 500;

export interface CachedTimeline {
  events: WireEvent[];
  hasMore: boolean;
}

export interface CacheSnapshot {
  channels: Channel[] | null;
  timelines: Record<string, CachedTimeline>;
  syncCursor: number;
}

export interface CacheStorage {
  loadSnapshot: () => Promise<CacheSnapshot>;
  saveChannels: (channels: Channel[]) => Promise<void>;
  saveTimeline: (channelId: string, timeline: CachedTimeline) => Promise<void>;
  saveSyncCursor: (cursor: number) => Promise<void>;
  listOps: () => Promise<QueuedOp[]>;
  putOp: (op: QueuedOp) => Promise<void>;
  removeOp: (opId: string) => Promise<void>;
  getDraft: (key: string) => Promise<string | null>;
  setDraft: (key: string, text: string) => Promise<void>;
  clearCache: () => Promise<void>;
}

export interface EventCache {
  loadSnapshot: () => Promise<CacheSnapshot>;
  saveChannels: (channels: Channel[]) => Promise<void>;
  saveTimeline: (channelId: string, events: WireEvent[], hasMore: boolean) => Promise<void>;
  enqueueEvents: (channelId: string, events: WireEvent[]) => void;
  saveSyncCursor: (cursor: number) => Promise<void>;
  listOps: () => Promise<QueuedOp[]>;
  putOp: (op: QueuedOp) => Promise<void>;
  removeOp: (opId: string) => Promise<void>;
  getDraft: (key: string) => Promise<string | null>;
  setDraft: (key: string, text: string) => Promise<void>;
  flushChannel: (channelId: string) => Promise<void>;
  flushAll: () => Promise<void>;
  clearCache: () => Promise<void>;
}

export function newestEvents(events: WireEvent[]): WireEvent[] {
  return [...events].sort((a, b) => a.id - b.id).slice(-MAX_EVENTS_PER_CHANNEL);
}

function normalizeTimeline(timeline: CachedTimeline): CachedTimeline {
  return {
    events: newestEvents(timeline.events),
    hasMore: timeline.hasMore,
  };
}

export function mergeEvents(
  current: CachedTimeline | undefined,
  events: WireEvent[],
  hasMore?: boolean,
): CachedTimeline {
  const byId = new Map<number, WireEvent>();
  for (const ev of current?.events ?? []) byId.set(ev.id, ev);
  for (const ev of events) byId.set(ev.id, ev);
  return normalizeTimeline({
    events: [...byId.values()],
    hasMore: hasMore ?? current?.hasMore ?? false,
  });
}

export function createEventCache(
  storage: CacheStorage,
  flushMs = DEFAULT_CACHE_FLUSH_MS,
): EventCache {
  let channels: Channel[] | null = null;
  let timelines: Record<string, CachedTimeline> = {};
  let syncCursor = 0;
  let persistedCursor = 0;
  let pendingCursor: number | null = null;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // After clearCache (logout / 401) the singleton must reject late writes:
  // an in-flight outbox flush or WS event resolving after the wipe would
  // otherwise persist the previous user's data for the next login to hydrate.
  let invalidated = false;

  const clearTimer = (channelId: string) => {
    const timer = timers.get(channelId);
    if (timer) clearTimeout(timer);
    timers.delete(channelId);
  };

  const persistPendingCursor = async () => {
    if (pendingCursor == null || pendingCursor <= persistedCursor || timers.size > 0) return;
    const cursor = pendingCursor;
    pendingCursor = null;
    persistedCursor = cursor;
    await storage.saveSyncCursor(cursor);
  };

  const flushChannel = async (channelId: string) => {
    clearTimer(channelId);
    const timeline = timelines[channelId];
    if (timeline) await storage.saveTimeline(channelId, normalizeTimeline(timeline));
    await persistPendingCursor();
  };

  const cache: EventCache = {
    loadSnapshot: async () => {
      invalidated = false; // a fresh session re-arms writes
      const snapshot = await storage.loadSnapshot();
      channels = snapshot.channels;
      syncCursor = snapshot.syncCursor;
      persistedCursor = snapshot.syncCursor;
      pendingCursor = null;
      timelines = Object.fromEntries(
        Object.entries(snapshot.timelines).map(([channelId, timeline]) => [
          channelId,
          normalizeTimeline(timeline),
        ]),
      );
      return { channels, timelines, syncCursor };
    },

    saveChannels: async (nextChannels) => {
      if (invalidated) return;
      channels = nextChannels;
      await storage.saveChannels(nextChannels);
    },

    saveTimeline: async (channelId, events, hasMore) => {
      if (invalidated) return;
      const timeline = mergeEvents(timelines[channelId], events, hasMore);
      timelines = { ...timelines, [channelId]: timeline };
      clearTimer(channelId);
      await storage.saveTimeline(channelId, timeline);
    },

    enqueueEvents: (channelId, events) => {
      if (invalidated || events.length === 0) return;
      timelines = { ...timelines, [channelId]: mergeEvents(timelines[channelId], events) };
      clearTimer(channelId);
      timers.set(
        channelId,
        setTimeout(() => {
          void flushChannel(channelId).catch((err: unknown) => {
            console.warn('failed to flush event cache', err);
          });
        }, flushMs),
      );
    },

    saveSyncCursor: async (cursor) => {
      if (invalidated || cursor <= syncCursor) return;
      syncCursor = cursor;
      if (timers.size > 0) {
        pendingCursor = Math.max(pendingCursor ?? 0, cursor);
        return;
      }
      persistedCursor = cursor;
      await storage.saveSyncCursor(cursor);
    },

    listOps: () => (invalidated ? Promise.resolve([]) : storage.listOps()),

    putOp: (op) => {
      if (invalidated) return Promise.resolve();
      return storage.putOp(op);
    },

    removeOp: (opId) => storage.removeOp(opId),

    getDraft: (key) => storage.getDraft(key),

    setDraft: (key, text) => storage.setDraft(key, text),

    flushChannel,

    flushAll: async () => {
      for (const channelId of Object.keys(timelines)) {
        clearTimer(channelId);
        const timeline = timelines[channelId];
        if (timeline) await storage.saveTimeline(channelId, normalizeTimeline(timeline));
      }
      await persistPendingCursor();
    },

    clearCache: async () => {
      invalidated = true; // reject any write that resolves after this point
      for (const channelId of timers.keys()) clearTimer(channelId);
      channels = null;
      timelines = {};
      syncCursor = 0;
      persistedCursor = 0;
      pendingCursor = null;
      await storage.clearCache();
    },
  };

  return cache;
}
