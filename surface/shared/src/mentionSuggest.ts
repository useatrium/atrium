import type { UserRef } from './timeline';
import type { SpecialMention } from './mentions';

export type MentionCandidate =
  | { kind: 'user'; user: UserRef; inChannel: boolean }
  | { kind: 'special'; name: SpecialMention; description: string };

interface RankedUser {
  user: UserRef;
  inChannel: boolean;
  score: number;
}

function matchScore(user: UserRef, prefix: string): number | null {
  if (prefix === '') return 0;
  const handle = user.handle.toLowerCase();
  const displayName = user.displayName.toLowerCase();
  if (handle === prefix) return 3;
  if (handle.startsWith(prefix)) return 2;
  if (displayName.split(/\s+/).some((word) => word.startsWith(prefix))) return 1;
  if (handle.includes(prefix) || displayName.includes(prefix)) return 0;
  return null;
}

function compareHandles(a: UserRef, b: UserRef): number {
  const insensitive = a.handle.toLowerCase().localeCompare(b.handle.toLowerCase());
  return insensitive || a.handle.localeCompare(b.handle);
}

export function suggestMentions(opts: {
  prefix: string;
  members?: UserRef[] | null;
  users?: UserRef[] | null;
  includeSpecials?: boolean;
  limit?: number;
}): MentionCandidate[] {
  const prefix = opts.prefix.toLowerCase();
  const byId = new Map<string, { user: UserRef; inChannel: boolean }>();

  for (const user of opts.users ?? []) byId.set(user.id, { user, inChannel: false });
  for (const user of opts.members ?? []) byId.set(user.id, { user, inChannel: true });

  const ranked: RankedUser[] = [];
  for (const candidate of byId.values()) {
    const score = matchScore(candidate.user, prefix);
    if (score !== null) ranked.push({ ...candidate, score });
  }
  ranked.sort(
    (a, b) => Number(b.inChannel) - Number(a.inChannel) || b.score - a.score || compareHandles(a.user, b.user),
  );

  const limit = Math.max(0, opts.limit ?? 8);
  const result: MentionCandidate[] = ranked
    .slice(0, limit)
    .map(({ user, inChannel }) => ({ kind: 'user', user, inChannel }));

  if (opts.includeSpecials) {
    if (prefix === '' || 'channel'.startsWith(prefix)) {
      result.push({ kind: 'special', name: 'channel', description: 'Notify everyone in this channel' });
    }
    if (prefix === '' || 'here'.startsWith(prefix)) {
      result.push({ kind: 'special', name: 'here', description: 'Notify everyone active in this channel' });
    }
  }

  return result;
}
