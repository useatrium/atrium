export type WindowOpenDecision = { kind: 'popout' } | { kind: 'external' } | { kind: 'deny' };

export interface WindowOpenPolicyContext {
  appOrigin: string;
  devOrigin: string | null;
}

export type RegisteredPopoutState = 'missing' | 'live' | 'destroyed';

export type SessionPopoutOpenDecision =
  | { action: 'create'; sessionId: string }
  | { action: 'focus'; sessionId: string }
  | { action: 'deny' };

const SESSION_PANE_PATH = /^\/s\/([^/]+)\/pane$/;

export function sessionIdFromPanePath(pathname: string): string | null {
  return SESSION_PANE_PATH.exec(pathname)?.[1] ?? null;
}

export function resolveSessionPopoutOpen(
  sessionId: string | null,
  existingWindow: RegisteredPopoutState,
): SessionPopoutOpenDecision {
  if (!sessionId) return { action: 'deny' };
  if (existingWindow === 'live') return { action: 'focus', sessionId };
  return { action: 'create', sessionId };
}

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

  if (isKnownOrigin && sessionIdFromPanePath(parsed.pathname)) {
    return { kind: 'popout' };
  }

  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !isKnownOrigin) {
    return { kind: 'external' };
  }

  return { kind: 'deny' };
}
