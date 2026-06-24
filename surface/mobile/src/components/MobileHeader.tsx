// Inline header for the (tabs) screens. The headless Tabs <TabSlot/> renders no
// header of its own, so each tab supplies one. Left = the "You/More" avatar
// (opens settings); center = title; right = optional per-tab actions.
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useChat } from '../lib/chat';
import { font, space, useTheme } from '../lib/theme';
import { Avatar } from './Avatar';

export function MobileHeader({ title, right }: { title: string; right?: ReactNode }) {
  const { colors } = useTheme();
  const { me } = useChat();
  return (
    <SafeAreaView edges={['top']} style={{ backgroundColor: colors.bg }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          height: 52,
          paddingHorizontal: space.lg,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="You — profile, connections, settings"
          onPress={() => router.push('/settings')}
          hitSlop={8}
        >
          <Avatar name={me.displayName} seed={me.id} size={28} />
        </Pressable>
        <Text style={{ flex: 1, color: colors.text, fontSize: font.lg, fontWeight: '800' }} numberOfLines={1}>
          {title}
        </Text>
        {right ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>{right}</View> : null}
      </View>
    </SafeAreaView>
  );
}
