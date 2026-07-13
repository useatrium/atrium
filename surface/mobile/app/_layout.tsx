import '../src/lib/hermesGlobals'; // polyfill global `Event` before livekit-client loads
import '../src/lib/promiseRejectionFilter'; // drop livekit's benign signalling-event rejections (dev LogBox)
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { registerGlobals } from '@livekit/react-native';
import { registerVoIPPush, setRTCAudioSessionConfiguration } from 'expo-callkit-telecom';
import {
  ApiError,
  connectionHost,
  createApi,
  DEFAULT_PREFS,
  DurableOpQueue,
  normalizePrefs,
  normalizePrefsPatch,
  randomId,
  type UserPrefs,
} from '@atrium/surface-client';
import { SessionProvider, useSession } from '../src/lib/session';
import { font, radius, space, ThemeProvider, useTheme } from '../src/lib/theme';
import { loadStoredPrefs } from '../src/lib/prefsStorage';
import { eventCache } from '../src/lib/cacheSqlite';
import { NATIVE_CALL_UI } from '../src/lib/nativeCallUi';

registerGlobals({ autoConfigureAudioSession: false });
if (NATIVE_CALL_UI) {
  setRTCAudioSessionConfiguration(false);
  registerVoIPPush();
}

function prefsEqual(a: UserPrefs, b: UserPrefs): boolean {
  return (
    a.theme === b.theme &&
    a.accent === b.accent &&
    a.motion === b.motion &&
    a.fontScale === b.fontScale &&
    a.highContrast === b.highContrast
  );
}

async function enqueuePrefsPatch(queue: DurableOpQueue, patch: Partial<UserPrefs>): Promise<void> {
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
  const { session, ready, invalidate } = useSession();
  const { colors, scheme } = useTheme();
  const [preflight, setPreflight] = useState<'checking' | 'ready' | 'unreachable'>('checking');
  const [preflightAttempt, setPreflightAttempt] = useState(0);

  useEffect(() => {
    if (!ready || !session) {
      setPreflight('checking');
      return;
    }
    let disposed = false;
    setPreflight('checking');
    const api = createApi({ baseUrl: session.serverUrl, getToken: () => session.token });
    api
      .me()
      .then(() => {
        if (!disposed) setPreflight('ready');
      })
      .catch((err: unknown) => {
        if (disposed) return;
        if (err instanceof ApiError && err.status === 401) {
          void invalidate();
          return;
        }
        setPreflight('unreachable');
      });
    return () => {
      disposed = true;
    };
  }, [invalidate, preflightAttempt, ready, session]);

  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  if (session && preflight === 'checking') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <Text accessibilityRole="text" accessibilityLiveRegion="polite" style={{ color: colors.textMuted }}>
          Checking your sign-in…
        </Text>
      </View>
    );
  }
  if (session && preflight === 'unreachable') {
    const host = connectionHost(session.serverUrl);
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.bg,
          paddingHorizontal: space.xl,
        }}
      >
        <View style={{ width: '100%', maxWidth: 360, alignItems: 'center', gap: space.md }}>
          <Text style={{ color: colors.text, fontSize: font.lg, fontWeight: '700', textAlign: 'center' }}>
            Couldn’t verify your sign-in
          </Text>
          <Text accessibilityRole="alert" style={{ color: colors.textMuted, fontSize: font.sm, textAlign: 'center' }}>
            Atrium couldn’t reach {host}. Check your connection and try again.
          </Text>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Try again"
              onPress={() => setPreflightAttempt((attempt) => attempt + 1)}
              style={({ pressed }) => ({
                minHeight: 44,
                justifyContent: 'center',
                borderRadius: radius.md,
                paddingHorizontal: space.lg,
                backgroundColor: pressed ? colors.bgPressed : colors.accent,
              })}
            >
              <Text style={{ color: colors.onAccent, fontSize: font.sm, fontWeight: '700' }}>Try again</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Sign in again"
              onPress={() => void invalidate()}
              style={({ pressed }) => ({
                minHeight: 44,
                justifyContent: 'center',
                borderRadius: radius.md,
                paddingHorizontal: space.lg,
                backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
              })}
            >
              <Text style={{ color: colors.textSecondary, fontSize: font.sm, fontWeight: '700' }}>Sign in again</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }
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

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {initialPrefs ? (
        <ThemeProvider initialPrefs={initialPrefs}>
          <SessionProvider>
            <PrefsSessionBridge />
            <RootNavigator />
          </SessionProvider>
        </ThemeProvider>
      ) : null}
    </GestureHandlerRootView>
  );
}
