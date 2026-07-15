import {
  foldSessionFrame,
  initialSessionState,
  parseSseStream,
  type CentaurEventFrame,
  type ExecutionStatus,
  type JsonObject,
  type JsonValue,
  type SessionStreamCallbacks,
  type SessionStreamTransport,
  type SessionState,
} from '@atrium/centaur-client';
import type { SessionStatus } from '@atrium/surface-client';

export { silenceThresholdMs, streamIsTerminal } from '@atrium/centaur-client';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface StreamSessionOptions {
  baseUrl: string;
  token: string;
  sessionId: string;
  afterEventId: number;
  signal: AbortSignal;
  fetchImpl: FetchLike;
}

export type StreamActivityKind = 'frame' | 'ping';
/** `folded` is false for deduplicated replay frames — still liveness (bytes
 * are flowing; the watchdog must not recycle a healthy replay), but not a new
 * fold (the lastFrameAt clock only advances on real folds). */
export type StreamActivityCallback = (kind: StreamActivityKind, serverTs: string | null, folded?: boolean) => void;

export function normalizeExecutionStatus(status: ExecutionStatus): SessionStatus {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'failed_permanent':
      return 'failed';
    default:
      return 'running';
  }
}

export function frameFromParsedSse(parsed: { event: string; id?: string; data: JsonValue }): CentaurEventFrame | null {
  if (!isJsonObject(parsed.data)) return null;
  const dataEventId = parsed.data.event_id;
  const eventId =
    typeof dataEventId === 'number'
      ? dataEventId
      : typeof dataEventId === 'string' && /^\d+$/.test(dataEventId)
        ? Number(dataEventId)
        : parsed.id && /^\d+$/.test(parsed.id)
          ? Number(parsed.id)
          : undefined;

  if (eventId === undefined) return null;
  // Proxy wall-clock stamp (see web parseFrame) — feeds item.ts in the reducer.
  const ts = typeof parsed.data.atrium_ts === 'string' ? parsed.data.atrium_ts : undefined;
  return {
    event: parsed.event,
    event_id: eventId,
    data: parsed.data,
    ...(ts ? { ts } : {}),
  } as CentaurEventFrame;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function streamSessionOnce(
  options: StreamSessionOptions,
  state: SessionState = initialSessionState(),
  onState?: (state: SessionState) => void,
  onOpen?: () => void,
  onActivity?: StreamActivityCallback,
): Promise<SessionState> {
  let acc = state;
  await consumeSessionStream(options, {
    onOpen: () => onOpen?.(),
    onPing: (serverTs) => onActivity?.('ping', serverTs),
    onFrame: (frame) => {
      const next = foldSessionFrame(acc, frame);
      const folded = next !== acc;
      onActivity?.('frame', frame.ts ?? null, folded);
      if (folded) {
        acc = next;
        onState?.(acc);
      }
    },
  });
  return acc;
}

interface ConsumeSessionStreamCallbacks {
  onFrame(frame: CentaurEventFrame): void;
  onOpen(): void;
  onPing(serverTs: string | null): void;
}

async function consumeSessionStream(
  options: StreamSessionOptions,
  callbacks: ConsumeSessionStreamCallbacks,
): Promise<void> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(
    options.sessionId,
  )}/stream?after_event_id=${options.afterEventId}`;
  const response = await options.fetchImpl(url, {
    headers: { authorization: `Bearer ${options.token}` },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`session stream failed (${response.status})`);
  }
  if (!response.body) {
    throw new Error('session stream response has no body');
  }

  callbacks.onOpen();
  for await (const parsed of parseSseStream(response.body)) {
    if (parsed.event === 'ping') {
      const serverTs =
        isJsonObject(parsed.data) && typeof parsed.data.atrium_ts === 'string' ? parsed.data.atrium_ts : null;
      callbacks.onPing(serverTs);
      continue;
    }
    const frame = frameFromParsedSse(parsed);
    if (!frame) continue;
    callbacks.onFrame(frame);
  }
}

export function createMobileSessionStreamTransport(options: {
  baseUrl: string;
  token: string;
  fetchImpl: FetchLike;
}): SessionStreamTransport {
  return {
    open(sessionId: string, afterEventId: number, callbacks: SessionStreamCallbacks) {
      const controller = new AbortController();
      let closed = false;
      void consumeSessionStream(
        {
          ...options,
          sessionId,
          afterEventId,
          signal: controller.signal,
        },
        callbacks,
      ).then(
        () => {
          if (!closed) callbacks.onError();
        },
        () => {
          if (!closed) callbacks.onError();
        },
      );
      return {
        close() {
          closed = true;
          controller.abort();
        },
      };
    },
  };
}
