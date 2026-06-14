import '../src/lib/hermesGlobals'; // polyfill global `Event` before livekit-client loads
import '../src/lib/promiseRejectionFilter'; // drop livekit's benign signalling-event rejections (dev LogBox)
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { registerGlobals } from '@livekit/react-native';
import { registerVoIPPush, setRTCAudioSessionConfiguration } from 'expo-callkit-telecom';
import {
  ApiError,
  createApi,
  DEFAULT_PREFS,
  DurableOpQueue,
  normalizePrefs,
  normalizePrefsPatch,
  randomId,
  type UserPrefs,
} from '@atrium/surface-client';
import { SessionProvider, useSession } from '../src/lib/session';
import { ThemeProvider, useTheme } from '../src/lib/theme';
import { loadStoredPrefs } from '../src/lib/prefsStorage';
import { eventCache } from '../src/lib/cacheSqlite';

registerGlobals({ autoConfigureAudioSession: false });
setRTCAudioSessionConfiguration(false);
registerVoIPPush();

function prefsEqual(a: UserPrefs, b: UserPrefs): boolean {
  return (
    a.theme === b.theme &&
    a.accent === b.accent &&
    a.motion === b.motion &&
    a.fontScale === b.fontScale &&
    a.highContrast === b.highContrast
  );
}

async function enqueuePrefsPatch(
  queue: DurableOpQueue,
  patch: Partial<UserPrefs>,
): Promise<void> {
  const normalized = normalizePrefsPatch(patch);
  if (Object.keys(normalized).length === 0) return;
  const op = await queue.enqueue({
    opId: randomId(),
    opType: 'prefs.set',
    payload: normalized,
  });
  if (op) queue.nudge();
}

function PrefsSessionBridge() {
  const { session, invalidate } = useSession();
  const { prefs, adoptPrefs, registerPrefsPatcher } = useTheme();
  const prefsRef = useRef(prefs);
  const queueRef = useRef<DurableOpQueue | null>(null);

  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  useEffect(() => {
    if (!session) {
      queueRef.current = null;
      registerPrefsPatcher(null);
      return;
    }
    const api = createApi({ baseUrl: session.serverUrl, getToken: () => session.token });
    const restorePrefsFromServer = () => {
      void api
        .me()
        .then(({ prefs }) => adoptPrefs(normalizePrefs(prefs)))
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) void invalidate();
        });
    };
    const queue = new DurableOpQueue({
      storage: eventCache,
      api,
      dispatch: () => {},
      onRejected: (_op, err) => {
        restorePrefsFromServer();
        if (err instanceof ApiError && err.status === 401) void invalidate();
      },
    });
    queueRef.current = queue;
    registerPrefsPatcher((patch) => enqueuePrefsPatch(queue, patch));
    return () => {
      if (queueRef.current === queue) queueRef.current = null;
      registerPrefsPatcher(null);
    };
  }, [adoptPrefs, invalidate, registerPrefsPatcher, session]);

  useEffect(() => {
    if (!session) return;
    let disposed = false;
    const api = createApi({ baseUrl: session.serverUrl, getToken: () => session.token });
    api
      .me()
      .then(async ({ prefs: remotePrefs }) => {
        if (disposed || remotePrefs == null) return;
        const remote = normalizePrefs(remotePrefs);
        // Re-push local prefs only when the server still has defaults. Any
        // non-default remote value is treated as newer user intent and wins.
        const local = prefsRef.current;
        if (prefsEqual(remote, DEFAULT_PREFS) && !prefsEqual(local, DEFAULT_PREFS)) {
          const queue = queueRef.current;
          if (queue) await enqueuePrefsPatch(queue, local).catch(() => {});
          return;
        }
        adoptPrefs(remote);
      })
      .catch((err: unknown) => {
        if (!disposed && err instanceof ApiError && err.status === 401) void invalidate();
      });
    return () => {
      disposed = true;
    };
  }, [adoptPrefs, invalidate, session]);

  return null;
}

function RootNavigator() {
  const { session, ready } = useSession();
  const { colors, scheme } = useTheme();
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Protected guard={!!session}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        <Stack.Protected guard={!session}>
          <Stack.Screen name="login" />
        </Stack.Protected>
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [initialPrefs, setInitialPrefs] = useState<UserPrefs | null>(null);

  useEffect(() => {
    let mounted = true;
    void loadStoredPrefs()
      .then((prefs) => {
        if (mounted) setInitialPrefs(prefs);
      })
      .catch(() => {
        if (mounted) setInitialPrefs(DEFAULT_PREFS);
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (!initialPrefs) return null;

  return (
    <ThemeProvider initialPrefs={initialPrefs}>
      <SessionProvider>
        <PrefsSessionBridge />
        <RootNavigator />
      </SessionProvider>
    </ThemeProvider>
  );
}
