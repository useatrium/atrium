// Bridge to the Electron desktop shell (surface/desktop). In a normal browser
// `bridge` is null and every helper is inert, so the web app keeps its existing
// same-origin + httpOnly-session-cookie behavior. In the desktop shell the
// preload exposes `window.atrium`, and the app talks to an absolute server
// origin with a bearer token, the same model the mobile app uses.

interface DesktopUser {
  id: string;
  handle: string;
  displayName: string;
}
interface DesktopSessionData {
  serverUrl: string;
  token: string;
  user: DesktopUser;
}
interface DesktopBridge {
  isDesktop: true;
  platform: string;
  serverUrl: string;
  session: DesktopSessionData | null;
  setSession(value: DesktopSessionData): Promise<void>;
  clearSession(): Promise<void>;
  setBadge(count: number): Promise<void>;
  onNavigate?(cb: (path: string) => void): () => void;
}

const bridge: DesktopBridge | null =
  typeof window !== 'undefined' && (window as unknown as { atrium?: DesktopBridge }).atrium?.isDesktop === true
    ? (window as unknown as { atrium: DesktopBridge }).atrium
    : null;

export const isDesktop = bridge !== null;

let token: string | null = bridge?.session?.token ?? null;

/** API client options: absolute origin + bearer token on desktop; undefined in
 * the browser (so createApi falls back to same-origin + cookie). */
export function desktopApiOptions(): { baseUrl: string; getToken: () => string | null } | undefined {
  if (!bridge) return undefined;
  return { baseUrl: bridge.serverUrl, getToken: () => token };
}

/** Per-attempt WS URL with a fresh token (desktop only; null in the browser). */
export function desktopWsUrl(): string | null {
  if (!bridge) return null;
  const wsBase = bridge.serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
  return token ? `${wsBase}/ws?token=${encodeURIComponent(token)}` : `${wsBase}/ws`;
}

/** After a successful login: keep the token and persist the session (keychain). */
export async function captureDesktopLogin(result: { user: DesktopUser; token?: string }): Promise<void> {
  if (!bridge || !result.token) return;
  token = result.token;
  await bridge.setSession({ serverUrl: bridge.serverUrl, token: result.token, user: result.user });
}

/** On logout: drop the in-memory token and clear the persisted session. */
export async function clearDesktopSession(): Promise<void> {
  token = null;
  if (bridge) await bridge.clearSession();
}

/** Dock/taskbar unread badge (desktop only; no-op in the browser). */
export function setDesktopBadge(count: number): void {
  void bridge?.setBadge(count);
}

/** Native shell navigation events (desktop only; inert in the browser). */
export function onDesktopNavigate(cb: (path: string) => void): () => void {
  return bridge?.onNavigate?.(cb) ?? (() => {});
}
