export const DEEP_LINK_SCHEME = 'atrium';

function normalizeAtriumPath(url: URL): string {
  const pathname = url.pathname === '/' ? '' : url.pathname;
  if (url.hostname) return `/${url.hostname}${pathname}`;
  return url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;
}

function validSegment(value: string | undefined): value is string {
  if (!value) return false;
  try {
    decodeURIComponent(value);
  } catch {
    return false;
  }
  return true;
}

function pathSegments(pathname: string): string[] | null {
  const path = pathname === '' ? '/' : pathname;
  if (!path.startsWith('/')) return null;
  if (path === '/') return [];

  const segments = path.slice(1).split('/');
  if (segments.some((segment) => segment.length === 0)) return null;
  return segments;
}

function routeFromPath(pathname: string, options: { allowSessionAlias: boolean }): string | null {
  const path = pathname === '' ? '/' : pathname;
  const segments = pathSegments(path);
  if (!segments) return null;
  if (segments.length === 0) return path;

  const kind = segments[0];
  const id = segments[1];

  if (kind === 'files' && segments.length === 1) return path;
  if (kind === 'activity' && segments.length === 1) return path;
  if (kind === 'agents' && segments.length === 1) return path;

  if (kind === 'settings') {
    if (segments.length === 1) return path;
    if (segments.length === 2 && validSegment(id)) return path;
    return null;
  }

  if (kind === 's' && validSegment(id)) {
    if (segments.length === 2) return path;
    if (segments.length === 3 && segments[2] === 'pane') return path;
    if (segments.length === 4 && segments[2] === 'work' && validSegment(segments[3])) return path;
    return null;
  }

  if (kind === 'e' && segments.length === 2 && validSegment(id)) return path;

  if (kind === 'c' && validSegment(id)) {
    if (segments.length === 2) return path;
    if (segments.length === 3 && segments[2] === 'members') return path;
    if (segments.length === 4 && segments[2] === 's' && validSegment(segments[3])) return path;
    if (segments.length === 4 && segments[2] === 't' && validSegment(segments[3])) return path;
    return null;
  }

  if (options.allowSessionAlias && kind === 'session' && segments.length === 2 && validSegment(id)) {
    return `/s/${id}`;
  }

  return null;
}

function routeFromUrl(url: URL, pathname: string, options: { allowSessionAlias: boolean }): string | null {
  const route = routeFromPath(pathname, options);
  return route ? `${route}${url.search}` : null;
}

export function deepLinkToRoute(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol === `${DEEP_LINK_SCHEME}:`) {
    return routeFromUrl(url, normalizeAtriumPath(url), { allowSessionAlias: true });
  }

  if (url.protocol === 'https:') {
    return routeFromUrl(url, url.pathname, { allowSessionAlias: false });
  }

  return null;
}
