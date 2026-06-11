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

/** Registers for push and routes notification taps to the right channel. */
function PushBridge() {
  const { api, state } = useChat();
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    configureNotificationHandler(() => stateRef.current.activeChannelId);
    void registerForPush(api);
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const data = resp.notification.request.content.data as
        | { channelId?: string }
        | undefined;
      if (data?.channelId) router.push(`/channel/${data.channelId}`);
    });
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
