// Floating Liquid-Glass bottom tab bar for the mobile app.
//
// Promotes Atrium's core destinations to the top level of navigation instead of
// unlabeled top-corner glyphs: Chat · Agents · Activity · Search (Search sits
// bottom-right == most thumb-reachable). "You / More" lives behind the top-left
// header avatar. Agents shows a live pulse while a session is running; Activity
// carries a badge for sessions that need attention.
//
// v1 is an overlay that navigates between the existing Stack routes (kept route
// names: /, /sessions, /search, + new /activity) and hides itself on detail /
// modal screens. A future increment can back this with a React Navigation Tabs
// navigator for per-tab state preservation.
import { useMemo } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import type { ComponentProps } from 'react';
import { isTerminalSessionStatus } from '@atrium/surface-client';
import { useChat } from '../lib/chat';
import { useTheme } from '../lib/theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

interface TabDef {
  key: string;
  label: string;
  icon: IoniconName;
  path: string;
  /** Route prefixes that count as "this tab is active". */
  match: (p: string) => boolean;
}

// Search last == bottom-right == most thumb-reachable (a11y).
const TABS: TabDef[] = [
  { key: 'chat', label: 'Chat', icon: 'chatbubbles', path: '/', match: (p) => p === '/' },
  { key: 'agents', label: 'Agents', icon: 'sparkles', path: '/sessions', match: (p) => p.startsWith('/sessions') },
  { key: 'activity', label: 'Activity', icon: 'notifications', path: '/activity', match: (p) => p.startsWith('/activity') },
  { key: 'search', label: 'Search', icon: 'search', path: '/search', match: (p) => p.startsWith('/search') },
];

/** The tab bar shows only on the top-level tab screens, not on pushed detail /
 * modal screens (channel, session, thread, new-*, settings). */
function activeTab(pathname: string): TabDef | undefined {
  return TABS.find((t) => t.match(pathname));
}

export function GlassTabBar() {
  const pathname = usePathname();
  const { colors, scheme } = useTheme();
  const { state } = useChat();
  const insets = useSafeAreaInsets();

  const attention = useMemo(() => {
    const sessions = Object.values(state.sessions ?? {});
    return sessions.filter((s) => s && s.status && !isTerminalSessionStatus(s.status)).length;
  }, [state.sessions]);

  const current = activeTab(pathname);
  if (!current) return null; // hidden on detail / modal screens

  const glass = scheme === 'dark' ? 'rgba(24,24,27,0.82)' : 'rgba(255,255,255,0.82)';

  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center' }}
    >
      <View
        accessibilityRole="tablist"
        style={[
          {
            flexDirection: 'row',
            alignSelf: 'stretch',
            marginHorizontal: 12,
            marginBottom: Math.max(insets.bottom, 10),
            paddingVertical: 8,
            paddingHorizontal: 6,
            borderRadius: 22,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: glass,
            shadowColor: '#000',
            shadowOpacity: 0.45,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 8 },
            elevation: 12,
          },
          // Web-only Liquid-Glass blur (RN style types don't include these keys).
          Platform.OS === 'web'
            ? ({ backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)' } as object)
            : null,
        ]}
      >
        {TABS.map((t) => {
          const on = t.key === current.key;
          const tint = on ? colors.accent : colors.textSecondary;
          const pulse = t.key === 'agents' && attention > 0;
          const badge = t.key === 'activity' ? attention : 0;
          return (
            <Pressable
              key={t.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={t.label + (badge ? `, ${badge} need attention` : '')}
              onPress={() => {
                if (!on) router.navigate(t.path as Parameters<typeof router.navigate>[0]);
              }}
              hitSlop={6}
              style={{ flex: 1, alignItems: 'center', gap: 2, minHeight: 44, justifyContent: 'center' }}
            >
              <View>
                <Ionicons name={t.icon} size={22} color={tint} />
                {pulse && (
                  <View
                    style={{
                      position: 'absolute',
                      top: -1,
                      right: -3,
                      width: 7,
                      height: 7,
                      borderRadius: 4,
                      backgroundColor: colors.accent,
                    }}
                  />
                )}
                {badge > 0 && (
                  <View
                    style={{
                      position: 'absolute',
                      top: -5,
                      right: -8,
                      minWidth: 15,
                      height: 15,
                      borderRadius: 8,
                      paddingHorizontal: 3,
                      backgroundColor: colors.danger,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ color: '#fff', fontSize: 9, fontWeight: '800' }}>{badge}</Text>
                  </View>
                )}
              </View>
              <Text style={{ color: tint, fontSize: 10, fontWeight: on ? '700' : '500' }}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
