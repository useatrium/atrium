import * as SQLite from 'expo-sqlite';
import { createEventCache, type CacheSnapshot, type CacheStorage } from './cache';
import type { Channel, WireEvent } from '@atrium/surface-client';

const DB_NAME = 'atrium-event-cache.db';

interface JsonRow {
  value: string;
}

interface TimelineRow {
  channel_id: string;
  events_json: string;
  has_more: number;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function db() {
  dbPromise ??= SQLite.openDatabaseAsync(DB_NAME).then(async (database) => {
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS cache_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_timelines (
        channel_id TEXT PRIMARY KEY NOT NULL,
        events_json TEXT NOT NULL,
        has_more INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    return database;
  });
  return dbPromise;
}

const storage: CacheStorage = {
  loadSnapshot: async (): Promise<CacheSnapshot> => {
    const database = await db();
    const channelsRow = await database.getFirstAsync<JsonRow>(
      'SELECT value FROM cache_meta WHERE key = ?',
      'channels',
    );
    const rows = await database.getAllAsync<TimelineRow>(
      'SELECT channel_id, events_json, has_more FROM channel_timelines',
    );
    const timelines: CacheSnapshot['timelines'] = {};
    for (const row of rows) {
      timelines[row.channel_id] = {
        events: JSON.parse(row.events_json) as WireEvent[],
        hasMore: row.has_more === 1,
      };
    }
    return {
      channels: channelsRow ? (JSON.parse(channelsRow.value) as Channel[]) : null,
      timelines,
    };
  },

  saveChannels: async (channels) => {
    const database = await db();
    await database.runAsync(
      'INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)',
      'channels',
      JSON.stringify(channels),
    );
  },

  saveTimeline: async (channelId, timeline) => {
    const database = await db();
    await database.runAsync(
      `INSERT OR REPLACE INTO channel_timelines
        (channel_id, events_json, has_more, updated_at)
        VALUES (?, ?, ?, ?)`,
      channelId,
      JSON.stringify(timeline.events),
      timeline.hasMore ? 1 : 0,
      Date.now(),
    );
  },

  clearCache: async () => {
    const database = await db();
    await database.execAsync(`
      DELETE FROM cache_meta;
      DELETE FROM channel_timelines;
    `);
  },
};

export const eventCache = createEventCache(storage);

export const loadSnapshot = eventCache.loadSnapshot;
export const saveChannels = eventCache.saveChannels;
export const saveTimeline = eventCache.saveTimeline;
export const clearCache = eventCache.clearCache;
