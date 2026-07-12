import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import {
  encodeMentionsToWire,
  matchMentionPrefix,
  suggestMentions,
  type MentionCandidate,
  type MentionRange,
  type UserRef,
} from '@atrium/surface-client';
import { api } from '../api';
import { primeUserDirectory } from '../userDirectory';

/** Rosters go stale as people join; refresh on the next picker open after this. */
const ROSTER_TTL_MS = 5 * 60 * 1000;
const memberCache = new Map<string, { members: UserRef[]; fetchedAt: number }>();
const memberRequests = new Map<string, Promise<UserRef[]>>();
let userCache: { users: UserRef[]; fetchedAt: number } | null = null;
let userRequest: Promise<UserRef[]> | null = null;

function cachedMembers(channelId: string): UserRef[] | null {
  return memberCache.get(channelId)?.members ?? null;
}

function loadMembers(channelId: string): Promise<UserRef[]> {
  const cached = memberCache.get(channelId);
  if (cached && Date.now() - cached.fetchedAt < ROSTER_TTL_MS) return Promise.resolve(cached.members);
  const pending = memberRequests.get(channelId);
  if (pending) return pending;
  const request = api
    .channelMembers(channelId)
    .then(({ members }) => {
      memberCache.set(channelId, { members, fetchedAt: Date.now() });
      return members;
    })
    .catch(() => {
      // Keep a stale roster over an empty one; cache the miss otherwise.
      if (!cached) memberCache.set(channelId, { members: [], fetchedAt: Date.now() });
      return cached?.members ?? [];
    })
    .finally(() => memberRequests.delete(channelId));
  memberRequests.set(channelId, request);
  return request;
}

export function addKnownChannelMember(channelId: string, user: UserRef): void {
  const cached = memberCache.get(channelId);
  if (cached && !cached.members.some((member) => member.id === user.id)) {
    memberCache.set(channelId, { members: [...cached.members, user], fetchedAt: cached.fetchedAt });
  }
}

function loadUsers(): Promise<UserRef[]> {
  if (userCache && Date.now() - userCache.fetchedAt < ROSTER_TTL_MS) return Promise.resolve(userCache.users);
  if (userRequest) return userRequest;
  const previous = userCache;
  userRequest = api
    .users()
    .then(({ users }) => {
      userCache = { users, fetchedAt: Date.now() };
      primeUserDirectory(users);
      return users;
    })
    .catch(() => {
      if (!previous) userCache = { users: [], fetchedAt: Date.now() };
      return previous?.users ?? [];
    })
    .finally(() => {
      userRequest = null;
    });
  return userRequest;
}

