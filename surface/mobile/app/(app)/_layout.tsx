import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
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
import { CallBannerLayout } from '../../src/components/GlobalCallUI';
import { useBadgeSync } from '../../src/lib/useBadgeSync';

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

    type NotificationDestination =
      | { kind: 'session'; id: string }
      | { kind: 'thread'; rootId: string; channelId: string | null }
      | { kind: 'channel'; id: string };

    const routeIdFrom = (value: unknown): string | null => {
      if (typeof value === 'string' && value.trim()) return value;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      return null;
    };

    const destinationFrom = (resp: Notifications.NotificationResponse): NotificationDestination | null => {
      const data = resp.notification.request.content.data as
        | Record<string, unknown>
        | undefined;
      const sessionId = routeIdFrom(data?.sessionId);
      const threadRootId = routeIdFrom(data?.threadRootId) ?? routeIdFrom(data?.rootId);
      const channelId = routeIdFrom(data?.channelId);
      if (sessionId) return { kind: 'session', id: sessionId };
      if (threadRootId) return { kind: 'thread', rootId: threadRootId, channelId };
      if (channelId) return { kind: 'channel', id: channelId };
      return null;
    };

    const pushDestination = (destination: NotificationDestination): void => {
      if (destination.kind === 'session') {
        router.push(`/session/${destination.id}`);
        return;
      }
      if (destination.kind === 'thread') {
        router.push({
          pathname: '/thread/[rootId]',
          params: {
            rootId: destination.rootId,
            ...(destination.channelId ? { channelId: destination.channelId } : {}),
          },
        });
        return;
      }
      router.push(`/channel/${destination.id}`);
    };

    // Tap while running/backgrounded.
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const destination = destinationFrom(resp);
      if (destination) pushDestination(destination);
    });

    // Tap that launched the app (cold start) — the listener above never sees it.
    const last = Notifications.getLastNotificationResponse();
    if (last) {
      const key = last.notification.request.identifier;
      const destination = destinationFrom(last);
      if (destination && handledColdStartTap !== key) {
        handledColdStartTap = key;
        pushDestination(destination);
      }
    }

    return () => sub.remove();
  }, [api]);

  return NATIVE_CALL_UI ? <NativeVoipPushBridge api={api} /> : null;
}

// === mobile-client additions ===
function BadgeSyncBridge() {
  const { state } = useChat();
  useBadgeSync(state.unread);
  return null;
}

export default function AppLayout() {
  const session = useRequiredSession();
  const { colors } = useTheme();
  return (
    <ChatProvider session={session}>
      <PushBridge />
      <BadgeSyncBridge />
      <CallBannerLayout>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.bg },
            headerTintColor: colors.text,
            headerTitleStyle: { color: colors.text, fontWeight: '700' },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.bg },
          }}
        >
          {/* The tab group owns its own (glass) bar + per-tab headers. */}
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="channel/[id]" options={{ title: '' }} />
          <Stack.Screen name="session/[id]" options={{ title: '' }} />
          <Stack.Screen name="thread/[rootId]" options={{ title: 'Thread' }} />
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
      </CallBannerLayout>
    </ChatProvider>
  );
}
