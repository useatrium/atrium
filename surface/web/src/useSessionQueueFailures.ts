import { useCallback, useState } from 'react';
import type { QueuedOp } from '@atrium/surface-client';

export type SessionQueueFailure =
  | { type: 'steer'; sessionId: string; text: string }
  | { type: 'cancel'; sessionId: string };

export function sessionQueueFailureFromOp(
  op: Pick<QueuedOp, 'opType' | 'payload'>,
): SessionQueueFailure | null {
  if (typeof op.payload !== 'object' || op.payload === null) return null;
  if (op.opType === 'session.steer') {
    const payload = op.payload as { sessionId?: unknown; text?: unknown };
    if (typeof payload.sessionId === 'string' && typeof payload.text === 'string') {
      return { type: 'steer', sessionId: payload.sessionId, text: payload.text };
    }
  }
  if (op.opType === 'session.cancel') {
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

  const rememberRejectedSessionOp = useCallback((op: Pick<QueuedOp, 'opType' | 'payload'>) => {
    const failure = sessionQueueFailureFromOp(op);
    if (!failure) return;
    if (failure.type === 'steer') {
      setFailedSteers((prev) => ({ ...prev, [failure.sessionId]: failure.text }));
      return;
    }
    setFailedCancels((prev) => ({ ...prev, [failure.sessionId]: true }));
  }, []);

  return {
    failedSteers,
    failedCancels,
    clearFailedSteer,
    clearFailedCancel,
    rememberRejectedSessionOp,
  };
}
