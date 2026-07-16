import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { extractMentionTokens, type UserRef } from '@atrium/surface-client';
import { api } from './api';

let usersById = new Map<string, UserRef>();
type Status = 'idle' | 'loading' | 'ok' | 'failed';
let status: Status = 'idle';
let inflight: Promise<void> | null = null;
let attempt = 0;
let nextAttemptAt = 0;
const recheckAt = new Map<string, number>();
// Backoff grows but is CAPPED rather than capping the attempt count: a hard attempt
// cap is just a bigger one-shot latch — exhaust it and the directory is poisoned
// until reload, which is the bug this module exists to prevent.
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, MAX_BACKOFF_MS];
const ABSENT_TTL_MS = 5 * 60_000;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return usersById;
}

export function primeUserDirectory(users: UserRef[]) {
  usersById = new Map(users.map((user) => [user.id.toLowerCase(), user]));
  status = 'ok';
  attempt = 0;
  inflight = null;
  emit();
}

function fire(): Promise<void> {
  status = 'loading';
  // A single trailing catch, not `.then(onOk, onErr)`: a malformed 200 (no `users`
  // field, e.g. an empty 304 body) makes primeUserDirectory throw, and the two-argument
  // form would leave status pinned at 'loading' forever — every later ensure() would
  // early-return and the directory could never recover. Any failure must reach the
  // retry path.
  const request = Promise.resolve()
    .then(() => api.users())
    .then(({ users }) => {
      primeUserDirectory(users);
    })
    .catch(() => {
      status = 'failed';
      attempt++;
      nextAttemptAt = Date.now() + (BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? MAX_BACKOFF_MS);
      inflight = null;
    });
  inflight = request;
  return request;
}

function ensure(neededIds: string[]): Promise<void> | undefined {
  if (status === 'loading') return inflight ?? undefined;

  const now = Date.now();
  if (status === 'idle') return fire();
  if (status === 'failed') {
    if (now >= nextAttemptAt) return fire();
    return undefined;
  }

  const unknown = neededIds.filter((id) => !usersById.has(id));
  if (unknown.length && unknown.some((id) => now >= (recheckAt.get(id) ?? 0))) {
    for (const id of unknown) recheckAt.set(id, now + ABSENT_TTL_MS);
    return fire();
  }
  return undefined;
}

export function loadUserDirectory(): Promise<void> {
  return ensure([]) ?? Promise.resolve();
}

export function useUserDirectory(text = '') {
  const directory = useSyncExternalStore(subscribe, snapshot, snapshot);
  const ids = extractMentionTokens(text).userIds;

  useEffect(() => {
    if (ids.length) void ensure(ids);
  }, [ids]);

  const resolve = useCallback((id: string) => directory.get(id.toLowerCase()) ?? null, [directory]);
  return { resolve };
}

export function clearUserDirectoryForTests() {
  usersById = new Map();
  status = 'idle';
  inflight = null;
  attempt = 0;
  nextAttemptAt = 0;
  recheckAt.clear();
  emit();
}
