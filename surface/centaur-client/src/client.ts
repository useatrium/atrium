import { tailEvents, type TailEventsOptions } from "./stream.js";
import type { CentaurEventFrame, JsonObject, JsonValue } from "./types.js";

export type FetchLike = typeof fetch;

export interface CentaurClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
}

export interface SpawnResponse {
  thread_key: string;
  assignment_generation: number;
  [key: string]: JsonValue | undefined;
}

export interface MessagePart {
  type: string;
  [key: string]: JsonValue;
}

export interface PostMessageResponse {
  [key: string]: JsonValue | undefined;
}

export interface ExecuteResponse {
  execution_id: string;
  [key: string]: JsonValue | undefined;
}

export interface ReleaseResponse {
  [key: string]: JsonValue | undefined;
}

export interface ExecutionResponse {
  execution_id?: string;
  status?: string;
  result_text?: string | null;
  [key: string]: JsonValue | undefined;
}

export interface ArtifactBytes {
  /** Raw byte stream of the artifact (null only if Centaur returns an empty body). */
  body: ReadableStream<Uint8Array> | null;
  /** Content-Type Centaur reported for the staged bytes, if any. */
  contentType: string | null;
  /** Content-Length Centaur reported, if any. */
  contentLength: number | null;
}

export interface GetArtifactBytesOptions {
  /** Overrides the client's apiKey for this call. The artifact byte endpoint
   * authenticates with ARTIFACT_CAPTURE_API_KEY, which differs from the
   * session-API key the rest of the client uses. */
  apiKey?: string;
}

export interface SpawnOptions {
  spawnId?: string;
}

export interface PostMessageOptions {
  messageId?: string;
}

export interface ExecuteOptions {
  executeId?: string;
  inputLines?: string[];
  metadata?: JsonObject;
  idleTimeoutMs?: number;
  maxDurationMs?: number;
}

export class CentaurApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly code?: string;
  readonly body?: JsonValue;

  constructor(args: {
    method: string;
    path: string;
    status: number;
    statusText: string;
    text: string;
    code?: string;
    body?: JsonValue;
  }) {
    super(
      `Centaur ${args.method} ${args.path} failed: ${args.status} ${args.statusText}${args.text ? `: ${args.text}` : ""}`,
    );
    this.name = "CentaurApiError";
    this.status = args.status;
    this.statusText = args.statusText;
    this.code = args.code;
    this.body = args.body;
  }
}

