// An identity gateway in front of Atrium (Cloudflare Access on the hosted box)
// answers an expired session by redirecting requests to its own login host —
// including the SPA's same-origin XHR. `fetch` cannot follow a cross-origin
// redirect, so it rejects with a bare TypeError that is indistinguishable from
// "offline" unless we re-ask for the redirect explicitly. Re-authenticating
// needs a *top-level navigation*; no amount of retrying the XHR can recover.

/** Survives the reload (same tab), so a gateway that bounces us straight back
 * lands on the error wall instead of looping. Cleared on a successful boot. */
const RELOAD_GUARD_KEY = 'atrium:auth-gateway-reload';

/** True when the gateway redirected this request somewhere we can't follow.
 * `redirect: 'manual'` turns that redirect into an opaqueredirect response
 * instead of a throw, which is the only way to tell it apart from a dead
 * network. Any throw here means the request never got an answer at all. */
export async function authGatewayRedirected(path = '/auth/me'): Promise<boolean> {
  try {
    const res = await fetch(path, { redirect: 'manual', credentials: 'include' });
    return res.type === 'opaqueredirect';
  } catch {
    return false;
  }
}

/** Reload to hand the gateway a top-level navigation it can redirect to its
 * login page. Returns false (and reloads nothing) if we already tried in this
 * tab, or if sessionStorage is unavailable — without a guard we can't bound a
 * reload loop, so we don't start one. */
export function reloadForAuthGateway(reload: () => void = () => location.reload()): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_GUARD_KEY)) return false;
    sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
  } catch {
    return false;
  }
  reload();
  return true;
}

export function clearAuthGatewayReloadGuard(): void {
  try {
    sessionStorage.removeItem(RELOAD_GUARD_KEY);
  } catch {
    /* storage disabled — nothing to clear */
  }
}
