import { type ReactNode, useEffect, useState } from 'react';
import { ApiError, api, type Workspace } from './api';
import { Chat } from './Chat';
import { EntryLinkRoute, entryHandleFromPath } from './EntryLinkRoute';
import { Login } from './Login';
import { isMarkupShellRoute, MarkupShellPage } from './MarkupShellPage';
import { Toasts } from './components/Toasts';
import { TooltipProvider } from './components/a11y';
import { adoptPrefs } from './theme';
import type { UserRef } from '@atrium/surface-client';
import { clearCache, loadBootSnapshot, saveBootSnapshot } from './cacheIdb';
import { clearDesktopSession } from './desktop';
import { initialInAppRoute } from './router';
import { SessionPanePage } from './sessions/SessionPanePage';
import { SessionWorkPage } from './sessions/SessionWorkPage';
import { SLUG_TAB, type ActiveWorkTab } from './sessions/WorkDrawer';

/** /s/:id/work/:slug — the Detach rung: a single work surface in its own tab.
 * Returns null for an unknown slug so we fall back to the normal app shell. */
export function workRouteFromPath(pathname: string): { sessionId: string; tab: ActiveWorkTab } | null {
  const m = /^\/s\/([^/]+)\/work\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  const tab = SLUG_TAB[m[2]!];
  return tab ? { sessionId: m[1]!, tab } : null;
}

/** /s/:id/pane — standalone lean session pane, no channel shell. */
export function paneRouteFromPath(pathname: string): { sessionId: string } | null {
  const m = /^\/s\/([^/]+)\/pane$/.exec(pathname);
  return m ? { sessionId: m[1]! } : null;
}

export function App() {
  const [paneRoute] = useState(() => paneRouteFromPath(location.pathname));
  const [markupShellRoute] = useState(() => isMarkupShellRoute(location.pathname));
  const [workRoute] = useState(() => workRouteFromPath(location.pathname));
  const [entryRouteHandle] = useState(() => entryHandleFromPath(location.pathname));
  const [initialRoute] = useState(() => initialInAppRoute(location.pathname));
  const [me, setMe] = useState<UserRef | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (markupShellRoute) {
      setChecked(true);
      return;
    }
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
  }, [markupShellRoute]);

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
  if (markupShellRoute) body = <MarkupShellPage />;
  else if (!checked) body = <div className="h-dvh bg-surface" />;
  else if (!me) body = <Login onLogin={setMe} />;
  else if (!workspace)
    body = (
      <div className="flex h-dvh items-center justify-center bg-surface text-sm text-fg-muted">
        Loading workspace…
      </div>
    );
  else if (paneRoute)
    body = <SessionPanePage key={paneRoute.sessionId} sessionId={paneRoute.sessionId} me={me} />;
  else if (workRoute)
    // Detached work surface in its own tab — a focused, full-viewport view of one
    // surface, no channel shell (it folds the same live stream as the in-app pane).
    body = <SessionWorkPage sessionId={workRoute.sessionId} tab={workRoute.tab} />;
  else if (entryRouteHandle)
    body = (
      <EntryLinkRoute handle={entryRouteHandle}>
        {(destination) => (
          <Chat
            me={me}
            workspace={workspace}
            initialSessionId={destination.initialSessionId}
            initialChannelId={destination.initialChannelId}
            initialMainSurface={destination.initialFileArtifactId ? 'files' : 'chat'}
            initialEntryHandle={destination.initialEntryHandle}
            onLogout={() => {
              api.logout().catch(() => {}).finally(() => {
                void clearDesktopSession().finally(() => {
                  clearCache().finally(() => location.reload());
                });
              });
            }}
          />
        )}
      </EntryLinkRoute>
    );
  else
    body = (
      <Chat
        me={me}
        workspace={workspace}
        initialSessionId={initialRoute.sessionId}
        initialChannelId={initialRoute.channelId}
        initialMainSurface={initialRoute.surface}
        initialSessionFocus={initialRoute.focusSession}
        initialEntryHandle={new URLSearchParams(location.search).get('entry')}
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
    <TooltipProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:border focus:border-edge-strong focus:bg-surface-overlay focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-fg"
      >
        Skip to main content
      </a>
      {body}
      <Toasts />
    </TooltipProvider>
  );
}
