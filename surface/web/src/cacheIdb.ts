import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  createEventCache,
  parseQueuedOp,
  type CachedTimeline,
  type CacheSnapshot,
  type CacheStorage,
  type Channel,
  type DraftSnapshot,
  type DraftSnapshotEntry,
  type QueuedOp,
  type UserPrefs,
  type UserRef,
  type WireEvent,
  type Workspace,
} from '@atrium/surface-client';

const DB_NAME = 'atrium-web-cache';
const DB_VERSION = 1;

type MetaKey = 'channels' | 'syncCursor' | 'opSeq' | 'boot';

interface MetaRow {
  key: MetaKey;
  value: unknown;
}

interface TimelineRow {
  channelId: string;
  events: WireEvent[];
  hasMore: boolean;
  updatedAt: number;
}

interface OpRow extends QueuedOp {
  seq: number;
}

interface DraftRow {
  key: string;
  text: string;
  updatedAt: number;
  /** Absent on rows written before the agent-intent flag existed. */
  agentIntent?: boolean;
}

export interface BootSnapshot {
  user: UserRef;
  workspace: Workspace;
  prefs?: UserPrefs;
}

interface AtriumCacheDb extends DBSchema {
  meta: {
    key: MetaKey;
    value: MetaRow;
  };
  channelTimelines: {
    key: string;
    value: TimelineRow;
  };
  clientOps: {
    key: string;
    value: OpRow;
    indexes: { seq: number };
  };
  composerDrafts: {
    key: string;
    value: DraftRow;
  };
}

const EMPTY_SNAPSHOT: CacheSnapshot = { channels: null, timelines: {}, syncCursor: 0 };

let dbPromise: Promise<IDBPDatabase<AtriumCacheDb>> | null = null;

function hasIndexedDb(): boolean {
  return typeof globalThis.indexedDB !== 'undefined';
}

async function db(): Promise<IDBPDatabase<AtriumCacheDb>> {
  if (!hasIndexedDb()) throw new Error('IndexedDB is unavailable');
  dbPromise ??= openDB<AtriumCacheDb>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore('meta', { keyPath: 'key' });
      database.createObjectStore('channelTimelines', { keyPath: 'channelId' });
      const ops = database.createObjectStore('clientOps', { keyPath: 'opId' });
      ops.createIndex('seq', 'seq');
      database.createObjectStore('composerDrafts', { keyPath: 'key' });
    },
  });
  return dbPromise;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`invalid ${key}`);
  return value;
}

function booleanField(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw new Error(`invalid ${key}`);
  return value;
}

