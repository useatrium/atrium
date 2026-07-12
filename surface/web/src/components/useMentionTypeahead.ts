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

const memberCache = new Map<string, UserRef[]>();
const memberRequests = new Map<string, Promise<UserRef[]>>();
let userCache: UserRef[] | null = null;
let userRequest: Promise<UserRef[]> | null = null;

function loadMembers(channelId: string): Promise<UserRef[]> {
  const cached = memberCache.get(channelId);
  if (cached) return Promise.resolve(cached);
  const pending = memberRequests.get(channelId);
  if (pending) return pending;
  const request = api
    .channelMembers(channelId)
    .then(({ members }) => {
      memberCache.set(channelId, members);
      return members;
    })
    .catch(() => {
      memberCache.set(channelId, []);
      return [];
    })
    .finally(() => memberRequests.delete(channelId));
  memberRequests.set(channelId, request);
  return request;
}

function loadUsers(): Promise<UserRef[]> {
  if (userCache) return Promise.resolve(userCache);
  if (userRequest) return userRequest;
  userRequest = api
    .users()
    .then(({ users }) => {
      userCache = users;
      primeUserDirectory(users);
      return users;
    })
    .catch(() => {
      userCache = [];
      return [];
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
  const rangesRef = useRef<MentionRange[]>([]);
  const listboxId = `mention-listbox-${useId().replace(/:/g, '')}`;
  const match = context ? matchMentionPrefix(value.slice(0, selectionStart)) : null;
  const matchKey = match ? `${match.start}:${match.prefix}` : null;

  useEffect(() => {
    if (!context || !match || (members !== null && users !== null)) return;
    // Public channels have no explicit membership (workspace = membership), so
    // the members endpoint is a 404 there — the whole directory counts as in-channel.
    const membersPromise = context.publicChannel ? Promise.resolve(null) : loadMembers(context.channelId);
    void Promise.all([membersPromise, loadUsers()]).then(([nextMembers, nextUsers]) => {
      setMembers(context.publicChannel ? nextUsers : nextMembers);
      setUsers(nextUsers);
    });
  }, [context, match, members, users]);

  useEffect(() => {
    setMembers(memberCache.get(context?.channelId ?? '') ?? null);
    setUsers(userCache);
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
    [match, selectionStart, setValue, textareaRef, value],
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
  const clear = useCallback(() => {
    rangesRef.current = [];
    setDismissedKey(null);
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
