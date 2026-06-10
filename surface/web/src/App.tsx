import { useEffect, useState } from 'react';
import { api, type Workspace } from './api';
import { Chat } from './Chat';
import { Login } from './Login';
import type { UserRef } from './state';

export function App() {
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

  if (!checked) return <div className="h-screen bg-zinc-950" />;
  if (!me) return <Login onLogin={setMe} />;
  if (!workspace)
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Loading workspace…
      </div>
    );

  return (
    <Chat
      me={me}
      workspace={workspace}
      onLogout={() => {
        api.logout().finally(() => location.reload());
      }}
    />
  );
}
