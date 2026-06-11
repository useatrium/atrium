import { useEffect, useRef } from 'react';
import type { UserRef, WireEvent } from './state';

export type WsStatus = 'connecting' | 'open' | 'closed';

interface WsCallbacks {
  onEvent: (ev: WireEvent) => void;
  onPresence: (channelId: string, users: UserRef[]) => void;
  /** Someone else viewing `channelId` is typing (ephemeral, no expiry signal). */
  onTyping?: (channelId: string, user: UserRef) => void;
  /** Fires on every (re)connect after the subscribe is sent — refetch catch-up here. */
  onOpen: () => void;
  onStatus: (status: WsStatus) => void;
}

export interface WsHandle {
  /** Best-effort typing signal; throttle at the call site. */
  sendTyping: (channelId: string) => void;
}

const PING_INTERVAL_MS = 25_000;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 10_000;

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
): WsHandle {
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const channelsRef = useRef(channelIds);
  const focusRef = useRef(focusChannelId);
  const socketRef = useRef<WebSocket | null>(null);

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
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
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

    connect();
    return () => {
      disposed = true;
      clearTimers();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socketRef.current = null;
      ws?.close();
    };
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
