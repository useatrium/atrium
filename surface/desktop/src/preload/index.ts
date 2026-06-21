import { contextBridge, ipcRenderer } from 'electron';

interface DesktopUser {
  id: string;
  handle: string;
  displayName: string;
}
interface DesktopSession {
  serverUrl: string;
  token: string;
  user: DesktopUser;
}

// Synchronous so `window.atrium.serverUrl` / `.session` exist before the web
// app's module scripts (which build the API client at import time) execute.
const boot = ipcRenderer.sendSync('atrium:bootstrap') as {
  serverUrl: string;
  session: DesktopSession | null;
};

contextBridge.exposeInMainWorld('atrium', {
  isDesktop: true as const,
  platform: process.platform,
  /** Atrium API/WS origin the renderer should target (token auth). */
  serverUrl: boot.serverUrl,
  /** Persisted login, or null when signed out. */
  session: boot.session,
  setSession: (value: DesktopSession): Promise<void> =>
    ipcRenderer.invoke('atrium:session:set', value),
  clearSession: (): Promise<void> => ipcRenderer.invoke('atrium:session:clear'),
  notify: (opts: { title: string; body?: string }): Promise<void> =>
    ipcRenderer.invoke('atrium:notify', opts),
});
