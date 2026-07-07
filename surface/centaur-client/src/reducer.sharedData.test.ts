import { describe, expect, it } from "vitest";
import { initialSessionState, reduceSession, type SessionState } from "./reducer.js";
import type { CentaurEventFrame } from "./types.js";

const reduceAll = (frames: CentaurEventFrame[]): SessionState =>
  frames.reduce((state, frame) => reduceSession(state, frame), initialSessionState());

describe("reduceSession shared data layer", () => {
  it("strips injected context appendices from displayed user messages", () => {
    const state = reduceAll([
      {
        event: "amp_raw_event",
        event_id: 1,
        data: {
          type: "item.completed",
          item: {
            id: "user-ref",
            type: "userMessage",
            text: "Use this entry\n\n---\nReferenced entries:\n- /e/evt_1\n# Session Context\nchannel notes",
          },
        },
      },
      {
        event: "amp_raw_event",
        event_id: 2,
        data: {
          type: "item.completed",
          item: {
            id: "user-session",
            type: "userMessage",
            text: "Use this session\n# Session Context\nchannel notes\n\n---\nReferenced entries:\n- /e/evt_1",
          },
        },
      },
      {
        event: "amp_raw_event",
        event_id: 3,
        data: {
          type: "item.completed",
          item: {
            id: "user-plain",
            type: "userMessage",
            text: "Leave this alone.",
          },
        },
      },
    ]);

    expect(state.items).toEqual([
      expect.objectContaining({ type: "user_message", id: "user-ref", text: "Use this entry" }),
      expect.objectContaining({ type: "user_message", id: "user-session", text: "Use this session" }),
      expect.objectContaining({ type: "user_message", id: "user-plain", text: "Leave this alone." }),
    ]);
  });

  it("accumulates reasoning text and summary deltas by itemId", () => {
    const state = reduceAll([
      {
        event: "amp_raw_event",
        event_id: 1,
        data: {
          method: "item/reasoning/textDelta",
          params: { itemId: "reason-1", delta: "First " },
        },
      },
      {
        event: "amp_raw_event",
        event_id: 2,
        data: {
          method: "item/reasoning/textDelta",
          params: { itemId: "reason-1", delta: "thought." },
        },
      },
      {
        event: "amp_raw_event",
        event_id: 3,
        data: {
          method: "item/reasoning/summaryTextDelta",
          params: { itemId: "reason-1", delta: "Summary " },
        },
      },
      {
        event: "amp_raw_event",
        event_id: 4,
        data: {
          method: "item/reasoning/summaryTextDelta",
          params: { itemId: "reason-1", delta: "text." },
        },
      },
    ]);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      type: "reasoning",
      id: "reasoning:reason-1",
      messageId: "reason-1",
      text: "First thought.",
      summary: "Summary text.",
      sourceEventIds: [1, 2, 3, 4],
    });
  });

  it("folds completed Codex reasoning items", () => {
    const state = reduceAll([
      {
        event: "amp_raw_event",
        event_id: 10,
        data: {
          type: "item.completed",
          item: {
            id: "reason-2",
            type: "reasoning",
            content: [{ type: "text", text: "Codex reasoning.", text_elements: [] }],
          },
        },
      },
    ]);

    expect(state.items).toEqual([
      expect.objectContaining({
        type: "reasoning",
        id: "reasoning:reason-2",
        messageId: "reason-2",
        text: "Codex reasoning.",
        sourceEventIds: [10],
      }),
    ]);
  });

  it("replaces todos from TodoWrite and sets plan from ExitPlanMode", () => {
    const state = reduceAll([
      {
        event: "amp_raw_event",
        event_id: 20,
        data: {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "todo-1",
                name: "TodoWrite",
                input: {
                  todos: [
                    { content: "Draft", status: "pending" },
                    { content: "Build", activeForm: "Building", status: "in_progress" },
                  ],
                },
              },
            ],
          },
        },
      },
      {
        event: "amp_raw_event",
        event_id: 21,
        data: {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "todo-2",
                name: "TodoWrite",
                input: {
                  todos: [{ content: "Verify", status: "completed" }],
                },
              },
            ],
          },
        },
      },
      {
        event: "amp_raw_event",
        event_id: 22,
        data: {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "plan-1",
                name: "ExitPlanMode",
                input: { plan: "1. Build shared state\n2. Test it" },
              },
            ],
          },
        },
      },
    ]);

    expect(state.todos).toEqual([{ content: "Verify", status: "completed" }]);
    expect(state.plan).toEqual({
      text: "1. Build shared state\n2. Test it",
      sourceEventIds: [22],
    });
    expect(state.items.filter((item) => item.type === "tool_call")).toHaveLength(3);
  });

  it("sets plan from completed Codex plan items", () => {
    const state = reduceAll([
      {
        event: "amp_raw_event",
        event_id: 30,
        data: {
          type: "item.completed",
          item: {
            id: "plan-2",
            type: "plan",
            text: "Codex plan",
          },
        },
      },
    ]);

    expect(state.plan).toEqual({ text: "Codex plan", sourceEventIds: [30] });
  });
});
