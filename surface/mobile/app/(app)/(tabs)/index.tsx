// Home: channels + DMs with unread badges. Nothing is "focused" while this
// screen is visible, so every channel accrues unreads.

import { useCallback, useMemo } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { channelAvatarName, channelLabel, dmPartner, type Channel } from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { font, space, useTheme } from '../../../src/lib/theme';
import { Avatar } from '../../../src/components/Avatar';
import { ConnectionBanner, UnreadBadge } from '../../../src/components/bits';
import { MobileHeader } from '../../../src/components/MobileHeader';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

function HeaderButton({
  icon,
  label,
  onPress,
}: {
  icon: IoniconName;
  label: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
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
  const {
    state,
    me,
    queuedChangesCount,
    leaveChannel,
    setMute,
    channelsLoaded,
    channelsError,
    refreshChannels,
  } = useChat();
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
        accessibilityRole="button"
        accessibilityLabel={`${label}${c.muted ? ', muted' : unread === 'mention' ? ', mention' : unread ? ', unread' : ''}`}
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
          <Avatar name={channelAvatarName(c, me.id)} seed={partner.id} size={28} />
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

  const sections = [
    { key: 'channels-header', kind: 'header' as const, title: 'Channels' },
    ...channels.map((channel) => ({ key: channel.id, kind: 'channel' as const, channel })),
    ...(channelsError && state.channels.length === 0
      ? [{ key: 'channels-error', kind: 'error' as const }]
      : []),
    ...(state.channels.length === 0 && !channelsLoaded && !channelsError
      ? [{ key: 'channels-loading', kind: 'loading' as const }]
      : []),
    ...(channels.length === 0 && channelsLoaded
      ? [{ key: 'channels-empty', kind: 'empty' as const }]
      : []),
    ...(dms.length > 0
      ? [
          { key: 'dms-header', kind: 'header' as const, title: 'Direct messages' },
          ...dms.map((channel) => ({ key: channel.id, kind: 'channel' as const, channel })),
        ]
      : []),
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader
        title="Chat"
        right={
          <>
            <HeaderButton icon="create-outline" label="New channel" onPress={() => router.push('/new-channel')} />
            <HeaderButton icon="mail-outline" label="New direct message" onPress={() => router.push('/new-dm')} />
          </>
        }
      />
      <ConnectionBanner status={state.wsStatus} queuedChangesCount={queuedChangesCount} />
      <FlatList
        style={{ flex: 1 }}
        data={sections}
        keyExtractor={(item) => item.key}
        refreshControl={
          <RefreshControl
            refreshing={!channelsLoaded && state.channels.length === 0}
            onRefresh={refreshChannels}
            tintColor={colors.textMuted}
          />
        }
        renderItem={({ item }) => {
          if (item.kind === 'header') return <SectionHeader title={item.title} />;
          if (item.kind === 'channel') return row(item.channel);
          if (item.kind === 'loading') {
            return (
              <Text style={{ color: colors.textMuted, fontSize: font.sm, paddingHorizontal: space.lg }}>
                Loading channels...
              </Text>
            );
          }
          if (item.kind === 'error') {
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Channel list failed. Tap to retry."
                onPress={refreshChannels}
                style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.lg }}
              >
                <Text style={{ color: colors.danger, fontSize: font.sm }}>
                  Channels failed — tap to retry
                </Text>
              </Pressable>
            );
          }
          return (
            <Text style={{ color: colors.textFaint, fontSize: font.sm, paddingHorizontal: space.lg }}>
              No channels yet.
            </Text>
          );
        }}
        ListFooterComponent={<View style={{ height: space.xl }} />}
      />
    </View>
  );
}
