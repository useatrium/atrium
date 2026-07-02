import { useEffect, useState } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import { initialSessionState, type SessionState } from '@atrium/centaur-client';
import { useRequiredSession } from './session';
import { streamIsTerminal, streamSessionOnce } from './sessionStreamCore';

const RECONNECT_DELAY_MS = 1000;

export interface SessionStream {
  stream: SessionState;
  connected: boolean;
  /** Local receipt time (ms epoch) of the newest folded frame — pairs with
   * `stream.lastFrameTs` for the shared turn-status clocks. */
  lastFrameAt: number | null;
  /** `localNow - serverNow` from the latest server ping; null until seen. */
  clockSkewMs: number | null;
}

export function useSessionStream(sessionId: string | null): SessionStream {
  const { serverUrl, token } = useRequiredSession();
  const [stream, setStream] = useState<SessionState>(initialSessionState);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let acc = initialSessionState();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    setStream(acc);
    setConnected(false);

    const connect = () => {
      if (disposed || controller.signal.aborted) return;
      setConnected(false);
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
          acc = next;
          if (!disposed) setStream(next);
        },
        () => {
          if (!disposed) setConnected(true);
        },
      )
        .then((next) => {
          acc = next;
          if (disposed || controller.signal.aborted) return;
          setConnected(false);
          if (streamIsTerminal(acc)) return;
          retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        })
        .catch(() => {
          if (disposed || controller.signal.aborted) return;
          setConnected(false);
          if (streamIsTerminal(acc)) return;
          retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        });
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller.abort();
    };
  }, [serverUrl, sessionId, token]);

  // lastFrameAt/clockSkewMs are populated by the stream-liveness work; the
  // interface lands first so consumers can build against it.
  return { stream, connected, lastFrameAt: null, clockSkewMs: null };
}
