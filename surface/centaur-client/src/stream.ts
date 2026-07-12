import { eventIdFrom, isJsonObject, jsonObjectFrom, parseJsonValueOrString, stringField } from './schema.js';
import type { CentaurEventFrame, JsonObject, JsonValue } from './types.js';
import { isTerminalExecutionStatus } from './types.js';

export interface TailEventsOptions {
  baseUrl: string;
  apiKey: string;
  executionId?: string;
  afterEventId?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  headers?: () => Record<string, string | undefined>;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

interface ParsedSseFrame {
  event: string;
  data: JsonValue;
  id?: string;
}

export async function* tailEvents(threadKey: string, options: TailEventsOptions): AsyncGenerator<CentaurEventFrame> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let afterEventId = options.afterEventId ?? 0;
  let backoffMs = options.initialBackoffMs ?? 250;
  const maxBackoffMs = options.maxBackoffMs ?? 5000;
  const yieldedIds = new Set<number>();

  while (!options.signal?.aborted) {
    try {
      for await (const frame of openEventStream(fetchImpl, threadKey, { ...options, afterEventId })) {
        const eventId = frame.event_id;
        if (yieldedIds.has(eventId)) {
          continue;
        }

        yieldedIds.add(eventId);
        afterEventId = Math.max(afterEventId, eventId);
        yield frame;

        if (frame.event === 'execution_state' && isTerminalExecutionStatus(frame.data.status)) {
          return;
        }
      }

      backoffMs = options.initialBackoffMs ?? 250;
      await sleep(backoffMs, options.signal);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) {
        return;
      }
      await sleep(backoffMs, options.signal);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  }
}

async function* openEventStream(
  fetchImpl: typeof fetch,
  threadKey: string,
  options: TailEventsOptions,
): AsyncGenerator<CentaurEventFrame> {
  const url = new URL(`/api/session/${encodeURIComponent(threadKey)}/events`, withTrailingSlash(options.baseUrl));
  if (options.executionId) {
    url.searchParams.set('execution_id', options.executionId);
  }
  url.searchParams.set('after_event_id', String(options.afterEventId ?? 0));

  const init: RequestInit = {
    headers: {
      'x-api-key': options.apiKey,
      ...cleanHeaders(options.headers?.() ?? {}),
    },
  };
  if (options.signal !== undefined) init.signal = options.signal;
  const response = await fetchImpl(url, init);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Centaur event stream failed: ${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
  }
  if (!response.body) {
    throw new Error('Centaur event stream response has no body');
  }

  for await (const parsed of parseSseStream(response.body)) {
    const frame = normalizeSseFrame(parsed);
    if (frame) {
      yield frame;
    }
  }
}

function cleanHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<ParsedSseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const frame = parseSseFrame(part);
        if (frame) {
          yield frame;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const frame = parseSseFrame(buffer);
      if (frame) {
        yield frame;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(raw: string): ParsedSseFrame | null {
  let event = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') {
      event = value;
    } else if (field === 'id') {
      id = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: parseJsonOrString(dataLines.join('\n')),
    ...(id !== undefined ? { id } : {}),
  };
}

function normalizeSseFrame(frame: ParsedSseFrame): CentaurEventFrame | null {
  const data = jsonObjectFrom(frame.data) ?? {};
  const eventId = eventIdFrom(data.event_id) ?? eventIdFrom(frame.id);

  if (eventId === undefined) {
    // A malformed/id-less frame must not kill the stream: throwing here would
    // reconnect at the same after_event_id and hit the same frame forever.
    return null;
  }

  if (frame.event === 'session.output.line') {
    return normalizeOutputLine(frame.data, eventId);
  }

  if (frame.event === 'session.execution_started') {
    return {
      event: 'execution_state',
      event_id: eventId,
      data: {
        type: 'execution.state',
        status: 'running',
        thread_key: stringField(data, 'thread_key'),
        execution_id: stringField(data, 'execution_id'),
        ...data,
      },
    };
  }

  if (frame.event === 'session.execution_completed') {
    return terminalExecutionState(eventId, data, 'completed');
  }

  if (frame.event === 'session.execution_failed') {
    return terminalExecutionState(eventId, data, 'failed');
  }

  if (frame.event === 'session.execution_cancelled') {
    return terminalExecutionState(eventId, data, 'cancelled');
  }

  if (isLegacyCentaurEvent(frame.event) && isJsonObject(frame.data)) {
    return {
      event: frame.event,
      event_id: eventId,
      data: frame.data,
    } as CentaurEventFrame;
  }

  return {
    event: 'system_event_observed',
    event_id: eventId,
    data: {
      type: 'obs.system',
      engine: 'api-rs',
      harness: 'api-rs',
      thread_key: stringField(data, 'thread_key'),
      execution_id: stringField(data, 'execution_id'),
      subtype: frame.event,
      payload: frame.data,
    },
  };
}

function normalizeOutputLine(data: JsonValue, eventId: number): CentaurEventFrame {
  const parsed = typeof data === 'string' ? parseJsonOrString(data) : data;
  if (isJsonObject(parsed)) {
    const type = parsed.type;
    if (type === 'question_requested') {
      return {
        event: 'question_requested',
        event_id: eventId,
        data: parsed as CentaurEventFrame['data'],
      } as CentaurEventFrame;
    }
    if (type === 'question_resolved') {
      return {
        event: 'question_resolved',
        event_id: eventId,
        data: parsed as CentaurEventFrame['data'],
      } as CentaurEventFrame;
    }
    if (type === 'artifact.captured') {
      return {
        event: 'artifact.captured',
        event_id: eventId,
        data: parsed as CentaurEventFrame['data'],
      } as CentaurEventFrame;
    }
    return {
      event: 'amp_raw_event',
      event_id: eventId,
      data: parsed as CentaurEventFrame['data'],
    } as CentaurEventFrame;
  }

  return {
    event: 'amp_raw_event',
    event_id: eventId,
    data: { type: 'result', text: String(parsed) },
  };
}

function terminalExecutionState(
  eventId: number,
  data: JsonObject,
  status: 'completed' | 'failed' | 'cancelled',
): CentaurEventFrame {
  return {
    event: 'execution_state',
    event_id: eventId,
    data: {
      type: 'execution.state',
      status,
      thread_key: stringField(data, 'thread_key'),
      execution_id: stringField(data, 'execution_id'),
      ...(typeof data.result_text === 'string' ? { result_text: data.result_text } : {}),
      ...(typeof data.error === 'string' ? { terminal_reason: data.error } : {}),
      ...data,
    },
  };
}

function parseJsonOrString(raw: string): JsonValue {
  return parseJsonValueOrString(raw);
}

function isLegacyCentaurEvent(event: string): boolean {
  return [
    'execution_state',
    'execution_started',
    'amp_raw_event',
    'system_event_observed',
    'assistant_text_observed',
    'assistant_tool_use_observed',
    'tool_result_observed',
    'usage_observed',
    'result_observed',
    'execution_summary',
    'question_requested',
    'question_resolved',
    'artifact.captured',
  ].includes(event);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}
