import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { extractMentionTokens, type UserRef } from '@atrium/surface-client';
import { api } from './api';

let usersById = new Map<string, UserRef>();
let loaded = false;
let loading: Promise<void> | null = null;
let retriedUnknown = false;
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
  loaded = true;
  emit();
}

export function loadUserDirectory(force = false): Promise<void> {
  if (!force && loaded) return Promise.resolve();
  if (loading) return loading;
  loading = Promise.resolve()
    .then(() => api.users())
    .then(({ users }) => {
      primeUserDirectory(users);
    })
    .catch(() => {
      loaded = true;
      emit();
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export function resolveDirectoryUser(id: string): UserRef | null {
  return usersById.get(id.toLowerCase()) ?? null;
}

export function useUserDirectory(text = '') {
  const directory = useSyncExternalStore(subscribe, snapshot, snapshot);
  const ids = extractMentionTokens(text).userIds;
  const hasIds = ids.length > 0;

  useEffect(() => {
    if (hasIds) void loadUserDirectory();
  }, [hasIds]);

  useEffect(() => {
    if (!loaded || retriedUnknown || !ids.some((id) => !directory.has(id.toLowerCase()))) return;
    retriedUnknown = true;
    void loadUserDirectory(true);
  }, [directory, ids]);

  const resolve = useCallback((id: string) => directory.get(id.toLowerCase()) ?? null, [directory]);
  return { resolve };
}

export function clearUserDirectoryForTests() {
  usersById = new Map();
  loaded = false;
  loading = null;
  retriedUnknown = false;
  emit();
}
