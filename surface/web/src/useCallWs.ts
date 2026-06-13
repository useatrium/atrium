import { useEffect, useRef } from 'react';
import {
  handleWsFrameSequence,
  isCallEvent,
  normalizePrefs,
  resetWsSequenceTracker,
  createWsSequenceTracker,
  type CallEvent,
  type UserRef,
  type WireEvent,
  type WsCallbacks,
  type WsHandle,
  type WsOptions,
  type WsStatus,
} from '@atrium/surface-client';

export type { WsStatus };

export interface CallWsCallbacks extends WsCallbacks {
  onCall?: (event: CallEvent) => void;
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
 * Web-local websocket wrapper. It mirrors the shared hook, with one extra
 * branch for ephemeral `call.*` frames so they never reach the timeline reducer.
 */
export function useWs(
  enabled: boolean,
  channelIds: string[],
  callbacks: CallWsCallbacks,
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

  const channelsKey = channelIds.join(',');
  useEffect(() => {
    channelsRef.current = channelIds;
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', channelIds }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsKey]);

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
    const seqTracker = createWsSequenceTracker();

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
        resetWsSequenceTracker(seqTracker);
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
          prefs?: unknown;
          seq?: unknown;
        };
        try {
          msg = JSON.parse(e.data as string);
        } catch {
          return;
        }
        handleWsFrameSequence(seqTracker, msg, () => cbRef.current.onOpen());
        if (isCallEvent(msg)) cbRef.current.onCall?.(msg);
        else if (msg.type === 'event' && msg.event) cbRef.current.onEvent(msg.event);
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
        else if (msg.type === 'prefs' && msg.prefs)
          cbRef.current.onPrefs?.(normalizePrefs(msg.prefs));
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
    const globalEvents = globalThis as unknown as {
      addEventListener?: (type: string, listener: EventListener) => void;
      removeEventListener?: (type: string, listener: EventListener) => void;
    };
    const onOfflineSignal = () => {
      if (disposed) return;
      clearTimers();
      cbRef.current.onStatus('closed');
      ws?.close();
    };
    const onOnlineSignal = () => {
      if (disposed) return;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        attempt = 0;
        connect();
        return;
      }
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        attempt = 0;
        connect();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) cbRef.current.onOpen();
    };
    globalEvents.addEventListener?.('offline', onOfflineSignal);
    globalEvents.addEventListener?.('online', onOnlineSignal);

    connect();
    return () => {
      disposed = true;
      clearTimers();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      unWake?.();
      globalEvents.removeEventListener?.('offline', onOfflineSignal);
      globalEvents.removeEventListener?.('online', onOnlineSignal);
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
