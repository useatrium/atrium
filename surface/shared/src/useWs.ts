import { useEffect, useRef } from 'react';
import { Option, Schema } from 'effect';
import {
  CallUserRefSchema,
  CallWireSchema,
  isCallEvent,
  type CallEvent,
} from './calls';
import { normalizePrefs, type UserPrefs } from './prefs';
import { UserRefSchema, WireEventSchema, type UserRef, type WireEvent } from './timeline';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface WsCallbacks {
  onEvent: (ev: WireEvent) => void;
  onPresence: (channelId: string, users: UserRef[]) => void;
  /** Someone else viewing `channelId` is typing (ephemeral, no expiry signal). */
  onTyping?: (channelId: string, user: UserRef) => void;
  /** Someone else watching session `sessionId` is composing (ephemeral). */
  onSessionTyping?: (sessionId: string, user: UserRef) => void;
  onRead?: (channelId: string, lastReadEventId: number) => void;
  onMuted?: (channelId: string, muted: boolean) => void;
  onChannelPinned?: (channelId: string, pinned: boolean) => void;
  onSessionPinned?: (sessionId: string, pinned: boolean) => void;
  onChannelLeft?: (channelId: string) => void;
  /** Server-synced user preferences changed (this device or another). */
  onPrefs?: (prefs: UserPrefs) => void;
  /** Ephemeral `call.*` lifecycle frame (calls); routed off the timeline reducer. */
  onCall?: (event: CallEvent) => void;
  /** Fires on every (re)connect after the subscribe is sent — refetch catch-up here. */
  onOpen: () => void;
  onStatus: (status: WsStatus) => void;
}

export interface WsHandle {
  /** Best-effort typing signal; throttle at the call site. */
  sendTyping: (channelId: string) => void;
  /** Best-effort session-scoped typing signal; throttle at the call site. */
  sendSessionTyping: (sessionId: string) => void;
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

export interface WsSequenceTracker {
  expectedSeq: number;
  disabled: boolean;
}

const WsFrameSeqSchema = {
  seq: Schema.optionalWith(Schema.Unknown, { exact: true }),
};

const WsEventFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('event'),
  event: WireEventSchema,
  ...WsFrameSeqSchema,
}));

const WsPresenceFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('presence'),
  channelId: Schema.String,
  users: Schema.mutable(Schema.Array(UserRefSchema)),
  ...WsFrameSeqSchema,
}));

const WsChannelTypingFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('typing'),
  channelId: Schema.String,
  user: UserRefSchema,
  ...WsFrameSeqSchema,
}));

const WsSessionTypingFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('typing'),
  sessionId: Schema.String,
  user: UserRefSchema,
  ...WsFrameSeqSchema,
}));

const WsReadFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('read'),
  channelId: Schema.String,
  lastReadEventId: Schema.Number,
  ...WsFrameSeqSchema,
}));

const WsMutedFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('muted'),
  channelId: Schema.String,
  muted: Schema.Boolean,
  ...WsFrameSeqSchema,
}));

const WsChannelPinnedFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('channel-pinned'),
  channelId: Schema.String,
  pinned: Schema.Boolean,
  ...WsFrameSeqSchema,
}));

const WsSessionPinnedFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('session-pinned'),
  sessionId: Schema.String,
  pinned: Schema.Boolean,
  ...WsFrameSeqSchema,
}));

const WsChannelLeftFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('channel-left'),
  channelId: Schema.String,
  ...WsFrameSeqSchema,
}));

const WsPrefsFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('prefs'),
  prefs: Schema.Unknown,
  ...WsFrameSeqSchema,
}));

const WsPongFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('pong'),
  t: Schema.Number,
  ...WsFrameSeqSchema,
}));

const WsCallRingingFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('call.ringing'),
  call: CallWireSchema,
  ...WsFrameSeqSchema,
}));

const WsCallAcceptedFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('call.accepted'),
  callId: Schema.String,
  user: CallUserRefSchema,
  ...WsFrameSeqSchema,
}));

const WsCallDeclinedFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('call.declined'),
  callId: Schema.String,
  userId: Schema.String,
  ...WsFrameSeqSchema,
}));

const WsCallParticipantJoinedFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('call.participant_joined'),
  callId: Schema.String,
  user: CallUserRefSchema,
  ...WsFrameSeqSchema,
}));

const WsCallParticipantLeftFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('call.participant_left'),
  callId: Schema.String,
  userId: Schema.String,
  ...WsFrameSeqSchema,
}));

const WsCallEndedFrameSchema = Schema.mutable(Schema.Struct({
  type: Schema.Literal('call.ended'),
  callId: Schema.String,
  ...WsFrameSeqSchema,
}));

const WsFrameSchema = Schema.Union(
  WsEventFrameSchema,
  WsPresenceFrameSchema,
  WsChannelTypingFrameSchema,
  WsSessionTypingFrameSchema,
  WsReadFrameSchema,
  WsMutedFrameSchema,
  WsChannelPinnedFrameSchema,
  WsSessionPinnedFrameSchema,
  WsChannelLeftFrameSchema,
  WsPrefsFrameSchema,
  WsPongFrameSchema,
  WsCallRingingFrameSchema,
  WsCallAcceptedFrameSchema,
  WsCallDeclinedFrameSchema,
  WsCallParticipantJoinedFrameSchema,
  WsCallParticipantLeftFrameSchema,
  WsCallEndedFrameSchema,
);

export type DecodedWsFrame = Schema.Schema.Type<typeof WsFrameSchema>;

