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
  | 'agent_auth';

interface ActivityRow {
  event_id: number;
  kind: ActivityKind;
  channel_id: string;
  channel_name: string;
  actor_id: string | null;
  actor_name: string | null;
  snippet: string;
  created_at: Date;
  session_title: string | null;
  session_status: string | null;
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
    sessionTitle: row.session_title,
    sessionStatus: row.session_status,
  };
}

export function registerActivityRoutes(app: FastifyInstance, deps: ActivityRouteDeps): void {
  const { pool, requireUser } = deps;

  app.get('/api/activity', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const q = req.query as { cursor?: string };
    const cursor = parseCursor(q.cursor);
    if (cursor === undefined) {
      return reply.code(400).send({ error: 'bad_query', message: 'cursor must be a positive event id' });
    }

    const visibleChannel = canSeeChannelSql();
    const res = await pool.query<ActivityRow>(
      `WITH activity AS (
         SELECT e.id AS event_id,
                'mention'::text AS kind,
                e.channel_id,
                e.actor_id,
                coalesce(nullif(e.payload->>'text', ''), '(attachment)') AS snippet,
                e.created_at,
                NULL::text AS session_title,
                NULL::text AS session_status
         FROM mentions mn
         JOIN events e ON e.id = mn.event_id
         JOIN channels c ON c.id = e.channel_id
         WHERE mn.user_id = $1
           AND e.channel_id IS NOT NULL
           AND ($2::bigint IS NULL OR e.id < $2::bigint)
           AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id,
                'dm'::text AS kind,
                e.channel_id,
                e.actor_id,
                coalesce(nullif(e.payload->>'text', ''), '(attachment)') AS snippet,
                e.created_at,
                NULL::text AS session_title,
                NULL::text AS session_status
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
           AND ($2::bigint IS NULL OR e.id < $2::bigint)
           AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id,
                'thread_reply'::text AS kind,
                e.channel_id,
                e.actor_id,
                coalesce(nullif(e.payload->>'text', ''), '(attachment)') AS snippet,
                e.created_at,
                NULL::text AS session_title,
                NULL::text AS session_status
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
           AND ($2::bigint IS NULL OR e.id < $2::bigint)
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
                s.title AS session_title,
                s.status AS session_status
         FROM events e
         JOIN channels c ON c.id = e.channel_id
         JOIN sessions s ON s.id::text = e.payload->>'sessionId'
         WHERE e.type = 'session.question_requested'
           AND s.spawned_by = $1
           AND ($2::bigint IS NULL OR e.id < $2::bigint)
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
                s.title AS session_title,
                s.status AS session_status
         FROM events e
         JOIN channels c ON c.id = e.channel_id
         JOIN sessions s ON s.id::text = e.payload->>'sessionId'
         WHERE e.type = 'session.completed'
           AND s.spawned_by = $1
           AND ($2::bigint IS NULL OR e.id < $2::bigint)
           AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id,
                'session_failed'::text AS kind,
                e.channel_id,
                e.actor_id,
                'The run crashed before finishing.' AS snippet,
                e.created_at,
                s.title AS session_title,
                s.status AS session_status
         FROM events e
         JOIN channels c ON c.id = e.channel_id
         JOIN sessions s ON s.id::text = e.payload->>'sessionId'
         WHERE e.type = 'session.status_changed'
           AND e.payload->>'status' = 'failed'
           AND NOT EXISTS (
             SELECT 1
             FROM events completed
             WHERE completed.type = 'session.completed'
               AND completed.payload->>'sessionId' = e.payload->>'sessionId'
           )
           AND s.spawned_by = $1
           AND ($2::bigint IS NULL OR e.id < $2::bigint)
           AND ${visibleChannel}

         UNION ALL

         SELECT e.id AS event_id,
                'agent_auth'::text AS kind,
                e.channel_id,
                e.actor_id,
                'Blocked until you reconnect ' || coalesce(e.payload->>'provider', 'the provider') || '.' AS snippet,
                e.created_at,
                s.title AS session_title,
                s.status AS session_status
         FROM events e
         JOIN channels c ON c.id = e.channel_id
         JOIN sessions s ON s.id::text = e.payload->>'sessionId'
         WHERE e.type IN ('session.provider_auth_required', 'session.github_auth_required')
           AND s.spawned_by = $1
           AND ($2::bigint IS NULL OR e.id < $2::bigint)
           AND ${visibleChannel}
       )
       SELECT a.event_id,
              a.kind::text AS kind,
              a.channel_id,
              c.name AS channel_name,
              a.actor_id,
              u.display_name AS actor_name,
              CASE WHEN char_length(a.snippet) > 140 THEN left(a.snippet, 139) || '…' ELSE a.snippet END AS snippet,
              a.created_at,
              a.session_title,
              a.session_status
       FROM activity a
       JOIN channels c ON c.id = a.channel_id
       LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.event_id DESC
       LIMIT 50`,
      [user.id, cursor],
    );

    const items = res.rows.map(toActivityItem);
    return {
      items,
      nextCursor: items.length === 50 ? items[items.length - 1]!.eventId : null,
    };
  });
}
