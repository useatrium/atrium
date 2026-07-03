import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api, type NormalizedEntry } from './api';

export interface EntryLinkDestination {
  pathname: string;
  search: string;
  initialChannelId: string | null;
  initialSessionId: string | null;
  initialEntryHandle: string;
  initialThreadRootEventId: number | null;
  targetType: NormalizedEntry['targetType'];
}

type EntryLocationWithThread = NormalizedEntry['location'] & { threadRootEventId?: number | null };

export function entryHandleFromPath(pathname: string): string | null {
  const match = /^\/e\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

export function destinationForEntry(entry: NormalizedEntry): EntryLinkDestination | null {
  const threadRootEventId = threadRootEventIdForEntry(entry);
  const entrySearch = new URLSearchParams({ entry: entry.handle });
  if (threadRootEventId != null) entrySearch.set('threadRoot', String(threadRootEventId));
  const search = entrySearch.toString();
  if (entry.targetType === 'record') {
    const sessionId = entry.location.sessionId;
    if (!sessionId) return null;
    return {
      pathname: `/s/${encodeURIComponent(sessionId)}`,
      search,
      initialChannelId: null,
      initialSessionId: sessionId,
      initialEntryHandle: entry.handle,
      initialThreadRootEventId: null,
      targetType: entry.targetType,
    };
  }

  const channelId = entry.location.channelId;
  if (!channelId) return null;
  return {
    pathname: '/',
    search,
    initialChannelId: channelId,
    initialSessionId: null,
    initialEntryHandle: entry.handle,
    initialThreadRootEventId: threadRootEventId,
    targetType: entry.targetType,
  };
}

function threadRootEventIdForEntry(entry: NormalizedEntry): number | null {
  if (entry.targetType !== 'event') return null;
  const value = (entry.location as EntryLocationWithThread).threadRootEventId;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

export function entryParamFromSearch(search: string): string | null {
  return new URLSearchParams(search).get('entry');
}

export function threadRootParamFromSearch(search: string): number | null {
  const raw = new URLSearchParams(search).get('threadRoot');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function stripEntryParamFromLocation(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has('entry') && !url.searchParams.has('threadRoot')) return;
  url.searchParams.delete('entry');
  url.searchParams.delete('threadRoot');
  const next = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(null, '', next);
}

export function EntryLinkRoute({
  handle,
  children,
}: {
  handle: string;
  children: (destination: EntryLinkDestination) => ReactNode;
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; destination: EntryLinkDestination }
    | { kind: 'not-found' }
  >({ kind: 'loading' });

  useEffect(() => {
    let disposed = false;
    setState({ kind: 'loading' });
    api
      .resolveEntry(handle)
      .then((entry) => {
        if (disposed) return;
        const destination = destinationForEntry(entry);
        if (!destination) {
          setState({ kind: 'not-found' });
          return;
        }
        const nextUrl = `${destination.pathname}?${destination.search}`;
        if (window.location.pathname + window.location.search !== nextUrl) {
          window.history.replaceState(null, '', nextUrl);
        }
        setState({ kind: 'ready', destination });
      })
      .catch((err: unknown) => {
        if (disposed) return;
        if (err instanceof ApiError && (err.status === 403 || err.status === 404 || err.status === 400)) {
          setState({ kind: 'not-found' });
          return;
        }
        setState({ kind: 'not-found' });
      });
    return () => {
      disposed = true;
    };
  }, [handle]);

  const body = useMemo(() => {
    if (state.kind === 'ready') return children(state.destination);
    if (state.kind === 'loading') return <div className="h-dvh bg-surface" />;
    return (
      <div className="flex h-dvh items-center justify-center bg-surface px-6 text-center">
        <div>
          <h1 className="text-base font-semibold text-fg">Entry not found</h1>
          <p className="mt-1 text-sm text-fg-muted">It may have been removed, or the link is not available.</p>
          <a
            href="/"
            className="mt-4 inline-flex rounded-md border border-edge-strong px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-overlay hover:text-fg"
          >
            Home
          </a>
        </div>
      </div>
    );
  }, [children, state]);

  return <>{body}</>;
}