export function decodeWsFrame(input: unknown): DecodedWsFrame | null {
  const decoded = Schema.decodeUnknownOption(WsFrameSchema)(input);
  return Option.isSome(decoded) ? decoded.value : null;
}

export function createWsSequenceTracker(): WsSequenceTracker {
  return { expectedSeq: 1, disabled: false };
}

export function resetWsSequenceTracker(tracker: WsSequenceTracker): void {
  tracker.expectedSeq = 1;
  tracker.disabled = false;
}

export function handleWsFrameSequence(
  tracker: WsSequenceTracker,
  frame: { seq?: unknown },
  onGap: () => void,
): void {
  if (tracker.disabled) return;
  if (typeof frame.seq !== 'number' || !Number.isInteger(frame.seq) || frame.seq < 1) {
    tracker.disabled = true;
    return;
  }
  if (frame.seq > tracker.expectedSeq) onGap();
  if (frame.seq >= tracker.expectedSeq) tracker.expectedSeq = frame.seq + 1;
}

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
    const seqTracker = createWsSequenceTracker();

    const clearTimers = () => {
      if (pingTimer) clearInterval(pingTimer);
      if (idleTimer) clearTimeout(idleTimer);
      pingTimer = null;
      idleTimer = null;
    };

    const resetIdle = (current: WebSocket) => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (socketRef.current === current) current.close();
      }, IDLE_TIMEOUT_MS);
    };

    const connect = () => {
      if (disposed) return;
      clearTimers();
      cbRef.current.onStatus('connecting');
      const url = urlRef.current;
      const target = typeof url === 'function' ? url() : url ?? defaultUrl();
      const current = new WebSocket(target);
      ws = current;
      socketRef.current = current;

      current.onopen = () => {
        if (disposed || socketRef.current !== current) return;
        attempt = 0;
        resetWsSequenceTracker(seqTracker);
        cbRef.current.onStatus('open');
        current.send(JSON.stringify({ type: 'subscribe', channelIds: channelsRef.current }));
        current.send(JSON.stringify({ type: 'focus', channelId: focusRef.current }));
        cbRef.current.onOpen();
        resetIdle(current);
        pingTimer = setInterval(() => {
          if (socketRef.current === current && current.readyState === WebSocket.OPEN) {
            current.send(JSON.stringify({ type: 'ping' }));
          }
        }, PING_INTERVAL_MS);
      };

      current.onmessage = (e) => {
        if (socketRef.current !== current) return;
        resetIdle(current);
        let raw: unknown;
        try {
          raw = JSON.parse(e.data as string);
        } catch {
          return;
        }
        const msg = decodeWsFrame(raw);
        if (!msg) return;
        handleWsFrameSequence(seqTracker, msg, () => cbRef.current.onOpen());
        if (isCallEvent(msg)) cbRef.current.onCall?.(msg);
        else if (msg.type === 'event' && msg.event) cbRef.current.onEvent(msg.event);
        else if (msg.type === 'presence' && msg.channelId)
          cbRef.current.onPresence(msg.channelId, msg.users ?? []);
        else if (msg.type === 'typing' && 'sessionId' in msg)
          cbRef.current.onSessionTyping?.(msg.sessionId, msg.user);
        else if (msg.type === 'typing' && 'channelId' in msg)
          cbRef.current.onTyping?.(msg.channelId, msg.user);
        else if (
          msg.type === 'read' &&
          msg.channelId &&
          typeof msg.lastReadEventId === 'number'
        )
          cbRef.current.onRead?.(msg.channelId, msg.lastReadEventId);
        else if (msg.type === 'muted' && msg.channelId && typeof msg.muted === 'boolean')
          cbRef.current.onMuted?.(msg.channelId, msg.muted);
        else if (msg.type === 'channel-pinned' && msg.channelId && typeof msg.pinned === 'boolean')
          cbRef.current.onChannelPinned?.(msg.channelId, msg.pinned);
        else if (msg.type === 'session-pinned' && msg.sessionId && typeof msg.pinned === 'boolean')
          cbRef.current.onSessionPinned?.(msg.sessionId, msg.pinned);
        else if (msg.type === 'channel-left' && msg.channelId)
          cbRef.current.onChannelLeft?.(msg.channelId);
        else if (msg.type === 'prefs' && msg.prefs)
          cbRef.current.onPrefs?.(normalizePrefs(msg.prefs));
      };

      current.onclose = () => {
        if (socketRef.current !== current) return;
        clearTimers();
        socketRef.current = null;
        ws = null;
        if (disposed) return;
        cbRef.current.onStatus('closed');
        const backoff = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
        const jitter = backoff * (0.5 + Math.random() * 0.5);
        attempt += 1;
        reconnectTimer = setTimeout(connect, jitter);
      };

      current.onerror = () => current.close();
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
      const current = socketRef.current;
      if (current && current.readyState === WebSocket.OPEN) {
        try {
          current.send(JSON.stringify({ type: 'ping' }));
        } catch {
          current.close();
          return;
        }
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (socketRef.current === current) current.close();
        }, PROBE_TIMEOUT_MS);
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
      socketRef.current?.close();
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
      const current = socketRef.current;
      if (!current || current.readyState === WebSocket.CLOSED || current.readyState === WebSocket.CLOSING) {
        attempt = 0;
        connect();
        return;
      }
      if (current.readyState === WebSocket.OPEN) cbRef.current.onOpen();
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
    sendSessionTyping: (sessionId: string) => {
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'typing', sessionId }));
      }
    },
  };
}
