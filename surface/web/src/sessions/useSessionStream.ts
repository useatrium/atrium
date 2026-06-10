// Fold the proxied Centaur SSE stream into a SessionState with the shared
// reducer. Handles resume: on stream error the EventSource is recreated with
// after_event_id=<last folded id>, and already-seen frames are dropped
// (duplicate terminal execution_state snapshots are allowed, per the schema).

import { useEffect, useState } from 'react';
import {
  initialSessionState,
  isTerminalExecutionStatus,
  reduceSession,
  type CentaurEventFrame,
  type SessionState,
} from '@atrium/centaur-client';
import { sessionsApi, type SessionStreamHandle } from './api';

const RECONNECT_DELAY_MS = 1000;

export interface SessionStream {
  stream: SessionState;
  connected: boolean;
}

export function useSessionStream(sessionId: string | null): SessionStream {
  const [stream, setStream] = useState<SessionState>(initialSessionState);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let acc = initialSessionState();
    let handle: SessionStreamHandle | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let flushScheduled = false;
    setStream(acc);
    setConnected(false);

    // Batch per-frame folds into one React commit per animation frame — the
    // LONGSTREAM capture delivers >1k frames in a couple of seconds.
    const scheduleFlush = () => {
      if (flushScheduled) return;
      flushScheduled = true;
      const raf =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : (cb: () => void) => setTimeout(cb, 16);
      raf(() => {
        flushScheduled = false;
        if (!disposed) setStream(acc);
      });
    };

    const onFrame = (frame: CentaurEventFrame) => {
      // Dedupe on resume: skip already-folded ids, but allow execution_state
      // (the terminal snapshot is legitimately re-emitted on replay).
      if (frame.event_id <= acc.lastEventId && frame.event !== 'execution_state') return;
      acc = reduceSession(acc, frame);
      scheduleFlush();
    };

    const connect = () => {
      if (disposed) return;
      handle = sessionsApi.openStream(sessionId, acc.lastEventId, {
        onFrame,
        onOpen: () => {
          if (!disposed) setConnected(true);
        },
        onError: () => {
          handle?.close();
          handle = null;
          if (disposed) return;
          setConnected(false);
          // A finished replay ends with a terminal state — don't loop forever.
          if (acc.status !== 'idle' && isTerminalExecutionStatus(acc.status)) return;
          retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        },
      });
    };
    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      handle?.close();
    };
  }, [sessionId]);

  return { stream, connected };
}