function maintainRanges(ranges: MentionRange[], previous: string, next: string): MentionRange[] {
  if (previous === next) return ranges;
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start += 1;
  let suffix = 0;
  while (
    suffix < previous.length - start &&
    suffix < next.length - start &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oldEnd = previous.length - suffix;
  const newEnd = next.length - suffix;
  const delta = newEnd - oldEnd;
  return ranges.flatMap((range) => {
    const insertionInside = start === oldEnd && range.start < start && start < range.end;
    const replacementIntersects = start < oldEnd && range.start < oldEnd && range.end > start;
    if (insertionInside || replacementIntersects) return [];
    if (range.start >= oldEnd) return [{ ...range, start: range.start + delta, end: range.end + delta }];
    return [range];
  });
}

export type MentionContext = { channelId: string; includeSpecials: boolean; publicChannel: boolean };

export function useMentionTypeahead({
  value,
  setValue,
  textareaRef,
  context,
}: {
  value: string;
  setValue: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  context?: MentionContext;
}) {
  const [selectionStart, setSelectionStart] = useState(0);
  const [members, setMembers] = useState<UserRef[] | null>(null);
  const [users, setUsers] = useState<UserRef[] | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  /** Range-tracked mentions of users outside a private channel — they will NOT
   * be notified (the server drops non-member mentions), so the composer warns. */
  const [nonMembers, setNonMembers] = useState<UserRef[]>([]);
  const rangesRef = useRef<MentionRange[]>([]);
  const listboxId = `mention-listbox-${useId().replace(/:/g, '')}`;
  const match = context ? matchMentionPrefix(value.slice(0, selectionStart)) : null;
  const matchKey = match ? `${match.start}:${match.prefix}` : null;
  // One load per mention session (an '@' at a given position), so a stale
  // roster refreshes on the next picker open rather than per keystroke.
  const matchStart = match ? match.start : null;

  useEffect(() => {
    if (!context || matchStart === null) return;
    // Public channels have no explicit membership (workspace = membership), so
    // the members endpoint is a 404 there — the whole directory counts as in-channel.
    const membersPromise = context.publicChannel ? Promise.resolve(null) : loadMembers(context.channelId);
    void Promise.all([membersPromise, loadUsers()]).then(([nextMembers, nextUsers]) => {
      setMembers(context.publicChannel ? nextUsers : nextMembers);
      setUsers(nextUsers);
    });
  }, [context, matchStart]);

  useEffect(() => {
    setMembers(cachedMembers(context?.channelId ?? ''));
    setUsers(userCache?.users ?? null);
    setDismissedKey(null);
    setActiveIndex(0);
  }, [context?.channelId]);

  const candidates = useMemo(
    () =>
      match && members && users
        ? suggestMentions({
            prefix: match.prefix,
            members,
            users,
            includeSpecials: context?.includeSpecials,
            limit: 8,
          })
        : [],
    [context?.includeSpecials, match, members, users],
  );
  const open = !!matchKey && dismissedKey !== matchKey && candidates.length > 0;

  useEffect(() => {
    setActiveIndex(0);
  }, [matchKey]);

  const trackSelection = useCallback(
    (element?: HTMLTextAreaElement | null) => {
      const textarea = element ?? textareaRef.current;
      if (textarea) setSelectionStart(textarea.selectionStart ?? textarea.value.length);
    },
    [textareaRef],
  );

  const onValueChange = useCallback(
    (next: string, caret: number) => {
      rangesRef.current = maintainRanges(rangesRef.current, value, next);
      const alive = new Set(rangesRef.current.map((range) => range.userId));
      setNonMembers((current) =>
        current.every((user) => alive.has(user.id)) ? current : current.filter((user) => alive.has(user.id)),
      );
      setValue(next);
      setSelectionStart(caret);
    },
    [setValue, value],
  );

  const insert = useCallback(
    (candidate: MentionCandidate) => {
      if (!match) return;
      const display = candidate.kind === 'user' ? `@${candidate.user.handle} ` : `@${candidate.name} `;
      const next = value.slice(0, match.start) + display + value.slice(selectionStart);
      rangesRef.current = maintainRanges(rangesRef.current, value, next);
      if (candidate.kind === 'user') {
        rangesRef.current.push({
          start: match.start,
          end: match.start + display.length - 1,
          userId: candidate.user.id,
        });
        if (!candidate.inChannel && context && !context.publicChannel && context.includeSpecials) {
          setNonMembers((current) =>
            current.some((user) => user.id === candidate.user.id) ? current : [...current, candidate.user],
          );
        }
      }
      setValue(next);
      setDismissedKey(null);
      const caret = match.start + display.length;
      setSelectionStart(caret);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(caret, caret);
      });
    },
    [context, match, selectionStart, setValue, textareaRef, value],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((index) => (index + delta + candidates.length) % candidates.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const candidate = candidates[activeIndex];
        if (candidate) insert(candidate);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDismissedKey(matchKey);
        return true;
      }
      return false;
    },
    [activeIndex, candidates, insert, matchKey, open],
  );

  const serialize = useCallback((text: string) => encodeMentionsToWire(text, rangesRef.current), []);
  const invite = useCallback(
    async (userId: string) => {
      if (!context) return;
      const user = nonMembers.find((candidate) => candidate.id === userId);
      if (!user) return;
      await api.addChannelMember(context.channelId, userId);
      addKnownChannelMember(context.channelId, user);
      setMembers((current) =>
        current && !current.some((member) => member.id === userId) ? [...current, user] : current,
      );
      setNonMembers((current) => current.filter((candidate) => candidate.id !== userId));
    },
    [context, nonMembers],
  );
  const clear = useCallback(() => {
    rangesRef.current = [];
    setDismissedKey(null);
    setNonMembers([]);
    setSelectionStart(0);
  }, []);
  const initialize = useCallback((ranges: MentionRange[], caret: number) => {
    rangesRef.current = ranges;
    setSelectionStart(caret);
    setDismissedKey(null);
  }, []);

  return {
    activeIndex,
    candidates,
    clear,
    initialize,
    insert,
    invite,
    nonMembers,
    listboxId,
    onKeyDown,
    onValueChange,
    open,
    serialize,
    setActiveIndex,
    trackSelection,
    optionId: (index: number) => `${listboxId}-option-${index}`,
  };
}

export function clearMentionTypeaheadCachesForTests() {
  memberCache.clear();
  memberRequests.clear();
  userCache = null;
  userRequest = null;
}
