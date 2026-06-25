import { describe, expect, it } from "vitest";
import { reduceSession, initialSessionState, type SessionState } from "../src/reducer.js";
import { collectArtifacts, artifactPaths } from "../src/artifacts.js";
import type { ArtifactCaptured, CentaurEventFrame } from "../src/types.js";

const reduceAll = (frames: CentaurEventFrame[]): SessionState =>
  frames.reduce((state, frame) => reduceSession(state, frame), initialSessionState());

const artifactFrame = (eventId: number, data: Partial<ArtifactCaptured>): CentaurEventFrame => ({
  event: "artifact.captured",
  event_id: eventId,
  data: {
    type: "artifact.captured",
    artifact_id: "a1",
    path: "/home/agent/workspace/out.png",
    kind: "created",
    mime: "image/png",
    size_bytes: 2048,
    sha256: "deadbeef",
    ref: "blob-1",
    ...data,
  },
});

describe("artifact.captured reducer", () => {
  it("folds captured artifacts into state.artifacts", () => {
    const state = reduceAll([
      artifactFrame(5, { artifact_id: "a1", path: "/tmp/chart.png" }),
      artifactFrame(6, { artifact_id: "a2", path: "/home/agent/workspace/report.pdf", mime: "application/pdf", ref: null, size_bytes: 9_000_000 }),
    ]);
    expect(state.artifacts).toHaveLength(2);
    expect(state.artifacts[0]).toMatchObject({ id: "a1", kind: "created", mime: "image/png", ref: "blob-1" });
    // Manifest-only (over-cap / junk): no bytes staged.
    expect(state.artifacts[1]).toMatchObject({ id: "a2", ref: null, size: 9_000_000 });
  });

  it("captures execution_id (and null when the event omits it)", () => {
    const state = reduceAll([
      artifactFrame(5, { artifact_id: "a1", execution_id: "exe_abc" }),
      artifactFrame(6, { artifact_id: "a2" }), // pre-execution_id event
    ]);
    expect(state.artifacts[0]).toMatchObject({ id: "a1", executionId: "exe_abc" });
    expect(state.artifacts[1]).toMatchObject({ id: "a2", executionId: null });
  });

  it("dedups by stable artifact_id across reconnect replays", () => {
    const state = reduceAll([
      artifactFrame(5, { artifact_id: "a1" }),
      artifactFrame(5, { artifact_id: "a1" }), // replayed same id+event
      artifactFrame(8, { artifact_id: "a1" }), // same content re-captured
    ]);
    expect(state.artifacts).toHaveLength(1);
  });

  it("collectArtifacts strips the sandbox prefix; artifactPaths counts distinct files", () => {
    const state = reduceAll([
      artifactFrame(5, { artifact_id: "a1", path: "/home/agent/workspace/src/out.png" }),
      artifactFrame(6, { artifact_id: "a2", path: "/tmp/x.csv", mime: "text/csv" }),
    ]);
    const arts = collectArtifacts(state);
    expect(arts.map((a) => a.path)).toEqual(["src/out.png", "/tmp/x.csv"]);
    expect(artifactPaths(arts)).toHaveLength(2);
  });

  it("folds artifact.presented events into state.artifactPresentations", () => {
    const state = reduceAll([
      {
        event: "artifact.presented",
        event_id: 12,
        data: {
          type: "artifact.presented",
          execution_id: "exe_123",
          path: "shared/apps/demo/index.html",
          title: "Demo App",
          renderer: "html-app",
          description: "Interactive demo",
        },
      },
    ]);
    expect(state.artifactPresentations).toEqual([
      {
        id: "artifact-presented:shared/apps/demo/index.html",
        path: "shared/apps/demo/index.html",
        title: "Demo App",
        renderer: "html-app",
        description: "Interactive demo",
        executionId: "exe_123",
        sourceEventIds: [12],
      },
    ]);
    expect(state.items).toEqual([
      {
        type: "artifact_presentation",
        id: "artifact-presented:shared/apps/demo/index.html",
        path: "shared/apps/demo/index.html",
        title: "Demo App",
        renderer: "html-app",
        description: "Interactive demo",
        executionId: "exe_123",
        sourceEventIds: [12],
      },
    ]);
  });
});
