import { useEffect, useRef } from 'react';
import { Platform, View } from 'react-native';
import { Stack, router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useVoIPPushToken } from 'expo-callkit-telecom';
import { useRequiredSession } from '../../src/lib/session';
import { ChatProvider, useChat } from '../../src/lib/chat';
import {
  configureNotificationHandler,
  registerForPush,
  setRegisteredVoipPushToken,
} from '../../src/lib/notifications';
import { useTheme } from '../../src/lib/theme';
import { NATIVE_CALL_UI } from '../../src/lib/nativeCallUi';
import { GlobalCallUI } from '../../src/components/GlobalCallUI';
import { GlassTabBar } from '../../src/components/GlassTabBar';

// The tap that cold-started the app fires before any listener exists; track
// what we've already routed so remounts don't re-navigate.
let handledColdStartTap: string | null = null;

function NativeVoipPushBridge({ api }: { api: ReturnType<typeof useChat>['api'] }) {
  const voip = useVoIPPushToken();

  useEffect(() => {
    if (!voip) {
      setRegisteredVoipPushToken(null);
      return;
    }
    const platform = voip.type === 'FCM' || Platform.OS === 'android' ? 'android' : 'ios';
    void api
      .registerPush({ token: voip.token, platform, kind: 'voip' })
      .then(() => setRegisteredVoipPushToken(voip.token))
      .catch((err: unknown) => {
        console.warn('[push] VoIP registration failed', err);
      });
  }, [api, voip]);

  return null;
}

/** Registers for push and routes notification taps to the right channel. */
function PushBridge() {
  const { api, state } = useChat();
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    configureNotificationHandler(() => stateRef.current.activeChannelId);
    void registerForPush(api);

    const channelFrom = (resp: Notifications.NotificationResponse): string | null => {
      const data = resp.notification.request.content.data as
        | { channelId?: string }
        | undefined;
      return typeof data?.channelId === 'string' ? data.channelId : null;
    };

    // Tap while running/backgrounded.
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const channelId = channelFrom(resp);
      if (channelId) router.push(`/channel/${channelId}`);
    });

    // Tap that launched the app (cold start) — the listener above never sees it.
    const last = Notifications.getLastNotificationResponse();
    if (last) {
      const key = last.notification.request.identifier;
      const channelId = channelFrom(last);
      if (channelId && handledColdStartTap !== key) {
        handledColdStartTap = key;
        router.push(`/channel/${channelId}`);
      }
    }

    return () => sub.remove();
  }, [api]);

  return NATIVE_CALL_UI ? <NativeVoipPushBridge api={api} /> : null;
}

export default function AppLayout() {
  const session = useRequiredSession();
  const { colors } = useTheme();
  return (
    <ChatProvider session={session}>
      <PushBridge />
      <View style={{ flex: 1 }}>
        <GlobalCallUI />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.bg },
            headerTintColor: colors.text,
            headerTitleStyle: { color: colors.text, fontWeight: '700' },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.bg },
          }}
        >
        <Stack.Screen name="index" options={{ title: 'Chat' }} />
        <Stack.Screen name="activity" options={{ title: 'Activity' }} />
        <Stack.Screen name="channel/[id]" options={{ title: '' }} />
        <Stack.Screen name="session/[id]" options={{ title: '' }} />
        <Stack.Screen name="thread/[rootId]" options={{ title: 'Thread' }} />
        <Stack.Screen
          name="search"
          options={{ title: 'Search', presentation: 'modal' }}
        />
        <Stack.Screen
          name="session-search"
          options={{ title: 'Search sessions', presentation: 'modal' }}
        />
        <Stack.Screen
          name="new-dm"
          options={{ title: 'New message', presentation: 'modal' }}
        />
        <Stack.Screen
          name="new-channel"
          options={{ title: 'New channel', presentation: 'modal' }}
        />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        </Stack>
        {/* Floating glass tab bar (Chat · Agents · Activity · Search). Renders
            only on the top-level tab routes; hides itself on detail/modal screens. */}
        <GlassTabBar />
      </View>
    </ChatProvider>
  );
}
