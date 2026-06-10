import { describe, expect, it } from "vitest";
import { parseSseStream, tailEvents } from "../src/stream.js";
import type { CentaurEventFrame } from "../src/types.js";

const encoder = new TextEncoder();

function streamFromChunks(chunks: string[], errorAtEnd = false): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk !== undefined) {
        controller.enqueue(encoder.encode(chunk));
        return;
      }
      if (errorAtEnd) {
        controller.error(new Error("synthetic disconnect"));
      } else {
        controller.close();
      }
    },
  });
}

function sse(frame: CentaurEventFrame): string {
  return `id: ${frame.event_id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

describe("parseSseStream", () => {
  it("parses split-across-chunks SSE frames", async () => {
    const stream = streamFromChunks([
      "id: 1\nevent: execution_state\ndata: {\"type\":\"execution.state\",",
      "\"status\":\"running\",\"thread_key\":\"t\",\"execution_id\":\"e\"}\n\nid: 2\nevent:",
      " amp_raw_event\ndata: {\"type\":\"result\",\"text\":\"ok\"}\n\n",
    ]);

    const frames = [];
    for await (const frame of parseSseStream(stream)) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      {
        id: "1",
        event: "execution_state",
        data: { type: "execution.state", status: "running", thread_key: "t", execution_id: "e" },
      },
      {
        id: "2",
        event: "amp_raw_event",
        data: { type: "result", text: "ok" },
      },
    ]);
  });
});

describe("tailEvents", () => {
  it("resumes after a disconnect and does not duplicate non-terminal ids", async () => {
    const frames: CentaurEventFrame[] = [
      { event: "execution_state", event_id: 1, data: { type: "execution.state", status: "queued", thread_key: "t", execution_id: "e" } },
      { event: "execution_state", event_id: 2, data: { type: "execution.state", status: "running", thread_key: "t", execution_id: "e" } },
      { event: "amp_raw_event", event_id: 3, data: { type: "result", text: "ok" } },
      { event: "execution_state", event_id: 4, data: { type: "execution.state", status: "completed", thread_key: "t", execution_id: "e", result_text: "ok" } },
    ];
    const requestedAfterIds: number[] = [];
    let call = 0;
    const fetchImpl: typeof fetch = async (input) => {
      call += 1;
      const url = new URL(String(input));
      requestedAfterIds.push(Number(url.searchParams.get("after_event_id")));
      const body = call === 1
        ? streamFromChunks([sse(frames[0]!), sse(frames[1]!)], true)
        : streamFromChunks([sse(frames[1]!), sse(frames[2]!), sse(frames[3]!)]);
      return new Response(body, { status: 200 });
    };

    const yielded: CentaurEventFrame[] = [];
    for await (const frame of tailEvents("t", {
      baseUrl: "http://centaur.test",
      apiKey: "key",
      executionId: "e",
      fetchImpl,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
    })) {
      yielded.push(frame);
    }

    expect(requestedAfterIds).toEqual([0, 2]);
    expect(yielded.map((frame) => frame.event_id)).toEqual([1, 2, 3, 4]);
    expect(yielded.filter((frame) => frame.event_id !== 4).map((frame) => frame.event_id)).toEqual([1, 2, 3]);
  });
});
