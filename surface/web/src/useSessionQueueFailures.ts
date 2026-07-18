import { useCallback, useState } from 'react';
import type { QueuedOp } from '@atrium/surface-client';

export type SessionQueueFailure =
  | { type: 'steer'; sessionId: string; text: string }
  | { type: 'cancel'; sessionId: string };

export function sessionQueueFailureFromOp(op: Pick<QueuedOp, 'opType' | 'payload'>): SessionQueueFailure | null {
  if (typeof op.payload !== 'object' || op.payload === null) return null;
  if (op.opType === 'session.steer') {
    const payload = op.payload as { sessionId?: unknown; text?: unknown };
    if (typeof payload.sessionId === 'string' && typeof payload.text === 'string') {
      return { type: 'steer', sessionId: payload.sessionId, text: payload.text };
    }
  }
  if (op.opType === 'session.cancel' || op.opType === 'session.stop_turn') {
    const payload = op.payload as { sessionId?: unknown };
    if (typeof payload.sessionId === 'string') {
      return { type: 'cancel', sessionId: payload.sessionId };
    }
  }
  return null;
}

export function useSessionQueueFailures() {
  const [failedSteers, setFailedSteers] = useState<Record<string, string>>({});
  const [failedCancels, setFailedCancels] = useState<Record<string, true>>({});
  // sessionId -> ms timestamp of an in-flight steer. Steering a *terminal*
  // session revives it, but the status regresses to `queued` only once the
  // server broadcasts back; until then the pane still reads the finished status
  // and shows "✓ Turn complete" right after you sent a message. This marks the
  // gap so the pane can say "Starting…" immediately. It self-heals: the pane
  // ignores it once the session is non-terminal or the timestamp ages out, and
  // it is cleared on failure below — so a stuck value can never pin "Starting…".
  const [pendingSteers, setPendingSteers] = useState<Record<string, number>>({});

  const markPendingSteer = useCallback((sessionId: string) => {
    setPendingSteers((prev) => ({ ...prev, [sessionId]: Date.now() }));
  }, []);

  const clearPendingSteer = useCallback((sessionId: string) => {
    setPendingSteers((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const clearFailedSteer = useCallback((sessionId: string) => {
    setFailedSteers((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const clearFailedCancel = useCallback((sessionId: string) => {
    setFailedCancels((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const rememberRejectedSessionOp = useCallback(
    (op: Pick<QueuedOp, 'opType' | 'payload'>) => {
      const failure = sessionQueueFailureFromOp(op);
      if (!failure) return;
      if (failure.type === 'steer') {
        setFailedSteers((prev) => ({ ...prev, [failure.sessionId]: failure.text }));
        // A rejected steer never starts a turn — drop the optimistic marker.
        clearPendingSteer(failure.sessionId);
        return;
      }
      setFailedCancels((prev) => ({ ...prev, [failure.sessionId]: true }));
    },
    [clearPendingSteer],
  );

  return {
    failedSteers,
    failedCancels,
    pendingSteers,
    clearFailedSteer,
    clearFailedCancel,
    markPendingSteer,
    clearPendingSteer,
    rememberRejectedSessionOp,
  };
}
