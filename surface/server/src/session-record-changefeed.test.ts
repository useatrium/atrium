import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createChannel } from './events.js';
import {
  SESSION_RECORD_CHANGE_CURSOR_ZERO,
  emitSessionRecordChange,
  sessionRecordChangesSince,
} from './session-record-changefeed.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from '../test/helpers.js';

let pool: pg.Pool;
let fx: Fixture;

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  fx = await seedFixture(pool);
});

async function insertSession(
  args: { channelId?: string; workspaceId?: string; spawnedBy?: string; title?: string } = {},
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sessions
       (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by)
     VALUES ($1, $2, $3, 'codex', $4, 'completed', $5)
     RETURNING id`,
    [
      args.workspaceId ?? fx.workspaceId,
      args.channelId ?? fx.channelId,
      `test:${randomUUID()}`,
      args.title ?? 'Record feed session',
      args.spawnedBy ?? fx.userId,
    ],
  );
  return res.rows[0]!.id;
}

async function insertUser(handle: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    'INSERT INTO users (handle, display_name) VALUES ($1, $2) RETURNING id',
    [handle, handle],
  );
  return res.rows[0]!.id;
}

describe('sessionRecordChangesSince', () => {
  it('returns changes in cursor order and resumes without duplicates or gaps', async () => {
    const firstSession = await insertSession({ title: 'First session' });
    const secondSession = await insertSession({ title: 'Second session' });

    await emitSessionRecordChange(pool, firstSession, 2);
    await emitSessionRecordChange(pool, secondSession, 3);
    await emitSessionRecordChange(pool, firstSession, 4);

    const firstPage = await sessionRecordChangesSince(pool, {
      userId: fx.userId,
      cursor: SESSION_RECORD_CHANGE_CURSOR_ZERO,
      limit: 2,
    });
    expect(firstPage.rows.map((row) => row.sessionId)).toEqual([firstSession, secondSession]);
    expect(firstPage.nextCursor).toEqual(firstPage.rows[1]!.cursor);
    expect(firstPage.nextCursor).not.toEqual(SESSION_RECORD_CHANGE_CURSOR_ZERO);

    const secondPage = await sessionRecordChangesSince(pool, {
      userId: fx.userId,
      cursor: firstPage.nextCursor,
      limit: 2,
    });
    expect(secondPage.rows.map((row) => row.sessionId)).toEqual([firstSession]);
    expect(secondPage.nextCursor).toEqual(secondPage.rows[0]!.cursor);

    const emptyPage = await sessionRecordChangesSince(pool, {
      userId: fx.userId,
      cursor: secondPage.nextCursor,
      limit: 2,
    });
    expect(emptyPage.rows).toEqual([]);
    expect(emptyPage.nextCursor).toEqual(secondPage.nextCursor);
  });

  it('filters the global feed to sessions visible to the user', async () => {
    const { channel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: 'private-records',
      actorId: fx.userId,
      private: true,
    });
    const privateSession = await insertSession({
      channelId: channel.id,
      workspaceId: fx.workspaceId,
      spawnedBy: fx.userId,
      title: 'Private feed session',
    });
    const bobId = await insertUser('bob');

    await emitSessionRecordChange(pool, privateSession, 1);

    await expect(
      sessionRecordChangesSince(pool, {
        userId: fx.userId,
        cursor: SESSION_RECORD_CHANGE_CURSOR_ZERO,
      }),
    ).resolves.toMatchObject({
      rows: [{ sessionId: privateSession }],
    });

    await expect(
      sessionRecordChangesSince(pool, {
        userId: bobId,
        cursor: SESSION_RECORD_CHANGE_CURSOR_ZERO,
      }),
    ).resolves.toMatchObject({
      rows: [],
    });
  });
});
