import { config } from './config.js';
import type { Db } from './db.js';
import { withTx } from './db.js';
import { appendEvent, type WireEvent } from './events.js';

export interface SessionArchivePublisher {
  publishEvent(event: WireEvent): void;
}

export interface ArchiveStaleSessionsOptions {
  /** Days after terminal completion before archiving. Zero disables the sweep. */
  days?: number;
}

interface ArchivedSessionRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  thread_root_event_id: number | null;
  archived_at: Date;
}

/**
 * Keep this predicate in one exported constant: it is both the sweeper's
 * contract and the critical partial-index predicate in migration 069.
 */
export const ARCHIVE_STALE_SESSIONS_SQL = `UPDATE sessions
   SET archived_at = now()
 WHERE status IN ('completed', 'failed', 'cancelled')
   AND archived_at IS NULL
   AND COALESCE(completed_at, created_at) < now() - ($1::int * interval '1 day')
 RETURNING id, workspace_id, channel_id, thread_root_event_id, archived_at`;

export function isSessionAutoArchiveEnabled(days: number): boolean {
  return Number.isSafeInteger(days) && days > 0;
}

/** Archive terminal sessions past the configured retention window. */
export async function archiveStaleSessions(
  pool: Db,
  publisher?: SessionArchivePublisher,
  options: ArchiveStaleSessionsOptions = {},
): Promise<WireEvent[]> {
  const days = options.days ?? config.sessionAutoArchiveDays;
  if (!isSessionAutoArchiveEnabled(days)) return [];

  const events = await withTx(pool, async (client) => {
    const archived = await client.query<ArchivedSessionRow>(ARCHIVE_STALE_SESSIONS_SQL, [days]);
    const out: WireEvent[] = [];
    for (const row of archived.rows) {
      out.push(
        await appendEvent(client, {
          workspaceId: row.workspace_id,
          channelId: row.channel_id,
          threadRootEventId: row.thread_root_event_id,
          type: 'session.archived',
          payload: {
            sessionId: row.id,
            archivedAt: row.archived_at.toISOString(),
          },
        }),
      );
    }
    return out;
  });
  for (const event of events) publisher?.publishEvent(event);
  return events;
}
