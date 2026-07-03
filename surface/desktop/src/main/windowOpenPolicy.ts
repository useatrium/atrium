export type WindowOpenDecision = { kind: 'popout' } | { kind: 'external' } | { kind: 'deny' };

export interface WindowOpenPolicyContext {
  appOrigin: string;
  devOrigin: string | null;
}

const SESSION_PANE_PATH = /^\/s\/[^/]+\/pane$/;

function comparableOrigin(url: URL): string {
  return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
}

function parseOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try {
    return comparableOrigin(new URL(origin));
  } catch {
    return null;
  }
}

export function resolveWindowOpen(url: string, ctx: WindowOpenPolicyContext): WindowOpenDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'deny' };
  }

  const urlOrigin = comparableOrigin(parsed);
  const appOrigin = parseOrigin(ctx.appOrigin);
  const devOrigin = parseOrigin(ctx.devOrigin);
  const isAppOrigin = appOrigin !== null && urlOrigin === appOrigin;
  const isDevOrigin = devOrigin !== null && urlOrigin === devOrigin;
  const isKnownOrigin = isAppOrigin || isDevOrigin;

  if (isKnownOrigin && SESSION_PANE_PATH.test(parsed.pathname)) {
    return { kind: 'popout' };
  }

  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !isKnownOrigin) {
    return { kind: 'external' };
  }

  return { kind: 'deny' };
}
