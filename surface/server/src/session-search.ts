import type { Db } from './db.js';
import { config } from './config.js';
import { workspaceMemberExists } from './membership.js';
import type {
  SessionRecordActor,
  SessionRecordDriver,
  SessionRecordKind,
  SessionRecordViewTier,
} from './session-records.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const EXCERPT_CHARS = 280;

export interface SessionRecordHit {
  sessionId: string;
  sessionTitle: string | null;
  channelId: string | null;
  channelName: string | null;
  eventId: number;
  seq: number;
  kind: SessionRecordKind;
  actor: SessionRecordActor;
  driver: SessionRecordDriver | null;
  viewTier: SessionRecordViewTier;
  excerpt: string;
  ts: string;
}

interface SessionRecordHitRow {
  session_id: string;
  session_title: string | null;
  channel_id: string | null;
  channel_name: string | null;
  event_id: number;
  seq: number;
  kind: SessionRecordKind;
  actor: SessionRecordActor;
  driver: SessionRecordDriver | null;
  view_tier: SessionRecordViewTier;
  text: string;
  ts: Date;
}

export async function searchSessionRecords(
  pool: Db,
  args: {
    query: string;
    userId: string;
    kinds?: string[];
    full?: boolean;
    limit?: number;
  },
): Promise<SessionRecordHit[]> {
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const kinds = args.kinds && args.kinds.length > 0 ? args.kinds : null;
  const includeFull = Boolean(args.full) && (await canViewFullSearchTier(pool, args.userId));
  const res = await pool.query<SessionRecordHitRow>(
    `SELECT sr.session_id,
            s.title AS session_title,
            s.channel_id,
            c.name AS channel_name,
            sr.event_id,
            sr.seq,
            sr.kind,
            sr.actor,
            sr.driver,
            sr.view_tier,
            sr.text,
            sr.ts
     FROM session_records sr
     JOIN sessions s ON s.id = sr.session_id
     JOIN channels c ON c.id = s.channel_id
     WHERE sr.tsv @@ websearch_to_tsquery('english', $1)
       AND ($3::text[] IS NULL OR sr.kind = ANY($3::text[]))
       AND ($4::boolean OR sr.view_tier = 'lean')
       AND ((c.kind = 'public' AND ${workspaceMemberExists('c.workspace_id', '$2')})
            OR s.spawned_by = $2
            OR EXISTS (SELECT 1 FROM channel_members cm
                       WHERE cm.channel_id = c.id AND cm.user_id = $2))
     ORDER BY sr.ts DESC, sr.seq DESC
     LIMIT $5`,
    [args.query, args.userId, kinds, includeFull, limit],
  );
  return res.rows.map((row) => ({
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    channelId: row.channel_id,
    channelName: row.channel_name,
    eventId: row.event_id,
    seq: row.seq,
    kind: row.kind,
    actor: row.actor,
    driver: row.driver,
    viewTier: row.view_tier,
    excerpt: excerpt(row.text),
    ts: row.ts.toISOString(),
  }));
}

async function canViewFullSearchTier(pool: Db, userId: string): Promise<boolean> {
  if (!config.fullViewEnabled) return false;
  const res = await pool.query<{ raw_access: boolean }>(
    `SELECT raw_access FROM users WHERE id = $1`,
    [userId],
  );
  return res.rows[0]?.raw_access === true;
}

function excerpt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= EXCERPT_CHARS) return trimmed;
  return `${trimmed.slice(0, EXCERPT_CHARS - 3).trimEnd()}...`;
}
