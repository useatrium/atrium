import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { firstHeader } from '../artifact-route-utils.js';
import type { Db } from '../db.js';
import type { UserRef } from '../events.js';
import { workspaceMemberExists } from '../membership.js';
import { parsePendingQuestion, parseProviderAuthRequired } from '../session-runs.js';

type ActivityKind =
  | 'mention'
  | 'dm'
  | 'thread_reply'
  | 'agent_question'
  | 'session_completed'
  | 'session_failed'
  | 'agent_auth'
  | 'reaction'
  | 'channel_invite'
  | 'seat_request'
  | 'missed_call'
  | 'call_declined';

interface ActivityRow {
  event_id: number;
  kind: ActivityKind;
  channel_id: string;
  channel_name: string;
  actor_id: string | null;
  actor_name: string | null;
  snippet: string;
  created_at: Date | string;
  session_id: string | null;
  session_title: string | null;
  session_status: string | null;
  attention: boolean;
  muted: boolean;
  unread: boolean;
}

interface ActivityQueryRow {
  last_read_event_id: number | string;
  unread_count: number | string;
  attention_count: number | string;
  unread_exception_ids: Array<number | string> | null;
  items: ActivityRow[] | null;
}

interface ActiveSessionRow {
  channel_id: string;
  pending_question: unknown | null;
  provider_auth_required: unknown | null;
  pending_seat_request: boolean;
}

interface ReviewSessionRow {
  channel_id: string;
}

type ChannelActivityCounts = { needsYou: number; running: number; toReview: number };

type ActivityCountsResponse = {
  attention: number;
  unread: number;
  needsYou: number;
  running: number;
  toReview: number;
  channelCounts: Record<string, ChannelActivityCounts>;
};

interface ActivityReadStateRow {
  last_read_event_id: number | string;
  unread_exception_ids: Array<number | string> | null;
}

export interface ActivityRouteDeps {
  pool: Db;
  requireUser(req: FastifyRequest, reply: FastifyReply): UserRef | null;
}

function parseCursor(value: unknown): number | null | undefined {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor > 0 ? cursor : undefined;
}

function parseReadEventId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function canSeeChannelSql(): string {
  return `(
    (c.kind = 'public' AND ${workspaceMemberExists('c.workspace_id', '$1')})
    OR EXISTS (
      SELECT 1 FROM channel_members viewer_member
      WHERE viewer_member.channel_id = c.id AND viewer_member.user_id = $1
    )
  )`;
}

function toActivityItem(row: ActivityRow) {
  return {
    eventId: String(row.event_id),
    kind: row.kind,
    channelId: row.channel_id,
    channelName: row.channel_name,
    actorId: row.actor_id,
    actorName: row.actor_name,
    snippet: row.snippet,
    createdAt: new Date(row.created_at).toISOString(),
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    sessionStatus: row.session_status,
    attention: row.attention,
    muted: row.muted,
    unread: row.unread,
  };
}

function exceptionIdsFrom(row: { unread_exception_ids: Array<number | string> | null }): string[] {
  return Array.isArray(row.unread_exception_ids) ? row.unread_exception_ids.map(String) : [];
}

async function readStateFor(
  pool: Db,
  userId: string,
): Promise<{ lastReadEventId: string; unreadExceptionIds: string[] }> {
  const res = await pool.query<ActivityReadStateRow>(
    `SELECT COALESCE((
       SELECT last_read_event_id FROM activity_read_cursors WHERE user_id = $1
     ), 0)::bigint AS last_read_event_id,
     COALESCE((
       SELECT json_agg(event_id ORDER BY event_id)
       FROM activity_unread_exceptions
       WHERE user_id = $1
     ), '[]'::json) AS unread_exception_ids`,
    [userId],
  );
  const row = res.rows[0]!;
  return {
    lastReadEventId: String(row.last_read_event_id),
    unreadExceptionIds: exceptionIdsFrom(row),
  };
}

/** Advance the watermark (forward-only) and clamp to a real event id. */
async function advanceWatermark(pool: Db, userId: string, requestedCursor: number): Promise<string> {
  const res = await pool.query<{ last_read_event_id: number | string }>(
    `WITH clamped AS (
       SELECT COALESCE(MAX(id), 0)::bigint AS last_read_event_id
       FROM events
       WHERE id <= $2::bigint
     )
     INSERT INTO activity_read_cursors (user_id, last_read_event_id, updated_at)
     SELECT $1, last_read_event_id, now()
     FROM clamped
     ON CONFLICT (user_id) DO UPDATE
       -- A late click from another tab must not make already-read activity
       -- unread again.
       SET last_read_event_id = GREATEST(activity_read_cursors.last_read_event_id, EXCLUDED.last_read_event_id),
           updated_at = now()
     RETURNING last_read_event_id`,
    [userId, requestedCursor],
  );
  return String(res.rows[0]!.last_read_event_id);
}

