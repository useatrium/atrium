import { useEffect, useRef, useState } from 'react';
import type { PreviewFile } from './types';
import { fetchText, previewUrl } from './utils';

const MAX_CONCURRENT_FETCHES = 4;
const MAX_CACHE_ENTRIES = 96;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_ENTRY_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

interface CacheEntry {
  promise: Promise<string>;
  text?: string;
  bytes: number;
  consumers: number;
  retained: boolean;
  controller: AbortController;
  cancelQueued: () => boolean;
  cancelTimer?: ReturnType<typeof setTimeout>;
}

interface QueuedFetch {
  run: () => void;
}

const cache = new Map<string, CacheEntry>();
const fetchQueue: QueuedFetch[] = [];
let activeFetches = 0;
let cachedBytes = 0;

export function previewTextCacheKey(file: PreviewFile): string {
  return `${file.id}:${file.versionSeq ?? 'unknown'}:${previewUrl(file)}`;
}

function touch(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
}

function drainQueue(): void {
  while (activeFetches < MAX_CONCURRENT_FETCHES) {
    const next = fetchQueue.shift();
    if (!next) return;
    activeFetches += 1;
    next.run();
  }
}

function scheduleFetch(task: () => Promise<string>): { promise: Promise<string>; cancelQueued: () => boolean } {
  let queued: QueuedFetch | undefined;
  let rejectQueued: ((reason: unknown) => void) | undefined;
  const promise = new Promise<string>((resolve, reject) => {
    rejectQueued = reject;
    queued = {
      run: () => {
        queued = undefined;
        void task()
          .then(resolve, reject)
          .finally(() => {
            activeFetches -= 1;
            drainQueue();
          });
      },
    };
    fetchQueue.push(queued);
    drainQueue();
  });
  return {
    promise,
    cancelQueued: () => {
      if (!queued) return false;
      const index = fetchQueue.indexOf(queued);
      if (index < 0) return false;
      fetchQueue.splice(index, 1);
      queued = undefined;
      rejectQueued?.(new DOMException('Preview load cancelled', 'AbortError'));
      return true;
    },
  };
}

function evictOverflow(): void {
  for (const [key, entry] of cache) {
    if (cache.size <= MAX_CACHE_ENTRIES && cachedBytes <= MAX_CACHE_BYTES) return;
    if (entry.text == null) continue;
    cache.delete(key);
    cachedBytes -= entry.bytes;
  }
}

function getPreviewTextEntry(file: PreviewFile, retained: boolean): CacheEntry {
  const key = previewTextCacheKey(file);
  const existing = cache.get(key);
  if (existing) {
    if (retained) existing.retained = true;
    touch(key, existing);
    return existing;
  }

  const controller = new AbortController();
  const scheduled = scheduleFetch(async () => {
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Preview load timed out', 'TimeoutError')),
      FETCH_TIMEOUT_MS,
    );
    try {
      return await fetchText(file, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  });
  const entry: CacheEntry = {
    bytes: 0,
    promise: scheduled.promise,
    consumers: 0,
    retained,
    controller,
    cancelQueued: scheduled.cancelQueued,
  };
  cache.set(key, entry);
  entry.promise = entry.promise
    .then((text) => {
      if (cache.get(key) !== entry) return text;
      const bytes = new TextEncoder().encode(text).byteLength;
      if (bytes > MAX_CACHED_ENTRY_BYTES) {
        cache.delete(key);
        return text;
      }
      entry.text = text;
      entry.bytes = bytes;
      cachedBytes += bytes;
      touch(key, entry);
      evictOverflow();
      return text;
    })
    .catch((error: unknown) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    });
  return entry;
}

export function loadPreviewText(file: PreviewFile): Promise<string> {
  return getPreviewTextEntry(file, true).promise;
}

function subscribePreviewText(file: PreviewFile): { promise: Promise<string>; release: () => void } {
  const key = previewTextCacheKey(file);
  const entry = getPreviewTextEntry(file, false);
  if (entry.cancelTimer) {
    clearTimeout(entry.cancelTimer);
    entry.cancelTimer = undefined;
  }
  entry.consumers += 1;
  let released = false;
  return {
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry.consumers -= 1;
      if (entry.consumers > 0 || entry.retained || entry.text != null || cache.get(key) !== entry) return;
      // React Strict Mode intentionally cleans up and remounts effects in the
      // same turn. Defer cancellation so that remount can reclaim the shared
      // request without sending a duplicate; truly stale queued work is still
      // removed before it starts.
      entry.cancelTimer = setTimeout(() => {
        entry.cancelTimer = undefined;
        if (entry.consumers > 0 || entry.retained || entry.text != null || cache.get(key) !== entry) return;
        if (entry.cancelQueued()) cache.delete(key);
      }, 0);
    },
  };
}

export function clearPreviewTextCache(): void {
  cache.clear();
  cachedBytes = 0;
}

type PreviewTextState =
  | { status: 'loading'; text: '' }
  | { status: 'ready'; text: string }
  | { status: 'error'; text: string };

export function usePreviewText(file: PreviewFile): PreviewTextState {
  const key = previewTextCacheKey(file);
  const fileRef = useRef(file);
  fileRef.current = file;
  const [state, setState] = useState<PreviewTextState>({ status: 'loading', text: '' });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', text: '' });
    const subscription = subscribePreviewText(fileRef.current);
    void subscription.promise.then(
      (text) => {
        if (active) setState({ status: 'ready', text });
      },
      (error: unknown) => {
        if (active) setState({ status: 'error', text: error instanceof Error ? error.message : 'Failed to load' });
      },
    );
    return () => {
      active = false;
      subscription.release();
    };
  }, [key]);

  return state;
}
