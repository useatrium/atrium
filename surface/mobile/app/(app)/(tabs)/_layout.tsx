import { useMemo } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { Tabs } from 'expo-router';
import { isLiveAgentWork, sessionAttentionKind, type Session } from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { useActivityCounts } from '../../../src/lib/useActivityCounts';
import { navigationTargetSize, TabIcon } from '../../../src/components/PlatformTabBar';
import { space, useTheme } from '../../../src/lib/theme';

export function getSessionNavigationCounts(sessions: Record<string, Session | undefined>) {
  const values = Object.values(sessions).filter(
    (session): session is Session => !!session && session.archivedAt === null,
  );
  return {
    live: values.filter(isLiveAgentWork).length,
    attention: values.filter((session) => sessionAttentionKind(session) !== null).length,
  };
}

export default function TabsLayout() {
  const { state } = useChat();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const counts = useMemo(() => getSessionNavigationCounts(state.sessions ?? {}), [state.sessions]);
  // Server-derived: correct on cold boot AND honors the read watermark for
  // acknowledged failures, unlike the live WS map above.
  const activityCounts = useActivityCounts();
  // Inbox follows web's actionable-first precedence. The native tab bar only
  // supports one badge style, so carry the most urgent useful count.
  const inboxBadge = activityCounts.needsYou || activityCounts.toReview || activityCounts.unread;
  const expandedAndroid = Platform.OS === 'android' && width >= 600;

  return (
    <Tabs
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        tabBarPosition: expandedAndroid ? 'left' : 'bottom',
        tabBarVariant: expandedAndroid ? 'material' : 'uikit',
        tabBarLabelPosition: expandedAndroid ? 'beside-icon' : 'below-icon',
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarActiveBackgroundColor: expandedAndroid ? colors.bgPressed : undefined,
        tabBarStyle: {
          backgroundColor: colors.bgElevated,
          borderTopColor: expandedAndroid ? 'transparent' : colors.border,
          borderRightColor: expandedAndroid ? colors.border : 'transparent',
          borderTopWidth: expandedAndroid ? 0 : 1,
          borderRightWidth: expandedAndroid ? 1 : 0,
          elevation: 0,
          shadowOpacity: 0,
          ...(expandedAndroid ? { width: 200, paddingHorizontal: space.sm, paddingVertical: space.md } : null),
        },
        tabBarItemStyle: {
          minHeight: navigationTargetSize,
          minWidth: navigationTargetSize,
          borderRadius: expandedAndroid ? 10 : 0,
        },
        tabBarLabelStyle: {
          fontSize: expandedAndroid ? 13 : 11,
          fontWeight: '600',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Chat',
          tabBarAccessibilityLabel: 'Chat',
          tabBarIcon: ({ color }) => <TabIcon name="chatbubbles" color={color} />,
        }}
      />
      <Tabs.Screen
        name="files"
        options={{
          title: 'Files',
          tabBarAccessibilityLabel: 'Files',
          tabBarIcon: ({ color }) => <TabIcon name="folder-open" color={color} />,
        }}
      />
      <Tabs.Screen
        name="sessions"
        options={{
          title: 'Agents',
          tabBarAccessibilityLabel: counts.live > 0 ? `Agents, ${counts.live} live` : 'Agents',
          tabBarIcon: ({ color }) => <TabIcon name="terminal" color={color} live={counts.live > 0} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Inbox',
          tabBarAccessibilityLabel: inboxBadge > 0 ? `Inbox, ${inboxBadge} items` : 'Inbox',
          tabBarBadge: inboxBadge > 0 ? inboxBadge : undefined,
          tabBarBadgeStyle: {
            backgroundColor: activityCounts.needsYou ? colors.warning : colors.accent,
            color: activityCounts.needsYou ? colors.bg : colors.onAccent,
          },
          tabBarIcon: ({ color }) => <TabIcon name="notifications" color={color} />,
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'Search',
          tabBarAccessibilityLabel: 'Search',
          tabBarIcon: ({ color }) => <TabIcon name="search" color={color} />,
        }}
      />
    </Tabs>
  );
}
