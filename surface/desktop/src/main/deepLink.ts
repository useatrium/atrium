export const DEEP_LINK_SCHEME = 'atrium';

function normalizeAtriumPath(url: URL): string {
  const pathname = url.pathname === '/' ? '' : url.pathname;
  if (url.hostname) return `/${url.hostname}${pathname}`;
  return url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;
}

function validSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    decodeURIComponent(value);
  } catch {
    return null;
  }
  return value;
}

function routeFromPath(pathname: string, options: { allowSessionAlias: boolean }): string | null {
  const segments = pathname.split('/').filter(Boolean);
  const kind = segments[0];
  const id = validSegment(segments[1]);

  if (kind === 's' && id && segments.length === 2) return `/s/${id}`;
  if (kind === 'e' && id && segments.length === 2) return `/e/${id}`;
  if (kind === 'c' && id) return `/c/${id}`;
  if (options.allowSessionAlias && kind === 'session' && id && segments.length === 2) {
    return `/s/${id}`;
  }

  return null;
}

export function deepLinkToRoute(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol === `${DEEP_LINK_SCHEME}:`) {
    return routeFromPath(normalizeAtriumPath(url), { allowSessionAlias: true });
  }

  if (url.protocol === 'https:') {
    return routeFromPath(url.pathname, { allowSessionAlias: false });
  }

  return null;
}
