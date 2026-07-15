import { useEffect, useRef, useState } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import {
  createSessionStreamMachine,
  initialSessionState,
  type SessionState,
  type SessionStreamMachine,
  type SessionStreamScheduler,
  type SessionStreamState,
} from '@atrium/centaur-client';
import { useRequiredSession } from './session';
import { createMobileSessionStreamTransport } from './sessionStreamCore';

export interface SessionStream {
  stream: SessionState;
  connected: boolean;
  /** Local receipt time (ms epoch) of the newest folded frame — pairs with
   * `stream.lastFrameTs` for the shared turn-status clocks. */
  lastFrameAt: number | null;
  /** `localNow - serverNow` from the latest server ping; null until seen. */
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
 * `active` should be true whenever the session has (or is about to have) a
 * live turn. The retry loop stops after a terminal fold while inactive; a
 * follow-up steer flips active true and reopens from the folded cursor.
 */
export function useSessionStream(sessionId: string | null, active = false): SessionStream {
  const { serverUrl, token } = useRequiredSession();
  const [state, setState] = useState<SessionStreamState>(initialStreamState);
  const machineRef = useRef<SessionStreamMachine | null>(null);

  // Preserve the old activeRef semantics: async guards can read the newest
  // prop without making active a dependency of the transport lifecycle.
  machineRef.current?.setActive(active);

  useEffect(() => {
    const machine = createSessionStreamMachine(
      createMobileSessionStreamTransport({ baseUrl: serverUrl, token, fetchImpl: expoFetch }),
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
  }, [serverUrl, sessionId, token]);

  useEffect(() => {
    const machine = machineRef.current;
    machine?.setActive(active);
    if (active) machine?.ensureConnected();
  }, [active, sessionId]);

  return state;
}
