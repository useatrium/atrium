import type { ReasoningItem, SessionItem, SubagentState, ToolCallItem } from './reducer.js';

export function toolDefaultOpen(item: ToolCallItem): boolean {
  return item.result === undefined;
}

export type TranscriptRow<TChange> =
  | { kind: 'item'; item: SessionItem; index: number }
  | { kind: 'change'; change: TChange; index: number }
  | { kind: 'hidden'; count: number; key: string; startIndex: number; endIndex: number };

export type TurnWorkItem = ReasoningItem | ToolCallItem;

/** One contiguous run of work hidden within a human/agent turn. */
export interface FoldedTurnRow {
  kind: 'fold';
  key: string;
  turn: number;
  executionId: string | null;
  items: TurnWorkItem[];
  toolNames: string[];
  startIndex: number;
  endIndex: number;
  triggerIndex: number | null;
  /** Zero-based `user_message` position; null when the harness omitted the initial echo. */
  triggerOrdinal: number | null;
  replyIndex: number | null;
  durationMs?: number;
  completed: boolean;
}

/** A fold renders live iff the conversation is active, the fold's turn hasn't
 * completed, and it is the newest fold. */
export function isLiveFold(fold: FoldedTurnRow, folds: readonly FoldedTurnRow[], active: boolean): boolean {
  return active && !fold.completed && folds.at(-1)?.key === fold.key;
}

function isWorkItem(item: SessionItem): item is TurnWorkItem {
  return item.type === 'reasoning' || item.type === 'tool_call';
}

export type SubagentStatus = 'running' | 'completed' | 'failed';

/** A Task-tool subagent surfaced in the live "Agents" strip: its descriptor
 * (from the parent Task `tool_call` input), status, and its own work items for
 * the drill-in. */
export interface SubagentGroup {
  parentId: string;
  subagentType: string | null;
  description: string | null;
  status: SubagentStatus;
  items: TurnWorkItem[];
  stepCount: number;
}

function subagentStringField(input: ToolCallItem['input'] | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** A subagent runs until its parent Task `tool_call` reports a result; the
 * result's `is_error` then settles it completed/failed. */
function subagentStatus(parent: ToolCallItem | undefined): SubagentStatus {
  if (parent?.result) return parent.result.is_error ? 'failed' : 'completed';
  return 'running';
}

/**
 * Joins the parent Task `tool_call`s in the transcript with their subagent
 * activity streams (`state.subagents`). Subagents are listed in spawn order —
 * the position of their Task call in `items` — with any not-yet-seen parents
 * appended. The parent Task step itself stays in the main transcript/fold; only
 * the subagent's own steps live here.
 */
export function subagentGroups(
  items: readonly SessionItem[],
  subagents: Record<string, SubagentState> | undefined,
): SubagentGroup[] {
  if (!subagents || Object.keys(subagents).length === 0) return [];

  const parentById = new Map<string, ToolCallItem>();
  for (const item of items) {
    if (item.type === 'tool_call') parentById.set(item.id, item);
  }
  const parentFor = (parentId: string): ToolCallItem | undefined => parentById.get(`tool:codex:${parentId}`);

  const order: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.type !== 'tool_call' || !item.id.startsWith('tool:codex:')) continue;
    const parentId = item.id.slice('tool:codex:'.length);
    if (subagents[parentId] && !seen.has(parentId)) {
      seen.add(parentId);
      order.push(parentId);
    }
  }
  for (const parentId of Object.keys(subagents)) {
    if (!seen.has(parentId)) {
      seen.add(parentId);
      order.push(parentId);
    }
  }

  return order.map((parentId) => {
    const parent = parentFor(parentId);
    const work = (subagents[parentId]?.items ?? []).filter(isWorkItem);
    return {
      parentId,
      subagentType: subagentStringField(parent?.input, 'subagent_type'),
      description: subagentStringField(parent?.input, 'description'),
      status: subagentStatus(parent),
      items: work,
      stepCount: work.length,
    };
  });
}

