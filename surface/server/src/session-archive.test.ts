import { describe, expect, it, vi } from 'vitest';
import type { Db } from './db.js';
import { ARCHIVE_STALE_SESSIONS_SQL, archiveStaleSessions, isSessionAutoArchiveEnabled } from './session-archive.js';

describe('archiveStaleSessions', () => {
  it('targets only unarchived terminal sessions older than the configured window', async () => {
    expect(ARCHIVE_STALE_SESSIONS_SQL).toContain("status IN ('completed', 'failed', 'cancelled')");
    expect(ARCHIVE_STALE_SESSIONS_SQL).toContain('archived_at IS NULL');
    expect(ARCHIVE_STALE_SESSIONS_SQL).toContain('COALESCE(completed_at, created_at)');
    expect(ARCHIVE_STALE_SESSIONS_SQL).toContain("($1::int * interval '1 day')");

    const query = vi.fn(async (sql: string) => {
      if (sql === ARCHIVE_STALE_SESSIONS_SQL) return { rows: [] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as Db;

    await expect(archiveStaleSessions(pool, undefined, { days: 14 })).resolves.toEqual([]);
    expect(query).toHaveBeenCalledWith(ARCHIVE_STALE_SESSIONS_SQL, [14]);
  });

  it('does nothing when auto-archive is disabled with zero days', async () => {
    const connect = vi.fn();
    const pool = { connect } as unknown as Db;

    await expect(archiveStaleSessions(pool, undefined, { days: 0 })).resolves.toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    expect(isSessionAutoArchiveEnabled(0)).toBe(false);
  });
});
