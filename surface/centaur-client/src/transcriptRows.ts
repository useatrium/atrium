import type { ReasoningItem, SessionItem, ToolCallItem } from './reducer.js';

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
