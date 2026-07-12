import { CALL_EMPTY_ACTIVE_TTL_MS, CALL_MAX_AGE_MS, CALL_RING_TTL_MS } from '@atrium/surface-client/calls';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from './db.js';
import {
  STALE_CALL_CANDIDATES_SQL,
  startCallSweeper,
  sweepStaleCalls,
  type CallSweepPublisher,
} from './call-sweeper.js';

function mockPool(query: ReturnType<typeof vi.fn>): Db {
  const client = { query, release: vi.fn() };
  return { connect: vi.fn(async () => client) } as unknown as Db;
}

describe('sweepStaleCalls', () => {
  it('encodes all three stale-call policies in its candidate predicate', () => {
    expect(STALE_CALL_CANDIDATES_SQL).toContain("calls.status = 'ringing'");
    expect(STALE_CALL_CANDIDATES_SQL).toContain('calls.started_at < now() - ($1::double precision');
    expect(STALE_CALL_CANDIDATES_SQL).toContain("calls.status = 'active'");
    expect(STALE_CALL_CANDIDATES_SQL).toContain('present.left_at IS NULL');
    expect(STALE_CALL_CANDIDATES_SQL).toContain('NOT EXISTS');
    expect(STALE_CALL_CANDIDATES_SQL).toContain('SELECT MAX(departed.left_at)');
    expect(STALE_CALL_CANDIDATES_SQL).toContain('calls.started_at\n       ) < now() - ($2::double precision');
    expect(STALE_CALL_CANDIDATES_SQL).toContain('calls.started_at < now() - ($3::double precision');
    expect(STALE_CALL_CANDIDATES_SQL).toContain("calls.status <> 'ended'");
  });

  it('ends candidates, marks participants left, and publishes to channel recipients', async () => {
    const callIds = ['ring-call', 'max-age-call'];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql === STALE_CALL_CANDIDATES_SQL) return { rows: callIds.map((id) => ({ id })) };
      if (sql.includes('SELECT calls.*, c.kind AS channel_kind')) {
        return { rows: [{ id: params?.[0], channel_id: `channel-${params?.[0]}` }] };
      }
      if (sql.startsWith('UPDATE call_participants')) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE calls\n     SET status = 'ended'")) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (sql === 'SELECT workspace_id, kind FROM channels WHERE id = $1') {
        return { rows: [{ workspace_id: 'workspace', kind: 'private' }] };
      }
      if (sql === 'SELECT user_id FROM channel_members WHERE channel_id = $1') {
        return { rows: [{ user_id: 'user-a' }, { user_id: 'user-b' }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const publishCallToUsers = vi.fn();
    const hub = { publishCallToUsers } satisfies CallSweepPublisher;

    const result = await sweepStaleCalls(mockPool(query), hub);

    expect(query).toHaveBeenCalledWith(STALE_CALL_CANDIDATES_SQL, [
      CALL_RING_TTL_MS,
      CALL_EMPTY_ACTIVE_TTL_MS,
      CALL_MAX_AGE_MS,
    ]);
    expect(result.map((row) => row.callId)).toEqual(callIds);
    expect(query.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE call_participants'))).toHaveLength(2);
    expect(publishCallToUsers).toHaveBeenCalledTimes(2);
    expect(publishCallToUsers).toHaveBeenNthCalledWith(1, ['user-a', 'user-b'], {
      type: 'call.ended',
      callId: 'ring-call',
    });
    expect(publishCallToUsers).toHaveBeenNthCalledWith(2, ['user-a', 'user-b'], {
      type: 'call.ended',
      callId: 'max-age-call',
    });
  });

  it('skips a tick while the previous sweep is still running', async () => {
    let releaseCandidates!: () => void;
    const candidatesBlocked = new Promise<void>((resolve) => {
      releaseCandidates = resolve;
    });
    const query = vi.fn(async (sql: string) => {
      if (sql === STALE_CALL_CANDIDATES_SQL) {
        await candidatesBlocked;
        return { rows: [] };
      }
      return { rows: [] };
    });
    const worker = startCallSweeper({
      pool: mockPool(query),
      hub: { publishCallToUsers: vi.fn() },
      intervalMs: 60_000,
    });

    const first = worker.runOnce();
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith(STALE_CALL_CANDIDATES_SQL, expect.any(Array)));
    await worker.runOnce();
    expect(query.mock.calls.filter(([sql]) => sql === STALE_CALL_CANDIDATES_SQL)).toHaveLength(1);

    releaseCandidates();
    await first;
    worker.stop();
  });
});
