import { useMemo } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { Tabs } from 'expo-router';
import { isLiveAgentWork, type Session } from '@atrium/surface-client';
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
          tabBarAccessibilityLabel:
            activityCounts.attention > 0
              ? `Agents, ${activityCounts.attention} need you${counts.live > 0 ? `, ${counts.live} live` : ''}`
              : counts.live > 0
                ? `Agents, ${counts.live} live`
                : 'Agents',
          tabBarBadge: activityCounts.attention > 0 ? activityCounts.attention : undefined,
          tabBarBadgeStyle: {
            backgroundColor: colors.warning,
            color: colors.bg,
          },
          tabBarIcon: ({ color }) => <TabIcon name="terminal" color={color} live={counts.live > 0} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Inbox',
          tabBarAccessibilityLabel: activityCounts.unread > 0 ? `Inbox, ${activityCounts.unread} unread` : 'Inbox',
          tabBarBadge: activityCounts.unread > 0 ? activityCounts.unread : undefined,
          tabBarBadgeStyle: {
            backgroundColor: colors.accent,
            color: colors.onAccent,
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
