import { useEffect, useRef } from 'react';
import type { UserRef, WireEvent } from './timeline';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface WsCallbacks {
  onEvent: (ev: WireEvent) => void;
  onPresence: (channelId: string, users: UserRef[]) => void;
  /** Someone else viewing `channelId` is typing (ephemeral, no expiry signal). */
  onTyping?: (channelId: string, user: UserRef) => void;
  onRead?: (channelId: string, lastReadEventId: number) => void;
  onMuted?: (channelId: string, muted: boolean) => void;
  onChannelLeft?: (channelId: string) => void;
  /** Fires on every (re)connect after the subscribe is sent — refetch catch-up here. */
  onOpen: () => void;
  onStatus: (status: WsStatus) => void;
}

export interface WsHandle {
  /** Best-effort typing signal; throttle at the call site. */
  sendTyping: (channelId: string) => void;
}

export interface WsOptions {
  /**
   * Full websocket URL or per-attempt supplier (lets native clients append a
   * fresh auth token). Default: same-origin /ws — browser only.
   */
  url?: string | (() => string);
  /**
   * Subscribe to "the app came back to the foreground" (e.g. React Native
   * AppState). On wake the hook reconnects immediately if it was waiting on
   * backoff, or ping-probes a socket the OS may have silently killed while
   * the app was suspended (dead sockets close within ~5s instead of waiting
   * out the 60s idle timer). Must be referentially stable; returns an
   * unsubscribe.
   */
  onWake?: (cb: () => void) => () => void;
}

const PING_INTERVAL_MS = 25_000;
const IDLE_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_BACKOFF_MS = 10_000;

function defaultUrl(): string {
  const loc = (globalThis as { location?: { protocol: string; host: string } }).location;
  if (!loc?.host) throw new Error('useWs: pass a websocket url outside the browser');
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${loc.host}/ws`;
}

/**
 * Reconnecting WebSocket subscribed to a set of channels. `focusChannelId`
 * tells the server which channel this client is actually viewing — channel
 * presence is focus-based, not subscription-based.
 */
export function useWs(
  enabled: boolean,
  channelIds: string[],
  callbacks: WsCallbacks,
  focusChannelId: string | null = null,
  options: WsOptions = {},
): WsHandle {
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const channelsRef = useRef(channelIds);
  const focusRef = useRef(focusChannelId);
  const socketRef = useRef<WebSocket | null>(null);
  const urlRef = useRef(options.url);
  urlRef.current = options.url;

  // Re-subscribe when the channel set changes on a live socket.
  const channelsKey = channelIds.join(',');
  useEffect(() => {
    channelsRef.current = channelIds;
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', channelIds }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsKey]);

  // Tell the server where we're looking when the active channel changes.
  useEffect(() => {
    focusRef.current = focusChannelId;
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'focus', channelId: focusChannelId }));
    }
  }, [focusChannelId]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let attempt = 0;
    let ws: WebSocket | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (pingTimer) clearInterval(pingTimer);
      if (idleTimer) clearTimeout(idleTimer);
      pingTimer = null;
      idleTimer = null;
    };

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ws?.close(), IDLE_TIMEOUT_MS);
    };

    const connect = () => {
      if (disposed) return;
      cbRef.current.onStatus('connecting');
      const url = urlRef.current;
      const target = typeof url === 'function' ? url() : url ?? defaultUrl();
      ws = new WebSocket(target);
      socketRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        cbRef.current.onStatus('open');
        ws!.send(JSON.stringify({ type: 'subscribe', channelIds: channelsRef.current }));
        ws!.send(JSON.stringify({ type: 'focus', channelId: focusRef.current }));
        cbRef.current.onOpen();
        resetIdle();
        pingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (e) => {
        resetIdle();
        let msg: {
          type?: string;
          event?: WireEvent;
          channelId?: string;
          lastReadEventId?: number;
          muted?: boolean;
          users?: UserRef[];
          user?: UserRef;
        };
        try {
          msg = JSON.parse(e.data as string);
        } catch {
          return;
        }
        if (msg.type === 'event' && msg.event) cbRef.current.onEvent(msg.event);
        else if (msg.type === 'presence' && msg.channelId)
          cbRef.current.onPresence(msg.channelId, msg.users ?? []);
        else if (msg.type === 'typing' && msg.channelId && msg.user)
          cbRef.current.onTyping?.(msg.channelId, msg.user);
        else if (
          msg.type === 'read' &&
          msg.channelId &&
          typeof msg.lastReadEventId === 'number'
        )
          cbRef.current.onRead?.(msg.channelId, msg.lastReadEventId);
        else if (msg.type === 'muted' && msg.channelId && typeof msg.muted === 'boolean')
          cbRef.current.onMuted?.(msg.channelId, msg.muted);
        else if (msg.type === 'channel-left' && msg.channelId)
          cbRef.current.onChannelLeft?.(msg.channelId);
      };

      ws.onclose = () => {
        clearTimers();
        socketRef.current = null;
        if (disposed) return;
        cbRef.current.onStatus('closed');
        const backoff = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
        const jitter = backoff * (0.5 + Math.random() * 0.5);
        attempt += 1;
        reconnectTimer = setTimeout(connect, jitter);
      };

      ws.onerror = () => ws?.close();
    };

    // Foreground wake: skip any pending backoff, or probe a possibly-dead
    // socket with a tight deadline (any inbound frame re-arms the normal
    // idle timer via resetIdle).
    const onWakeSignal = () => {
      if (disposed) return;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        attempt = 0;
        connect();
        return;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          ws.close();
          return;
        }
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => ws?.close(), PROBE_TIMEOUT_MS);
      }
    };
    const unWake = options.onWake?.(onWakeSignal);

    connect();
    return () => {
      disposed = true;
      clearTimers();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      unWake?.();
      socketRef.current = null;
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return {
    sendTyping: (channelId: string) => {
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'typing', channelId }));
      }
    },
  };
}