async function markActivityItemsRead(
  pool: Db,
  userId: string,
  eventIds: readonly number[],
  preserveUnreadEventIds: readonly number[] = [],
): Promise<void> {
  for (const eventId of eventIds) {
    await advanceWatermark(pool, userId, eventId);
    await pool.query(`DELETE FROM activity_unread_exceptions WHERE user_id = $1 AND event_id = $2`, [userId, eventId]);
  }
  if (eventIds.length > 0 && preserveUnreadEventIds.length > 0) {
    await pool.query(
      `INSERT INTO activity_unread_exceptions (user_id, event_id)
       SELECT $1, event_id
         FROM UNNEST($2::bigint[]) AS preserved(event_id)
       ON CONFLICT DO NOTHING`,
      [userId, preserveUnreadEventIds],
    );
  }
}

const MENTION_TOKEN_RE = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;

/** Snippets are raw message text, so id-mentions arrive as `<@uuid>` tokens.
 * Resolve them to `@Display Name` here — every client renders snippets as
 * plain text, and a token soup in the inbox row helps no one. Unknown ids
 * (deleted users) keep the token rather than inventing a name. */
async function resolveMentionTokensInSnippets(pool: Db, items: Array<{ snippet: string }>): Promise<void> {
  const ids = new Set<string>();
  for (const item of items) {
    for (const match of item.snippet.matchAll(MENTION_TOKEN_RE)) ids.add(match[1]!.toLowerCase());
  }
  if (ids.size === 0) return;
  const res = await pool.query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`,
    [[...ids]],
  );
  const names = new Map(res.rows.map((row) => [row.id.toLowerCase(), row.display_name]));
  for (const item of items) {
    item.snippet = item.snippet.replace(MENTION_TOKEN_RE, (token, id: string) => {
      const name = names.get(id.toLowerCase());
      return name ? `@${name}` : token;
    });
  }
}

function incrementChannelCount(
  channelCounts: Map<string, ChannelActivityCounts>,
  channelId: string,
  key: keyof ChannelActivityCounts,
): void {
  const counts = channelCounts.get(channelId) ?? { needsYou: 0, running: 0, toReview: 0 };
  counts[key] += 1;
  channelCounts.set(channelId, counts);
}

async function loadAgentWorkCounts(
  pool: Db,
  userId: string,
  visibleChannel: string,
): Promise<Omit<ActivityCountsResponse, 'attention' | 'unread'>> {
  // This aggregate is over current session state, not whichever 50 activity
  // rows happened to be returned by the feed.
  const activeSessions = await pool.query<ActiveSessionRow>(
    `SELECT s.channel_id,
            s.pending_question,
            s.provider_auth_required,
            EXISTS (
              SELECT 1 FROM seat_requests sr WHERE sr.session_id = s.id
            ) AS pending_seat_request
       FROM sessions s
       JOIN channels c ON c.id = s.channel_id
      WHERE s.archived_at IS NULL
        AND s.status IN ('spawning', 'queued', 'running')
        AND ${visibleChannel}`,
    [userId],
  );
  const channelCounts = new Map<string, ChannelActivityCounts>();
  let needsYou = 0;
  let running = 0;
  for (const session of activeSessions.rows) {
    if (
      parsePendingQuestion(session.pending_question) ||
      parseProviderAuthRequired(session.provider_auth_required) ||
      session.pending_seat_request
    ) {
      needsYou += 1;
      incrementChannelCount(channelCounts, session.channel_id, 'needsYou');
    } else {
      running += 1;
      incrementChannelCount(channelCounts, session.channel_id, 'running');
    }
  }

  const reviewSessions = await pool.query<ReviewSessionRow>(
    `WITH read_cursor AS (
       SELECT COALESCE((
         SELECT last_read_event_id FROM activity_read_cursors WHERE user_id = $1
       ), 0)::bigint AS last_read_event_id
     ), terminal_items AS (
       SELECT e.id AS event_id, s.id AS session_id, s.channel_id
         FROM events e
         JOIN sessions s ON s.id::text = e.payload->>'sessionId'
         JOIN channels c ON c.id = s.channel_id
        WHERE e.type = 'session.completed'
          AND s.spawned_by = $1
          AND s.archived_at IS NULL
          AND ${visibleChannel}

       UNION ALL

       SELECT e.id AS event_id, s.id AS session_id, s.channel_id
         FROM events e
         JOIN sessions s ON s.id::text = e.payload->>'sessionId'
         JOIN channels c ON c.id = s.channel_id
        WHERE e.type = 'session.status_changed'
          AND e.payload->>'status' = 'failed'
          AND s.spawned_by = $1
          AND s.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM events completed
             WHERE completed.type = 'session.completed'
               AND completed.payload->>'sessionId' = e.payload->>'sessionId'
               AND completed.id > e.id
          )
          AND ${visibleChannel}
     ), latest_terminal AS (
       SELECT DISTINCT ON (session_id) session_id, channel_id, event_id
         FROM terminal_items
        ORDER BY session_id, event_id DESC
     )
     SELECT lt.channel_id
       FROM latest_terminal lt
       CROSS JOIN read_cursor
      WHERE (
        lt.event_id > read_cursor.last_read_event_id
        OR EXISTS (
          SELECT 1 FROM activity_unread_exceptions ue
           WHERE ue.user_id = $1 AND ue.event_id = lt.event_id
        )
      )
        AND NOT EXISTS (
          SELECT 1 FROM channel_mutes mt
           WHERE mt.user_id = $1 AND mt.channel_id = lt.channel_id
        )`,
    [userId],
  );
  for (const session of reviewSessions.rows) incrementChannelCount(channelCounts, session.channel_id, 'toReview');
  return {
    needsYou,
    running,
    toReview: reviewSessions.rows.length,
    channelCounts: Object.fromEntries(channelCounts),
  };
}

function setCountsCacheHeaders(req: FastifyRequest, reply: FastifyReply, body: ActivityCountsResponse): boolean {
  const canonicalBody = {
    ...body,
    channelCounts: Object.entries(body.channelCounts).sort(([left], [right]) => left.localeCompare(right)),
  };
  const digest = createHash('sha256').update(JSON.stringify(canonicalBody)).digest('hex');
  const etag = `"${digest}"`;
  reply.header('ETag', etag);
  reply.header('Cache-Control', 'private, no-cache');
  const ifNoneMatch = firstHeader(req.headers['if-none-match']);
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(',').some((candidate) => {
    const tag = candidate.trim();
    return tag === '*' || tag === etag || tag === `W/${etag}`;
  });
}

export function registerActivityRoutes(app: FastifyInstance, deps: ActivityRouteDeps): void {
  const { pool, requireUser } = deps;

  app.post('/api/activity/read', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = req.body as
      | {
          lastReadEventId?: unknown;
          markReadEventId?: unknown;
          markUnreadEventId?: unknown;
        }
      | undefined;

    const markUnreadEventId = parseReadEventId(body?.markUnreadEventId);
    const markReadEventId = parseReadEventId(body?.markReadEventId);
    const requestedCursor = parseReadEventId(body?.lastReadEventId);

    const modes = [
      requestedCursor !== undefined,
      markReadEventId !== undefined,
      markUnreadEventId !== undefined,
    ].filter(Boolean).length;
    if (modes !== 1) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Provide exactly one of lastReadEventId, markReadEventId, or markUnreadEventId',
      });
    }

    // Mark all / advance through: forward-only watermark + clear every
    // mark-unread exception so the inbox is fully clean.
    if (requestedCursor !== undefined) {
      await advanceWatermark(pool, user.id, requestedCursor);
      await pool.query(`DELETE FROM activity_unread_exceptions WHERE user_id = $1`, [user.id]);
      return readStateFor(pool, user.id);
    }

    // Per-item mark read: advance watermark through this event (older items
    // also become read) and drop any mark-unread exception on it.
    if (markReadEventId !== undefined) {
      await markActivityItemsRead(pool, user.id, [markReadEventId]);
      return readStateFor(pool, user.id);
    }

    // Per-item mark unread: only meaningful for already-read rows (≤ watermark).
    // Above-watermark rows are already unread; store nothing.
    const eventId = markUnreadEventId!;
    if (eventId === 0) {
      return reply.code(400).send({ error: 'bad_request', message: 'markUnreadEventId must be a positive event id' });
    }
    await pool.query(
      `INSERT INTO activity_unread_exceptions (user_id, event_id)
       SELECT $1, $2::bigint
       WHERE $2::bigint > 0
         AND $2::bigint <= COALESCE((
           SELECT last_read_event_id FROM activity_read_cursors WHERE user_id = $1
         ), 0)
         AND EXISTS (SELECT 1 FROM events e WHERE e.id = $2::bigint)
       ON CONFLICT DO NOTHING`,
      [user.id, eventId],
    );
    return readStateFor(pool, user.id);
  });

  app.post('/api/activity/sessions/:sessionId/read', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { sessionId } = req.params as { sessionId: string };
    const visibleChannel = canSeeChannelSql();
    const session = await pool.query<{ id: string }>(
      `SELECT s.id
         FROM sessions s
         JOIN channels c ON c.id = s.channel_id
        WHERE s.id::text = $2
          AND ${visibleChannel}`,
      [user.id, sessionId],
    );
    if (!session.rows[0]) {
      return reply.code(404).send({ error: 'session_not_found', message: 'session not found' });
    }

    // Keep this terminal-event definition in step with the activity feed. A
    // failed status-change becomes an activity item only when no later
    // completed event supersedes it.
    const unread = await pool.query<{ event_id: number | string }>(
      `WITH read_cursor AS (
         SELECT COALESCE((
           SELECT last_read_event_id FROM activity_read_cursors WHERE user_id = $1
         ), 0)::bigint AS last_read_event_id
       ), terminal_items AS (
         SELECT e.id AS event_id, s.channel_id
           FROM events e
           JOIN sessions s ON s.id::text = e.payload->>'sessionId'
          WHERE s.id::text = $2
            AND s.spawned_by = $1
            AND e.type = 'session.completed'

         UNION ALL

         SELECT e.id AS event_id, s.channel_id
           FROM events e
           JOIN sessions s ON s.id::text = e.payload->>'sessionId'
          WHERE s.id::text = $2
            AND s.spawned_by = $1
            AND e.type = 'session.status_changed'
            AND e.payload->>'status' = 'failed'
            AND NOT EXISTS (
              SELECT 1 FROM events completed
               WHERE completed.type = 'session.completed'
                 AND completed.payload->>'sessionId' = e.payload->>'sessionId'
                 AND completed.id > e.id
            )
       )
       SELECT ti.event_id
         FROM terminal_items ti
         CROSS JOIN read_cursor
        WHERE (
          ti.event_id > read_cursor.last_read_event_id
          OR EXISTS (
            SELECT 1 FROM activity_unread_exceptions ue
             WHERE ue.user_id = $1 AND ue.event_id = ti.event_id
          )
        )
          AND NOT EXISTS (
            SELECT 1 FROM channel_mutes mt
             JOIN sessions s ON s.id::text = $2
            WHERE mt.user_id = $1 AND mt.channel_id = s.channel_id
          )
        ORDER BY ti.event_id ASC`,
      [user.id, sessionId],
    );
    // Per-item reads use a global watermark. Preserve other sessions' unread
    // terminal rows as exceptions before that watermark can cover them.
    const preserved = await pool.query<{ event_id: number | string }>(
      `WITH read_cursor AS (
         SELECT COALESCE((
           SELECT last_read_event_id FROM activity_read_cursors WHERE user_id = $1
         ), 0)::bigint AS last_read_event_id
       ), terminal_items AS (
         SELECT e.id AS event_id, s.channel_id
           FROM events e
           JOIN sessions s ON s.id::text = e.payload->>'sessionId'
           JOIN channels c ON c.id = s.channel_id
          WHERE s.id::text <> $2
            AND s.spawned_by = $1
            AND e.type = 'session.completed'
            AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id, s.channel_id
           FROM events e
           JOIN sessions s ON s.id::text = e.payload->>'sessionId'
           JOIN channels c ON c.id = s.channel_id
          WHERE s.id::text <> $2
            AND s.spawned_by = $1
            AND e.type = 'session.status_changed'
            AND e.payload->>'status' = 'failed'
            AND NOT EXISTS (
              SELECT 1 FROM events completed
               WHERE completed.type = 'session.completed'
                 AND completed.payload->>'sessionId' = e.payload->>'sessionId'
                 AND completed.id > e.id
            )
            AND ${visibleChannel}
       )
       SELECT ti.event_id
         FROM terminal_items ti
         CROSS JOIN read_cursor
        WHERE (
          ti.event_id > read_cursor.last_read_event_id
          OR EXISTS (
            SELECT 1 FROM activity_unread_exceptions ue
             WHERE ue.user_id = $1 AND ue.event_id = ti.event_id
          )
        )
          AND NOT EXISTS (
            SELECT 1 FROM channel_mutes mt
             WHERE mt.user_id = $1 AND mt.channel_id = ti.channel_id
          )`,
      [user.id, sessionId],
    );
    await markActivityItemsRead(
      pool,
      user.id,
      unread.rows.map((row) => Number(row.event_id)),
      preserved.rows.map((row) => Number(row.event_id)),
    );
    return reply.code(204).send();
  });

  // Both endpoints execute this one definition. The counts-only form gates the
  // page CTE off at the SQL level, so it never builds the 50 feed rows.
  const queryActivity = async (userId: string, cursor: number | null, countsOnly: boolean) => {
    const visibleChannel = canSeeChannelSql();
    const res = await pool.query<ActivityQueryRow>(
      `WITH read_cursor AS (
         SELECT COALESCE((
           SELECT last_read_event_id
           FROM activity_read_cursors
           WHERE user_id = $1
         ), 0)::bigint AS last_read_event_id
       ),
       activity AS (
         SELECT e.id AS event_id,
                'mention'::text AS kind,
                e.channel_id,
                e.actor_id,
                coalesce(nullif(e.payload->>'text', ''), '(attachment)') AS snippet,
                e.created_at,
                NULL::uuid AS session_id,
                NULL::text AS session_title,
                NULL::text AS session_status,
                false AS attention
         FROM mentions mn
         JOIN events e ON e.id = mn.event_id
         JOIN channels c ON c.id = e.channel_id
         WHERE mn.user_id = $1
           AND e.channel_id IS NOT NULL
           AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id,
                'dm'::text AS kind,
                e.channel_id,
                e.actor_id,
                coalesce(nullif(e.payload->>'text', ''), '(attachment)') AS snippet,
                e.created_at,
                NULL::uuid AS session_id,
                NULL::text AS session_title,
                NULL::text AS session_status,
                false AS attention
         FROM events e
         JOIN channels c ON c.id = e.channel_id
         WHERE e.type = 'message.posted'
           AND c.kind IN ('dm', 'gdm')
           AND e.actor_id IS NOT NULL
           AND e.actor_id <> $1
           AND e.thread_root_event_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM mentions mn
             WHERE mn.event_id = e.id AND mn.user_id = $1
           )
           AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id,
                'missed_call'::text AS kind,
                e.channel_id,
                e.actor_id,
                'You missed a call.' AS snippet,
                e.created_at,
                NULL::uuid AS session_id,
                NULL::text AS session_title,
                NULL::text AS session_status,
                false AS attention
         FROM events e
         JOIN channels c ON c.id = e.channel_id
         WHERE e.type = 'call.ended'
           AND c.kind IN ('dm', 'gdm')
           AND e.actor_id IS NOT NULL
           AND e.payload->>'initiatorId' <> $1::text
           AND NOT EXISTS (
             SELECT 1
             FROM call_participants cp
             WHERE cp.call_id::text = e.payload->>'callId'
               AND cp.user_id = $1
           )
           AND NOT EXISTS (
             SELECT 1
             FROM call_declines cd
             WHERE cd.call_id::text = e.payload->>'callId'
               AND cd.user_id = $1
           )
           AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id,
                'call_declined'::text AS kind,
                e.channel_id,
                e.actor_id,
                'You declined this call.' AS snippet,
                e.created_at,
                NULL::uuid AS session_id,
                NULL::text AS session_title,
                NULL::text AS session_status,
                false AS attention
         FROM events e
         JOIN channels c ON c.id = e.channel_id
         WHERE e.type = 'call.ended'
           AND c.kind IN ('dm', 'gdm')
           AND e.actor_id IS NOT NULL
           AND e.payload->>'initiatorId' <> $1::text
           AND NOT EXISTS (
             SELECT 1
             FROM call_participants cp
             WHERE cp.call_id::text = e.payload->>'callId'
               AND cp.user_id = $1
           )
           AND EXISTS (
             SELECT 1
             FROM call_declines cd
             WHERE cd.call_id::text = e.payload->>'callId'
               AND cd.user_id = $1
           )
           AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id,
                'thread_reply'::text AS kind,
                e.channel_id,
                e.actor_id,
                coalesce(nullif(e.payload->>'text', ''), '(attachment)') AS snippet,
                e.created_at,
                NULL::uuid AS session_id,
                NULL::text AS session_title,
                NULL::text AS session_status,
                false AS attention
         FROM events e
         JOIN channels c ON c.id = e.channel_id
         WHERE e.type = 'message.posted'
           AND e.thread_root_event_id IS NOT NULL
           AND e.actor_id <> $1
           AND NOT EXISTS (
             SELECT 1 FROM mentions mn
             WHERE mn.event_id = e.id AND mn.user_id = $1
           )
           AND EXISTS (
             SELECT 1
             FROM events participant
             WHERE participant.actor_id = $1
               AND participant.type IN ('message.posted', 'session.spawned')
               AND (
                 participant.id = e.thread_root_event_id
                 OR (
                   participant.thread_root_event_id = e.thread_root_event_id
                   AND participant.id < e.id
                 )
               )
           )
           AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id,
                'agent_question'::text AS kind,
                e.channel_id,
                e.actor_id,
                coalesce(
                  nullif(e.payload#>>'{questions,0,question}', ''),
                  nullif(e.payload#>>'{questions,0,header}', ''),
                  'Open Atrium to respond.'
                ) AS snippet,
                e.created_at,
                s.id AS session_id,
                s.title AS session_title,
                s.status AS session_status,
                (
                  s.pending_question IS NOT NULL
                  AND s.status IN ('spawning', 'queued', 'running')
                ) AS attention
         FROM events e
         JOIN channels c ON c.id = e.channel_id
         JOIN sessions s ON s.id::text = e.payload->>'sessionId'
         WHERE e.type = 'session.question_requested'
           AND s.spawned_by = $1
           AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id,
                CASE WHEN e.payload->>'status' = 'failed' THEN 'session_failed' ELSE 'session_completed' END::text AS kind,
                e.channel_id,
                e.actor_id,
                CASE
                  WHEN e.payload->>'status' = 'failed' THEN coalesce(
                    nullif(e.payload->>'resultExcerpt', ''),
                    'No result — the run ended with an error.'
                  )
                  ELSE coalesce(
                    nullif(e.payload->>'resultExcerpt', ''),
                    nullif(e.payload->>'status', ''),
                    'Session completed'
                  )
                END AS snippet,
                e.created_at,
                s.id AS session_id,
                s.title AS session_title,
                s.status AS session_status,
                CASE
                  WHEN e.payload->>'status' = 'failed'
                    THEN s.status = 'failed' AND (
                      e.id > read_cursor.last_read_event_id
                      OR EXISTS (
                        SELECT 1 FROM activity_unread_exceptions ue
                        WHERE ue.user_id = $1 AND ue.event_id = e.id
                      )
                    )
                  ELSE false
                END AS attention
         FROM events e
         JOIN channels c ON c.id = e.channel_id
         JOIN sessions s ON s.id::text = e.payload->>'sessionId'
         CROSS JOIN read_cursor
         WHERE e.type = 'session.completed'
           AND s.spawned_by = $1
           AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id,
                'session_failed'::text AS kind,
                e.channel_id,
                e.actor_id,
                'The run crashed before finishing.' AS snippet,
                e.created_at,
                s.id AS session_id,
                s.title AS session_title,
                s.status AS session_status,
                (
                  s.status = 'failed'
                  AND (
                    e.id > read_cursor.last_read_event_id
                    OR EXISTS (
                      SELECT 1 FROM activity_unread_exceptions ue
                      WHERE ue.user_id = $1 AND ue.event_id = e.id
                    )
                  )
                ) AS attention
         FROM events e
         JOIN channels c ON c.id = e.channel_id
         JOIN sessions s ON s.id::text = e.payload->>'sessionId'
         CROSS JOIN read_cursor
         WHERE e.type = 'session.status_changed'
           AND e.payload->>'status' = 'failed'
           AND NOT EXISTS (
             SELECT 1
             FROM events completed
             WHERE completed.type = 'session.completed'
               AND completed.payload->>'sessionId' = e.payload->>'sessionId'
               AND completed.id > e.id
           )
           AND s.spawned_by = $1
           AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id,
                'agent_auth'::text AS kind,
                e.channel_id,
                e.actor_id,
                'Blocked until you reconnect ' || coalesce(e.payload->>'provider', 'the provider') || '.' AS snippet,
                e.created_at,
                s.id AS session_id,
                s.title AS session_title,
                s.status AS session_status,
                (s.provider_auth_required IS NOT NULL) AS attention
         FROM events e
         JOIN channels c ON c.id = e.channel_id
         JOIN sessions s ON s.id::text = e.payload->>'sessionId'
         WHERE e.type IN ('session.provider_auth_required', 'session.github_auth_required')
           AND s.spawned_by = $1
           AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id,
                'reaction'::text AS kind,
                e.channel_id,
                e.actor_id,
                (e.payload->>'emoji') || '  ' || coalesce(nullif(t.payload->>'text', ''), '(attachment)') AS snippet,
                e.created_at,
                NULL::uuid AS session_id,
                NULL::text AS session_title,
                NULL::text AS session_status,
                false AS attention
         FROM events e
         JOIN events t
           ON t.id = NULLIF(substring(e.payload->>'target' FROM '^evt_([0-9]+)$'), '')::bigint
         JOIN channels c ON c.id = e.channel_id
         WHERE e.type = 'reaction.added'
           AND e.actor_id IS NOT NULL
           AND e.actor_id <> $1
           AND t.actor_id = $1
           AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id,
                'channel_invite'::text AS kind,
                e.channel_id,
                e.actor_id,
                'You were added to this channel.' AS snippet,
                e.created_at,
                NULL::uuid AS session_id,
                NULL::text AS session_title,
                NULL::text AS session_status,
                false AS attention
         FROM events e
         JOIN channels c ON c.id = e.channel_id
         WHERE e.type = 'channel.member_joined'
           AND e.payload->>'userId' = $1::text
           AND e.actor_id IS NOT NULL
           AND e.actor_id <> $1
           AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id,
                'seat_request'::text AS kind,
                e.channel_id,
                e.actor_id,
                'Wants to take the driver seat.' AS snippet,
                e.created_at,
                s.id AS session_id,
                s.title AS session_title,
                s.status AS session_status,
                (
                  s.status IN ('spawning', 'queued', 'running')
                  -- A seat request is directed at the session's owner. Channel
                  -- bystanders see the item; only the owner is asked to act.
                  AND s.spawned_by = $1
                  AND EXISTS (
                    SELECT 1
                      FROM seat_requests sr
                     WHERE sr.session_id = s.id
                       AND sr.user_id = e.actor_id
                  )
                ) AS attention
         FROM events e
         JOIN channels c ON c.id = e.channel_id
         JOIN sessions s ON s.id::text = e.payload->>'sessionId'
         WHERE e.type = 'session.seat_requested'
           AND e.actor_id IS NOT NULL
           AND e.actor_id <> $1
           AND s.spawned_by = $1
           AND ${visibleChannel}
       ),
       page AS (
         SELECT a.event_id,
                a.kind::text AS kind,
                a.channel_id,
                c.name AS channel_name,
                a.actor_id,
                u.display_name AS actor_name,
                CASE WHEN char_length(a.snippet) > 140 THEN left(a.snippet, 139) || '…' ELSE a.snippet END AS snippet,
                a.created_at,
                a.session_id,
                a.session_title,
                a.session_status,
                (a.attention AND mt.channel_id IS NULL) AS attention,
                (mt.channel_id IS NOT NULL) AS muted,
                (
                  mt.channel_id IS NULL
                  AND (
                    a.event_id > (SELECT last_read_event_id FROM read_cursor)
                    OR EXISTS (
                      SELECT 1 FROM activity_unread_exceptions ue
                      WHERE ue.user_id = $1 AND ue.event_id = a.event_id
                    )
                  )
                ) AS unread
         FROM activity a
         JOIN channels c ON c.id = a.channel_id
         LEFT JOIN users u ON u.id = a.actor_id
         LEFT JOIN channel_mutes mt ON mt.channel_id = a.channel_id AND mt.user_id = $1
         WHERE NOT $3::boolean
           AND ($2::bigint IS NULL OR a.event_id < $2::bigint)
         ORDER BY a.event_id DESC
         LIMIT 50
       ),
       attention_count AS (
         SELECT COUNT(DISTINCT s.id)::int AS attention_count
         FROM sessions s
         CROSS JOIN read_cursor
         LEFT JOIN LATERAL (
           SELECT MAX(failed.id)::bigint AS event_id
             FROM events failed
            WHERE failed.payload->>'sessionId' = s.id::text
              AND (
                (failed.type = 'session.completed' AND failed.payload->>'status' = 'failed')
                OR (failed.type = 'session.status_changed' AND failed.payload->>'status' = 'failed')
              )
         ) latest_failure ON s.status = 'failed'
         WHERE s.spawned_by = $1
           -- Archiving a session is how you say "stop asking me". The Inbox
           -- list drops archived rows, so counting them here left a badge you
           -- could never clear. needsYou/running/toReview already exclude them.
           AND s.archived_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM channel_mutes mt
             WHERE mt.channel_id = s.channel_id AND mt.user_id = $1
           )
           AND (
             (
               s.pending_question IS NOT NULL
               AND s.status IN ('spawning', 'queued', 'running')
             )
             OR (
               s.status IN ('spawning', 'queued', 'running')
               AND EXISTS (
                 SELECT 1 FROM seat_requests sr WHERE sr.session_id = s.id
               )
             )
             OR (
               -- provider_auth_required outlives the turn: it is only cleared on
               -- steer, resolve, or assignment — never on completion. Without the
               -- same liveness guard the other terms carry, a cancelled session
               -- pinned the badge forever.
               s.provider_auth_required IS NOT NULL
               AND s.status IN ('spawning', 'queued', 'running')
             )
             OR (
               s.status = 'failed'
               AND (
                 COALESCE(latest_failure.event_id, 0) > read_cursor.last_read_event_id
                 OR EXISTS (
                   SELECT 1 FROM activity_unread_exceptions ue
                   WHERE ue.user_id = $1
                     AND ue.event_id = COALESCE(latest_failure.event_id, 0)
                 )
               )
             )
           )
       )
       SELECT read_cursor.last_read_event_id,
              LEAST(
                99::bigint,
                (SELECT COUNT(*)
                 FROM activity qa
                 WHERE (
                   qa.event_id > read_cursor.last_read_event_id
                   OR EXISTS (
                     SELECT 1 FROM activity_unread_exceptions ue
                     WHERE ue.user_id = $1 AND ue.event_id = qa.event_id
                   )
                 )
                   AND NOT EXISTS (
                     SELECT 1 FROM channel_mutes mt
                     WHERE mt.channel_id = qa.channel_id AND mt.user_id = $1
                   ))
              )::int AS unread_count,
              attention_count.attention_count,
              COALESCE((
                SELECT json_agg(event_id ORDER BY event_id)
                FROM activity_unread_exceptions
                WHERE user_id = $1
              ), '[]'::json) AS unread_exception_ids,
              COALESCE((SELECT json_agg(page ORDER BY page.event_id DESC) FROM page), '[]'::json) AS items
       FROM read_cursor
       CROSS JOIN attention_count`,
      [userId, cursor, countsOnly],
    );

    return { result: res.rows[0]!, visibleChannel };
  };

  app.get('/api/activity/counts', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { result, visibleChannel } = await queryActivity(user.id, null, true);
    const agentWorkCounts = await loadAgentWorkCounts(pool, user.id, visibleChannel);
    const body: ActivityCountsResponse = {
      attention: Number(result.attention_count),
      unread: Number(result.unread_count),
      ...agentWorkCounts,
    };
    if (setCountsCacheHeaders(req, reply, body)) return reply.code(304).send();
    return body;
  });

  app.get('/api/activity', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { cursor?: string };
    const cursor = parseCursor(q.cursor);
    if (cursor === undefined) {
      return reply.code(400).send({ error: 'bad_query', message: 'cursor must be a positive event id' });
    }

    const { result, visibleChannel } = await queryActivity(user.id, cursor, false);

    const items = Array.isArray(result.items) ? result.items.map(toActivityItem) : [];
    await resolveMentionTokensInSnippets(pool, items);
    const agentWorkCounts = await loadAgentWorkCounts(pool, user.id, visibleChannel);
    return {
      items,
      nextCursor: items.length === 50 ? items[items.length - 1]!.eventId : null,
      lastReadEventId: String(result.last_read_event_id),
      unreadExceptionIds: exceptionIdsFrom(result),
      counts: {
        attention: Number(result.attention_count),
        unread: Number(result.unread_count),
        needsYou: agentWorkCounts.needsYou,
        running: agentWorkCounts.running,
        toReview: agentWorkCounts.toReview,
      },
      channelCounts: agentWorkCounts.channelCounts,
    };
  });
}
