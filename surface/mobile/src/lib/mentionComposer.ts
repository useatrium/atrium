import {
  decodeWireToDisplay,
  encodeMentionsToWire,
  updateMentionRangesForEdit,
  type MentionCandidate,
  type MentionRange,
  type UserRef,
} from '@atrium/surface-client';

// Range math now lives in shared/src/mentions.ts; re-exported so the composer
// and its tests keep importing it from here unchanged.
export { updateMentionRangesForEdit };

export function encodeMessageForSend(displayText: string, ranges: MentionRange[]): string {
  return encodeMentionsToWire(displayText, ranges);
}

export function insertMentionCandidate(
  text: string,
  ranges: MentionRange[],
  matchStart: number,
  caret: number,
  value: string,
  candidate: MentionCandidate,
): { text: string; ranges: MentionRange[]; caret: number } {
  const replacement = `@${value} `;
  const nextText = `${text.slice(0, matchStart)}${replacement}${text.slice(caret)}`;
  const nextRanges = updateMentionRangesForEdit(text, nextText, ranges);
  if (candidate.kind === 'user') {
    nextRanges.push({ start: matchStart, end: matchStart + replacement.length - 1, userId: candidate.user.id });
    nextRanges.sort((a, b) => a.start - b.start);
  }
  return { text: nextText, ranges: nextRanges, caret: matchStart + replacement.length };
}

export function trimMentionSubmission(text: string, ranges: MentionRange[]): { text: string; ranges: MentionRange[] } {
  const leading = text.length - text.trimStart().length;
  const trimmed = text.trim();
  return {
    text: trimmed,
    ranges: ranges
      .map((range) => ({ ...range, start: range.start - leading, end: range.end - leading }))
      .filter((range) => range.start >= 0 && range.end <= trimmed.length),
  };
}

/** Keep a warned non-member only while a range still mentions them. */
export function pruneWarnedMentions(warned: UserRef[], ranges: MentionRange[]): UserRef[] {
  const alive = new Set(ranges.map((range) => range.userId));
  return warned.every((user) => alive.has(user.id)) ? warned : warned.filter((user) => alive.has(user.id));
}

export function decodeEditingText(
  wireText: string,
  resolveUser?: (id: string) => UserRef | undefined,
): { text: string; ranges: MentionRange[] } {
  return decodeWireToDisplay(wireText, (id) => resolveUser?.(id)?.handle ?? null);
}
