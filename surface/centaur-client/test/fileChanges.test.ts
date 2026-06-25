import { describe, expect, it } from "vitest";
import {
  changedPaths,
  codexInlineFileChanges,
  collectFileChanges,
  displayPath,
  fileChangeFromToolCall,
  fileChangesFromItems,
} from "../src/fileChanges.js";
import { initialSessionState, reduceSession, type SessionItem, type ToolCallItem } from "../src/reducer.js";
import type { CentaurEventFrame } from "../src/types.js";

/** A codex `item.completed` frame at `eventId`. */
function codexFrame(eventId: number, item: Record<string, unknown>): CentaurEventFrame {
  return {
    event: "amp_raw_event",
    event_id: eventId,
    data: { type: "item.completed", item },
  } as unknown as CentaurEventFrame;
}

function tool(name: string, input: Record<string, unknown>, id = "t-1"): ToolCallItem {
  return { type: "tool_call", id, name, input: input as never, sourceEventIds: [1] };
}

describe("displayPath", () => {
  it("strips the absolute sandbox workspace prefix", () => {
    expect(displayPath("/home/agent/workspace/src/app.ts")).toBe("src/app.ts");
    expect(displayPath("/var/lib/workspace/a/b.py")).toBe("a/b.py");
  });
  it("leaves repo-relative paths alone", () => {
    expect(displayPath("src/app.ts")).toBe("src/app.ts");
    expect(displayPath("./x.ts")).toBe("x.ts");
  });
  it("projects canonical artifact paths to agent-visible paths", () => {
    expect(displayPath("shared/channels/channel-1/report.md")).toBe("report.md");
    expect(displayPath("scratch/11111111-1111-4111-8111-111111111111/draft.md")).toBe("scratch/draft.md");
    expect(displayPath("shared/global/handbook.md")).toBe("shared/global/handbook.md");
  });
});

describe("fileChangeFromToolCall", () => {
  it("maps Edit to an update with a -/+ hunk", () => {
    const fc = fileChangeFromToolCall(
      tool("Edit", {
        file_path: "/home/agent/workspace/src/a.ts",
        old_string: "const a = 1;",
        new_string: "const a = 2;",
      }),
    );
    expect(fc).toMatchObject({ path: "src/a.ts", kind: "update", toolName: "Edit" });
    expect(fc!.diff).toBe("- const a = 1;\n+ const a = 2;");
  });

  it("maps Write to an add (all additions)", () => {
    const fc = fileChangeFromToolCall(
      tool("Write", { file_path: "/home/agent/workspace/new.txt", content: "line1\nline2" }),
    );
    expect(fc).toMatchObject({ path: "new.txt", kind: "add" });
    expect(fc!.diff).toBe("+ line1\n+ line2");
  });

  it("concatenates MultiEdit hunks", () => {
    const fc = fileChangeFromToolCall(
      tool("MultiEdit", {
        file_path: "x.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
      }),
    );
    expect(fc!.kind).toBe("update");
    expect(fc!.diff).toBe("- a\n+ b\n- c\n+ d");
  });

  it("reads the text-editor tool's old_str/new_str (not old_string)", () => {
    const fc = fileChangeFromToolCall(
      tool("str_replace_based_edit_tool", { path: "src/a.ts", old_str: "x", new_str: "y" }),
    );
    expect(fc).toMatchObject({ path: "src/a.ts", kind: "update" });
    expect(fc!.diff).toBe("- x\n+ y");
  });

  it("does not emit a ghost line for a trailing newline in old/new strings", () => {
    const fc = fileChangeFromToolCall(
      tool("Edit", { file_path: "a.ts", old_string: "foo\n", new_string: "bar\n" }),
    );
    // "foo\n".split("\n") would be ["foo",""] — the trailing empty must be dropped.
    expect(fc!.diff).toBe("- foo\n+ bar");
  });

  it("ignores non-edit tools and edits without a path", () => {
    expect(fileChangeFromToolCall(tool("Bash", { command: "ls" }))).toBeNull();
    expect(fileChangeFromToolCall(tool("Edit", { old_string: "a", new_string: "b" }))).toBeNull();
  });
});

