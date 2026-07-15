import { initialSessionState, reduceSession, type SessionState } from './reducer.js';
import { isTerminalExecutionStatus, type CentaurEventFrame } from './types.js';

const RECONNECT_DELAY_MS = 1_000;
// The server pings every 15s (and once at open); three missed beats means the
// connection silently died (some transports never report a dead TCP path) —
// tear down and reconnect from the folded cursor.
const SILENT_DEATH_MS = 45_000;
// Without ping proof (a connection that died before its first ping, or an old
// comment-only server) death and legitimate silence look identical — recycle
// on a much longer horizon instead of never.
const SILENT_DEATH_FALLBACK_MS = 4 * 60_000;
const WATCHDOG_TICK_MS = 10_000;

export interface SessionStreamCallbacks {
  onFrame(frame: CentaurEventFrame): void;
  onOpen(): void;
  onPing(serverTs: string | null): void;
  onError(): void;
}

export interface SessionStreamHandle {
  close(): void;
}

export interface SessionStreamTransport {
  open(sessionId: string, afterEventId: number, callbacks: SessionStreamCallbacks): SessionStreamHandle;
}

export interface SessionStreamScheduler {
  now(): number;
  /** Schedule once and return a cancellation function. */
  schedule(delayMs: number, callback: () => void): () => void;
  /** Schedule repeatedly and return a cancellation function. */
  repeat(intervalMs: number, callback: () => void): () => void;
  /** Publish accumulated frames on the platform's next render boundary. */
  scheduleFlush(callback: () => void): () => void;
}

export interface SessionStreamState {
  stream: SessionState;
  connected: boolean;
  /** Local receipt time (ms epoch) of the newest folded frame. */
  lastFrameAt: number | null;
  /** `localNow - serverNow` from the latest valid server ping. */
  clockSkewMs: number | null;
}

export interface SessionStreamMachine {
  start(sessionId: string | null): void;
  stop(): void;
  /** Updates terminal/retry guards without causing transport I/O. */
  setActive(active: boolean): void;
  /** Reopens a closed stream, or recycles a silently dead one. */
  ensureConnected(): void;
  getState(): SessionStreamState;
  subscribe(listener: (state: SessionStreamState) => void): () => void;
}

interface Connection {
  handle: SessionStreamHandle | null;
}

export function silenceThresholdMs(pingProof: boolean): number {
  return pingProof ? SILENT_DEATH_MS : SILENT_DEATH_FALLBACK_MS;
}

export function streamIsTerminal(state: SessionState): boolean {
  return state.status !== 'idle' && isTerminalExecutionStatus(state.status);
}

export function foldSessionFrame(state: SessionState, frame: CentaurEventFrame): SessionState {
  // Dedupe on resume, except for the terminal execution snapshot that the
  // durable stream legitimately re-emits during replay.
  if (frame.event_id <= state.lastEventId && frame.event !== 'execution_state') return state;
  return reduceSession(state, frame);
}

