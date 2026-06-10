import { describe, expect, it } from "vitest";
import { CentaurClient } from "../src/client.js";
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
