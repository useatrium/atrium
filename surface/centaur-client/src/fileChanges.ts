// Changes surface (Phase 4): derive the set of file edits a session made from
// the already-folded transcript items — "Changes/diff is free from frames". This
// covers the Claude/amp edit tools (Edit / Write / MultiEdit / NotebookEdit),
// which arrive as tool_call items with a known input schema. Codex `fileChange`
// items (changes[].{path,kind,diff}) are a separate source handled later; they
// are dropped by the reducer today.

import type { JsonObject } from "./types.js";
import type { SessionItem, ToolCallItem } from "./reducer.js";

export type FileChangeKind = "add" | "update" | "delete";

export interface FileChange {
  /** Stable id (the source tool-call id) for dedup + React keys. */
  id: string;
  /** Display path — the absolute sandbox/workspace prefix is stripped. */
  path: string;
  kind: FileChangeKind;
  /** Unified-style diff text synthesized from the tool input. */
  diff: string;
  /** The tool that made the edit (Edit / Write / …). */
  toolName: string;
  sourceEventIds: number[];
}

// Claude Code's Edit + the Anthropic text-editor tool (whose str_replace command
// uses old_str/new_str, not old_string/new_string).
const EDIT_TOOLS = new Set(["Edit", "str_replace_editor", "str_replace_based_edit_tool"]);
const WRITE_TOOLS = new Set(["Write", "create_file"]);
const MULTI_EDIT_TOOLS = new Set(["MultiEdit"]);
const NOTEBOOK_TOOLS = new Set(["NotebookEdit"]);

/** Strip the absolute sandbox prefix so /home/agent/workspace/src/x.ts → src/x.ts. */
export function displayPath(path: string): string {
  const m = /\/workspace\/(.+)$/.exec(path);
  if (m) return m[1]!;
  return path.replace(/^\.\//, "");
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Split into lines, dropping a single trailing empty from a terminal newline
 * (old_string/content frequently end with "\n", which would emit a ghost line). */
function splitLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Old lines render as removals, new lines as additions. Claude's Edit already
 * passes the minimal changed region, so no LCS is needed for a readable hunk. */
function synthDiff(oldText: string | null, newText: string | null): string {
  const lines: string[] = [];
  if (oldText) for (const l of splitLines(oldText)) lines.push(`- ${l}`);
  if (newText) for (const l of splitLines(newText)) lines.push(`+ ${l}`);
  return lines.join("\n");
}

function pathFrom(input: JsonObject): string | null {
  return (
    str(input["file_path"]) ??
    str(input["path"]) ??
    str(input["notebook_path"]) ??
    str(input["filePath"])
  );
}

/** Map a single Claude/amp edit tool_call to a FileChange, or null if it is not
 * a file edit / is missing a path. */
export function fileChangeFromToolCall(item: ToolCallItem): FileChange | null {
  const path = pathFrom(item.input);
  if (!path) return null;

  let kind: FileChangeKind;
  let diff: string;

  if (EDIT_TOOLS.has(item.name)) {
    kind = "update";
    const oldText = str(item.input["old_string"]) ?? str(item.input["old_str"]);
    const newText = str(item.input["new_string"]) ?? str(item.input["new_str"]);
    diff = synthDiff(oldText, newText);
  } else if (WRITE_TOOLS.has(item.name)) {
    kind = "add";
    diff = synthDiff(null, str(item.input["content"]) ?? str(item.input["file_text"]));
  } else if (MULTI_EDIT_TOOLS.has(item.name)) {
    kind = "update";
    const edits = Array.isArray(item.input["edits"]) ? (item.input["edits"] as unknown[]) : [];
    diff = edits
      .map((e) =>
        e && typeof e === "object" && !Array.isArray(e)
          ? synthDiff(str((e as JsonObject)["old_string"]), str((e as JsonObject)["new_string"]))
          : "",
      )
      .filter(Boolean)
      .join("\n");
  } else if (NOTEBOOK_TOOLS.has(item.name)) {
    kind = "update";
    diff = synthDiff(null, str(item.input["new_source"]));
  } else {
    return null;
  }

  return {
    id: item.id,
    path: displayPath(path),
    kind,
    diff,
    toolName: item.name,
    sourceEventIds: [...item.sourceEventIds],
  };
}

/**
 * Collect every file change a session made, newest-edit-per-path winning order
 * but keeping each edit (a file edited twice yields two entries — the surface
 * groups by path for display). Pure over the reduced transcript items.
 */
export function collectFileChanges(items: SessionItem[]): FileChange[] {
  const out: FileChange[] = [];
  for (const item of items) {
    if (item.type !== "tool_call") continue;
    const change = fileChangeFromToolCall(item);
    if (change) out.push(change);
  }
  return out;
}

/** Distinct file paths touched — drives the "Changes·N" strip count. */
export function changedPaths(changes: FileChange[]): string[] {
  const seen = new Set<string>();
  for (const c of changes) seen.add(c.path);
  return [...seen];
}
