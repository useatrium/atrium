// Placing a session's work folds into a thread's message spine.
//
// Two clocks meet here, and they are not the same clock: the SSE stream counts
// turns (segments between `user_message` echoes), while the thread counts
// `session.replied` events (one per execution that finished with an answer). A
// fold is assigned to the reply it produced when those line up, and otherwise
// keeps a row of its own rather than attaching to someone else's answer.

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

/**
 * Maps each reply-producing fold to that reply's zero-based position. Folds
 * beyond the thread's reply count are left unmapped: the stream knows about
 * turns the thread never heard an answer for (a failed execution posts no
 * `session.replied`), and guessing would nest one turn's work under another
 * turn's answer.
 */
function foldsByReplyOrdinal(workFolds: readonly FoldedTurnRow[], agentReplyCount: number): Map<number, FoldedTurnRow> {
  const byOrdinal = new Map<number, FoldedTurnRow>();
  for (const fold of workFolds) {
    if (fold.replyOrdinal == null || fold.replyOrdinal >= agentReplyCount) continue;
    if (!byOrdinal.has(fold.replyOrdinal)) byOrdinal.set(fold.replyOrdinal, fold);
  }
  return byOrdinal;
}

export function buildSpineRows({ items, workFolds, attachedSessionId, sessionLive }: SpineInput): SpineRow[] {
  const rows: SpineRow[] = [];
  let replyOrdinal = 0;
  let triggerOrdinal = 0;

  const agentReplyCount = items.filter(
    (item) => item.kind !== 'day' && item.message != null && isAgentReply(item.message, attachedSessionId),
  ).length;
  const byReplyOrdinal = foldsByReplyOrdinal(workFolds, agentReplyCount);

  // Spoken for before any pass runs: a fold that belongs to a reply must never
  // ALSO be pushed as its own row. Seeding the set (rather than guarding one
  // pass) is what makes that hold for every pass below — the trigger pass used
  // to hoist a later reply's fold into a standalone row, rendering it twice.
  const usedFolds = new Set<string>([...byReplyOrdinal.values()].map((fold) => fold.key));
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
    if (isAgentReply(message, attachedSessionId)) {
      fold = byReplyOrdinal.get(replyOrdinal);
      replyOrdinal += 1;
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

  // Work the passes above never claimed still has to be reachable.
  for (const fold of workFolds) {
    if (usedFolds.has(fold.key)) continue;
    pushFold(fold);
  }
  return rows;
}
