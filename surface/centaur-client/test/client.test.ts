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
  it("threads idempotency keys through spawn, message, and execute bodies", async () => {
    const bodies: unknown[] = [];
    const client = new CentaurClient({
      baseUrl: "http://centaur.test:8000",
      apiKey: "k",
      fetchImpl: (async (_url: URL | RequestInfo, init?: RequestInit) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return new Response(JSON.stringify({ assignment_generation: 1, execution_id: "exe_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    await client.spawn("thread-1", "claude-code", { spawnId: "spawn-1" });
    await client.postMessage("thread-1", 1, [{ type: "text", text: "hi" }], {}, { messageId: "msg-1" });
    await client.execute("thread-1", 1, "claude-code", { executeId: "exec-1" });

    expect(bodies).toEqual([
      { thread_key: "thread-1", harness: "claude-code", spawn_id: "spawn-1" },
      {
        thread_key: "thread-1",
        assignment_generation: 1,
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        metadata: {},
        message_id: "msg-1",
      },
      {
        thread_key: "thread-1",
        assignment_generation: 1,
        harness: "claude-code",
        delivery: { platform: "dev" },
        execute_id: "exec-1",
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

    await expect(client.execute("thread-1", 1, "claude-code")).rejects.toMatchObject({
      status: 409,
      code: "ASSIGNMENT_GENERATION_STALE",
    });
    await expect(client.execute("thread-1", 1, "claude-code")).rejects.toBeInstanceOf(CentaurApiError);
  });

  it("release posts to /agent/threads/{thread_key}/release (regression: was /agent/release)", async () => {
    const captured: { url?: string; body?: unknown } = {};
    const client = new CentaurClient({
      baseUrl: "http://centaur.test:8000",
      apiKey: "k",
      fetchImpl: captureFetch(captured),
    });
    await client.release("probe x/1", "rel-1", true);
    expect(captured.url).toBe(
      "http://centaur.test:8000/agent/threads/probe%20x%2F1/release",
    );
    expect(captured.body).toEqual({ release_id: "rel-1", cancel_inflight: true });
  });

  it("answerQuestion posts to /agent/executions/{execution_id}/answer", async () => {
    const captured: { url?: string; body?: unknown } = {};
    const client = new CentaurClient({
      baseUrl: "http://centaur.test:8000",
      apiKey: "k",
      fetchImpl: captureFetch(captured),
    });
    await client.answerQuestion("exe/1", "q-1", { choice: { answers: ["A"] } });
    expect(captured.url).toBe(
      "http://centaur.test:8000/agent/executions/exe%2F1/answer",
    );
    expect(captured.body).toEqual({
      question_id: "q-1",
      answers: { choice: { answers: ["A"] } },
    });
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
