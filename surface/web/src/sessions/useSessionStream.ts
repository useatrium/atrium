// Fold the proxied Centaur SSE stream into a SessionState with the shared
// reducer. Handles resume: on stream error the EventSource is recreated with
// after_event_id=<last folded id>, and already-seen frames are dropped
// (duplicate terminal execution_state snapshots are allowed, per the schema).

import { useEffect, useRef, useState } from 'react';
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

/**
 * `active` should be true whenever the session has (or is about to have) a live
 * turn — i.e. its session-level status is non-terminal. The server closes this
 * SSE after replaying a *terminal* session's mirror (it only live-tails a
 * non-terminal session), and the client's own retry loop stops on a terminal
 * fold. So when a completed session regresses to running on a follow-up steer,
 * nothing would re-open the stream. `active` flipping back to true drives that
 * re-open, resuming from the last folded event id so the transcript is neither
 * lost nor double-folded.
 */
export function useSessionStream(sessionId: string | null, active = false): SessionStream {
  const [stream, setStream] = useState<SessionState>(initialSessionState);
  const [connected, setConnected] = useState(false);
  // Set per mount to the current run's reconnect trigger; the `active`-watch
  // effect below calls it. Nulled on cleanup so it never fires a disposed run.
  const ensureConnectedRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let acc = initialSessionState();
    let handle: SessionStreamHandle | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let flushScheduled = false;
    let generation = 0;
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
      // Guard re-entry: only one open handle at a time. ensureConnected() and
      // the retry timer both funnel through here.
      if (disposed || handle) return;
      generation += 1;
      const handleGeneration = generation;
      const isCurrent = () => !disposed && generation === handleGeneration;
      handle = sessionsApi.openStream(sessionId, acc.lastEventId, {
        onFrame: (frame) => {
          if (isCurrent()) onFrame(frame);
        },
        onOpen: () => {
          if (isCurrent()) setConnected(true);
        },
        onError: () => {
          if (!isCurrent()) return;
          handle?.close();
          handle = null;
          generation += 1;
          if (disposed) return;
          setConnected(false);
          // A finished replay ends with a terminal state — don't loop forever.
          // If a later turn regresses the session to active, the `active`-watch
          // effect re-opens via ensureConnected().
          if (acc.status !== 'idle' && isTerminalExecutionStatus(acc.status)) return;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            connect();
          }, RECONNECT_DELAY_MS);
        },
      });
    };

    // Re-open the stream if it's currently closed (no live handle, no pending
    // retry). Safe to call spuriously — a no-op while connected or retrying.
    ensureConnectedRef.current = () => {
      if (disposed || handle || retryTimer) return;
      connect();
    };

    connect();

    return () => {
      disposed = true;
      ensureConnectedRef.current = null;
      if (retryTimer) clearTimeout(retryTimer);
      handle?.close();
    };
  }, [sessionId]);

  // When the session becomes active again (e.g. a follow-up steer flips a
  // completed session back to running), re-open the SSE the server already
  // closed. Keyed on sessionId too so we re-arm against the fresh mount.
  useEffect(() => {
    if (active) ensureConnectedRef.current?.();
  }, [active, sessionId]);

  return { stream, connected };
}
