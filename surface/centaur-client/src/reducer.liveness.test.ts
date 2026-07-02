import { describe, expect, it } from "vitest";
import { initialSessionState, reduceSession, type SessionState } from "./reducer.js";
import type { CentaurEventFrame } from "./types.js";

const reduceAll = (frames: CentaurEventFrame[]): SessionState =>
  frames.reduce((state, frame) => reduceSession(state, frame), initialSessionState());

const running = (eventId: number, ts?: string): CentaurEventFrame =>
  ({
    event: "execution_state",
    event_id: eventId,
    data: { type: "execution.state", status: "running" },
    ...(ts ? { ts } : {}),
  }) as CentaurEventFrame;

const completed = (eventId: number, ts?: string): CentaurEventFrame =>
  ({
    event: "execution_state",
    event_id: eventId,
    data: { type: "execution.state", status: "completed" },
    ...(ts ? { ts } : {}),
  }) as CentaurEventFrame;

describe("reduceSession liveness layer", () => {
  it("stamps lastFrameTs and increments frameSeq on every fold", () => {
    const state = reduceAll([
      running(1, "2026-07-02T10:00:00.000Z"),
      {
        event: "amp_raw_event",
        event_id: 2,
        ts: "2026-07-02T10:00:05.000Z",
        data: {
          method: "item/agentMessage/delta",
          params: { itemId: "m1", delta: "hi" },
        },
      },
    ]);

    expect(state.frameSeq).toBe(2);
    expect(state.lastFrameTs).toBe("2026-07-02T10:00:05.000Z");
  });

  it("keeps the previous lastFrameTs when a frame carries no stamp", () => {
    const state = reduceAll([
      running(1, "2026-07-02T10:00:00.000Z"),
      {
        event: "amp_raw_event",
        event_id: 2,
        data: { method: "item/agentMessage/delta", params: { itemId: "m1", delta: "hi" } },
      },
    ]);

    expect(state.lastFrameTs).toBe("2026-07-02T10:00:00.000Z");
  });

  it("anchors the turn to execution_state running, refined by turn/started", () => {
    const state = reduceAll([
      running(1, "2026-07-02T10:00:00.000Z"),
      {
        event: "amp_raw_event",
        event_id: 2,
        ts: "2026-07-02T10:00:03.000Z",
        data: { method: "turn/started", params: {} },
      },
    ]);

    expect(state.turnStartTs).toBe("2026-07-02T10:00:03.000Z");
    expect(state.turnEndTs).toBeUndefined();
  });

  it("does not reset the turn anchor on a mid-turn running snapshot", () => {
    const state = reduceAll([
      running(1, "2026-07-02T10:00:00.000Z"),
      running(2, "2026-07-02T10:05:00.000Z"),
    ]);

    expect(state.turnStartTs).toBe("2026-07-02T10:00:00.000Z");
  });

  it("closes the turn on turn/completed and terminal execution_state", () => {
    const state = reduceAll([
      running(1, "2026-07-02T10:00:00.000Z"),
      {
        event: "amp_raw_event",
        event_id: 2,
        ts: "2026-07-02T10:04:00.000Z",
        data: { method: "turn/completed", params: {} },
      },
      completed(3, "2026-07-02T10:04:01.000Z"),
    ]);

    expect(state.turnEndTs).toBe("2026-07-02T10:04:00.000Z");
    expect(state.status).toBe("completed");
  });

  it("re-opens the turn when a steer regresses a completed session", () => {
    const state = reduceAll([
      running(1, "2026-07-02T10:00:00.000Z"),
      completed(2, "2026-07-02T10:04:00.000Z"),
      running(3, "2026-07-02T11:00:00.000Z"),
    ]);

    expect(state.turnStartTs).toBe("2026-07-02T11:00:00.000Z");
    expect(state.turnEndTs).toBeUndefined();
  });

  it("a new turn/started clears the previous turn end", () => {
    const state = reduceAll([
      running(1, "2026-07-02T10:00:00.000Z"),
      {
        event: "amp_raw_event",
        event_id: 2,
        ts: "2026-07-02T10:04:00.000Z",
        data: { method: "turn/completed", params: {} },
      },
      {
        event: "amp_raw_event",
        event_id: 3,
        ts: "2026-07-02T10:05:00.000Z",
        data: { method: "turn/started", params: {} },
      },
    ]);

    expect(state.turnStartTs).toBe("2026-07-02T10:05:00.000Z");
    expect(state.turnEndTs).toBeUndefined();
  });

  it("estimates tokens from streamed delta chars until real usage arrives", () => {
    const deltas = reduceAll([
      running(1, "2026-07-02T10:00:00.000Z"),
      {
        event: "amp_raw_event",
        event_id: 2,
        data: {
          method: "item/reasoning/textDelta",
          params: { itemId: "r1", delta: "twelve chars" }, // 12
        },
      },
      {
        event: "amp_raw_event",
        event_id: 3,
        data: {
          method: "item/agentMessage/delta",
          params: { itemId: "m1", delta: "eight ch" }, // 8
        },
      },
    ]);
    expect(deltas.deltaChars).toBe(20);
    expect(deltas.tokensUsed).toBeUndefined();

    const withReal = reduceSession(deltas, {
      event: "amp_raw_event",
      event_id: 4,
      data: {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "t",
          turnId: "u",
          tokenUsage: {
            total: { totalTokens: 900, inputTokens: 700, outputTokens: 150, reasoningOutputTokens: 50 },
            last: { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
          },
        },
      },
    } as never);
    // Real output tokens (150 + 50), not the input-inflated total.
    expect(withReal.tokensUsed).toBe(200);

    // Snapshots are cumulative — a stale/smaller one never regresses the count.
    const stale = reduceSession(withReal, {
      event: "amp_raw_event",
      event_id: 5,
      data: {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "t",
          turnId: "u",
          tokenUsage: {
            total: { totalTokens: 100, inputTokens: 0, outputTokens: 90, reasoningOutputTokens: 10 },
            last: { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
          },
        },
      },
    } as never);
    expect(stale.tokensUsed).toBe(200);
  });

  it("accumulates usage_observed output tokens", () => {
    const state = reduceAll([
      running(1, "2026-07-02T10:00:00.000Z"),
      {
        event: "usage_observed",
        event_id: 2,
        data: { type: "obs.usage", model: "m", cost_usd: 0.01, output_tokens: 120 },
      } as never,
      {
        event: "usage_observed",
        event_id: 3,
        data: { type: "obs.usage", model: "m", cost_usd: 0.01, output_tokens: 80 },
      } as never,
    ]);
    expect(state.tokensUsed).toBe(200);
  });

  it("flags the transport on stdout_pump_failed and clears it on recovery", () => {
    const failed: CentaurEventFrame = {
      event: "system_event_observed",
      event_id: 2,
      data: {
        type: "obs.system",
        engine: "api-rs",
        harness: "api-rs",
        thread_key: "t",
        execution_id: "e",
        subtype: "session.stdout_pump_failed",
        payload: {},
      },
    } as CentaurEventFrame;

    const midFailure = reduceAll([running(1, "2026-07-02T10:00:00.000Z"), failed]);
    expect(midFailure.transport).toBe("reattaching");

    const reattached = reduceSession(midFailure, {
      event: "system_event_observed",
      event_id: 3,
      data: {
        type: "obs.system",
        engine: "api-rs",
        harness: "api-rs",
        thread_key: "t",
        execution_id: "e",
        subtype: "session.stdout_pump_reattached",
        payload: {},
      },
    } as CentaurEventFrame);
    expect(reattached.transport).toBe("ok");

    // Harness output flowing again also proves the pipe is healthy.
    const viaOutput = reduceSession(midFailure, {
      event: "amp_raw_event",
      event_id: 3,
      ts: "2026-07-02T10:00:10.000Z",
      data: { method: "item/agentMessage/delta", params: { itemId: "m1", delta: "x" } },
    });
    expect(viaOutput.transport).toBe("ok");
  });
});
