import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedOp } from '@atrium/surface-client';

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

class FakeDb {
  nextRowId = 1;
  sendOutbox: OutboxRow[] | null = [
    {
      client_msg_id: 'client-a',
      channel_id: 'ch-1',
      text: 'queued one',
      thread_root_event_id: null,
      attachments_json: '[]',
      created_at: '2026-06-11T12:00:00.000Z',
      inserted_at: 10,
    },
    {
      client_msg_id: 'client-b',
      channel_id: 'ch-1',
      text: 'queued two',
      thread_root_event_id: 5,
      attachments_json: '[{"id":"file-1","filename":"a.txt","contentType":"text/plain","size":12}]',
      created_at: '2026-06-11T12:00:01.000Z',
      inserted_at: 11,
    },
  ];
  clientOps: OpRow[] = [];

  async execAsync(sql: string): Promise<void> {
    if (sql.includes('DROP TABLE send_outbox')) this.sendOutbox = null;
    if (sql.includes('DELETE FROM client_ops')) this.clientOps = [];
  }

  async getFirstAsync<T>(sql: string): Promise<T | null> {
    if (sql.includes("name = 'send_outbox'")) {
      return (this.sendOutbox ? { name: 'send_outbox' } : null) as T | null;
    }
    return null;
  }

  async getAllAsync<T>(sql: string): Promise<T[]> {
    if (sql.includes('FROM send_outbox')) return [...(this.sendOutbox ?? [])] as T[];
    if (sql.includes('FROM client_ops')) return [...this.clientOps].sort((a, b) => a.inserted_at - b.inserted_at) as T[];
    return [];
  }

  async runAsync(sql: string, ...args: unknown[]): Promise<void> {
    if (sql.includes('INSERT OR IGNORE INTO client_ops')) {
      const row: OpRow = {
        row_id: this.nextRowId++,
        op_id: String(args[0]),
        op_type: args[1] as QueuedOp['opType'],
        queue_key: String(args[2]),
        payload_json: String(args[3]),
        status: args[4] as QueuedOp['status'],
        retry_count: Number(args[5]),
        created_at: String(args[6]),
        inserted_at: Number(args[7]),
      };
      if (!this.clientOps.some((op) => op.op_id === row.op_id)) this.clientOps.push(row);
      return;
    }
    if (sql.includes('INSERT INTO client_ops')) {
      const row: OpRow = {
        row_id: this.nextRowId++,
        op_id: String(args[0]),
        op_type: args[1] as QueuedOp['opType'],
        queue_key: String(args[2]),
        payload_json: String(args[3]),
        status: args[4] as QueuedOp['status'],
        retry_count: Number(args[5]),
        created_at: String(args[6]),
        inserted_at: Number(args[7]),
      };
      this.clientOps = this.clientOps.filter((op) => op.op_id !== row.op_id);
      this.clientOps.push(row);
      return;
    }
    if (sql.includes('DELETE FROM client_ops WHERE rowid = ?')) {
      this.clientOps = this.clientOps.filter((op) => op.row_id !== args[0]);
      return;
    }
    if (sql.includes('DELETE FROM client_ops WHERE op_id = ?')) {
      this.clientOps = this.clientOps.filter((op) => op.op_id !== args[0]);
    }
  }
}

describe('SQLite client op migration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it(
    'migrates legacy send_outbox rows into msg.send client_ops and drops the old table',
    async () => {
      const fakeDb = new FakeDb();
      vi.doMock('expo-sqlite', () => ({
        openDatabaseAsync: vi.fn(async () => fakeDb),
      }));

      const { eventCache } = await import('../src/lib/cacheSqlite');
      const ops = await eventCache.listOps();

      expect(fakeDb.sendOutbox).toBeNull();
      expect(ops.map((op) => op.opType)).toEqual(['msg.send', 'msg.send']);
      expect(ops.map((op) => op.queueKey)).toEqual(['msg:ch-1', 'msg:ch-1']);
      expect(ops[0]!.opId).not.toBe('client-a');
      expect(ops[0]!.payload).toMatchObject({
        clientMsgId: 'client-a',
        channelId: 'ch-1',
        text: 'queued one',
      });
      expect(ops[1]!.payload).toMatchObject({
        clientMsgId: 'client-b',
        threadRootEventId: 5,
        attachments: [{ id: 'file-1', filename: 'a.txt' }],
      });
    },
    15_000,
  );

  it('drops corrupted client_ops rows instead of returning them to the queue', async () => {
    const fakeDb = new FakeDb();
    fakeDb.sendOutbox = null;
    fakeDb.clientOps = [
      {
        row_id: fakeDb.nextRowId++,
        op_id: 'bad-op',
        op_type: 'legacy.bad' as QueuedOp['opType'],
        queue_key: 'msg:ch-1',
        payload_json: '{"channelId":"ch-1"}',
        status: 'pending',
        retry_count: 0,
        created_at: '2026-06-11T12:00:00.000Z',
        inserted_at: 1,
      },
      {
        row_id: fakeDb.nextRowId++,
        op_id: 'good-op',
        op_type: 'read.mark',
        queue_key: 'read:ch-1',
        payload_json: '{"channelId":"ch-1","lastReadEventId":7}',
        status: 'pending',
        retry_count: 0,
        created_at: '2026-06-11T12:00:01.000Z',
        inserted_at: 2,
      },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.doMock('expo-sqlite', () => ({
      openDatabaseAsync: vi.fn(async () => fakeDb),
    }));

    const { eventCache } = await import('../src/lib/cacheSqlite');
    const ops = await eventCache.listOps();

    expect(ops.map((op) => op.opId)).toEqual(['good-op']);
    expect(fakeDb.clientOps.map((op) => op.op_id)).toEqual(['good-op']);
    expect(warn).toHaveBeenCalledWith(
      'dropping invalid SQLite queued op',
      expect.any(Error),
    );
  });
});
