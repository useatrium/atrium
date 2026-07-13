import * as SQLite from 'expo-sqlite';
import { createEventCache, type CacheSnapshot, type CacheStorage } from './cache';
import {
  makeQueuedOp,
  parseQueuedOp,
  randomId,
  type AttachmentMeta,
  type Channel,
  type DraftSnapshot,
  type DraftSnapshotEntry,
  type MsgSendPayload,
  type QueuedOp,
  type WireEvent,
} from '@atrium/surface-client';

const DB_NAME = 'atrium-event-cache.db';

interface JsonRow {
  value: string;
}

interface DraftRow {
  draft_key: string;
  text: string;
  updated_at: number;
}

interface TimelineRow {
  channel_id: string;
  events_json: string;
  has_more: number;
  updated_at: number;
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

interface OpRow {
  row_id: number;
  op_id: string;
  op_type: QueuedOp['opType'];
  queue_key: string;
  payload_json: string;
  status: QueuedOp['status'];
  retry_count: number;
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
      CREATE TABLE IF NOT EXISTS client_ops (
        op_id TEXT PRIMARY KEY NOT NULL,
        op_type TEXT NOT NULL,
        queue_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        inserted_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS composer_drafts (
        draft_key TEXT PRIMARY KEY NOT NULL,
        text TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    await migrateSendOutbox(database);
    return database;
  });
  return dbPromise;
}

async function migrateSendOutbox(database: SQLite.SQLiteDatabase): Promise<void> {
  const oldTable = await database.getFirstAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'send_outbox'",
  );
  if (!oldTable) return;
  const rows = await database.getAllAsync<OutboxRow>(
    `SELECT client_msg_id, channel_id, text, thread_root_event_id, attachments_json, created_at, inserted_at
       FROM send_outbox
       ORDER BY inserted_at ASC, rowid ASC`,
  );
  for (const row of rows) {
    const attachments = JSON.parse(row.attachments_json) as AttachmentMeta[];
    const payload: MsgSendPayload = {
      clientMsgId: row.client_msg_id,
      channelId: row.channel_id,
      text: row.text,
      ...(row.thread_root_event_id != null ? { threadRootEventId: row.thread_root_event_id } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      createdAt: row.created_at,
    };
    const op = makeQueuedOp(
      {
        opId: randomId(),
        opType: 'msg.send',
        payload,
        createdAt: row.created_at,
      },
      row.created_at,
    );
    await database.runAsync(
      `INSERT OR IGNORE INTO client_ops
        (op_id, op_type, queue_key, payload_json, status, retry_count, created_at, inserted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      op.opId,
      op.opType,
      op.queueKey,
      JSON.stringify(op.payload),
      op.status,
      op.retryCount,
      op.createdAt,
      row.inserted_at,
    );
  }
  await database.execAsync('DROP TABLE send_outbox;');
}

const storage: CacheStorage = {
  loadSnapshot: async (): Promise<CacheSnapshot> => {
    const database = await db();
    const channelsRow = await database.getFirstAsync<JsonRow>('SELECT value FROM cache_meta WHERE key = ?', 'channels');
    const syncCursorRow = await database.getFirstAsync<JsonRow>(
      'SELECT value FROM cache_meta WHERE key = ?',
      'syncCursor',
    );
    const rows = await database.getAllAsync<TimelineRow>(
      'SELECT channel_id, events_json, has_more, updated_at FROM channel_timelines',
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
      syncCursor: Math.max(0, Number(syncCursorRow?.value ?? 0) || 0),
      lastSyncedAt: rows.length > 0 ? new Date(Math.max(...rows.map((row) => row.updated_at))).toISOString() : null,
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

  saveSyncCursor: async (cursor) => {
    const database = await db();
    await database.runAsync(
      'INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)',
      'syncCursor',
      String(Math.max(0, Math.floor(cursor))),
    );
  },

  listOps: async (): Promise<QueuedOp[]> => {
    const database = await db();
    const rows = await database.getAllAsync<OpRow>(
      `SELECT rowid AS row_id, op_id, op_type, queue_key, payload_json, status, retry_count, created_at, inserted_at
        FROM client_ops
        ORDER BY inserted_at ASC, rowid ASC`,
    );
    const ops: QueuedOp[] = [];
    for (const row of rows) {
      try {
        ops.push(
          parseQueuedOp({
            opId: row.op_id,
            opType: row.op_type,
            queueKey: row.queue_key,
            payload: JSON.parse(row.payload_json) as unknown,
            status: row.status,
            retryCount: row.retry_count,
            createdAt: row.created_at,
          }),
        );
      } catch (err) {
        console.warn('dropping invalid SQLite queued op', err);
        await database.runAsync('DELETE FROM client_ops WHERE rowid = ?', row.row_id);
      }
    }
    return ops;
  },

  putOp: async (op) => {
    const database = await db();
    await database.runAsync(
      `INSERT INTO client_ops
        (op_id, op_type, queue_key, payload_json, status, retry_count, created_at, inserted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(op_id) DO UPDATE SET
          op_type = excluded.op_type,
          queue_key = excluded.queue_key,
          payload_json = excluded.payload_json,
          status = excluded.status,
          retry_count = excluded.retry_count,
          created_at = excluded.created_at`,
      op.opId,
      op.opType,
      op.queueKey,
      JSON.stringify(op.payload),
      op.status,
      op.retryCount,
      op.createdAt,
      Date.now(),
    );
  },

  removeOp: async (opId) => {
    const database = await db();
    await database.runAsync('DELETE FROM client_ops WHERE op_id = ?', opId);
  },

  getDraft: async (key) => {
    const database = await db();
    const row = await database.getFirstAsync<JsonRow>(
      'SELECT text AS value FROM composer_drafts WHERE draft_key = ?',
      key,
    );
    return row?.value ?? null;
  },

  getDraftEntry: async (key): Promise<DraftSnapshotEntry | null> => {
    const database = await db();
    const row = await database.getFirstAsync<DraftRow>(
      'SELECT draft_key, text, updated_at FROM composer_drafts WHERE draft_key = ?',
      key,
    );
    return row ? { text: row.text, updatedAt: new Date(row.updated_at).toISOString() } : null;
  },

  listDrafts: async (): Promise<DraftSnapshot> => {
    const database = await db();
    const rows = await database.getAllAsync<DraftRow>('SELECT draft_key, text, updated_at FROM composer_drafts');
    return Object.fromEntries(
      rows.map((row) => [row.draft_key, { text: row.text, updatedAt: new Date(row.updated_at).toISOString() }]),
    );
  },

  setDraft: async (key, text, updatedAt) => {
    const database = await db();
    if (text.length === 0) {
      await database.runAsync('DELETE FROM composer_drafts WHERE draft_key = ?', key);
      return;
    }
    const parsed = updatedAt ? Date.parse(updatedAt) : Date.now();
    await database.runAsync(
      `INSERT OR REPLACE INTO composer_drafts (draft_key, text, updated_at)
        VALUES (?, ?, ?)`,
      key,
      text,
      Number.isFinite(parsed) ? parsed : Date.now(),
    );
  },

  clearCache: async () => {
    const database = await db();
    await database.execAsync(`
      DELETE FROM cache_meta;
      DELETE FROM channel_timelines;
      DELETE FROM client_ops;
      DELETE FROM composer_drafts;
    `);
  },
};

export const eventCache = createEventCache(storage);

export const loadSnapshot = eventCache.loadSnapshot;
export const saveChannels = eventCache.saveChannels;
export const saveTimeline = eventCache.saveTimeline;
export const saveSyncCursor = eventCache.saveSyncCursor;
export const clearCache = eventCache.clearCache;
