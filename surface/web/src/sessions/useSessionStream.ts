import { useEffect, useRef, useState } from 'react';
import {
  createSessionStreamMachine,
  initialSessionState,
  type SessionState,
  type SessionStreamMachine,
  type SessionStreamScheduler,
  type SessionStreamState,
} from '@atrium/centaur-client';
import { sessionsApi } from './api';

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

const scheduler: SessionStreamScheduler = {
  now: () => Date.now(),
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
  repeat(intervalMs, callback) {
    const timer = setInterval(callback, intervalMs);
    return () => clearInterval(timer);
  },
  scheduleFlush(callback) {
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(frame);
    }
    const timer = setTimeout(callback, 16);
    return () => clearTimeout(timer);
  },
};

const initialStreamState = (): SessionStreamState => ({
  stream: initialSessionState(),
  connected: false,
  lastFrameAt: null,
  clockSkewMs: null,
});

/**
 * `active` should be true whenever the session has (or is about to have) a live
 * turn. A terminal replay legitimately stops reconnecting; when a follow-up
 * steer regresses the session to running, the active flip reopens from the
 * last folded event id so the transcript is neither lost nor double-folded.
 */
export function useSessionStream(sessionId: string | null, active = false): SessionStream {
  const [state, setState] = useState<SessionStreamState>(initialStreamState);
  const machineRef = useRef<SessionStreamMachine | null>(null);

  // Like mobile's former activeRef, terminal/error guards see the newest prop
  // during render without rebuilding the session transport effect.
  machineRef.current?.setActive(active);

  useEffect(() => {
    const machine = createSessionStreamMachine(
      {
        open: (id, afterEventId, callbacks) => sessionsApi.openStream(id, afterEventId, callbacks),
      },
      scheduler,
    );
    machine.setActive(active);
    machineRef.current = machine;
    const unsubscribe = machine.subscribe(setState);
    machine.start(sessionId);

    return () => {
      if (machineRef.current === machine) machineRef.current = null;
      unsubscribe();
      machine.stop();
    };
  }, [sessionId]);

  // Re-arm after a completed session becomes active again. ensureConnected is
  // safe while connected or retrying and recycles a silently dead handle.
  useEffect(() => {
    const machine = machineRef.current;
    machine?.setActive(active);
    if (active) machine?.ensureConnected();
  }, [active, sessionId]);

  return state;
}
