import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';
import { workspaceMemberExists } from './membership.js';
import { projectSessionIncremental, rebuildSessionRecords } from './session-records.js';

export interface SessionRecordChangeCursor {
  xid: string;
  id: string;
}

export interface SessionRecordChangeFeedRow {
  sessionId: string;
  cursor: SessionRecordChangeCursor;
}

export interface SessionRecordChangeFeedPage {
  rows: SessionRecordChangeFeedRow[];
  nextCursor: SessionRecordChangeCursor;
}

export const SESSION_RECORD_CHANGE_CURSOR_ZERO: SessionRecordChangeCursor = {
  xid: '0',
  id: '0',
};

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

type Queryable = Pick<DbClient, 'query'>;

interface SessionRecordChangeRow {
  id: string;
  xid: string;
  session_id: string;
}

export async function emitSessionRecordChange(
  clientOrPool: Db | DbClient,
  sessionId: string,
  recordCount: number,
): Promise<void> {
  const count = normalizeRecordCount(recordCount);
  const run = async (client: Queryable): Promise<void> => {
    await client.query(
      `SELECT pg_advisory_xact_lock_shared(
                hashtextextended('session_record_changes', 0))`,
    );
    const res = await client.query(
      `INSERT INTO session_record_changes (session_id, workspace_id, record_count)
       SELECT s.id, s.workspace_id, $2::int
         FROM sessions s
        WHERE s.id = $1
       RETURNING id`,
      [sessionId, count],
    );
    if (res.rowCount === 0) throw new Error('session not found');
  };

  if (isPool(clientOrPool)) {
    await withTx(clientOrPool, run);
    return;
  }
  await run(clientOrPool);
}

export async function projectAndEmitChange(pool: Db, sessionId: string): Promise<number> {
  const count = await rebuildSessionRecords(pool, sessionId);
  await emitSessionRecordChange(pool, sessionId, count);
  return count;
}

export async function projectIncrementalAndEmit(pool: Db, sessionId: string): Promise<number> {
  const result = await projectSessionIncremental(pool, sessionId);
  if (result.projected > 0) {
    await emitSessionRecordChange(pool, sessionId, result.projected);
  }
  return result.projected;
}

export async function sessionRecordChangesSince(
  pool: Db,
  args: {
    userId: string;
    cursor?: SessionRecordChangeCursor;
    limit?: number;
  },
): Promise<SessionRecordChangeFeedPage> {
  const cursor = args.cursor ?? SESSION_RECORD_CHANGE_CURSOR_ZERO;
  const limit = clampLimit(args.limit ?? DEFAULT_LIMIT);

  return withTx(pool, async (client) => {
    const lock = await client.query<{ got: boolean }>(
      `SELECT pg_try_advisory_xact_lock(
                hashtextextended('session_record_changes', 0)) AS got`,
    );
    if (!lock.rows[0]?.got) {
      return { rows: [], nextCursor: cursor };
    }

    const res = await client.query<SessionRecordChangeRow>(
      `SELECT src.id::text AS id,
              src.xid::text AS xid,
              src.session_id
         FROM session_record_changes src
         JOIN sessions s ON s.id = src.session_id
         JOIN channels c ON c.id = s.channel_id
        WHERE (src.xid, src.id) > ($1::xid8, $2::bigint)
          AND ((c.kind = 'public' AND ${workspaceMemberExists('c.workspace_id', '$3')})
               OR s.spawned_by = $3
               OR EXISTS (SELECT 1 FROM channel_members cm
                          WHERE cm.channel_id = c.id AND cm.user_id = $3))
        ORDER BY src.xid, src.id
        LIMIT $4`,
      [cursor.xid, cursor.id, args.userId, limit],
    );

    const rows = res.rows.map((row) => ({
      sessionId: row.session_id,
      cursor: { xid: row.xid, id: row.id },
    }));
    const last = res.rows[res.rows.length - 1];
    return {
      rows,
      nextCursor: last ? { xid: last.xid, id: last.id } : cursor,
    };
  });
}

function isPool(clientOrPool: Db | DbClient): clientOrPool is Db {
  return typeof (clientOrPool as Db).connect === 'function';
}

function normalizeRecordCount(recordCount: number): number {
  if (!Number.isFinite(recordCount)) throw new Error('recordCount must be finite');
  return Math.max(0, Math.trunc(recordCount));
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}
