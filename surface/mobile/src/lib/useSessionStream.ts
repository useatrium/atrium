import { useEffect, useRef, useState } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import { initialSessionState, type SessionState } from '@atrium/centaur-client';
import { useRequiredSession } from './session';
import { silenceThresholdMs, streamIsTerminal, streamSessionOnce } from './sessionStreamCore';

const RECONNECT_DELAY_MS = 1000;
const WATCHDOG_TICK_MS = 10_000;

export interface SessionStream {
  stream: SessionState;
  connected: boolean;
  /** Local receipt time (ms epoch) of the newest folded frame — pairs with
   * `stream.lastFrameTs` for the shared turn-status clocks. */
  lastFrameAt: number | null;
  /** `localNow - serverNow` from the latest server ping; null until seen. */
  clockSkewMs: number | null;
}

/**
 * `active` should be true whenever the session has (or is about to have) a
 * live turn. The retry loop legitimately stops after folding a terminal
 * execution — so when a follow-up steer regresses a completed session back to
 * running (observed via the session entity, not this stream), nothing would
 * re-open the stream. `active` flipping true forces one reconnect from the
 * folded cursor (web parity — see surface/web useSessionStream).
 */
export function useSessionStream(sessionId: string | null, active = false): SessionStream {
  const { serverUrl, token } = useRequiredSession();
  const [stream, setStream] = useState<SessionState>(initialSessionState);
  const [connected, setConnected] = useState(false);
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
  const [clockSkewMs, setClockSkewMs] = useState<number | null>(null);
  // Set per mount to the current run's forced-reconnect trigger; the
  // `active`-watch effect below calls it. Nulled on cleanup.
  const ensureConnectedRef = useRef<(() => void) | null>(null);
  // The session entity's liveness, readable inside the stream loop's guards
  // without re-running the effect.
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!sessionId) {
      // The owning screen can outlive its session (re-pointed from a
      // session-attached thread to a plain one). Without this reset the
      // previous session's folded state keeps rendering (web parity).
      setStream(initialSessionState());
      setConnected(false);
      setLastFrameAt(null);
      setClockSkewMs(null);
      return;
    }
    let disposed = false;
    let acc = initialSessionState();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let currentAttempt: AbortController | null = null;
    let liveAt = Date.now();
    let pingEver = false;
    setStream(acc);
    setConnected(false);
    setLastFrameAt(null);
    setClockSkewMs(null);

    // The loop stops on a terminal fold ONLY while the session entity agrees
    // it's over: a steer that revives a completed session flips `active` true
    // (via activeRef), which both re-arms these guards and lets the retry path
    // keep trying if the forced reopen itself fails.
    const shouldStop = () => streamIsTerminal(acc) && !activeRef.current;

    const scheduleReconnect = () => {
      if (disposed || retryTimer || shouldStop()) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, RECONNECT_DELAY_MS);
    };

    const settleAttempt = (controller: AbortController, next?: SessionState) => {
      if (currentAttempt !== controller) return;
      currentAttempt = null;
      if (next) acc = next;
      if (disposed) return;
      setConnected(false);
      scheduleReconnect();
    };

    const connect = () => {
      if (disposed || currentAttempt || shouldStop()) return;
      const controller = new AbortController();
      currentAttempt = controller;
      liveAt = Date.now();
      setConnected(false);
      const isCurrentAttempt = () => !disposed && currentAttempt === controller;
      streamSessionOnce(
        {
          baseUrl: serverUrl,
          token,
          sessionId,
          afterEventId: acc.lastEventId,
          signal: controller.signal,
          fetchImpl: expoFetch,
        },
        acc,
        (next) => {
          if (!isCurrentAttempt()) return;
          acc = next;
          setStream(next);
        },
        () => {
          if (!isCurrentAttempt()) return;
          liveAt = Date.now();
          setConnected(true);
        },
        (kind, serverTs, folded) => {
          if (!isCurrentAttempt()) return;
          const now = Date.now();
          liveAt = now;
          if (kind === 'frame') {
            if (folded) setLastFrameAt(now);
            return;
          }
          pingEver = true;
          if (serverTs === null) return;
          const parsed = Date.parse(serverTs);
          if (!Number.isNaN(parsed)) setClockSkewMs(now - parsed);
        },
      )
        .then((next) => {
          settleAttempt(controller, next);
        })
        .catch(() => {
          settleAttempt(controller);
        });
    };

    connect();

    // Reconnect when the session goes active again (steer on a completed
    // session). A no-op while a retry is pending; a silently-dead lingering
    // attempt past the silence threshold is recycled rather than trusted —
    // otherwise the revive-steer would starve behind a hung fetch.
    ensureConnectedRef.current = () => {
      if (disposed || retryTimer) return;
      if (currentAttempt) {
        if (Date.now() - liveAt < silenceThresholdMs(pingEver)) return;
        currentAttempt.abort();
        return; // settleAttempt reconnects via scheduleReconnect
      }
      connect();
    };

    // NO terminal exemption: a healthy terminal replay settles and nulls
    // currentAttempt, so a lingering attempt on a terminal fold is exactly the
    // silently-dead-connection case and must be recycled or a later steer
    // starves behind it (settleAttempt's shouldStop() decides whether the
    // recycle also reconnects).
    watchdogTimer = setInterval(() => {
      if (disposed || !currentAttempt || currentAttempt.signal.aborted) return;
      const threshold = silenceThresholdMs(pingEver);
      if (Date.now() - liveAt < threshold) return;
      setConnected(false);
      currentAttempt.abort();
    }, WATCHDOG_TICK_MS);

    return () => {
      disposed = true;
      ensureConnectedRef.current = null;
      if (retryTimer) clearTimeout(retryTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      currentAttempt?.abort();
    };
  }, [serverUrl, sessionId, token]);

  useEffect(() => {
    if (active) ensureConnectedRef.current?.();
  }, [active, sessionId]);

  return { stream, connected, lastFrameAt, clockSkewMs };
}
