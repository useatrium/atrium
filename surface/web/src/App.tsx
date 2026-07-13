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
import { clearDesktopSession, onDesktopNavigate } from './desktop';
import { initialInAppRoute, navigate } from './router';
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
  const [bootError, setBootError] = useState<'authentication' | 'workspace' | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);

  useEffect(() => onDesktopNavigate((path) => navigate(path)), []);

  useEffect(() => {
    if (markupShellRoute) {
      setChecked(true);
      return;
    }
    let disposed = false;
    let phase: 'authentication' | 'workspace' = 'authentication';
    setBootError(null);
    api
      .me()
      .then(async ({ user, prefs }) => {
        if (disposed) return;
        setMe(user);
        if (prefs) adoptPrefs(prefs);
        phase = 'workspace';
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
          if (disposed) return;
          if (!snapshot) {
            setBootError(phase);
            return;
          }
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
  }, [markupShellRoute, bootAttempt]);

  useEffect(() => {
    if (!checked || !me || workspace || bootError) return;
    const currentUser = me;
    setBootError(null);
    api
      .workspaces()
      .then(({ workspaces }) => setWorkspaces(workspaces))
      .catch(() => setBootError('workspace'));
    function setWorkspaces(list: Workspace[]) {
      const first = list[0] ?? null;
      setWorkspace(first);
      if (first) {
        void saveBootSnapshot({ user: currentUser, workspace: first }).catch((err: unknown) => {
          console.warn('failed to cache boot snapshot', err);
        });
      }
    }
  }, [bootAttempt, bootError, checked, me, workspace]);

  // Toasts mount at the root so even login-screen failures surface.
  let body: ReactNode;
  if (markupShellRoute) body = <MarkupShellPage />;
  else if (!checked)
    body = (
      <main id="main-content" className="flex h-dvh items-center justify-center bg-surface px-6">
        <p role="status" aria-live="polite" className="text-sm text-fg-muted">
          Checking your sign-in…
        </p>
      </main>
    );
  else if (bootError)
    body = (
      <main id="main-content" className="flex h-dvh items-center justify-center bg-surface px-6">
        <div className="max-w-sm text-center">
          <h1 className="text-base font-semibold text-fg">
            {bootError === 'workspace' ? 'Workspace unavailable' : 'Couldn’t verify your sign-in'}
          </h1>
          <p role="alert" className="mt-2 text-sm text-fg-muted">
            {bootError === 'workspace'
              ? 'Atrium couldn’t load your workspace. Check your connection and try again.'
              : 'Atrium couldn’t reach the server. Check your connection and try again.'}
          </p>
          <button
            type="button"
            onClick={() => {
              setChecked(false);
              setBootAttempt((attempt) => attempt + 1);
            }}
            className="mt-4 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover"
          >
            Try again
          </button>
        </div>
      </main>
    );
  else if (!me) body = <Login onLogin={setMe} />;
  else if (!workspace)
    body = (
      <main id="main-content" className="flex h-dvh items-center justify-center bg-surface px-6">
        <p role="status" aria-live="polite" className="text-sm text-fg-muted">
          Loading your workspace…
        </p>
      </main>
    );
  else if (paneRoute) body = <SessionPanePage key={paneRoute.sessionId} sessionId={paneRoute.sessionId} me={me} />;
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
            initialThreadRootEventId={destination.initialThreadRootEventId}
            onLogout={() => {
              api
                .logout()
                .catch(() => {})
                .finally(() => {
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
        initialThreadRootEventId={
          initialRoute.threadRootId != null && Number.isSafeInteger(Number(initialRoute.threadRootId))
            ? Number(initialRoute.threadRootId)
            : null
        }
        onLogout={() => {
          // logout() first (still holds the token), then drop the keychain
          // session, then clear the cache and reload.
          api
            .logout()
            .catch(() => {})
            .finally(() => {
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
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-max focus:rounded-md focus:border focus:border-edge-strong focus:bg-surface-overlay focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-fg"
      >
        Skip to main content
      </a>
      {body}
      <Toasts />
    </TooltipProvider>
  );
}
