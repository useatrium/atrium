import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import type { UserRef } from '../events.js';
import { workspaceMemberExists } from '../membership.js';

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
}

interface ActivityQueryRow {
  last_read_event_id: number | string;
  unread_count: number | string;
  attention_count: number | string;
  items: ActivityRow[] | null;
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
  };
}

export function registerActivityRoutes(app: FastifyInstance, deps: ActivityRouteDeps): void {
  const { pool, requireUser } = deps;

  app.post('/api/activity/read', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = req.body as { lastReadEventId?: unknown } | undefined;
    const requestedCursor = parseReadEventId(body?.lastReadEventId);
    if (requestedCursor === undefined) {
      return reply.code(400).send({ error: 'bad_request', message: 'lastReadEventId must be a non-negative event id' });
    }

    // A cursor always lands on a real event (or the initial zero), even if a
    // client sends an optimistic id that has not been committed yet.
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
      [user.id, requestedCursor],
    );

    return { lastReadEventId: String(res.rows[0]!.last_read_event_id) };
  });

  app.get('/api/activity', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { cursor?: string };
    const cursor = parseCursor(q.cursor);
    if (cursor === undefined) {
      return reply.code(400).send({ error: 'bad_query', message: 'cursor must be a positive event id' });
    }

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
                    THEN s.status = 'failed' AND e.id > read_cursor.last_read_event_id
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
                (s.status = 'failed' AND e.id > read_cursor.last_read_event_id) AS attention
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
                false AS attention
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
                (mt.channel_id IS NOT NULL) AS muted
         FROM activity a
         JOIN channels c ON c.id = a.channel_id
         LEFT JOIN users u ON u.id = a.actor_id
         LEFT JOIN channel_mutes mt ON mt.channel_id = a.channel_id AND mt.user_id = $1
         WHERE ($2::bigint IS NULL OR a.event_id < $2::bigint)
         ORDER BY a.event_id DESC
         LIMIT 50
       ),
       attention_count AS (
         SELECT COUNT(DISTINCT s.id)::int AS attention_count
         FROM sessions s
         CROSS JOIN read_cursor
         WHERE s.spawned_by = $1
           AND NOT EXISTS (
             SELECT 1 FROM channel_mutes mt
             WHERE mt.channel_id = s.channel_id AND mt.user_id = $1
           )
           AND (
             (
               s.pending_question IS NOT NULL
               AND s.status IN ('spawning', 'queued', 'running')
             )
             OR s.provider_auth_required IS NOT NULL
             OR (
               s.status = 'failed'
               AND COALESCE((
                 SELECT MAX(failed.id)
                 FROM events failed
                 WHERE failed.payload->>'sessionId' = s.id::text
                   AND (
                     (failed.type = 'session.completed' AND failed.payload->>'status' = 'failed')
                     OR (failed.type = 'session.status_changed' AND failed.payload->>'status' = 'failed')
                   )
               ), 0)::bigint > read_cursor.last_read_event_id
             )
           )
       )
       SELECT read_cursor.last_read_event_id,
              LEAST(
                99::bigint,
                (SELECT COUNT(*)
                 FROM activity qa
                 WHERE qa.event_id > read_cursor.last_read_event_id
                   AND NOT EXISTS (
                     SELECT 1 FROM channel_mutes mt
                     WHERE mt.channel_id = qa.channel_id AND mt.user_id = $1
                   ))
              )::int AS unread_count,
              attention_count.attention_count,
              COALESCE((SELECT json_agg(page ORDER BY page.event_id DESC) FROM page), '[]'::json) AS items
       FROM read_cursor
       CROSS JOIN attention_count`,
      [user.id, cursor],
    );

    const result = res.rows[0]!;
    const items = Array.isArray(result.items) ? result.items.map(toActivityItem) : [];
    return {
      items,
      nextCursor: items.length === 50 ? items[items.length - 1]!.eventId : null,
      lastReadEventId: String(result.last_read_event_id),
      counts: {
        attention: Number(result.attention_count),
        unread: Number(result.unread_count),
      },
    };
  });
}