function numberField(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid ${key}`);
  return value;
}

function asEventArray(value: unknown): WireEvent[] {
  if (!Array.isArray(value)) throw new Error('invalid events');
  for (const event of value) {
    if (!isRecord(event) || typeof event.id !== 'number' || !Number.isFinite(event.id)) {
      throw new Error('invalid event');
    }
  }
  return clone(value as WireEvent[]);
}

function asChannels(value: unknown): Channel[] {
  if (!Array.isArray(value)) throw new Error('invalid channels');
  for (const channel of value) {
    if (!isRecord(channel) || typeof channel.id !== 'string') throw new Error('invalid channel');
  }
  return clone(value as Channel[]);
}

function asUser(value: unknown): UserRef {
  if (!isRecord(value)) throw new Error('invalid user');
  return {
    id: stringField(value, 'id'),
    handle: stringField(value, 'handle'),
    displayName: stringField(value, 'displayName'),
  };
}

function asWorkspace(value: unknown): Workspace {
  if (!isRecord(value)) throw new Error('invalid workspace');
  return {
    id: stringField(value, 'id'),
    name: stringField(value, 'name'),
    createdAt: stringField(value, 'createdAt'),
  };
}

function asBootSnapshot(value: unknown): BootSnapshot {
  if (!isRecord(value)) throw new Error('invalid boot snapshot');
  return {
    user: asUser(value.user),
    workspace: asWorkspace(value.workspace),
    ...(isRecord(value.prefs) ? { prefs: clone(value.prefs as unknown as UserPrefs) } : {}),
  };
}

function asTimeline(row: unknown): { channelId: string; timeline: CachedTimeline } {
  if (!isRecord(row)) throw new Error('invalid timeline row');
  return {
    channelId: stringField(row, 'channelId'),
    timeline: {
      events: asEventArray(row.events),
      hasMore: booleanField(row, 'hasMore'),
    },
  };
}

function asDraftEntry(row: unknown): DraftSnapshotEntry {
  if (!isRecord(row) || typeof row.text !== 'string') throw new Error('invalid draft');
  const updatedAt = numberField(row, 'updatedAt');
  return { text: row.text, updatedAt: new Date(updatedAt).toISOString(), agentIntent: row.agentIntent === true };
}

async function clearStores(database: IDBPDatabase<AtriumCacheDb>): Promise<void> {
  const tx = database.transaction(['meta', 'channelTimelines', 'clientOps', 'composerDrafts'], 'readwrite');
  await Promise.all([
    tx.objectStore('meta').clear(),
    tx.objectStore('channelTimelines').clear(),
    tx.objectStore('clientOps').clear(),
    tx.objectStore('composerDrafts').clear(),
  ]);
  await tx.done;
}

async function clearAfterCorruption<T>(fallback: T, err: unknown): Promise<T> {
  console.warn('clearing corrupted IndexedDB cache', err);
  let database: IDBPDatabase<AtriumCacheDb> | null = null;
  try {
    database = await db();
    await clearStores(database);
  } catch (clearErr) {
    console.warn('failed to clear IndexedDB cache', clearErr);
    database?.close();
    dbPromise = null;
    if (hasIndexedDb()) {
      await deleteDB(DB_NAME).catch((deleteErr: unknown) => {
        console.warn('failed to delete IndexedDB cache', deleteErr);
      });
    }
  }
  return fallback;
}

const idbStorage: CacheStorage = {
  loadSnapshot: async (): Promise<CacheSnapshot> => {
    try {
      const database = await db();
      const [channelsRow, cursorRow, timelineRows] = await Promise.all([
        database.get('meta', 'channels'),
        database.get('meta', 'syncCursor'),
        database.getAll('channelTimelines'),
      ]);
      const timelines: CacheSnapshot['timelines'] = {};
      for (const row of timelineRows) {
        const { channelId, timeline } = asTimeline(row);
        timelines[channelId] = timeline;
      }
      const cursor =
        cursorRow == null
          ? 0
          : typeof cursorRow.value === 'number' && Number.isFinite(cursorRow.value)
            ? Math.max(0, Math.floor(cursorRow.value))
            : (() => {
                throw new Error('invalid sync cursor');
              })();
      return {
        channels: channelsRow == null ? null : asChannels(channelsRow.value),
        timelines,
        syncCursor: cursor,
      };
    } catch (err) {
      return clearAfterCorruption(clone(EMPTY_SNAPSHOT), err);
    }
  },

  saveChannels: async (channels) => {
    const database = await db();
    await database.put('meta', { key: 'channels', value: clone(channels) });
  },

  saveTimeline: async (channelId, timeline) => {
    const database = await db();
    await database.put('channelTimelines', {
      channelId,
      events: clone(timeline.events),
      hasMore: timeline.hasMore,
      updatedAt: Date.now(),
    });
  },

  saveSyncCursor: async (cursor) => {
    const database = await db();
    await database.put('meta', {
      key: 'syncCursor',
      value: Math.max(0, Math.floor(cursor)),
    });
  },

  listOps: async (): Promise<QueuedOp[]> => {
    try {
      const database = await db();
      const tx = database.transaction('clientOps', 'readwrite');
      const ops: QueuedOp[] = [];
      let cursor = await tx.store.index('seq').openCursor();
      while (cursor) {
        try {
          ops.push(parseQueuedOp(cursor.value));
        } catch (err) {
          console.warn('dropping invalid IndexedDB queued op', err);
          await cursor.delete();
        }
        cursor = await cursor.continue();
      }
      await tx.done;
      return ops;
    } catch (err) {
      return clearAfterCorruption([], err);
    }
  },

  putOp: async (op) => {
    const database = await db();
    const tx = database.transaction(['clientOps', 'meta'], 'readwrite');
    const ops = tx.objectStore('clientOps');
    const meta = tx.objectStore('meta');
    const existing = await ops.get(op.opId);
    let seq = existing?.seq;
    if (seq == null) {
      const current = await meta.get('opSeq');
      seq = typeof current?.value === 'number' && Number.isFinite(current.value) ? Math.floor(current.value) + 1 : 1;
      await meta.put({ key: 'opSeq', value: seq });
    }
    await ops.put({ ...clone(op), seq });
    await tx.done;
  },

  removeOp: async (opId) => {
    const database = await db();
    await database.delete('clientOps', opId);
  },

  getDraft: async (key) => {
    try {
      const row = await (await db()).get('composerDrafts', key);
      if (row == null) return null;
      return asDraftEntry(row).text;
    } catch (err) {
      return clearAfterCorruption(null, err);
    }
  },

  getDraftEntry: async (key) => {
    try {
      const row = await (await db()).get('composerDrafts', key);
      return row == null ? null : asDraftEntry(row);
    } catch (err) {
      return clearAfterCorruption(null, err);
    }
  },

  listDrafts: async () => {
    try {
      const rows = await (await db()).getAll('composerDrafts');
      const drafts: DraftSnapshot = {};
      for (const row of rows) drafts[row.key] = asDraftEntry(row);
      return drafts;
    } catch (err) {
      return clearAfterCorruption({}, err);
    }
  },

  setDraft: async (key, text, updatedAt, agentIntent) => {
    const database = await db();
    if (text.length === 0) {
      await database.delete('composerDrafts', key);
      return;
    }
    const parsed = updatedAt ? Date.parse(updatedAt) : Date.now();
    await database.put('composerDrafts', {
      key,
      text,
      updatedAt: Number.isFinite(parsed) ? parsed : Date.now(),
      agentIntent: agentIntent === true,
    });
  },

  clearCache: async () => {
    await clearStores(await db());
  },
};

function createMemoryStorage(): CacheStorage {
  let snapshot: CacheSnapshot = clone(EMPTY_SNAPSHOT);
  let ops: Array<QueuedOp & { seq: number }> = [];
  let nextSeq = 1;
  const drafts = new Map<string, DraftSnapshotEntry>();
  return {
    loadSnapshot: async () => clone(snapshot),
    saveChannels: async (channels) => {
      snapshot = { ...snapshot, channels: clone(channels) };
    },
    saveTimeline: async (channelId, timeline) => {
      snapshot = {
        ...snapshot,
        timelines: { ...snapshot.timelines, [channelId]: clone(timeline) },
      };
    },
    saveSyncCursor: async (cursor) => {
      snapshot = { ...snapshot, syncCursor: Math.max(0, Math.floor(cursor)) };
    },
    listOps: async () =>
      ops
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map(({ seq: _seq, ...op }) => clone(op)),
    putOp: async (op) => {
      const existing = ops.find((current) => current.opId === op.opId);
      ops = ops.filter((current) => current.opId !== op.opId);
      ops.push({ ...clone(op), seq: existing?.seq ?? nextSeq++ });
    },
    removeOp: async (opId) => {
      ops = ops.filter((op) => op.opId !== opId);
    },
    getDraft: async (key) => drafts.get(key)?.text ?? null,
    getDraftEntry: async (key) => drafts.get(key) ?? null,
    listDrafts: async () => Object.fromEntries([...drafts].map(([key, draft]) => [key, structuredClone(draft)])),
    setDraft: async (key, text, updatedAt, agentIntent) => {
      if (text.length === 0) drafts.delete(key);
      else
        drafts.set(key, {
          text,
          updatedAt: updatedAt ?? new Date().toISOString(),
          agentIntent: agentIntent === true,
        });
    },
    clearCache: async () => {
      snapshot = clone(EMPTY_SNAPSHOT);
      ops = [];
      drafts.clear();
      nextSeq = 1;
    },
  };
}

let memoryBootSnapshot: BootSnapshot | null = null;

export async function loadBootSnapshot(): Promise<BootSnapshot | null> {
  if (!hasIndexedDb()) return memoryBootSnapshot ? clone(memoryBootSnapshot) : null;
  try {
    const row = await (await db()).get('meta', 'boot');
    return row == null ? null : asBootSnapshot(row.value);
  } catch (err) {
    return clearAfterCorruption(null, err);
  }
}

export async function saveBootSnapshot(snapshot: BootSnapshot): Promise<void> {
  if (!hasIndexedDb()) {
    memoryBootSnapshot = clone(snapshot);
    return;
  }
  await (await db()).put('meta', { key: 'boot', value: clone(snapshot) });
}

const storage = hasIndexedDb() ? idbStorage : createMemoryStorage();

export const eventCache = createEventCache(storage);

export const clearCache = async (): Promise<void> => {
  memoryBootSnapshot = null;
  await eventCache.clearCache();
};
