import {
  decodeWireToDisplay,
  encodeMentionsToWire,
  type MentionCandidate,
  type MentionRange,
  type UserRef,
} from '@atrium/surface-client';

export function encodeMessageForSend(displayText: string, ranges: MentionRange[]): string {
  return encodeMentionsToWire(displayText, ranges);
}

export function updateMentionRangesForEdit(
  previousText: string,
  nextText: string,
  ranges: MentionRange[],
): MentionRange[] {
  let start = 0;
  while (start < previousText.length && start < nextText.length && previousText[start] === nextText[start]) start += 1;

  let previousEnd = previousText.length;
  let nextEnd = nextText.length;
  while (previousEnd > start && nextEnd > start && previousText[previousEnd - 1] === nextText[nextEnd - 1]) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  const delta = nextText.length - previousText.length;
  return ranges.flatMap((range) => {
    const insertionInsideRange = previousEnd === start && start > range.start && start < range.end;
    const replacementIntersectsRange = start < range.end && previousEnd > range.start;
    if (insertionInsideRange || replacementIntersectsRange) return [];
    if (range.start >= previousEnd) return [{ ...range, start: range.start + delta, end: range.end + delta }];
    return [range];
  });
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

export function decodeEditingText(
  wireText: string,
  resolveUser?: (id: string) => UserRef | undefined,
): { text: string; ranges: MentionRange[] } {
  return decodeWireToDisplay(wireText, (id) => resolveUser?.(id)?.handle ?? null);
}
