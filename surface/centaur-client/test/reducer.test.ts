import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { reduceSession, initialSessionState, type SessionState } from "../src/reducer.js";
import type { CentaurEventFrame } from "../src/types.js";

const fixture = (name: string): CentaurEventFrame[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as CentaurEventFrame[];

const reduceAll = (frames: CentaurEventFrame[]): SessionState =>
  frames.reduce((state, frame) => reduceSession(state, frame), initialSessionState());

const userMessageFrame = (eventId: number, id: string, text: string): CentaurEventFrame => ({
  event: "amp_raw_event",
  event_id: eventId,
  data: {
    type: "item.completed",
    item: {
      id,
      type: "userMessage",
      content: [{ type: "text", text, text_elements: [] }],
    },
  },
});

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

  it("accumulates Codex agentMessage deltas and replaces them with completed text", () => {
    const state = reduceAll([
      {
        event: "amp_raw_event",
        event_id: 1,
        data: { type: "system", subtype: "init", session_id: "codex-session" },
      },
      {
        event: "amp_raw_event",
        event_id: 2,
        data: {
          type: "item.started",
          item: {
            id: "prompt-1",
            type: "userMessage",
            content: [{ type: "text", text: "say howdy", text_elements: [] }],
          },
        },
      },
      {
        event: "amp_raw_event",
        event_id: 3,
        data: {
          type: "item.completed",
          item: {
            id: "prompt-1",
            type: "userMessage",
            content: [{ type: "text", text: "say howdy", text_elements: [] }],
          },
        },
      },
      {
        event: "amp_raw_event",
        event_id: 4,
        data: { type: "item.agentMessage.delta", id: "agent-1", delta: "how" },
      },
      {
        event: "amp_raw_event",
        event_id: 5,
        data: { type: "item.agentMessage.delta", id: "agent-1", delta: "dy!" },
      },
      {
        event: "amp_raw_event",
        event_id: 6,
        data: { type: "item.completed", item: { id: "agent-1", type: "agentMessage", text: "howdy" } },
      },
      {
        event: "amp_raw_event",
        event_id: 7,
        data: { type: "turn.done", result: "", turn_id: 1, agent_thread_id: "thread-1" },
      },
    ]);

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({
      type: "user_message",
      id: "prompt-1",
      text: "say howdy",
      sourceEventIds: [3],
    });
    expect(state.items[1]).toMatchObject({
      type: "text",
      id: "text:codex:agent-1",
      text: "howdy",
      messageId: "agent-1",
      sourceEventIds: [4, 5, 6],
    });
    expect(state.resultText).toBe("");
  });

  it("folds Codex userMessage completed frames with injected session context stripped", () => {
    const state = reduceAll([
      userMessageFrame(
        42,
        "steer-1",
        "Please explain the failure.\n# Session Context\n\n- **Date/Time**: 2026-06-15\n- **Thread ID**: t1\n---",
      ),
    ]);
    const userMessages = state.items.filter((item) => item.type === "user_message");

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({
      type: "user_message",
      id: "steer-1",
      text: "Please explain the failure.",
      sourceEventIds: [42],
    });
    expect(userMessages[0]?.text).not.toContain("# Session Context");
  });

  it("keeps distinct Codex userMessages in arrival order", () => {
    const state = reduceAll([
      userMessageFrame(10, "steer-1", "First steer"),
      userMessageFrame(11, "steer-2", "Second steer\n# Session Context\n\nhidden"),
    ]);

    expect(state.items).toHaveLength(2);
    expect(state.items.map((item) => item.type)).toEqual(["user_message", "user_message"]);
    expect(state.items[0]).toMatchObject({ id: "steer-1", text: "First steer" });
    expect(state.items[1]).toMatchObject({ id: "steer-2", text: "Second steer" });
    expect(state.items.every((item) => !("text" in item) || !item.text.includes("# Session Context"))).toBe(true);
  });

  it("upserts re-delivered Codex userMessages without duplicating transcript items", () => {
    const state = reduceAll([
      userMessageFrame(20, "steer-1", "Please retry\n# Session Context\n\nhidden"),
      userMessageFrame(20, "steer-1", "Please retry\n# Session Context\n\nhidden"),
      userMessageFrame(21, "steer-1", "Please retry\n# Session Context\n\nhidden"),
    ]);
    const userMessages = state.items.filter((item) => item.type === "user_message");

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({
      type: "user_message",
      id: "steer-1",
      text: "Please retry",
      sourceEventIds: [20, 21],
    });
    expect(userMessages[0]?.text).not.toContain("# Session Context");
  });

  it("renders Codex commandExecution items as tool calls with output", () => {
    const state = reduceAll([
      {
        event: "amp_raw_event",
        event_id: 1,
        data: { type: "item.started", item: { id: "cmd-1", type: "commandExecution", command: "pwd" } },
      },
      {
        event: "amp_raw_event",
        event_id: 2,
        data: { type: "item.commandExecution.outputDelta", item_id: "cmd-1", delta: "/Users/" },
      },
      {
        event: "amp_raw_event",
        event_id: 3,
        data: { type: "item.commandExecution.outputDelta", item_id: "cmd-1", delta: "gary\n" },
      },
      {
        event: "amp_raw_event",
        event_id: 4,
        data: {
          type: "item.completed",
          item: { id: "cmd-1", type: "commandExecution", command: "pwd", output: "/Users/gary\n", exit_code: 0 },
        },
      },
    ]);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      type: "tool_call",
      id: "tool:codex:cmd-1",
      name: "command",
      input: { command: "pwd" },
      result: {
        content: "/Users/gary\n",
        is_error: false,
      },
    });
  });

  it("keeps Claude reconciliation intact when Codex frames arrive later", () => {
    const state = reduceAll([
      {
        event: "amp_raw_event",
        event_id: 1,
        data: {
          type: "assistant",
          message: { id: "msg-1", content: [{ type: "text", text: "Claude " }] },
        },
      },
      {
        event: "amp_raw_event",
        event_id: 2,
        data: {
          type: "assistant",
          uuid: "uuid-1",
          message: { id: "msg-1", content: [{ type: "text", text: "Claude done." }] },
        },
      },
      {
        event: "amp_raw_event",
        event_id: 3,
        data: { type: "item.agentMessage.delta", delta: "Codex " },
      },
      {
        event: "amp_raw_event",
        event_id: 4,
        data: { type: "item.completed", item: { id: "codex-1", type: "agentMessage", text: "Codex done." } },
      },
    ]);

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ type: "text", text: "Claude done.", uuid: "uuid-1" });
    expect(state.items[1]).toMatchObject({ type: "text", text: "Codex done.", messageId: "codex-1" });
  });

  it("keeps agentMessage, commandExecution, and question folding working together", () => {
    const state = reduceAll([
      userMessageFrame(1, "steer-1", "Run pwd"),
      {
        event: "amp_raw_event",
        event_id: 2,
        data: { type: "item.completed", item: { id: "agent-1", type: "agentMessage", text: "Running pwd." } },
      },
      {
        event: "amp_raw_event",
        event_id: 3,
        data: { type: "item.started", item: { id: "cmd-1", type: "commandExecution", command: "pwd" } },
      },
      {
        event: "amp_raw_event",
        event_id: 4,
        data: {
          type: "item.completed",
          item: { id: "cmd-1", type: "commandExecution", command: "pwd", output: "/tmp\n", exit_code: 0 },
        },
      },
      {
        event: "question_requested",
        event_id: 5,
        data: {
          type: "question_requested",
          question_id: "q-1",
          questions: [{ id: "choice", header: "Decision", question: "Continue?", options: [] }],
        },
      },
    ]);

    expect(state.items.map((item) => item.type)).toEqual(["user_message", "text", "tool_call", "question"]);
    expect(state.items[1]).toMatchObject({ type: "text", text: "Running pwd.", messageId: "agent-1" });
    expect(state.items[2]).toMatchObject({
      type: "tool_call",
      id: "tool:codex:cmd-1",
      result: { content: "/tmp\n", is_error: false },
    });
    expect(state.items[3]).toMatchObject({ type: "question", id: "question:q-1", status: "pending" });
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
    expect(withQuestion.items).toHaveLength(1);
    expect(withQuestion.items[0]).toMatchObject({
      type: "question",
      id: "question:q-1",
      questionId: "q-1",
      turnId: "turn-1",
      status: "pending",
      questions: [{ id: "choice", header: "Decision", question: "Which path?" }],
      sourceEventIds: [10],
    });

    const resolved = reduceSession(withQuestion, {
      event: "question_resolved",
      event_id: 11,
      data: { type: "question_resolved", question_id: "q-1", reason: "answered" },
    });
    expect(resolved.pendingQuestion).toBeNull();
    expect(resolved.items[0]).toMatchObject({
      type: "question",
      status: "resolved",
      reason: "answered",
      sourceEventIds: [10, 11],
    });

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
    expect(terminal.items[0]).toMatchObject({
      type: "question",
      status: "resolved",
      reason: "cancelled",
      sourceEventIds: [10, 12],
    });
  });
});