describe("collectFileChanges over a reduced stream (real frame path)", () => {
  it("derives a change from a Claude assistant Edit tool_use frame", () => {
    const frame: CentaurEventFrame = {
      event: "amp_raw_event",
      event_id: 1,
      data: {
        type: "assistant",
        uuid: "u1",
        message: {
          id: "m1",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Edit",
              input: {
                file_path: "/home/agent/workspace/src/x.ts",
                old_string: "a",
                new_string: "b",
              },
            },
          ],
        },
      },
    } as unknown as CentaurEventFrame;

    const state = reduceSession(initialSessionState(), frame);
    const changes = collectFileChanges(state);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "src/x.ts", kind: "update", toolName: "Edit" });
  });

  it("captures codex fileChange frames (changes[].{path,kind,diff}) and strips paths", () => {
    const frame: CentaurEventFrame = {
      event: "amp_raw_event",
      event_id: 5,
      data: {
        type: "item.completed",
        item: {
          id: "fc-1",
          type: "fileChange",
          changes: [
            { path: "/home/agent/workspace/a.ts", kind: "update", diff: "@@\n-x\n+y" },
            { path: "/home/agent/workspace/new.txt", kind: "add", diff: "hello\nworld" },
          ],
        },
      },
    } as unknown as CentaurEventFrame;

    const state = reduceSession(initialSessionState(), frame);
    expect(state.fileChanges).toHaveLength(2);
    const changes = collectFileChanges(state);
    expect(changes.map((c) => ({ path: c.path, kind: c.kind }))).toEqual([
      { path: "a.ts", kind: "update" },
      { path: "new.txt", kind: "add" },
    ]);
    // Codex `add` diff (raw content, no prefix) is normalized to +/green; the
    // update hunk is left as-is.
    expect(changes[1]!.diff).toBe("+ hello\n+ world");
    expect(changes[0]!.diff).toBe("@@\n-x\n+y");
    // Re-applying the same frame does not duplicate (id-stable) and does NOT
    // mutate the prior state's array.
    const before = state.fileChanges;
    const again = reduceSession(state, frame);
    expect(state.fileChanges).toBe(before); // prior state untouched
    expect(state.fileChanges).toHaveLength(2);
    expect(again.fileChanges).not.toBe(before); // fresh array
    expect(again.fileChanges).toHaveLength(2); // still deduped
  });

  it("ignores a fileChange item with no changes[] array", () => {
    const frame: CentaurEventFrame = {
      event: "amp_raw_event",
      event_id: 7,
      data: { type: "item.completed", item: { id: "fc-x", type: "fileChange" } },
    } as unknown as CentaurEventFrame;
    expect(reduceSession(initialSessionState(), frame).fileChanges).toHaveLength(0);
  });

  it("merges codex + claude edits in collectFileChanges", () => {
    let state = initialSessionState();
    state = reduceSession(state, {
      event: "amp_raw_event",
      event_id: 1,
      data: {
        type: "assistant",
        uuid: "u1",
        message: {
          id: "m1",
          content: [
            { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "claude.ts", old_string: "a", new_string: "b" } },
          ],
        },
      },
    } as unknown as CentaurEventFrame);
    state = reduceSession(state, {
      event: "amp_raw_event",
      event_id: 2,
      data: { type: "item.completed", item: { id: "fc-1", type: "fileChange", changes: [{ path: "codex.ts", kind: "add", diff: "+x" }] } },
    } as unknown as CentaurEventFrame);
    expect(changedPaths(collectFileChanges(state))).toEqual(["claude.ts", "codex.ts"]);
  });
});

