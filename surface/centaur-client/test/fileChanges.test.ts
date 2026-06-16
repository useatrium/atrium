import { describe, expect, it } from "vitest";
import {
  changedPaths,
  collectFileChanges,
  displayPath,
  fileChangeFromToolCall,
  fileChangesFromItems,
} from "../src/fileChanges.js";
import { initialSessionState, reduceSession, type SessionItem, type ToolCallItem } from "../src/reducer.js";
import type { CentaurEventFrame } from "../src/types.js";

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
            { path: "/home/agent/workspace/new.bin", kind: "add", diff: "+bytes" },
          ],
        },
      },
    } as unknown as CentaurEventFrame;

    const state = reduceSession(initialSessionState(), frame);
    expect(state.fileChanges).toHaveLength(2);
    const changes = collectFileChanges(state);
    expect(changes.map((c) => ({ path: c.path, kind: c.kind }))).toEqual([
      { path: "a.ts", kind: "update" },
      { path: "new.bin", kind: "add" },
    ]);
    // Re-applying the same frame does not duplicate (id-stable).
    const again = reduceSession(state, frame);
    expect(again.fileChanges).toHaveLength(2);
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
