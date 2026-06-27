import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { normalizePrefs } from '@atrium/surface-client/prefs';
import type { Db, DbClient } from '../db.js';
import { listChannelsFor, listVisibleSyncEvents, type UserRef } from '../events.js';
import { workspaceMemberExists } from '../membership.js';

export interface SyncRouteDeps {
  pool: Db;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
}

async function syncStateSnapshot(client: DbClient, userId: string) {
  const readRows = await client.query<{ channel_id: string; last_read_event_id: number }>(
    `SELECT rc.channel_id, rc.last_read_event_id
     FROM channel_read_cursors rc
     JOIN channels c ON c.id = rc.channel_id
     LEFT JOIN channel_members cm
       ON cm.channel_id = c.id AND cm.user_id = $1
     WHERE rc.user_id = $1
       AND ((c.kind = 'public' AND ${workspaceMemberExists('c.workspace_id', '$1')})
            OR cm.user_id IS NOT NULL)
     ORDER BY rc.channel_id ASC`,
    [userId],
  );
  const muteRows = await client.query<{ channel_id: string }>(
    `SELECT m.channel_id
     FROM channel_mutes m
     JOIN channels c ON c.id = m.channel_id
     LEFT JOIN channel_members cm
       ON cm.channel_id = c.id AND cm.user_id = $1
     WHERE m.user_id = $1
       AND ((c.kind = 'public' AND ${workspaceMemberExists('c.workspace_id', '$1')})
            OR cm.user_id IS NOT NULL)
     ORDER BY m.channel_id ASC`,
    [userId],
  );
  const prefs = await client.query<{ prefs: unknown }>('SELECT prefs FROM users WHERE id = $1', [userId]);
  const draftRows = await client.query<{
    draft_key: string;
    text: string;
    updated_at: Date;
    deleted_at: Date | null;
  }>(
    `SELECT draft_key, text, updated_at, deleted_at
     FROM user_drafts
     WHERE user_id = $1
     ORDER BY draft_key ASC`,
    [userId],
  );
  const readCursors: Record<string, number> = {};
  for (const row of readRows.rows) readCursors[row.channel_id] = Number(row.last_read_event_id);
  const drafts: Record<string, { text: string; updatedAt: string }> = {};
  const draftDeletions: Record<string, string> = {};
  for (const row of draftRows.rows) {
    if (row.deleted_at) {
      draftDeletions[row.draft_key] = row.deleted_at.toISOString();
      continue;
    }
    drafts[row.draft_key] = { text: row.text, updatedAt: row.updated_at.toISOString() };
  }
  return {
    readCursors,
    mutes: muteRows.rows.map((row) => row.channel_id),
    prefs: normalizePrefs(prefs.rows[0]?.prefs),
    drafts,
    draftDeletions,
    channels: await listChannelsFor(client, userId),
  };
}

export function registerSyncRoutes(app: FastifyInstance, deps: SyncRouteDeps): void {
  const { pool, requireUser } = deps;

  app.get('/api/sync', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { after?: string; limit?: string };
    const after = q.after == null ? 0 : Number(q.after);
    const rawLimit = q.limit == null ? 500 : Number(q.limit);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(rawLimit) || rawLimit <= 0) {
      return reply.code(400).send({ error: 'bad_query', message: 'after must be non-negative and limit positive' });
    }
    const limit = Math.min(rawLimit, 1000);
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      // Events and state are read from one snapshot so nextCursor covers
      // exactly the event set represented in this sync response.
      const page = await listVisibleSyncEvents(client, { userId: user.id, after, limit });
      const state = await syncStateSnapshot(client, user.id);
      await client.query('COMMIT');
      return { ...page, state };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}
