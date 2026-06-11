export interface MentionPrefixMatch {
  start: number;
  prefix: string;
}

const MENTION_PREFIX_RE = /@([a-z0-9_-]*)$/i;

export function matchMentionPrefix(text: string): MentionPrefixMatch | null {
  const match = MENTION_PREFIX_RE.exec(text);
  if (!match) return null;
  return { start: match.index, prefix: match[1] ?? '' };
}
