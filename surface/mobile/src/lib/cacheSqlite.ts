import * as SQLite from 'expo-sqlite';
import {
  createEventCache,
  type CacheSnapshot,
  type CacheStorage,
  type OutboxMessage,
} from './cache';
import type { AttachmentMeta, Channel, WireEvent } from '@atrium/surface-client';

const DB_NAME = 'atrium-event-cache.db';

interface JsonRow {
  value: string;
}

interface TimelineRow {
  channel_id: string;
  events_json: string;
  has_more: number;
}

interface OutboxRow {
  client_msg_id: string;
  channel_id: string;
  text: string;
  thread_root_event_id: number | null;
  attachments_json: string;
  created_at: string;
  inserted_at: number;
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
      CREATE TABLE IF NOT EXISTS send_outbox (
        client_msg_id TEXT PRIMARY KEY NOT NULL,
        channel_id TEXT NOT NULL,
        text TEXT NOT NULL,
        thread_root_event_id INTEGER,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        inserted_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS composer_drafts (
        draft_key TEXT PRIMARY KEY NOT NULL,
        text TEXT NOT NULL,
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

  enqueueOutbox: async (msg) => {
    const database = await db();
    await database.runAsync(
      `INSERT OR REPLACE INTO send_outbox
        (client_msg_id, channel_id, text, thread_root_event_id, attachments_json, created_at, inserted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      msg.clientMsgId,
      msg.channelId,
      msg.text,
      msg.threadRootEventId ?? null,
      JSON.stringify(msg.attachments ?? []),
      msg.createdAt,
      Date.now(),
    );
  },

  listOutbox: async (): Promise<OutboxMessage[]> => {
    const database = await db();
    const rows = await database.getAllAsync<OutboxRow>(
      `SELECT client_msg_id, channel_id, text, thread_root_event_id, attachments_json, created_at, inserted_at
        FROM send_outbox
        ORDER BY inserted_at ASC, rowid ASC`,
    );
    return rows.map((row) => {
      const attachments = JSON.parse(row.attachments_json) as AttachmentMeta[];
      return {
        clientMsgId: row.client_msg_id,
        channelId: row.channel_id,
        text: row.text,
        ...(row.thread_root_event_id != null
          ? { threadRootEventId: row.thread_root_event_id }
          : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        createdAt: row.created_at,
      };
    });
  },

  removeOutbox: async (clientMsgId) => {
    const database = await db();
    await database.runAsync('DELETE FROM send_outbox WHERE client_msg_id = ?', clientMsgId);
  },

  getDraft: async (key) => {
    const database = await db();
    const row = await database.getFirstAsync<JsonRow>(
      'SELECT text AS value FROM composer_drafts WHERE draft_key = ?',
      key,
    );
    return row?.value ?? null;
  },

  setDraft: async (key, text) => {
    const database = await db();
    if (text.length === 0) {
      await database.runAsync('DELETE FROM composer_drafts WHERE draft_key = ?', key);
      return;
    }
    await database.runAsync(
      `INSERT OR REPLACE INTO composer_drafts (draft_key, text, updated_at)
        VALUES (?, ?, ?)`,
      key,
      text,
      Date.now(),
    );
  },

  clearCache: async () => {
    const database = await db();
    await database.execAsync(`
      DELETE FROM cache_meta;
      DELETE FROM channel_timelines;
      DELETE FROM send_outbox;
      DELETE FROM composer_drafts;
    `);
  },
};

export const eventCache = createEventCache(storage);

export const loadSnapshot = eventCache.loadSnapshot;
export const saveChannels = eventCache.saveChannels;
export const saveTimeline = eventCache.saveTimeline;
export const clearCache = eventCache.clearCache;
