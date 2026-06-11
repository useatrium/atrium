import { useEffect, useState } from 'react';
import { api, type Workspace } from './api';
import { Chat } from './Chat';
import { Login } from './Login';
import { Toasts } from './components/Toasts';
import type { UserRef } from '@atrium/surface-client';

/** /s/:id — session permalink; opens the app with that session's pane open. */
function sessionIdFromPath(pathname: string): string | null {
  const m = /^\/s\/([^/]+)$/.exec(pathname);
  return m?.[1] ?? null;
}

export function App() {
  const [initialSessionId] = useState(() => sessionIdFromPath(location.pathname));
  const [me, setMe] = useState<UserRef | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    api
      .me()
      .then(({ user }) => setMe(user))
      .catch(() => {})
      .finally(() => setChecked(true));
  }, []);

  useEffect(() => {
    if (!me) return;
    api.workspaces().then(({ workspaces }) => setWorkspaces(workspaces));
    function setWorkspaces(list: Workspace[]) {
      setWorkspace(list[0] ?? null);
    }
  }, [me]);

  // Toasts mount at the root so even login-screen failures surface.
  let body;
  if (!checked) body = <div className="h-dvh bg-zinc-950" />;
  else if (!me) body = <Login onLogin={setMe} />;
  else if (!workspace)
    body = (
      <div className="flex h-dvh items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Loading workspace…
      </div>
    );
  else
    body = (
      <Chat
        me={me}
        workspace={workspace}
        initialSessionId={initialSessionId}
        onLogout={() => {
          api.logout().finally(() => location.reload());
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
