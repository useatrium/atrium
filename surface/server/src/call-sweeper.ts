import { CALL_EMPTY_ACTIVE_TTL_MS, CALL_MAX_AGE_MS, CALL_RING_TTL_MS } from '@atrium/surface-client/calls';
import { endCall, type EndCallResult } from './calls.js';
import type { Db } from './db.js';
import { withTx } from './db.js';

export const CALL_SWEEP_INTERVAL_MS = 30_000;

/** The lifecycle policy used to select non-ended calls for cleanup. */
export const STALE_CALL_CANDIDATES_SQL = `SELECT calls.id
   FROM calls
  WHERE calls.status <> 'ended'
    AND (
      (calls.status = 'ringing'
       AND calls.started_at < now() - ($1::double precision * interval '1 millisecond'))
      OR
      (calls.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM call_participants present
          WHERE present.call_id = calls.id AND present.left_at IS NULL
       )
       AND COALESCE(
         (SELECT MAX(departed.left_at) FROM call_participants departed WHERE departed.call_id = calls.id),
         calls.started_at
       ) < now() - ($2::double precision * interval '1 millisecond'))
      OR calls.started_at < now() - ($3::double precision * interval '1 millisecond')
    )
  ORDER BY calls.started_at ASC, calls.id ASC
  FOR UPDATE OF calls SKIP LOCKED`;

export interface CallSweepPublisher {
  publishCallToUsers(userIds: string[], event: { type: 'call.ended'; callId: string }): void;
}

export interface SweepStaleCallsOptions {
  ringTtlMs?: number;
  emptyActiveTtlMs?: number;
  maxAgeMs?: number;
}

export interface CallSweeperOptions extends SweepStaleCallsOptions {
  pool: Db;
  hub: CallSweepPublisher;
  intervalMs?: number;
}

export interface CallSweeper {
  runOnce(): Promise<void>;
  stop(): void;
}

/** End stale calls transactionally, then publish their terminal lifecycle frames. */
export async function sweepStaleCalls(
  pool: Db,
  hub: CallSweepPublisher,
  options: SweepStaleCallsOptions = {},
): Promise<EndCallResult[]> {
  const ringTtlMs = options.ringTtlMs ?? CALL_RING_TTL_MS;
  const emptyActiveTtlMs = options.emptyActiveTtlMs ?? CALL_EMPTY_ACTIVE_TTL_MS;
  const maxAgeMs = options.maxAgeMs ?? CALL_MAX_AGE_MS;
  const ended = await withTx(pool, async (client) => {
    const candidates = await client.query<{ id: string }>(STALE_CALL_CANDIDATES_SQL, [
      ringTtlMs,
      emptyActiveTtlMs,
      maxAgeMs,
    ]);
    const results: EndCallResult[] = [];
    for (const candidate of candidates.rows) {
      const result = await endCall(client, candidate.id);
      if (result?.ended) results.push(result);
    }
    return results;
  });

  for (const result of ended) {
    hub.publishCallToUsers(result.recipients, { type: 'call.ended', callId: result.callId });
  }
  return ended;
}

/** Start a non-overlapping stale-call worker whose timer does not hold Node open. */
export function startCallSweeper(options: CallSweeperOptions): CallSweeper {
  const { pool, hub } = options;
  const intervalMs = options.intervalMs ?? CALL_SWEEP_INTERVAL_MS;
  let inFlight = false;
  let stopped = false;

  async function runOnce(): Promise<void> {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      await sweepStaleCalls(pool, hub, options);
    } catch (err) {
      console.warn('stale call sweep failed', err);
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref?.();

  return {
    runOnce,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