function elapsedMs(first: SessionItem | undefined, last: SessionItem | undefined): number | undefined {
  if (!first?.ts || !last?.ts) return undefined;
  const start = Date.parse(first.ts);
  const end = Date.parse(last.ts);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

/**
 * Projects the transcript into turn-scoped work folds. A turn is the segment
 * after a `user_message` (or the initial pre-user segment) and before the next
 * `user_message`. Each contiguous reasoning/tool run becomes its own fold, so
 * intervening narration remains chronologically interleaved.
 */
export function foldedTurnRows(items: readonly SessionItem[]): FoldedTurnRow[] {
  const folds: FoldedTurnRow[] = [];
  let segmentStart = 0;
  let triggerIndex: number | null = null;
  let triggerOrdinal: number | null = null;
  let nextTriggerOrdinal = 0;
  let turn = 0;

  const flush = (segmentEnd: number) => {
    let lastWorkIndex: number | null = null;
    for (let index = segmentEnd - 1; index >= segmentStart; index -= 1) {
      if (isWorkItem(items[index]!)) {
        lastWorkIndex = index;
        break;
      }
    }
    if (lastWorkIndex === null) {
      turn += 1;
      return;
    }

    let replyIndex: number | null = null;
    for (let index = segmentEnd - 1; index > lastWorkIndex; index -= 1) {
      if (items[index]?.type === 'text') {
        replyIndex = index;
        break;
      }
    }
    const workEnd = replyIndex ?? segmentEnd;
    const runs: Array<Array<{ item: TurnWorkItem; index: number }>> = [];
    let run: Array<{ item: TurnWorkItem; index: number }> = [];
    for (let index = segmentStart; index < workEnd; index += 1) {
      const item = items[index]!;
      if (isWorkItem(item)) {
        run.push({ item, index });
        continue;
      }
      if (run.length > 0) runs.push(run);
      run = [];
    }
    if (run.length > 0) runs.push(run);

    runs.forEach((indexedWork, runIndex) => {
      const isLastRun = runIndex === runs.length - 1;
      const runReplyIndex = isLastRun ? replyIndex : null;
      const workItems = indexedWork.map(({ item }) => item);
      const toolNames = [...new Set(workItems.flatMap((item) => (item.type === 'tool_call' ? [item.name] : [])))];
      const first = indexedWork[0]!;
      const lastIndex = runReplyIndex ?? indexedWork[indexedWork.length - 1]!.index;
      const durationMs = elapsedMs(first.item, items[lastIndex]);
      const executionId =
        (runReplyIndex === null ? null : items[runReplyIndex]?.executionId) ??
        [...workItems].reverse().find((item) => item.executionId !== null)?.executionId ??
        null;
      folds.push({
        kind: 'fold',
        key: `turn-${turn}-${first.item.id}`,
        turn,
        executionId,
        items: workItems,
        toolNames,
        startIndex: first.index,
        endIndex: indexedWork[indexedWork.length - 1]!.index,
        triggerIndex,
        triggerOrdinal,
        replyIndex: runReplyIndex,
        ...(durationMs !== undefined ? { durationMs } : {}),
        completed: segmentEnd < items.length || replyIndex !== null || !isLastRun,
      });
    });
    turn += 1;
  };

  items.forEach((item, index) => {
    if (item.type !== 'user_message') return;
    flush(index);
    triggerIndex = index;
    triggerOrdinal = nextTriggerOrdinal;
    nextTriggerOrdinal += 1;
    segmentStart = index + 1;
  });
  flush(items.length);
  return folds;
}

/**
 * Merges a turn's contiguous work runs back into one fold per turn. The session
 * pane keeps the split runs (they interleave with the narration shown between
 * them); the thread reading view — which does not render that narration — uses
 * this so a turn shows a single "N steps" chip instead of several stacked ones.
 */
export function coalesceTurnFolds(folds: readonly FoldedTurnRow[]): FoldedTurnRow[] {
  const out: FoldedTurnRow[] = [];
  for (const fold of folds) {
    const prev = out[out.length - 1];
    if (prev && prev.turn === fold.turn) {
      prev.items = [...prev.items, ...fold.items];
      prev.toolNames = [...new Set([...prev.toolNames, ...fold.toolNames])];
      prev.endIndex = fold.endIndex;
      prev.replyIndex = fold.replyIndex;
      prev.executionId = fold.executionId ?? prev.executionId;
      prev.completed = fold.completed;
      const durationMs = elapsedMs(prev.items[0], prev.items[prev.items.length - 1]);
      if (durationMs !== undefined) prev.durationMs = durationMs;
      else delete prev.durationMs;
    } else {
      out.push({ ...fold });
    }
  }
  return out;
}

export function fullTranscriptRows<TChange>(
  items: readonly SessionItem[],
  changesAt: (index: number) => readonly TChange[],
): TranscriptRow<TChange>[] {
  const rows: TranscriptRow<TChange>[] = [];
  items.forEach((item, index) => {
    for (const change of changesAt(index)) rows.push({ kind: 'change', change, index });
    rows.push({ kind: 'item', item, index });
  });
  for (const change of changesAt(items.length)) {
    rows.push({ kind: 'change', change, index: items.length });
  }
  return rows;
}

export function focusTranscriptRows<TChange>(
  items: readonly SessionItem[],
  changesAt: (index: number) => readonly TChange[],
): TranscriptRow<TChange>[] {
  const rows: TranscriptRow<TChange>[] = [];
  let hiddenCount = 0;
  let hiddenKey = '';
  let hiddenStartIndex = 0;
  let hiddenEndIndex = 0;

  const flushHidden = () => {
    if (hiddenCount > 0) {
      rows.push({
        kind: 'hidden',
        count: hiddenCount,
        key: hiddenKey,
        startIndex: hiddenStartIndex,
        endIndex: hiddenEndIndex,
      });
    }
    hiddenCount = 0;
    hiddenKey = '';
  };
  const hide = (key: string, index: number) => {
    if (hiddenCount === 0) hiddenStartIndex = index;
    hiddenCount += 1;
    if (!hiddenKey) hiddenKey = key;
    hiddenEndIndex = index;
  };

  items.forEach((item, index) => {
    for (const _change of changesAt(index)) hide(`change-${index}`, index);
    if (isWorkItem(item)) {
      hide(item.id, index);
      return;
    }
    flushHidden();
    rows.push({ kind: 'item', item, index });
  });
  for (const _change of changesAt(items.length)) {
    hide(`change-${items.length}`, items.length);
  }
  flushHidden();
  return rows;
}
