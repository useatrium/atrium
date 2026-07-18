// Placing a session's work folds into a thread's message spine.
//
// The SSE transcript and thread event stream meet here through the execution id
// shared by a work fold and the `session.replied` event it produced. Unmatched
// work keeps a row of its own rather than attaching to someone else's answer.

import { isLiveFold, type FoldedTurnRow } from '@atrium/centaur-client';
import type { ChatMessage, TimelineItem } from '@atrium/surface-client';

export type SpineRow =
  | {
      kind: 'message';
      key: string;
      message: ChatMessage;
      grouped: boolean;
      aside: boolean;
      fold?: FoldedTurnRow;
      foldLive?: boolean;
    }
  | { kind: 'fold'; key: string; fold: FoldedTurnRow; live: boolean };

interface SpineInput {
  items: readonly TimelineItem[];
  workFolds: readonly FoldedTurnRow[];
  attachedSessionId: string | null;
  sessionLive: boolean;
}

function isAgentReply(message: ChatMessage, attachedSessionId: string | null): boolean {
  return attachedSessionId != null && message.sessionId === attachedSessionId && message.sessionEventType === 'replied';
}

function foldsByExecutionId(
  workFolds: readonly FoldedTurnRow[],
  replyExecutionIds: ReadonlySet<string>,
): Map<string, FoldedTurnRow[]> {
  const byExecutionId = new Map<string, FoldedTurnRow[]>();
  for (const fold of workFolds) {
    if (fold.executionId === null || !replyExecutionIds.has(fold.executionId)) continue;
    // A steer can split one running execution into several folds. Its final
    // answer belongs to the last fold; earlier folds remain standalone.
    const executionFolds = byExecutionId.get(fold.executionId) ?? [];
    executionFolds.push(fold);
    byExecutionId.set(fold.executionId, executionFolds);
  }
  return byExecutionId;
}

export function buildSpineRows({ items, workFolds, attachedSessionId, sessionLive }: SpineInput): SpineRow[] {
  const rows: SpineRow[] = [];
  let triggerOrdinal = 0;

  const replyExecutionIds = new Set<string>();
  for (const item of items) {
    if (item.kind === 'day' || !item.message || !isAgentReply(item.message, attachedSessionId)) continue;
    if (item.message.sessionExecutionId !== null && item.message.sessionExecutionId !== undefined) {
      replyExecutionIds.add(item.message.sessionExecutionId);
    }
  }
  const byExecutionId = foldsByExecutionId(workFolds, replyExecutionIds);

  // Spoken for before any pass runs: a fold that belongs to a reply must never
  // ALSO be pushed as its own row. Seeding the set (rather than guarding one
  // pass) is what makes that hold for every pass below — the trigger pass used
  // to hoist a later reply's fold into a standalone row, rendering it twice.
  const usedFolds = new Set<string>(
    [...byExecutionId.values()].flatMap((folds) => {
      const finalFold = folds.at(-1);
      return finalFold ? [finalFold.key] : [];
    }),
  );
  const pushFold = (fold: FoldedTurnRow) => {
    rows.push({ kind: 'fold', key: fold.key, fold, live: isLiveFold(fold, workFolds, sessionLive) });
    usedFolds.add(fold.key);
  };

  // The root ask is trigger zero. Harnesses that omit its user_message echo
  // produce a null trigger, which belongs at this same position.
  for (const fold of workFolds) {
    if (usedFolds.has(fold.key)) continue;
    if (fold.triggerOrdinal === null || fold.triggerOrdinal === 0) pushFold(fold);
  }

  for (const item of items) {
    if (item.kind === 'day' || !item.message) continue;
    const message = item.message;
    let fold: FoldedTurnRow | undefined;
    if (isAgentReply(message, attachedSessionId) && message.sessionExecutionId != null) {
      const executionFolds = byExecutionId.get(message.sessionExecutionId) ?? [];
      fold = executionFolds.at(-1);
      // If trigger placement could not anchor earlier runs, put them directly
      // before the reply they chronologically precede instead of at the end.
      for (const earlierFold of executionFolds.slice(0, -1)) {
        if (!usedFolds.has(earlierFold.key)) pushFold(earlierFold);
      }
    }
    const aside =
      attachedSessionId != null &&
      message.sessionId == null &&
      message.steeredSessionId == null &&
      message.suggestedSessionId == null;
    rows.push({
      kind: 'message',
      key: item.key,
      message,
      grouped: item.grouped ?? false,
      aside,
      ...(fold ? { fold, foldLive: isLiveFold(fold, workFolds, sessionLive) } : {}),
    });
    const targetsAttachedSession =
      attachedSessionId != null &&
      (message.steeredSessionId === attachedSessionId || message.suggestedSessionId === attachedSessionId);
    if (targetsAttachedSession) {
      triggerOrdinal += 1;
      for (const fold of workFolds) {
        if (!usedFolds.has(fold.key) && fold.triggerOrdinal === triggerOrdinal) pushFold(fold);
      }
    }
  }

  // Truly unanchored work still has to be reachable.
  for (const fold of workFolds) {
    if (usedFolds.has(fold.key)) continue;
    pushFold(fold);
  }
  return rows;
}
