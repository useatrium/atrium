export type SpecialMention = 'channel' | 'here';

/** Range in DISPLAY text; text.slice(start, end) looks like "@handle". */
export interface MentionRange {
  start: number;
  end: number;
  userId: string;
}

export interface MentionPrefixMatch {
  start: number;
  prefix: string;
}

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MENTION_PREFIX_RE = /@([a-z0-9_-]*)$/i;
const USER_TOKEN_RE = new RegExp(`<@(${UUID_SOURCE})>`, 'gi');
const WIRE_TOKEN_RE = new RegExp(`<@(${UUID_SOURCE})>|<!(channel|here)>`, 'gi');
const SPECIAL_TOKEN_RE = /<!(channel|here)>/gi;
const SPECIAL_DISPLAY_RE = /@(channel|here)(?![a-z0-9_-])/gi;

function hasMentionLeftBoundary(text: string, at: number): boolean {
  if (at === 0) return true;
  const previous = text[at - 1];
  return previous !== undefined && (/\s/.test(previous) || `(["'{<`.includes(previous));
}

/**
 * Reproject mention ranges across a plain-text edit from `previousText` to
 * `nextText`. Ranges wholly after the changed span shift by the length delta;
 * a range whose interior is touched (an insertion strictly inside it, or a
 * replacement that overlaps it) is dropped, since its "@handle" text no longer
 * survives intact. Shared by the web typeahead and the mobile composer.
 */
export function updateMentionRangesForEdit(
  previousText: string,
  nextText: string,
  ranges: MentionRange[],
): MentionRange[] {
  if (previousText === nextText) return ranges;

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

export function matchMentionPrefix(text: string): MentionPrefixMatch | null {
  const match = MENTION_PREFIX_RE.exec(text);
  if (!match || !hasMentionLeftBoundary(text, match.index)) return null;
  return { start: match.index, prefix: match[1] ?? '' };
}

export function extractMentionTokens(text: string): { userIds: string[]; specials: SpecialMention[] } {
  const userIds: string[] = [];
  const specials: SpecialMention[] = [];
  const seenUserIds = new Set<string>();
  const seenSpecials = new Set<SpecialMention>();

  WIRE_TOKEN_RE.lastIndex = 0;
  for (let match = WIRE_TOKEN_RE.exec(text); match; match = WIRE_TOKEN_RE.exec(text)) {
    if (match[1]) {
      const userId = match[1].toLowerCase();
      if (!seenUserIds.has(userId)) {
        seenUserIds.add(userId);
        userIds.push(userId);
      }
    } else if (match[2]) {
      const special = match[2].toLowerCase() as SpecialMention;
      if (!seenSpecials.has(special)) {
        seenSpecials.add(special);
        specials.push(special);
      }
    }
  }

  return { userIds, specials };
}

function encodeSpecialMentions(text: string, displayText: string, offsetInDisplay: number): string {
  SPECIAL_DISPLAY_RE.lastIndex = 0;
  return text.replace(SPECIAL_DISPLAY_RE, (match, _name: string, offset: number) => {
    if (!hasMentionLeftBoundary(displayText, offsetInDisplay + offset)) return match;
    return `<!${match.slice(1).toLowerCase()}>`;
  });
}

export function encodeMentionsToWire(displayText: string, ranges: MentionRange[]): string {
  const sortedRanges = [...ranges].sort((a, b) => a.start - b.start);
  const out: string[] = [];
  let cursor = 0;

  for (const range of sortedRanges) {
    const validBounds =
      Number.isInteger(range.start) &&
      Number.isInteger(range.end) &&
      range.start >= 0 &&
      range.end > range.start &&
      range.end <= displayText.length;
    if (!validBounds || range.start < cursor || !displayText.slice(range.start, range.end).startsWith('@')) continue;

    out.push(encodeSpecialMentions(displayText.slice(cursor, range.start), displayText, cursor));
    out.push(`<@${range.userId}>`);
    cursor = range.end;
  }

  out.push(encodeSpecialMentions(displayText.slice(cursor), displayText, cursor));
  return out.join('');
}

export function decodeWireToDisplay(
  wireText: string,
  resolveHandle: (userId: string) => string | null,
): { text: string; ranges: MentionRange[] } {
  const ranges: MentionRange[] = [];
  let text = '';
  let cursor = 0;

  WIRE_TOKEN_RE.lastIndex = 0;
  for (let match = WIRE_TOKEN_RE.exec(wireText); match; match = WIRE_TOKEN_RE.exec(wireText)) {
    text += wireText.slice(cursor, match.index);
    if (match[1]) {
      const userId = match[1];
      const displayMention = `@${resolveHandle(userId) ?? 'unknown'}`;
      const start = text.length;
      text += displayMention;
      ranges.push({ start, end: text.length, userId });
    } else {
      text += `@${match[2]?.toLowerCase()}`;
    }
    cursor = match.index + match[0].length;
  }

  text += wireText.slice(cursor);
  return { text, ranges };
}

export function mentionsUser(text: string, me: { id: string | null; handle: string | null }): boolean {
  SPECIAL_TOKEN_RE.lastIndex = 0;
  if (SPECIAL_TOKEN_RE.test(text)) return true;

  if (me.id) {
    USER_TOKEN_RE.lastIndex = 0;
    for (let match = USER_TOKEN_RE.exec(text); match; match = USER_TOKEN_RE.exec(text)) {
      if (match[1]?.toLowerCase() === me.id.toLowerCase()) return true;
    }
  }

  if (!me.handle) return false;
  const escapedHandle = me.handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const legacyMentionRe = new RegExp(`@${escapedHandle}(?![a-z0-9_-])`, 'gi');
  for (let match = legacyMentionRe.exec(text); match; match = legacyMentionRe.exec(text)) {
    if (hasMentionLeftBoundary(text, match.index)) return true;
  }
  return false;
}
