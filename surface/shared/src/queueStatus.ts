import { useEffect, useState } from 'react';
import type { AppState } from './appState';
import type { OpStorage, QueuedOp } from './opQueue';

export type QueueStatusWs = AppState['wsStatus'];

export function countActiveQueuedChanges(
  ops: readonly Pick<QueuedOp, 'status'>[],
): number {
  return ops.filter((op) => op.status === 'pending' || op.status === 'inflight').length;
}

export function queuedChangesLabel(
  wsStatus: QueueStatusWs,
  queuedChanges: number,
): string | null {
  const count = Math.max(0, Math.floor(queuedChanges));
  const parts: string[] = [];
  if (wsStatus !== 'open') parts.push('Reconnecting…');
  if (count > 0) parts.push(`${count} ${count === 1 ? 'change' : 'changes'} queued`);
  return parts.length > 0 ? parts.join(' ') : null;
}

export function useQueuedChangesCount(
  storage: Pick<OpStorage, 'listOps'>,
  wsStatus: QueueStatusWs,
  nudgeSignal: unknown,
  intervalMs = 750,
): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let disposed = false;
    void storage
      .listOps()
      .then((ops) => {
        if (!disposed) setCount(countActiveQueuedChanges(ops));
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [storage, wsStatus, nudgeSignal]);

  useEffect(() => {
    if (wsStatus === 'open' && count === 0) return;
    let disposed = false;
    const refresh = () => {
      void storage
        .listOps()
        .then((ops) => {
          if (!disposed) setCount(countActiveQueuedChanges(ops));
        })
        .catch(() => {});
    };
    const timer = setInterval(refresh, intervalMs);
    refresh();
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [count, intervalMs, storage, wsStatus]);

  return count;
}
