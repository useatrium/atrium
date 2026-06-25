// Changes surface (Phase 4): derive the set of file edits a session made from
// the already-folded transcript items — "Changes/diff is free from frames". This
// covers the Claude/amp edit tools (Edit / Write / MultiEdit / NotebookEdit),
// which arrive as tool_call items with a known input schema. Codex `fileChange`
// items (changes[].{path,kind,diff}) are a separate source the reducer captures
// into state.fileChanges; collectFileChanges merges both for the drawer, and
// codexInlineFileChanges anchors them for inline transcript rendering.

import type { JsonObject } from "./types.js";
import type { FileChange, FileChangeKind, SessionItem, SessionState, ToolCallItem } from "./reducer.js";

export type { FileChange, FileChangeKind } from "./reducer.js";

/** Earliest event a transcript item / change was sourced from — its position in
 * the stream. Items are pushed in event order, so across items this is
 * non-decreasing; used to anchor codex edits inline at the point they happened. */
function startEventId(sourceEventIds: number[]): number {
  return sourceEventIds.length ? Math.min(...sourceEventIds) : 0;
}

// Claude Code's Edit + the Anthropic text-editor tool (whose str_replace command
// uses old_str/new_str, not old_string/new_string).
const EDIT_TOOLS = new Set(["Edit", "str_replace_editor", "str_replace_based_edit_tool"]);
const WRITE_TOOLS = new Set(["Write", "create_file"]);
const MULTI_EDIT_TOOLS = new Set(["MultiEdit"]);
const NOTEBOOK_TOOLS = new Set(["NotebookEdit"]);

/** Strip sandbox/canonical prefixes so work surfaces show the path the agent sees. */
export function displayPath(path: string): string {
  const active = /^shared\/channels\/[^/]+\/(.+)$/.exec(path);
  if (active) return active[1]!;
  const scratch = /^scratch\/[0-9a-f-]{36}\/(.+)$/i.exec(path);
  if (scratch) return `scratch/${scratch[1]!}`;
  const workspace = /\/workspace\/(.+)$/.exec(path);
  if (workspace) return workspace[1]!;
  const home = /^\/home\/agent\/(.+)$/.exec(path);
  if (home) return home[1]!;
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

/** Claude/amp edits, derived from the transcript tool_call items (paths already
 * stripped to display form). */
export function fileChangesFromItems(items: SessionItem[]): FileChange[] {
  const out: FileChange[] = [];
  for (const item of items) {
    if (item.type !== "tool_call") continue;
    const change = fileChangeFromToolCall(item);
    if (change) out.push(change);
  }
  return out;
}

/**
 * Normalize a captured codex `fileChange` for display: strip the sandbox path
 * prefix, and for an `add` (whose diff is raw file content with no +/- prefix)
 * prefix every line so it counts/colours like a Claude Write. `update`/`delete`
 * carry real unified hunks (-/+ lines), so those are left untouched. Shared by
 * the Changes drawer ({@link collectFileChanges}) and the inline transcript
 * cards ({@link codexInlineFileChanges}) so the two views never drift.
 */
export function normalizeCodexFileChange(change: FileChange): FileChange {
  return {
    ...change,
    path: displayPath(change.path),
    diff:
      change.kind === "add" && change.diff
        ? change.diff.split("\n").map((l) => `+ ${l}`).join("\n")
        : change.diff,
  };
}

/**
 * Every file change a session made, in edit order — Claude/amp edits derived
 * from the transcript items plus codex `fileChange` edits the reducer captured
 * (whose absolute paths are stripped here for parity). The surface groups by
 * path; a file edited twice yields two entries.
 */
export function collectFileChanges(state: SessionState): FileChange[] {
  return [...fileChangesFromItems(state.items), ...state.fileChanges.map(normalizeCodexFileChange)];
}

/** A codex file change positioned for inline rendering in the transcript.
 * `index` is the insertion point in `state.items`: render the card *before*
 * `items[index]` (so `index === items.length` puts it after the whole
 * transcript), mirroring how the web layer interleaves seat-audit lines. */
export interface AnchoredFileChange {
  change: FileChange;
  index: number;
}

/**
 * The session's codex `fileChange` edits, normalized and anchored for inline
 * placement in the transcript. Claude/amp edits are already transcript
 * `tool_call` items (they render inline via the item loop), so they are NOT
 * included here — only codex changes, which the reducer keeps out of `items`.
 *
 * Each change's `index` is the number of items created at/before the change's
 * own event, i.e. the card lands right where the edit happened in the stream.
 * Anchoring is derived purely from event ids, so it is stable across a reload
 * (unlike the seat-line arrival anchoring, which is a mount-time approximation).
 */
export function codexInlineFileChanges(state: SessionState): AnchoredFileChange[] {
  const itemStarts = state.items.map((it) => startEventId(it.sourceEventIds));
  return state.fileChanges.map((change) => {
    const at = startEventId(change.sourceEventIds);
    const index = itemStarts.filter((start) => start <= at).length;
    return { change: normalizeCodexFileChange(change), index };
  });
}

/** Distinct file paths touched — drives the "Changes·N" strip count. */
export function changedPaths(changes: FileChange[]): string[] {
  const seen = new Set<string>();
  for (const c of changes) seen.add(c.path);
  return [...seen];
}
