// Home: channels + DMs with unread badges. Nothing is "focused" while this
// screen is visible, so every channel accrues unreads.

import { useCallback, useMemo } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { channelLabel, dmPartner, type Channel } from '@atrium/surface-client';
import { useChat } from '../../src/lib/chat';
import { useSession } from '../../src/lib/session';
import {
  getRegisteredPushToken,
  unregisterPush,
} from '../../src/lib/notifications';
import { font, space, useTheme } from '../../src/lib/theme';
import { Avatar } from '../../src/components/Avatar';
import { ConnectionBanner, UnreadBadge } from '../../src/components/bits';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

function HeaderButton({ icon, onPress }: { icon: IoniconName; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}
    >
      <Ionicons name={icon} size={21} color={colors.textSecondary} />
    </Pressable>
  );
}

function SectionHeader({ title }: { title: string }) {
  const { colors } = useTheme();
  return (
    <Text
      style={{
        color: colors.textMuted,
        fontSize: font.xs,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        paddingHorizontal: space.lg,
        paddingTop: space.lg,
        paddingBottom: space.sm,
      }}
    >
      {title}
    </Text>
  );
}

export default function ChannelList() {
  const { state, me, api, leaveChannel, setMute } = useChat();
  const { logout } = useSession();
  const { colors } = useTheme();

  useFocusEffect(
    useCallback(() => {
      leaveChannel();
    }, [leaveChannel]),
  );

  const { channels, dms } = useMemo(() => {
    const channels: Channel[] = [];
    const dms: Channel[] = [];
    for (const c of state.channels) (c.kind === 'dm' || c.kind === 'gdm' ? dms : channels).push(c);
    return { channels, dms };
  }, [state.channels]);

  const confirmLogout = () => {
    Alert.alert(me.displayName, `@${me.handle}`, [
      {
        text: 'Log out',
        style: 'destructive',
        onPress: () => {
          void unregisterPush(api, getRegisteredPushToken()).finally(() => void logout());
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const row = (c: Channel) => {
    const unread = c.muted ? false : state.unread[c.id] ?? false;
    const partner = dmPartner(c, me.id);
    const label = channelLabel(c, me.id);
    const toggleMute = () => {
      Alert.alert(label, undefined, [
        {
          text: c.muted ? 'Unmute' : 'Mute',
          onPress: () => setMute(c.id, !c.muted),
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    };
    return (
      <Pressable
        key={c.id}
        onPress={() => router.push(`/channel/${c.id}`)}
        onLongPress={toggleMute}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
          paddingHorizontal: space.lg,
          paddingVertical: 10,
          backgroundColor: pressed ? colors.borderSoft : 'transparent',
        })}
      >
        {c.kind === 'dm' && partner ? (
          <Avatar name={channelLabel(c, me.id)} seed={partner.id} size={28} />
        ) : c.kind === 'gdm' ? (
          <View style={{ width: 28, alignItems: 'center' }}>
            <Text style={{ color: colors.textMuted, fontSize: font.md, fontWeight: '700' }}>
              @
            </Text>
          </View>
        ) : (
          <View style={{ width: 28, alignItems: 'center' }}>
            <Text style={{ color: colors.textMuted, fontSize: font.lg, fontWeight: '600' }}>
              {c.kind === 'private' ? '🔒' : '#'}
            </Text>
          </View>
        )}
        <Text
          style={{
            flex: 1,
            color: c.muted ? colors.textMuted : unread ? colors.text : colors.textSecondary,
            fontSize: font.md,
            fontWeight: unread ? '700' : '400',
          }}
          numberOfLines={1}
        >
          {label}
        </Text>
        {c.muted ? (
          <Text style={{ color: colors.textMuted, fontSize: font.sm }}>🔕</Text>
        ) : (
          <UnreadBadge level={unread} />
        )}
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen
        options={{
          title: 'Atrium',
          headerLeft: () => (
            <Pressable onPress={confirmLogout} hitSlop={8}>
              <Avatar name={me.displayName} seed={me.id} size={28} />
            </Pressable>
          ),
          headerRight: () => (
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <HeaderButton icon="hardware-chip-outline" onPress={() => router.push('/sessions')} />
              <HeaderButton icon="search-outline" onPress={() => router.push('/search')} />
              <HeaderButton icon="mail-outline" onPress={() => router.push('/new-dm')} />
              <HeaderButton icon="add-outline" onPress={() => router.push('/new-channel')} />
            </View>
          ),
        }}
      />
      <ConnectionBanner status={state.wsStatus} />
      <ScrollView style={{ flex: 1 }}>
        <SectionHeader title="Channels" />
        {channels.map(row)}
        {channels.length === 0 && (
          <Text style={{ color: colors.textFaint, fontSize: font.sm, paddingHorizontal: space.lg }}>
            No channels yet.
          </Text>
        )}
        {dms.length > 0 && <SectionHeader title="Direct messages" />}
        {dms.map(row)}
        <View style={{ height: space.xl }} />
      </ScrollView>
    </View>
  );
}
