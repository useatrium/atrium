import { describe, expect, it } from "vitest";
import { CentaurApiError, CentaurClient } from "../src/client.js";
import { parseSseStream } from "../src/stream.js";

function captureFetch(captured: { url?: string; body?: unknown }) {
  return (async (url: URL | RequestInfo, init?: RequestInit) => {
    captured.url = String(url);
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("CentaurClient endpoint paths", () => {
  it("maps spawn, message, and execute calls onto api-rs session endpoints", async () => {
    const bodies: unknown[] = [];
    const urls: string[] = [];
    const client = new CentaurClient({
      baseUrl: "http://centaur.test:8000",
      apiKey: "k",
      fetchImpl: (async (url: URL | RequestInfo, init?: RequestInit) => {
        urls.push(String(url));
        bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return new Response(JSON.stringify({ thread_key: "thread:1", execution_id: "exe_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    await client.spawn("thread:1", "codex", { spawnId: "spawn-1" });
    await client.postMessage("thread:1", 1, [{ type: "text", text: "hi" }], {}, { messageId: "msg-1" });
    await client.execute("thread:1", 1, "codex", {
      executeId: "exec-1",
      inputLines: ['{"type":"user"}'],
    });

    expect(urls).toEqual([
      "http://centaur.test:8000/api/session/thread%3A1",
      "http://centaur.test:8000/api/session/thread%3A1/messages",
      "http://centaur.test:8000/api/session/thread%3A1/execute",
    ]);
    expect(bodies).toEqual([
      {
        harness_type: "codex",
        metadata: { source: "atrium", harness: "codex", spawn_id: "spawn-1" },
      },
      {
        messages: [
          {
            client_message_id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "hi" }],
            metadata: {},
          },
        ],
      },
      {
        idempotency_key: "exec-1",
        metadata: { source: "atrium", harness: "codex" },
        input_lines: ['{"type":"user"}'],
      },
    ]);
  });

  it("throws typed api errors with Centaur error codes when present", async () => {
    const client = new CentaurClient({
      baseUrl: "http://centaur.test:8000",
      apiKey: "k",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ code: "ASSIGNMENT_GENERATION_STALE" }), {
          status: 409,
          statusText: "Conflict",
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.execute("thread:1", 1, "codex")).rejects.toMatchObject({
      status: 409,
      code: "ASSIGNMENT_GENERATION_STALE",
    });
    await expect(client.execute("thread:1", 1, "codex")).rejects.toBeInstanceOf(CentaurApiError);
  });

  it("maps cancelling release calls onto the api-rs session cancel endpoint", async () => {
    const captured: { url?: string; body?: unknown } = {};
    const client = new CentaurClient({
      baseUrl: "http://centaur.test:8000",
      apiKey: "k",
      fetchImpl: captureFetch(captured),
    });
    await expect(client.release("probe:x/1", "rel-1", false)).resolves.toMatchObject({
      ok: true,
      cancel_inflight: false,
    });
    expect(captured.url).toBeUndefined();

    await expect(client.release("probe:x/1", "rel-1", true)).resolves.toMatchObject({
      ok: true,
      cancel_inflight: true,
    });
    expect(captured.url).toBe("http://centaur.test:8000/api/session/probe%3Ax%2F1/cancel");
    expect(captured.body).toEqual({ release_id: "rel-1", cancel_inflight: true });
  });

  it("rejects cancelling release calls when api-rs reports a stop failure", async () => {
    const client = new CentaurClient({
      baseUrl: "http://centaur.test:8000",
      apiKey: "k",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: false, stop_error: "delete failed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.release("thread:1", "rel-1", true)).rejects.toThrow(
      "Centaur session cancel failed: delete failed",
    );
  });

  it("rejects question answers until api-rs exposes an answer route", async () => {
    const client = new CentaurClient({
      baseUrl: "http://centaur.test:8000",
      apiKey: "k",
      fetchImpl: captureFetch({}),
    });
    await expect(
      client.answerQuestion("exe/1", "q-1", { choice: { answers: ["A"] } }),
    ).rejects.toThrow(
      "api-rs does not expose interactive question answers yet",
    );
  });
});

describe("SSE id-less frame handling", () => {
  it("parser surfaces frames without ids; normalize layer must skip them (no throw)", async () => {
    const bytes = new TextEncoder().encode(
      'event: ping\ndata: {"type":"ping"}\n\n' +
        'event: execution_state\ndata: {"type":"execution.state","status":"completed","event_id":7}\n\n',
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const frames = [];
    for await (const f of parseSseStream(stream)) {
      frames.push(f);
    }
    expect(frames).toHaveLength(2);
    expect(frames[0]!.data.event_id).toBeUndefined();
    expect(frames[1]!.data.event_id).toBe(7);
  });
});
