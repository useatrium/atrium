import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { pruneOrphanFiles, type FileStorageGc } from '../src/gc.js';
import { deleteMessage, postMessage } from '../src/events.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let deleteCalls: string[];

const logger = {
  log: () => {},
  warn: () => {},
};

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  deleteCalls = [];
  await truncateAll(pool);
  fx = await seedFixture(pool);
  delete process.env.ATRIUM_FILE_GC_DAYS;
});

function storage(onDelete: (key: string) => Promise<void> | void = () => {}): FileStorageGc {
  return {
    deleteObject: async (key: string) => {
      deleteCalls.push(key);
      await onDelete(key);
    },
  };
}

async function insertFile(ageDays: number): Promise<{ id: string; s3Key: string }> {
  const id = randomUUID();
  const s3Key = `${id}/doc.txt`;
  await pool.query(
    `INSERT INTO files (
       id, workspace_id, uploader_id, filename, content_type, size_bytes, s3_key, created_at
     )
     VALUES ($1, $2, $3, 'doc.txt', 'text/plain', 12, $4, now() - ($5::int * interval '1 day'))`,
    [id, fx.workspaceId, fx.userId, s3Key, ageDays],
  );
  return { id, s3Key };
}

async function fileExists(id: string): Promise<boolean> {
  const res = await pool.query('SELECT 1 FROM files WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}

describe('pruneOrphanFiles', () => {
  it('deletes an old orphan object and row, then no-ops on a second run', async () => {
    const file = await insertFile(8);
    const fileStorage = storage();

    const first = await pruneOrphanFiles(pool, fileStorage, { days: 7, logger });

    expect(first).toEqual({ scanned: 1, deleted: 1, skippedOnError: 0 });
    expect(deleteCalls).toEqual([file.s3Key]);
    expect(await fileExists(file.id)).toBe(false);

    const second = await pruneOrphanFiles(pool, fileStorage, { days: 7, logger });
    expect(second).toEqual({ scanned: 0, deleted: 0, skippedOnError: 0 });
    expect(deleteCalls).toEqual([file.s3Key]);
  });

  it('leaves a young orphan untouched', async () => {
    const file = await insertFile(2);

    const result = await pruneOrphanFiles(pool, storage(), { days: 7, logger });

    expect(result).toEqual({ scanned: 0, deleted: 0, skippedOnError: 0 });
    expect(deleteCalls).toEqual([]);
    expect(await fileExists(file.id)).toBe(true);
  });

  it('leaves an old file referenced by a message.posted event, even after delete tombstone', async () => {
    const file = await insertFile(8);
    const posted = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'attached',
      attachments: [
        {
          id: file.id,
          filename: 'doc.txt',
          contentType: 'text/plain',
          size: 12,
        },
      ],
    });
    await deleteMessage(pool, { targetEventId: posted.id, actorId: fx.userId });

    const result = await pruneOrphanFiles(pool, storage(), { days: 7, logger });

    expect(result).toEqual({ scanned: 0, deleted: 0, skippedOnError: 0 });
    expect(deleteCalls).toEqual([]);
    expect(await fileExists(file.id)).toBe(true);
  });

  it('keeps the row when object delete fails with a non-404 error', async () => {
    const file = await insertFile(8);
    const err = new Error('s3 unavailable');

    const result = await pruneOrphanFiles(
      pool,
      storage(() => {
        throw err;
      }),
      {
        days: 7,
        logger,
      },
    );

    expect(result).toEqual({ scanned: 1, deleted: 0, skippedOnError: 1 });
    expect(deleteCalls).toEqual([file.s3Key]);
    expect(await fileExists(file.id)).toBe(true);
  });

  it('deletes the row when object delete reports NoSuchKey', async () => {
    const file = await insertFile(8);
    const err = Object.assign(new Error('missing'), { name: 'NoSuchKey' });

    const result = await pruneOrphanFiles(
      pool,
      storage(() => {
        throw err;
      }),
      {
        days: 7,
        logger,
      },
    );

    expect(result).toEqual({ scanned: 1, deleted: 1, skippedOnError: 0 });
    expect(deleteCalls).toEqual([file.s3Key]);
    expect(await fileExists(file.id)).toBe(false);
  });

  it('honors ATRIUM_FILE_GC_DAYS=0 as disabled', async () => {
    process.env.ATRIUM_FILE_GC_DAYS = '0';
    const file = await insertFile(8);

    const result = await pruneOrphanFiles(pool, storage(), { logger });

    expect(result).toEqual({ scanned: 0, deleted: 0, skippedOnError: 0 });
    expect(deleteCalls).toEqual([]);
    expect(await fileExists(file.id)).toBe(true);
  });
});
