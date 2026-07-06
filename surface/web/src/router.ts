import { useSyncExternalStore } from 'react';

export type MainSurface = 'chat' | 'files' | 'activity' | 'agents' | 'settings';

export interface InAppRoute {
  surface: MainSurface;
  channelId: string | null;
  sessionId: string | null;
  /** Reserved for an explicit focus-on-load; permalinks now open in split. */
  focusSession: boolean;
}

export interface BrowserLocation {
  pathname: string;
  search: string;
  hash: string;
}

type NavigateOptions = {
  replace?: boolean;
};

const listeners = new Set<() => void>();
const DEFAULT_ROUTE: InAppRoute = {
  surface: 'chat',
  channelId: null,
  sessionId: null,
  focusSession: false,
};
const SERVER_LOCATION: BrowserLocation = { pathname: '/', search: '', hash: '' };
let cachedLocation: BrowserLocation = SERVER_LOCATION;
let cachedLocationKey = '/';

function emitLocationChange(): void {
  for (const listener of listeners) listener();
}

function getBrowserLocation(): BrowserLocation {
  if (typeof window === 'undefined') return SERVER_LOCATION;
  const key = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (key === cachedLocationKey) return cachedLocation;
  cachedLocationKey = key;
  cachedLocation = {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  };
  return cachedLocation;
}

function subscribe(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

export function useLocation(): BrowserLocation {
  return useSyncExternalStore(subscribe, getBrowserLocation, getBrowserLocation);
}

export function navigate(path: string, options: NavigateOptions = {}): void {
  if (typeof window === 'undefined') return;
  const next = new URL(path, window.location.href);
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const target = `${next.pathname}${next.search}${next.hash}`;
  if (current === target) return;
  const method = options.replace ? 'replaceState' : 'pushState';
  window.history[method](null, '', target);
  emitLocationChange();
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseInAppRoute(pathname: string): InAppRoute | null {
  if (pathname === '/') return DEFAULT_ROUTE;
  if (pathname === '/files') return { ...DEFAULT_ROUTE, surface: 'files' };
  if (pathname === '/activity') return { ...DEFAULT_ROUTE, surface: 'activity' };
  if (pathname === '/agents') return { ...DEFAULT_ROUTE, surface: 'agents' };
  if (pathname === '/settings') return { ...DEFAULT_ROUTE, surface: 'settings' };

  const legacySession = /^\/s\/([^/]+)$/.exec(pathname);
  if (legacySession) {
    // Legacy /s/:id opens the session pane in the default (split) layout —
    // matching the prior permalink behavior the e2e suite locks in. Focus is a
    // user-driven pane toggle, not a property of the permalink.
    const sessionId = decodeSegment(legacySession[1]!);
    return sessionId ? { ...DEFAULT_ROUTE, sessionId } : null;
  }

  const channel = /^\/c\/([^/]+)$/.exec(pathname);
  if (channel) {
    const channelId = decodeSegment(channel[1]!);
    return channelId ? { ...DEFAULT_ROUTE, channelId } : null;
  }

  const channelSession = /^\/c\/([^/]+)\/s\/([^/]+)$/.exec(pathname);
  if (channelSession) {
    const channelId = decodeSegment(channelSession[1]!);
    const sessionId = decodeSegment(channelSession[2]!);
    return channelId && sessionId ? { ...DEFAULT_ROUTE, channelId, sessionId } : null;
  }

  return null;
}

export function initialInAppRoute(pathname: string): InAppRoute {
  return parseInAppRoute(pathname) ?? DEFAULT_ROUTE;
}

export function routePath(route: InAppRoute): string {
  if (route.surface === 'files') return '/files';
  if (route.surface === 'activity') return '/activity';
  if (route.surface === 'agents') return '/agents';
  if (route.surface === 'settings') return '/settings';
  if (!route.channelId) return route.sessionId ? `/s/${encodeURIComponent(route.sessionId)}` : '/';
  const channelPath = `/c/${encodeURIComponent(route.channelId)}`;
  return route.sessionId ? `${channelPath}/s/${encodeURIComponent(route.sessionId)}` : channelPath;
}
