import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { reduceSession, initialSessionState, type SessionState } from "../src/reducer.js";
import type { CentaurEventFrame } from "../src/types.js";

const fixture = (name: string): CentaurEventFrame[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as CentaurEventFrame[];

const reduceAll = (frames: CentaurEventFrame[]): SessionState =>
  frames.reduce((state, frame) => reduceSession(state, frame), initialSessionState());

describe("reduceSession", () => {
  it("reduces A_pong without duplicating observed text projections", () => {
    const state = reduceAll(fixture("A_pong"));

    expect(state.status).toBe("completed");
    expect(state.resultText).toContain("PONG");
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ type: "text", text: "PONG" });
  });

  it("reduces B_tooltest into one Bash tool card with result", () => {
    const state = reduceAll(fixture("B_tooltest"));
    const tools = state.items.filter((item) => item.type === "tool_call");

    expect(state.status).toBe("completed");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: "tool_call",
      name: "Bash",
      input: {
        command: expect.stringContaining("atrium-roundtrip-ok"),
      },
      result: {
        content: expect.stringContaining("atrium-roundtrip-ok"),
        is_error: false,
      },
    });
  });

  it("accumulates LONGSTREAM deltas in order and reconciles the complete message", () => {
    const frames = fixture("C_longstream");
    const assistantDeltas = frames.filter(
      (frame) =>
        frame.event === "amp_raw_event" &&
        frame.data.type === "assistant" &&
        !frame.data.uuid &&
        frame.data.message.content.some((block) => block.type === "text"),
    );
    const expected = assistantDeltas
      .flatMap((frame) =>
        frame.event === "amp_raw_event" && frame.data.type === "assistant"
          ? frame.data.message.content
          : [],
      )
      .filter((block) => block.type === "text")
      .map((block) => block.type === "text" ? block.text : "")
      .join("");

    const state = reduceAll(frames);
    const texts = state.items.filter((item) => item.type === "text");

    expect(texts).toHaveLength(1);
    expect(texts[0]?.text).toBe(expected);
    expect(texts[0]?.text).toHaveLength(expected.length);
    expect(texts[0]?.text.match(/token-0000/g)).toHaveLength(1);
    expect(texts[0]?.text.match(/token-0199/g)).toHaveLength(1);
  });

  it("tracks pending questions and clears them on resolution or terminal state", () => {
    const requested: CentaurEventFrame = {
      event: "question_requested",
      event_id: 10,
      data: {
        type: "question_requested",
        question_id: "q-1",
        turn_id: "turn-1",
        questions: [
          {
            id: "choice",
            header: "Decision",
            question: "Which path?",
            options: [{ label: "A", description: "Path A" }],
          },
        ],
      },
    };
    const withQuestion = reduceSession(initialSessionState(), requested);
    expect(withQuestion.pendingQuestion).toMatchObject({
      questionId: "q-1",
      questions: [{ id: "choice", header: "Decision" }],
    });

    const resolved = reduceSession(withQuestion, {
      event: "question_resolved",
      event_id: 11,
      data: { type: "question_resolved", question_id: "q-1", reason: "answered" },
    });
    expect(resolved.pendingQuestion).toBeNull();

    const terminal = reduceSession(withQuestion, {
      event: "execution_state",
      event_id: 12,
      data: {
        type: "execution.state",
        status: "completed",
        thread_key: "thread-1",
        execution_id: "exe-1",
      },
    });
    expect(terminal.pendingQuestion).toBeNull();
  });
});
