import { type ReactNode, useEffect, useState } from 'react';
import { ApiError, api, type Workspace } from './api';
import { Chat } from './Chat';
import { Login } from './Login';
import { Toasts } from './components/Toasts';
import { adoptPrefs } from './theme';
import type { UserRef } from '@atrium/surface-client';
import { clearCache, loadBootSnapshot, saveBootSnapshot } from './cacheIdb';
import { clearDesktopSession } from './desktop';
import { SessionWorkPage } from './sessions/SessionWorkPage';
import { SLUG_TAB, type ActiveWorkTab } from './sessions/WorkDrawer';

/** /s/:id — session permalink; opens the app with that session's pane open. */
function sessionIdFromPath(pathname: string): string | null {
  const m = /^\/s\/([^/]+)$/.exec(pathname);
  return m?.[1] ?? null;
}

/** /s/:id/work/:slug — the Detach rung: a single work surface in its own tab.
 * Returns null for an unknown slug so we fall back to the normal app shell. */
export function workRouteFromPath(pathname: string): { sessionId: string; tab: ActiveWorkTab } | null {
  const m = /^\/s\/([^/]+)\/work\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  const tab = SLUG_TAB[m[2]!];
  return tab ? { sessionId: m[1]!, tab } : null;
}

export function App() {
  const [workRoute] = useState(() => workRouteFromPath(location.pathname));
  const [initialSessionId] = useState(() => sessionIdFromPath(location.pathname));
  const [me, setMe] = useState<UserRef | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let disposed = false;
    api
      .me()
      .then(async ({ user, prefs }) => {
        if (disposed) return;
        setMe(user);
        if (prefs) adoptPrefs(prefs);
        const { workspaces } = await api.workspaces();
        if (disposed) return;
        const first = workspaces[0] ?? null;
        setWorkspace(first);
        if (first) {
          void saveBootSnapshot({
            user,
            workspace: first,
            ...(prefs ? { prefs } : {}),
          }).catch((err: unknown) => {
            console.warn('failed to cache boot snapshot', err);
          });
        }
      })
      .catch(async (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          await clearCache();
          return;
        }
        try {
          const snapshot = await loadBootSnapshot();
          if (disposed || !snapshot) return;
          setMe(snapshot.user);
          setWorkspace(snapshot.workspace);
          if (snapshot.prefs) adoptPrefs(snapshot.prefs);
        } catch (loadErr) {
          console.warn('failed to load boot snapshot', loadErr);
        }
      })
      .finally(() => {
        if (!disposed) setChecked(true);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!me || workspace) return;
    const currentUser = me;
    api.workspaces().then(({ workspaces }) => setWorkspaces(workspaces)).catch(() => {});
    function setWorkspaces(list: Workspace[]) {
      const first = list[0] ?? null;
      setWorkspace(first);
      if (first) {
        void saveBootSnapshot({ user: currentUser, workspace: first }).catch((err: unknown) => {
          console.warn('failed to cache boot snapshot', err);
        });
      }
    }
  }, [me, workspace]);

  // Toasts mount at the root so even login-screen failures surface.
  let body: ReactNode;
  if (!checked) body = <div className="h-dvh bg-surface" />;
  else if (!me) body = <Login onLogin={setMe} />;
  else if (!workspace)
    body = (
      <div className="flex h-dvh items-center justify-center bg-surface text-sm text-fg-muted">
        Loading workspace…
      </div>
    );
  else if (workRoute)
    // Detached work surface in its own tab — a focused, full-viewport view of one
    // surface, no channel shell (it folds the same live stream as the in-app pane).
    body = <SessionWorkPage sessionId={workRoute.sessionId} tab={workRoute.tab} />;
  else
    body = (
      <Chat
        me={me}
        workspace={workspace}
        initialSessionId={initialSessionId}
        onLogout={() => {
          // logout() first (still holds the token), then drop the keychain
          // session, then clear the cache and reload.
          api.logout().catch(() => {}).finally(() => {
            void clearDesktopSession().finally(() => {
              clearCache().finally(() => location.reload());
            });
          });
        }}
      />
    );

  return (
    <>
      {body}
      <Toasts />
    </>
  );
}
