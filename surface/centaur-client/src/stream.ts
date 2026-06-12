import type { CentaurEventFrame, JsonObject } from "./types.js";
import { isTerminalExecutionStatus } from "./types.js";

export interface TailEventsOptions {
  baseUrl: string;
  apiKey: string;
  executionId?: string;
  afterEventId?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

interface ParsedSseFrame {
  event: string;
  data: JsonObject;
  id?: string;
}

export async function* tailEvents(
  threadKey: string,
  options: TailEventsOptions,
): AsyncGenerator<CentaurEventFrame> {
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

        if (
          frame.event === "execution_state" &&
          isTerminalExecutionStatus(frame.data.status)
        ) {
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
  const url = new URL(
    `/agent/threads/${encodeURIComponent(threadKey)}/events`,
    withTrailingSlash(options.baseUrl),
  );
  if (options.executionId) {
    url.searchParams.set("execution_id", options.executionId);
  }
  url.searchParams.set("after_event_id", String(options.afterEventId ?? 0));

  const response = await fetchImpl(url, {
    headers: { "x-api-key": options.apiKey },
    signal: options.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Centaur event stream failed: ${response.status} ${response.statusText}${text ? `: ${text}` : ""}`);
  }
  if (!response.body) {
    throw new Error("Centaur event stream response has no body");
  }

  for await (const parsed of parseSseStream(response.body)) {
    const frame = normalizeSseFrame(parsed);
    if (frame) {
      yield frame;
    }
  }
}

export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<ParsedSseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
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
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") {
      event = value;
    } else if (field === "id") {
      id = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    id,
    data: JSON.parse(dataLines.join("\n")) as JsonObject,
  };
}

function normalizeSseFrame(frame: ParsedSseFrame): CentaurEventFrame | null {
  const dataEventId = frame.data.event_id;
  const eventId = typeof dataEventId === "number"
    ? dataEventId
    : typeof dataEventId === "string" && /^\d+$/.test(dataEventId)
      ? Number(dataEventId)
      : frame.id && /^\d+$/.test(frame.id)
        ? Number(frame.id)
        : undefined;

  if (eventId === undefined) {
    // A malformed/id-less frame must not kill the stream: throwing here would
    // reconnect at the same after_event_id and hit the same frame forever.
    return null;
  }

  return {
    event: frame.event,
    event_id: eventId,
    data: frame.data,
  } as CentaurEventFrame;
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
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
