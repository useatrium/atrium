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
// The server pings every 15s (and once at open); three missed beats means the
// connection silently died (EventSource never fires onerror for a dead TCP
// path, e.g. through a tunnel) — tear down and reconnect from the cursor.
const SILENT_DEATH_MS = 45_000;
// Without ping proof (a connection that died before its first ping, or an
// old comment-only server) death and legitimate silence look identical —
// recycle on a much longer horizon instead of never.
const SILENT_DEATH_FALLBACK_MS = 4 * 60_000;
const WATCHDOG_TICK_MS = 10_000;

export interface SessionStream {
  stream: SessionState;
  connected: boolean;
  /** Local receipt time (ms epoch) of the newest folded frame — pairs with
   * `stream.lastFrameTs` for skew-free "quiet for Ns" and elapsed clocks. */
  lastFrameAt: number | null;
  /** `localNow - serverNow` from the latest ping; add to a server timestamp
   * to compare it against Date.now(). Null until the first ping. */
  clockSkewMs: number | null;
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
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
  const [clockSkewMs, setClockSkewMs] = useState<number | null>(null);
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
    // Any sign of life on the wire (open, ping, frame) refreshes this.
    let liveAt = Date.now();
    // Whether any connection this mount has delivered a named ping. With
    // ping proof, prolonged silence is death; without it (not-yet-rolled
    // comment-only server, or a connection that died pre-ping) the watchdog
    // falls back to a long horizon instead of either churning healthy quiet
    // streams or never recycling dead ones. (A server doesn't downgrade, so
    // proof from an earlier connection carries forward.)
    let pingEver = false;
    let frameAt: number | null = null;
    setStream(acc);
    setConnected(false);
    setLastFrameAt(null);
    setClockSkewMs(null);

    // Batch per-frame folds into one React commit per animation frame — the
    // LONGSTREAM capture delivers >1k frames in a couple of seconds.
    const scheduleFlush = () => {
      if (flushScheduled) return;
      flushScheduled = true;
      const raf =
        typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16);
      raf(() => {
        flushScheduled = false;
        if (disposed) return;
        setStream(acc);
        setLastFrameAt(frameAt);
      });
    };

    const onFrame = (frame: CentaurEventFrame) => {
      liveAt = Date.now();
      // Dedupe on resume: skip already-folded ids, but allow execution_state
      // (the terminal snapshot is legitimately re-emitted on replay).
      if (frame.event_id <= acc.lastEventId && frame.event !== 'execution_state') return;
      frameAt = Date.now();
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
      liveAt = Date.now();
      handle = sessionsApi.openStream(sessionId, acc.lastEventId, {
        onFrame: (frame) => {
          if (isCurrent()) onFrame(frame);
        },
        onOpen: () => {
          if (!isCurrent()) return;
          liveAt = Date.now();
          setConnected(true);
        },
        onPing: (serverTs) => {
          if (!isCurrent()) return;
          liveAt = Date.now();
          pingEver = true;
          if (serverTs !== null) {
            const parsed = Date.parse(serverTs);
            if (!Number.isNaN(parsed)) setClockSkewMs(Date.now() - parsed);
          }
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

    // Tear down the current handle so connect() can start a fresh one.
    const recycle = () => {
      handle?.close();
      handle = null;
      generation += 1;
      setConnected(false);
    };

    // Re-open the stream if it's currently closed (no live handle, no pending
    // retry). Safe to call spuriously — a no-op while connected or retrying.
    // A handle that has been silently dead past the ping window is recycled
    // rather than trusted: without this, a steer after a lost server FIN
    // would no-op here and the new turn would never stream.
    ensureConnectedRef.current = () => {
      if (disposed || retryTimer) return;
      if (handle) {
        if (Date.now() - liveAt < SILENT_DEATH_MS) return;
        recycle();
      }
      connect();
    };

    connect();

    // Silent-death watchdog: a dead TCP path never fires EventSource.onerror.
    // With ping proof (this connection, or any earlier one this mount — a
    // server doesn't downgrade), 45s of total silence means the connection is
    // gone; without proof, use the long fallback horizon. No terminal
    // exemption: a cleanly-closed post-replay stream nulls `handle` via
    // onError, so a lingering handle on a terminal fold is exactly the
    // dead-connection case (and must be recycled or a later steer starves).
    const watchdog = setInterval(() => {
      if (disposed || !handle) return;
      const threshold = pingEver ? SILENT_DEATH_MS : SILENT_DEATH_FALLBACK_MS;
      if (Date.now() - liveAt < threshold) return;
      recycle();
      connect();
    }, WATCHDOG_TICK_MS);

    return () => {
      disposed = true;
      ensureConnectedRef.current = null;
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(watchdog);
      handle?.close();
    };
  }, [sessionId]);

  // When the session becomes active again (e.g. a follow-up steer flips a
  // completed session back to running), re-open the SSE the server already
  // closed. Keyed on sessionId too so we re-arm against the fresh mount.
  useEffect(() => {
    if (active) ensureConnectedRef.current?.();
  }, [active, sessionId]);

  return { stream, connected, lastFrameAt, clockSkewMs };
}
