import { useSyncExternalStore } from 'react';

const HOVER_NONE_MEDIA_QUERY = '(hover: none)';

// One MediaQueryList for the whole app. MessageRow renders per message, so a
// per-hook listener would attach hundreds of them in a busy channel.
let query: MediaQueryList | null = null;

function mediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  if (!query) query = window.matchMedia(HOVER_NONE_MEDIA_QUERY);
  return query;
}

function subscribe(onChange: () => void): () => void {
  const q = mediaQuery();
  if (!q) return () => {};
  q.addEventListener('change', onChange);
  return () => q.removeEventListener('change', onChange);
}

/** True on devices with no hover (phones/tablets), where actions need a visible ⋯ rather than a hover toolbar. */
export function useIsHoverNone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => mediaQuery()?.matches ?? false,
    () => false,
  );
}
