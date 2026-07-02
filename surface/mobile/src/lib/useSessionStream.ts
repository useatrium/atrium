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

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let acc = initialSessionState();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let currentAttempt: AbortController | null = null;
    let liveAt = Date.now();
    let pingSeen = false;
    let pingEver = false;
    setStream(acc);
    setConnected(false);
    setLastFrameAt(null);
    setClockSkewMs(null);

    const scheduleReconnect = () => {
      if (disposed || retryTimer || streamIsTerminal(acc)) return;
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

    const connect = (force = false) => {
      if (disposed || currentAttempt || (!force && streamIsTerminal(acc))) return;
      const controller = new AbortController();
      currentAttempt = controller;
      liveAt = Date.now();
      pingSeen = false;
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
        (kind, serverTs) => {
          if (!isCurrentAttempt()) return;
          const now = Date.now();
          liveAt = now;
          if (kind === 'frame') {
            setLastFrameAt(now);
            return;
          }
          pingSeen = true;
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

    // Force one reconnect past the terminal stop when the session goes active
    // again (steer on a completed session). No-op while an attempt or retry
    // is in flight.
    ensureConnectedRef.current = () => {
      if (disposed || currentAttempt || retryTimer) return;
      connect(true);
    };

    watchdogTimer = setInterval(() => {
      if (disposed || !currentAttempt || currentAttempt.signal.aborted) return;
      if (streamIsTerminal(acc)) return;
      const threshold = silenceThresholdMs(pingSeen || pingEver);
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
