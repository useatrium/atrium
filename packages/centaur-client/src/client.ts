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

  spawn(threadKey: string, harness: string): Promise<SpawnResponse> {
    return this.request("POST", "/agent/spawn", {
      thread_key: threadKey,
      harness,
    });
  }

  postMessage(
    threadKey: string,
    generation: number,
    parts: MessagePart[],
    meta: JsonObject = {},
  ): Promise<PostMessageResponse> {
    const body: JsonObject = {
      thread_key: threadKey,
      assignment_generation: generation,
      role: "user",
      parts,
      metadata: meta,
    };
    if (typeof meta.user_id === "string") {
      body.user_id = meta.user_id;
    }
    return this.request("POST", "/agent/message", body);
  }

  execute(threadKey: string, generation: number, harness: string): Promise<ExecuteResponse> {
    return this.request("POST", "/agent/execute", {
      thread_key: threadKey,
      assignment_generation: generation,
      harness,
      delivery: { platform: "dev" },
    });
  }

  release(threadKey: string, releaseId: string, cancelInflight = false): Promise<ReleaseResponse> {
    return this.request("POST", `/agent/threads/${encodeURIComponent(threadKey)}/release`, {
      release_id: releaseId,
      cancel_inflight: cancelInflight,
    });
  }

  getExecution(executionId: string): Promise<ExecutionResponse> {
    return this.request("GET", `/agent/executions/${encodeURIComponent(executionId)}`);
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
      throw new Error(`Centaur ${method} ${path} failed: ${response.status} ${response.statusText}${text ? `: ${text}` : ""}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
