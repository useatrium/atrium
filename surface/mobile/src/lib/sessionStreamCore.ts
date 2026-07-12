import {
  initialSessionState,
  isTerminalExecutionStatus,
  parseSseStream,
  reduceSession,
  type CentaurEventFrame,
  type ExecutionStatus,
  type JsonObject,
  type JsonValue,
  type SessionState,
} from '@atrium/centaur-client';
import type { SessionStatus } from '@atrium/surface-client';

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

const SILENT_DEATH_MS = 45_000;
const SILENT_DEATH_FALLBACK_MS = 4 * 60_000;

export function silenceThresholdMs(pingProof: boolean): number {
  return pingProof ? SILENT_DEATH_MS : SILENT_DEATH_FALLBACK_MS;
}

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

export function foldSessionFrame(state: SessionState, frame: CentaurEventFrame): SessionState {
  if (frame.event_id <= state.lastEventId && frame.event !== 'execution_state') return state;
  return reduceSession(state, frame);
}

export async function streamSessionOnce(
  options: StreamSessionOptions,
  state: SessionState = initialSessionState(),
  onState?: (state: SessionState) => void,
  onOpen?: () => void,
  onActivity?: StreamActivityCallback,
): Promise<SessionState> {
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

  onOpen?.();
  let acc = state;
  for await (const parsed of parseSseStream(response.body)) {
    if (parsed.event === 'ping') {
      const serverTs =
        isJsonObject(parsed.data) && typeof parsed.data.atrium_ts === 'string' ? parsed.data.atrium_ts : null;
      onActivity?.('ping', serverTs);
      continue;
    }
    const frame = frameFromParsedSse(parsed);
    if (!frame) continue;
    const next = foldSessionFrame(acc, frame);
    const folded = next !== acc;
    onActivity?.('frame', frame.ts ?? null, folded);
    if (folded) {
      acc = next;
      onState?.(acc);
    }
  }
  return acc;
}

export function streamIsTerminal(state: SessionState): boolean {
  return state.status !== 'idle' && isTerminalExecutionStatus(state.status);
}