export function createSessionStreamMachine(
  transport: SessionStreamTransport,
  scheduler: SessionStreamScheduler,
): SessionStreamMachine {
  let state = freshState();
  let acc = state.stream;
  let sessionId: string | null = null;
  let active = false;
  // Terminal retries are re-armed by an actual inactive -> active transition,
  // not merely by active already being true while the entity status lags a
  // just-folded terminal frame. This preserves terminal replay stop while
  // still carrying a failed follow-up reopen until its running frame arrives.
  let terminalRetryOverride = false;
  let stopped = true;
  let connection: Connection | null = null;
  let cancelRetry: (() => void) | null = null;
  let cancelWatchdog: (() => void) | null = null;
  let cancelFlush: (() => void) | null = null;
  let liveAt = 0;
  // Whether any connection for this attached session has delivered a named
  // ping. A server doesn't downgrade, so proof carries across reconnects.
  let pingEver = false;
  let pendingFrameAt: number | null = null;
  const listeners = new Set<(next: SessionStreamState) => void>();

  const publish = (patch: Partial<SessionStreamState> = {}) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };

  // Batch per-frame folds into one platform commit per render boundary — the
  // LONGSTREAM capture delivers >1k frames in a couple of seconds.
  const scheduleFoldFlush = () => {
    if (cancelFlush) return;
    const pending = { cancel: () => {} };
    cancelFlush = () => pending.cancel();
    pending.cancel = scheduler.scheduleFlush(() => {
      if (cancelFlush === null) return;
      cancelFlush = null;
      if (stopped || sessionId === null) return;
      publish({ stream: acc, lastFrameAt: pendingFrameAt });
    });
  };

  const shouldStop = () => streamIsTerminal(acc) && !terminalRetryOverride;

  const closeConnection = () => {
    const current = connection;
    connection = null;
    // Invalidate first: close/abort can synchronously or asynchronously report
    // an error, and that stale callback must not schedule another reconnect.
    current?.handle?.close();
  };

  const recycle = () => {
    closeConnection();
    if (state.connected) publish({ connected: false });
  };

  const scheduleReconnect = () => {
    if (stopped || sessionId === null || cancelRetry || shouldStop()) return;
    const pending = { cancel: () => {} };
    cancelRetry = () => pending.cancel();
    pending.cancel = scheduler.schedule(RECONNECT_DELAY_MS, () => {
      if (cancelRetry === null) return;
      cancelRetry = null;
      connect();
    });
  };

  const connect = () => {
    if (stopped || sessionId === null || connection || shouldStop()) return;
    const current: Connection = { handle: null };
    connection = current;
    liveAt = scheduler.now();

    const isCurrent = () => !stopped && connection === current;
    const handle = transport.open(sessionId, acc.lastEventId, {
      onFrame(frame) {
        if (!isCurrent()) return;
        liveAt = scheduler.now();
        const next = foldSessionFrame(acc, frame);
        if (next === acc) return;
        pendingFrameAt = scheduler.now();
        acc = next;
        if (!streamIsTerminal(acc)) terminalRetryOverride = false;
        scheduleFoldFlush();
      },
      onOpen() {
        if (!isCurrent()) return;
        liveAt = scheduler.now();
        if (!state.connected) publish({ connected: true });
      },
      onPing(serverTs) {
        if (!isCurrent()) return;
        const now = scheduler.now();
        liveAt = now;
        pingEver = true;
        if (serverTs === null) return;
        const parsed = Date.parse(serverTs);
        if (!Number.isNaN(parsed)) publish({ clockSkewMs: now - parsed });
      },
      onError() {
        if (!isCurrent()) return;
        closeConnection();
        if (state.connected) publish({ connected: false });
        // A finished replay ends with a terminal state — don't loop forever.
        // If a later turn regresses the session to active, ensureConnected()
        // re-opens it. While active, failed forced reopens keep retrying.
        scheduleReconnect();
      },
    });
    current.handle = handle;
    // A synchronous transport callback may have invalidated this attempt
    // before open() returned its handle.
    if (!isCurrent()) handle.close();
  };

  const stopRun = () => {
    stopped = true;
    cancelRetry?.();
    cancelRetry = null;
    cancelWatchdog?.();
    cancelWatchdog = null;
    cancelFlush?.();
    cancelFlush = null;
    closeConnection();
  };

  const machine: SessionStreamMachine = {
    start(nextSessionId) {
      stopRun();
      sessionId = nextSessionId;
      stopped = false;
      acc = initialSessionState();
      pendingFrameAt = null;
      pingEver = false;
      terminalRetryOverride = false;
      liveAt = scheduler.now();
      // The owner can outlive its session. Without this reset, the previous
      // session's folded state renders in an unrelated thread after detach.
      publish({ stream: acc, connected: false, lastFrameAt: null, clockSkewMs: null });
      if (sessionId === null) return;

      connect();
      // Silent-death watchdog: a dead TCP path may never report an error.
      // With ping proof, 45s of total silence means the connection is gone;
      // without proof, use the long fallback horizon. No terminal exemption:
      // a cleanly closed replay nulls the handle through onError, so a
      // lingering handle on a terminal fold is exactly the dead case.
      cancelWatchdog = scheduler.repeat(WATCHDOG_TICK_MS, () => {
        if (stopped || !connection) return;
        if (scheduler.now() - liveAt < silenceThresholdMs(pingEver)) return;
        recycle();
        connect();
      });
    },

    stop() {
      stopRun();
    },

    setActive(nextActive) {
      if (!stopped && !active && nextActive) terminalRetryOverride = true;
      if (!nextActive) terminalRetryOverride = false;
      active = nextActive;
    },

    ensureConnected() {
      if (stopped || sessionId === null || cancelRetry) return;
      if (connection) {
        if (scheduler.now() - liveAt < silenceThresholdMs(pingEver)) return;
        recycle();
      }
      connect();
    },

    getState() {
      return state;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return machine;
}

function freshState(): SessionStreamState {
  return {
    stream: initialSessionState(),
    connected: false,
    lastFrameAt: null,
    clockSkewMs: null,
  };
}
