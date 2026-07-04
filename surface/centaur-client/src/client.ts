import { tailEvents, type TailEventsOptions } from "./stream.js";
import { errorCodeFromBody, jsonObjectFrom, parseJsonValue } from "./schema.js";
import type { CentaurEventFrame, JsonObject, JsonValue } from "./types.js";

export type FetchLike = typeof fetch;

export interface CentaurClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  headers?: () => Record<string, string | undefined>;
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

export interface InterruptTurnResponse {
  ok?: boolean;
  interrupted?: boolean;
  execution_id?: string | null;
  error?: string | null;
  [key: string]: JsonValue | undefined;
}

export interface ExecutionResponse {
  execution_id?: string;
  status?: string;
  result_text?: string | null;
  [key: string]: JsonValue | undefined;
}

/** A repo to check out into the sandbox at spawn. `repo` is `owner/name`
 * (resolved against the node repo-cache); `ref` is the branch/tag. Folded into
 * `centaur_session_repos` server-side → `AGENT_REPOS_JSON` → entrypoint checkout. */
export interface RepoSpec {
  repo: string;
  ref?: string;
  subdir?: string;
  private?: boolean;
}

export interface SpawnOptions {
  spawnId?: string;
  repos?: RepoSpec[];
  metadata?: JsonObject;
}

export interface PostMessageOptions {
  messageId?: string;
}

export interface ExecuteOptions {
  executeId?: string;
  inputLines?: string[];
  metadata?: JsonObject;
  environment?: Record<string, string>;
  idleTimeoutMs?: number;
  maxDurationMs?: number;
}

export class CentaurApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly code: string | undefined;
  readonly body: JsonValue | undefined;

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
  private readonly headers: () => Record<string, string | undefined>;

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
      this.headers = () => ({});
      return;
    }

    this.baseUrl = optionsOrBaseUrl.baseUrl;
    this.apiKey = optionsOrBaseUrl.apiKey;
    this.fetchImpl = optionsOrBaseUrl.fetchImpl ?? fetch;
    this.headers = optionsOrBaseUrl.headers ?? (() => ({}));
  }

  spawn(threadKey: string, harness: string, opts: SpawnOptions = {}): Promise<SpawnResponse> {
    const body: JsonObject = {
      harness_type: toApiRsHarness(harness),
      metadata: {
        source: "atrium",
        harness,
        ...(opts.metadata ?? {}),
        ...(opts.spawnId ? { spawn_id: opts.spawnId } : {}),
      },
      ...(opts.repos && opts.repos.length
        ? { repos: opts.repos.map((r) => ({ ...r })) }
        : {}),
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
      metadata: {
        source: "atrium",
        harness,
        ...(opts.metadata ?? {}),
      },
      input_lines: opts.inputLines ?? [],
    };
    if (opts.executeId !== undefined) body.idempotency_key = opts.executeId;
    if (opts.environment !== undefined) body.environment = opts.environment;
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

  interruptTurn(threadKey: string): Promise<InterruptTurnResponse> {
    const path = `/api/session/${encodeURIComponent(threadKey)}/interrupt`;
    return this.request<InterruptTurnResponse>("POST", path, {}).then((response) => {
      if (response.ok === false) {
        const error = typeof response.error === "string" && response.error.length > 0
          ? response.error
          : "unknown interrupt failure";
        throw new CentaurApiError({
          method: "POST",
          path,
          status: 502,
          statusText: "Bad Gateway",
          text: `interrupt failed: ${error}`,
          code: "centaur_interrupt_failed",
          body: response,
        });
      }
      return response;
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

  tailEvents(
    threadKey: string,
    options: Omit<TailEventsOptions, "baseUrl" | "apiKey" | "fetchImpl">,
  ): AsyncGenerator<CentaurEventFrame> {
    return tailEvents(threadKey, {
      ...options,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      fetchImpl: this.fetchImpl,
      headers: this.headers,
    });
  }

  private async request<T extends JsonObject = JsonObject>(method: string, path: string, body?: JsonObject): Promise<T> {
    const extraHeaders = cleanHeaders(this.headers());
    const init: RequestInit = {
      method,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        ...extraHeaders,
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.fetchImpl(new URL(path, withTrailingSlash(this.baseUrl)), init);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const parsed = parseJson(text);
      const code = parseErrorCode(parsed);
      throw new CentaurApiError({
        method,
        path,
        status: response.status,
        statusText: response.statusText,
        text,
        ...(code !== undefined ? { code } : {}),
        ...(parsed !== undefined ? { body: parsed } : {}),
      });
    }

    if (response.status === 204) {
      return {} as T;
    }

    const parsed = await response.json().catch(() => undefined) as unknown;
    const decoded = jsonObjectFrom(parsed);
    if (!decoded) {
      throw new CentaurApiError({
        method,
        path,
        status: response.status,
        statusText: response.statusText,
        text: "invalid JSON object response",
        code: "invalid_json_object_response",
      });
    }
    return decoded as T;
  }
}

function cleanHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
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
  return parseJsonValue(text);
}

function parseErrorCode(body: JsonValue | undefined): string | undefined {
  return errorCodeFromBody(body);
}
