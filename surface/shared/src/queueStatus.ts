import { useEffect, useRef, useState } from 'react';
import type { AppState } from './appState';
import type { OpStorage, QueuedOp } from './opQueue';

export type QueueStatusWs = AppState['wsStatus'];

export function countActiveQueuedChanges(
  ops: readonly Pick<QueuedOp, 'status'>[],
): number {
  return ops.filter((op) => op.status === 'pending' || op.status === 'inflight').length;
}

/** Offline is the only state loud enough for a banner; everything else stays quiet. */
export function reconnectingLabel(wsStatus: QueueStatusWs): string | null {
  return wsStatus === 'open' ? null : 'Reconnecting…';
}

export type QueueSyncState = {
  /** pending + inflight ops in the local queue */
  queuedCount: number;
  /** the queue has stayed non-empty for stuckAfterMs while connected — worth a subtle indicator */
  syncStuck: boolean;
};

/**
 * Advance the stuck clock: the queue is "stuck" only after it has been non-empty
 * continuously for stuckAfterMs while the socket is open. Reconnects restart the
 * clock so the post-reconnect flush doesn't flash an indicator.
 */
export function deriveSyncStuck(
  wsStatus: QueueStatusWs,
  queuedCount: number,
  stuckSince: number | null,
  now: number,
  stuckAfterMs: number,
): { stuckSince: number | null; syncStuck: boolean } {
  const next = wsStatus === 'open' && queuedCount > 0 ? (stuckSince ?? now) : null;
  return { stuckSince: next, syncStuck: next !== null && now - next >= stuckAfterMs };
}

export function useQueueSyncState(
  storage: Pick<OpStorage, 'listOps'>,
  wsStatus: QueueStatusWs,
  nudgeSignal: unknown,
  { intervalMs = 750, stuckAfterMs = 2500 }: { intervalMs?: number; stuckAfterMs?: number } = {},
): QueueSyncState {
  const [state, setState] = useState<QueueSyncState>({ queuedCount: 0, syncStuck: false });
  const stuckSinceRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void storage
        .listOps()
        .then((ops) => {
          if (disposed) return;
          const queuedCount = countActiveQueuedChanges(ops);
          const derived = deriveSyncStuck(
            wsStatus,
            queuedCount,
            stuckSinceRef.current,
            Date.now(),
            stuckAfterMs,
          );
          stuckSinceRef.current = derived.stuckSince;
          setState((prev) =>
            prev.queuedCount === queuedCount && prev.syncStuck === derived.syncStuck
              ? prev
              : { queuedCount, syncStuck: derived.syncStuck },
          );
        })
        .catch(() => {});
    };
    refresh();
    // Keep polling while anything is queued or the socket is down; an idle,
    // connected client runs no timer at all.
    if (wsStatus !== 'open' || state.queuedCount > 0) {
      const timer = setInterval(refresh, intervalMs);
      return () => {
        disposed = true;
        clearInterval(timer);
      };
    }
    return () => {
      disposed = true;
    };
  }, [state.queuedCount, intervalMs, storage, stuckAfterMs, wsStatus, nudgeSignal]);

  return state;
}
