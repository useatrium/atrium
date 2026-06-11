import { useEffect, useRef } from 'react';
import { Stack, router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useRequiredSession } from '../../src/lib/session';
import { ChatProvider, useChat } from '../../src/lib/chat';
import {
  configureNotificationHandler,
  registerForPush,
} from '../../src/lib/notifications';
import { colors } from '../../src/lib/theme';

// The tap that cold-started the app fires before any listener exists; track
// what we've already routed so remounts don't re-navigate.
let handledColdStartTap: string | null = null;

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

  return null;
}

export default function AppLayout() {
  const session = useRequiredSession();
  return (
    <ChatProvider session={session}>
      <PushBridge />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { color: colors.text, fontWeight: '700' },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Atrium' }} />
        <Stack.Screen name="channel/[id]" options={{ title: '' }} />
        <Stack.Screen name="thread/[rootId]" options={{ title: 'Thread' }} />
        <Stack.Screen
          name="search"
          options={{ title: 'Search', presentation: 'modal' }}
        />
        <Stack.Screen
          name="new-dm"
          options={{ title: 'New message', presentation: 'modal' }}
        />
        <Stack.Screen
          name="new-channel"
          options={{ title: 'New channel', presentation: 'modal' }}
        />
      </Stack>
    </ChatProvider>
  );
}
