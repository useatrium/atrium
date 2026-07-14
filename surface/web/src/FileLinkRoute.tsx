import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentPathRef } from '@atrium/surface-client/agent-paths';
import { URL_PARAMS } from './router';

type ResolvedFile = { artifactId: string; path: string; tombstoned: boolean };

export interface FileLinkDestination {
  pathname: '/files';
  search: string;
  initialFileArtifactId: string;
}

export function destinationForFile(file: ResolvedFile): FileLinkDestination {
  const params = new URLSearchParams();
  const segments = file.path.split('/').filter(Boolean);
  const dir = segments.slice(0, -1).join('/');
  if (dir) params.set(URL_PARAMS.dir, dir);
  params.set(URL_PARAMS.file, file.artifactId);
  return { pathname: '/files', search: params.toString(), initialFileArtifactId: file.artifactId };
}

export function FileLinkRoute({
  refInfo,
  children,
}: {
  refInfo: Exclude<AgentPathRef, { kind: 'workspace-relative' }>;
  children: (destination: FileLinkDestination) => ReactNode;
}) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ready'; destination: FileLinkDestination } | { kind: 'not-found' }
  >({ kind: 'loading' });

  useEffect(() => {
    let disposed = false;
    setState({ kind: 'loading' });
    fetch(`/api/files/by-path?path=${encodeURIComponent(refInfo.canonicalPath)}`, { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as ResolvedFile;
      })
      .then((file) => {
        if (disposed) return;
        const destination = destinationForFile(file);
        const nextUrl = `${destination.pathname}?${destination.search}`;
        if (window.location.pathname + window.location.search !== nextUrl) {
          window.history.replaceState(null, '', nextUrl);
        }
        setState({ kind: 'ready', destination });
      })
      .catch(() => {
        if (!disposed) setState({ kind: 'not-found' });
      });
    return () => {
      disposed = true;
    };
  }, [refInfo.canonicalPath]);

  const body = useMemo(() => {
    if (state.kind === 'ready') return children(state.destination);
    if (state.kind === 'loading') return <div className="h-dvh bg-surface" />;
    return (
      <div className="flex h-dvh items-center justify-center bg-surface px-6 text-center">
        <div>
          <h1 className="text-base font-semibold text-fg">File not found</h1>
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
