import { useSyncExternalStore } from 'react';
import { agentPathFromLocationPath, type AgentPathRef } from '@atrium/surface-client/agent-paths';

export type MainSurface = 'chat' | 'files' | 'activity' | 'settings' | 'credentials';

// URL grammar. Paths are places; query params are view modifiers layered on a
// place. Every navigational view state must be expressible here so it survives
// refresh and can be linked.
//
//   /                          default channel
//   /c/:channelId              channel
//   /c/:channelId/s/:sessionId channel + focused session
//   /c/:channelId/t/:rootId    channel + open thread panel
//   /c/:channelId/members      channel + members view
//   /s/:sessionId              legacy session permalink (canonicalizes)
//   /files /activity           surfaces
//   /credentials               advanced credential store
//   /settings[/:section]       settings, optionally scrolled to a section
//
// Query params (URL_PARAMS): `agent` (session panel over the current channel),
// `file` (open artifact lightbox), `panel`
// (lightbox side panel: info|history), `work` (in-pane work-drawer slug),
// `dir` (FilesHub folder path), `preview` (artifact/app preview path),
// `view` (`focus` session layout; written via replaceState). `entry` and
// `threadRoot` remain inbound-only deep-link params consumed on load.
export const URL_PARAMS = {
  agent: 'agent',
  file: 'file',
  panel: 'panel',
  work: 'work',
  dir: 'dir',
  preview: 'preview',
  view: 'view',
  entry: 'entry',
  threadRoot: 'threadRoot',
} as const;

export interface InAppRoute {
  surface: MainSurface;
  channelId: string | null;
  sessionId: string | null;
  /** Session panel layered over channelId — /c/:id?agent=:sessionId. */
  panelSessionId?: string | null;
  /** Open thread panel rooted at this event — /c/:id/t/:rootId. */
  threadRootId?: string | null;
  /** Channel members view — /c/:id/members. */
  membersOpen?: boolean;
  /** Settings section — /settings/:section. */
  settingsSection?: string | null;
  /** Reserved for legacy explicit focus-on-load links. */
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
  threadRootId: null,
  membersOpen: false,
  settingsSection: null,
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
  if (pathname === '/credentials') return { ...DEFAULT_ROUTE, surface: 'credentials' };
  if (pathname === '/settings') return { ...DEFAULT_ROUTE, surface: 'settings' };

  const settingsSection = /^\/settings\/([^/]+)$/.exec(pathname);
  if (settingsSection) {
    const section = decodeSegment(settingsSection[1]!);
    return section ? { ...DEFAULT_ROUTE, surface: 'settings', settingsSection: section } : null;
  }

  const legacySession = /^\/s\/([^/]+)$/.exec(pathname);
  if (legacySession) {
    // Legacy /s/:id canonicalizes to the same focused session place.
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

  const channelThread = /^\/c\/([^/]+)\/t\/([^/]+)$/.exec(pathname);
  if (channelThread) {
    const channelId = decodeSegment(channelThread[1]!);
    const threadRootId = decodeSegment(channelThread[2]!);
    return channelId && threadRootId ? { ...DEFAULT_ROUTE, channelId, threadRootId } : null;
  }

  const channelMembers = /^\/c\/([^/]+)\/members$/.exec(pathname);
  if (channelMembers) {
    const channelId = decodeSegment(channelMembers[1]!);
    return channelId ? { ...DEFAULT_ROUTE, channelId, membersOpen: true } : null;
  }

  return null;
}

export function initialInAppRoute(pathname: string): InAppRoute {
  if (filePathRefFromPath(pathname)) return { ...DEFAULT_ROUTE, surface: 'files' };
  return parseInAppRoute(pathname) ?? DEFAULT_ROUTE;
}

export function filePathRefFromPath(pathname: string): Exclude<AgentPathRef, { kind: 'workspace-relative' }> | null {
  const ref = agentPathFromLocationPath(pathname);
  return ref?.kind === 'workspace-relative' ? null : ref;
}

export function routePath(route: InAppRoute): string {
  if (route.surface === 'files') return '/files';
  if (route.surface === 'activity') return '/activity';
  if (route.surface === 'credentials') return '/credentials';
  if (route.surface === 'settings') {
    return route.settingsSection ? `/settings/${encodeURIComponent(route.settingsSection)}` : '/settings';
  }
  if (!route.channelId) return route.sessionId ? `/s/${encodeURIComponent(route.sessionId)}` : '/';
  const channelPath = `/c/${encodeURIComponent(route.channelId)}`;
  if (route.sessionId) return `${channelPath}/s/${encodeURIComponent(route.sessionId)}`;
  if (route.threadRootId) return `${channelPath}/t/${encodeURIComponent(route.threadRootId)}`;
  if (route.membersOpen) return `${channelPath}/members`;
  return channelPath;
}