describe("fileChangesFromItems", () => {
  it("collects edits across the transcript and counts distinct paths", () => {
    const items: SessionItem[] = [
      { type: "text", id: "x", text: "hi", sourceEventIds: [1] },
      tool("Edit", { file_path: "a.ts", old_string: "1", new_string: "2" }, "t1"),
      tool("Bash", { command: "ls" }, "t2"),
      tool("Write", { file_path: "a.ts", content: "x" }, "t3"),
      tool("Write", { file_path: "b.ts", content: "y" }, "t4"),
    ];
    const changes = fileChangesFromItems(items);
    expect(changes.map((c) => c.id)).toEqual(["t1", "t3", "t4"]);
    expect(changedPaths(changes)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("codexInlineFileChanges (inline transcript placement)", () => {
  it("anchors each codex edit after the items that preceded it (by event id)", () => {
    // Built directly so the placement math is tested in isolation (the reducer
    // merges consecutive codex messages into one item, which the reduce-path is
    // exercised for in the web sessionPane test). Two messages at ev1 / ev5; an
    // edit at ev3 lands between them, an edit at ev7 after both.
    const state = initialSessionState();
    state.items = [
      { type: "text", id: "m1", text: "starting", sourceEventIds: [1] },
      { type: "text", id: "m2", text: "done", sourceEventIds: [5] },
    ];
    state.fileChanges = [
      { id: "fc-1", path: "/home/agent/workspace/a.ts", kind: "update", diff: "@@\n-x\n+y", toolName: "fileChange", sourceEventIds: [3] },
      { id: "fc-2", path: "/home/agent/workspace/b.ts", kind: "delete", diff: "@@\n-gone", toolName: "fileChange", sourceEventIds: [7] },
    ];

    const anchored = codexInlineFileChanges(state);
    expect(anchored.map((a) => ({ path: a.change.path, index: a.index }))).toEqual([
      { path: "a.ts", index: 1 }, // after m1 (ev1), before m2 (ev5)
      { path: "b.ts", index: 2 }, // after both messages
    ]);
  });

  it("normalizes paths + add diffs identically to the drawer (collectFileChanges), and excludes claude edits", () => {
    let state = initialSessionState();
    // A Claude Edit tool_use (becomes a transcript item, NOT a codex fileChange).
    state = reduceSession(state, {
      event: "amp_raw_event",
      event_id: 1,
      data: {
        type: "assistant",
        uuid: "u1",
        message: {
          id: "m1",
          content: [
            { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "claude.ts", old_string: "a", new_string: "b" } },
          ],
        },
      },
    } as unknown as CentaurEventFrame);
    // A codex add whose diff is raw file content (no +/- prefix).
    state = reduceSession(state, codexFrame(2, {
      id: "fc-1", type: "fileChange",
      changes: [{ path: "/home/agent/workspace/new.txt", kind: "add", diff: "hello\nworld" }],
    }));

    const anchored = codexInlineFileChanges(state);
    // Only the codex change — the Claude edit renders inline via its tool_call item.
    expect(anchored).toHaveLength(1);
    expect(anchored[0]!.change).toMatchObject({ path: "new.txt", kind: "add" });
    // Same normalization the drawer applies (path stripped, add → +/green).
    const fromDrawer = collectFileChanges(state).find((c) => c.path === "new.txt")!;
    expect(anchored[0]!.change.diff).toBe("+ hello\n+ world");
    expect(anchored[0]!.change.diff).toBe(fromDrawer.diff);
  });

  it("anchors a codex edit that precedes all transcript items at index 0", () => {
    let state = initialSessionState();
    state = reduceSession(state, codexFrame(2, {
      id: "fc-1", type: "fileChange",
      changes: [{ path: "/home/agent/workspace/early.ts", kind: "update", diff: "@@\n-x\n+y" }],
    }));
    state = reduceSession(state, codexFrame(5, { id: "m1", type: "agentMessage", text: "after the edit" }));
    const anchored = codexInlineFileChanges(state);
    expect(anchored).toEqual([expect.objectContaining({ index: 0 })]);
    expect(anchored[0]!.change.path).toBe("early.ts");
  });
});
