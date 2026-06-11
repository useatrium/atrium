import type { Channel, QueuedOp, WireEvent } from '@atrium/surface-client';

export const MAX_EVENTS_PER_CHANNEL = 300;
export const DEFAULT_CACHE_FLUSH_MS = 500;

export interface CachedTimeline {
  events: WireEvent[];
  hasMore: boolean;
}

export interface CacheSnapshot {
  channels: Channel[] | null;
  timelines: Record<string, CachedTimeline>;
}

export interface CacheStorage {
  loadSnapshot: () => Promise<CacheSnapshot>;
  saveChannels: (channels: Channel[]) => Promise<void>;
  saveTimeline: (channelId: string, timeline: CachedTimeline) => Promise<void>;
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
  listOps: () => Promise<QueuedOp[]>;
  putOp: (op: QueuedOp) => Promise<void>;
  removeOp: (opId: string) => Promise<void>;
  getDraft: (key: string) => Promise<string | null>;
  setDraft: (key: string, text: string) => Promise<void>;
  flushChannel: (channelId: string) => Promise<void>;
  flushAll: () => Promise<void>;
  clearCache: () => Promise<void>;
}

function newestEvents(events: WireEvent[]): WireEvent[] {
  return [...events].sort((a, b) => a.id - b.id).slice(-MAX_EVENTS_PER_CHANNEL);
}

function normalizeTimeline(timeline: CachedTimeline): CachedTimeline {
  return {
    events: newestEvents(timeline.events),
    hasMore: timeline.hasMore,
  };
}

function mergeEvents(current: CachedTimeline | undefined, events: WireEvent[], hasMore?: boolean) {
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
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // After clearCache (logout / 401) the singleton must reject late writes —
  // an in-flight outbox flush or WS event resolving after the wipe would
  // otherwise persist the previous user's data for the next login to hydrate.
  let invalidated = false;

  const clearTimer = (channelId: string) => {
    const timer = timers.get(channelId);
    if (timer) clearTimeout(timer);
    timers.delete(channelId);
  };

  const flushChannel = async (channelId: string) => {
    clearTimer(channelId);
    const timeline = timelines[channelId];
    if (!timeline) return;
    await storage.saveTimeline(channelId, normalizeTimeline(timeline));
  };

  const cache: EventCache = {
    loadSnapshot: async () => {
      invalidated = false; // a fresh session re-arms writes
      const snapshot = await storage.loadSnapshot();
      channels = snapshot.channels;
      timelines = Object.fromEntries(
        Object.entries(snapshot.timelines).map(([channelId, timeline]) => [
          channelId,
          normalizeTimeline(timeline),
        ]),
      );
      return { channels, timelines };
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
      await Promise.all(Object.keys(timelines).map((channelId) => flushChannel(channelId)));
    },

    clearCache: async () => {
      invalidated = true; // reject any write that resolves after this point
      for (const channelId of timers.keys()) clearTimer(channelId);
      channels = null;
      timelines = {};
      await storage.clearCache();
    },
  };

  return cache;
}
