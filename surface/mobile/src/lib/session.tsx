// Persistent login session: server origin + bearer token + user, stored in
// the device keychain via expo-secure-store.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { createApi, type UserRef } from '@atrium/surface-client';

const STORE_KEY = 'atrium.session.v1';

export interface Session {
  serverUrl: string;
  token: string;
  user: UserRef;
}

interface SessionContextValue {
  session: Session | null;
  /** False until SecureStore has been read on boot. */
  ready: boolean;
  login: (serverUrl: string, handle: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Called by the chat layer when the server says the token is dead. */
  invalidate: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function normalizeServerUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync(STORE_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw) as Session;
        if (parsed.serverUrl && parsed.token && parsed.user?.id) setSession(parsed);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const login = useCallback(async (serverUrl: string, handle: string, displayName: string) => {
    const base = normalizeServerUrl(serverUrl);
    const api = createApi({ baseUrl: base });
    const { user, token } = await api.login(handle, displayName);
    if (!token) {
      throw new Error('Server did not return a token — update the Atrium server.');
    }
    const next: Session = { serverUrl: base, token, user };
    await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(next));
    setSession(next);
  }, []);

  const invalidate = useCallback(async () => {
    await SecureStore.deleteItemAsync(STORE_KEY).catch(() => {});
    setSession(null);
  }, []);

  const logout = useCallback(async () => {
    if (session) {
      const api = createApi({ baseUrl: session.serverUrl, getToken: () => session.token });
      await api.logout().catch(() => {}); // revoke best-effort; clear locally regardless
    }
    await import('./cacheSqlite')
      .then(({ clearCache }) => clearCache())
      .catch(() => {});
    await invalidate();
  }, [session, invalidate]);

  return (
    <SessionContext.Provider value={{ session, ready, login, logout, invalidate }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}

/** Like useSession, but only renders where a session is guaranteed. */
export function useRequiredSession(): Session {
  const { session } = useSession();
  if (!session) throw new Error('no active session');
  return session;
}