export class CentaurClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: CentaurClientOptions);
  constructor(baseUrl: string, apiKey: string);
  constructor(optionsOrBaseUrl: CentaurClientOptions | string, apiKey?: string) {
    if (typeof optionsOrBaseUrl === "string") {
      if (!apiKey) {
        throw new Error("apiKey is required when constructing CentaurClient with baseUrl");
      }
      this.baseUrl = optionsOrBaseUrl;
      this.apiKey = apiKey;
      this.fetchImpl = fetch;
      return;
    }

    this.baseUrl = optionsOrBaseUrl.baseUrl;
    this.apiKey = optionsOrBaseUrl.apiKey;
    this.fetchImpl = optionsOrBaseUrl.fetchImpl ?? fetch;
  }

  spawn(threadKey: string, harness: string, opts: SpawnOptions = {}): Promise<SpawnResponse> {
    const body: JsonObject = {
      harness_type: toApiRsHarness(harness),
      metadata: {
        source: "atrium",
        harness,
        ...(opts.spawnId ? { spawn_id: opts.spawnId } : {}),
      },
    };
    return this.request<Record<string, JsonValue | undefined>>(
      "POST",
      `/api/session/${encodeURIComponent(threadKey)}`,
      body,
    ).then((session) => ({
      ...session,
      thread_key: typeof session.thread_key === "string" ? session.thread_key : threadKey,
      assignment_generation: 1,
    }));
  }

  postMessage(
    threadKey: string,
    generation: number,
    parts: MessagePart[],
    meta: JsonObject = {},
    opts: PostMessageOptions = {},
  ): Promise<PostMessageResponse> {
    const body: JsonObject = {
      messages: [
        {
          ...(opts.messageId ? { client_message_id: opts.messageId } : {}),
          role: "user",
          parts,
          metadata: meta,
        },
      ],
    };
    void generation;
    return this.request(
      "POST",
      `/api/session/${encodeURIComponent(threadKey)}/messages`,
      body,
    );
  }

  execute(threadKey: string, generation: number, harness: string, opts: ExecuteOptions = {}): Promise<ExecuteResponse> {
    const body: JsonObject = {
      idempotency_key: opts.executeId,
      metadata: {
        source: "atrium",
        harness,
        ...(opts.metadata ?? {}),
      },
      input_lines: opts.inputLines ?? [],
    };
    if (opts.idleTimeoutMs !== undefined) body.idle_timeout_ms = opts.idleTimeoutMs;
    if (opts.maxDurationMs !== undefined) body.max_duration_ms = opts.maxDurationMs;
    void generation;
    return this.request(
      "POST",
      `/api/session/${encodeURIComponent(threadKey)}/execute`,
      body,
    );
  }

  release(threadKey: string, releaseId: string, cancelInflight = false): Promise<ReleaseResponse> {
    if (!cancelInflight) {
      void threadKey;
      void releaseId;
      return Promise.resolve({ ok: true, cancel_inflight: false });
    }
    return this.request<ReleaseResponse>(
      "POST",
      `/api/session/${encodeURIComponent(threadKey)}/cancel`,
      { release_id: releaseId, cancel_inflight: true },
    ).then((response) => {
      if (response.ok === false) {
        const error =
          typeof response.stop_error === "string"
            ? response.stop_error
            : "unknown cancel failure";
        throw new Error(`Centaur session cancel failed: ${error}`);
      }
      return { ...response, cancel_inflight: true };
    });
  }

  getExecution(executionId: string): Promise<ExecutionResponse> {
    void executionId;
    return Promise.reject(new Error("api-rs does not expose execution lookup yet"));
  }

  answerQuestion(
    threadKey: string,
    executionId: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
  ): Promise<Record<string, JsonValue | undefined>> {
    return this.request("POST", `/api/session/${encodeURIComponent(threadKey)}/executions/${encodeURIComponent(executionId)}/answer`, {
      question_id: questionId,
      answers: answers as JsonObject,
    });
  }

  /**
   * Fetch a captured artifact's bytes from Centaur staging. The byte endpoint
   * is keyed by `(executionId, ref)` and authenticates with the artifact-capture
   * key (distinct from the session-API key), so `opts.apiKey` overrides the
   * client default. Returns the raw stream + reported content metadata; throws
   * {@link CentaurApiError} on a non-2xx response (e.g. 404 for an evicted ref).
   */
  async getArtifactBytes(
    executionId: string,
    ref: string,
    opts: GetArtifactBytesOptions = {},
  ): Promise<ArtifactBytes> {
    const path = `/agent/executions/${encodeURIComponent(executionId)}/artifacts/${encodeURIComponent(ref)}`;
    const response = await this.fetchImpl(new URL(path, withTrailingSlash(this.baseUrl)), {
      method: "GET",
      headers: { "x-api-key": opts.apiKey ?? this.apiKey },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const parsed = parseJson(text);
      throw new CentaurApiError({
        method: "GET",
        path,
        status: response.status,
        statusText: response.statusText,
        text,
        code: parseErrorCode(parsed),
        body: parsed,
      });
    }

    const contentLengthHeader = response.headers.get("content-length");
    const contentLength =
      contentLengthHeader !== null && /^\d+$/.test(contentLengthHeader)
        ? Number(contentLengthHeader)
        : null;
    return {
      body: response.body,
      contentType: response.headers.get("content-type"),
      contentLength,
    };
  }

  tailEvents(
    threadKey: string,
    options: Omit<TailEventsOptions, "baseUrl" | "apiKey" | "fetchImpl">,
  ): AsyncGenerator<CentaurEventFrame> {
    return tailEvents(threadKey, {
      ...options,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      fetchImpl: this.fetchImpl,
    });
  }

  private async request<T>(method: string, path: string, body?: JsonObject): Promise<T> {
    const response = await this.fetchImpl(new URL(path, withTrailingSlash(this.baseUrl)), {
      method,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const parsed = parseJson(text);
      throw new CentaurApiError({
        method,
        path,
        status: response.status,
        statusText: response.statusText,
        text,
        code: parseErrorCode(parsed),
        body: parsed,
      });
    }

    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }
}

function toApiRsHarness(harness: string): string {
  const normalized = harness.trim().toLowerCase();
  if (normalized === "claude-code" || normalized === "claude_code") return "claudecode";
  return normalized || "codex";
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function parseJson(text: string): JsonValue | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

function parseErrorCode(body: JsonValue | undefined): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const direct = body.code;
  if (typeof direct === "string") return direct;
  const error = body.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const nested = (error as JsonObject).code;
    if (typeof nested === "string") return nested;
  }
  return undefined;
}
