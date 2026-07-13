import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { CallWire, UserRef } from '@atrium/surface-client';
import { Avatar } from './Avatar';
import { font, radius, space, useTheme } from '../lib/theme';
import type { ActiveCallState } from '../lib/useCall';

export function IncomingCallBanner({
  call,
  caller,
  channelName,
  answering,
  onAccept,
  onDecline,
}: {
  call: CallWire;
  caller: UserRef;
  channelName: string;
  answering: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLabel={`${caller.displayName} is calling in ${channelName}`}
      accessibilityLiveRegion="polite"
      style={{
        borderBottomColor: colors.borderSoft,
        borderBottomWidth: 1,
        backgroundColor: colors.bgElevated,
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
      }}
    >
      <Avatar name={caller.displayName} seed={caller.id} size={32} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }}>
          {caller.displayName} is calling
        </Text>
        <Text numberOfLines={1} style={{ color: colors.textMuted, fontSize: font.xs }}>
          {channelName}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Decline call ${call.id}`}
        onPress={onDecline}
        hitSlop={8}
        style={{
          width: 40,
          height: 40,
          borderRadius: radius.xl,
          backgroundColor: colors.dangerSurface,
          borderColor: colors.dangerBorder,
          borderWidth: 1,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name="call" size={18} color={colors.danger} style={{ transform: [{ rotate: '135deg' }] }} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Accept call"
        disabled={answering}
        onPress={onAccept}
        hitSlop={8}
        style={{
          width: 40,
          height: 40,
          borderRadius: radius.xl,
          backgroundColor: answering ? colors.bgPressed : colors.accent,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: answering ? 0.65 : 1,
        }}
      >
        <Ionicons name="call" size={18} color={answering ? colors.textMuted : colors.onAccent} />
      </Pressable>
    </View>
  );
}

export function CallNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={{
        borderBottomColor: colors.warningBorder,
        borderBottomWidth: 1,
        backgroundColor: colors.warningSurface,
        paddingHorizontal: space.lg,
        paddingVertical: space.xs,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
      }}
    >
      <Text style={{ flex: 1, color: colors.warning, fontSize: font.xs }}>{message}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss call notice"
        onPress={onDismiss}
        hitSlop={8}
        style={{ minWidth: 36, minHeight: 32, alignItems: 'center', justifyContent: 'center' }}
      >
        <Ionicons name="close" size={17} color={colors.warning} />
      </Pressable>
    </View>
  );
}

export function JoinCallStrip({
  call,
  meId,
  channelName,
  joining,
  onJoin,
}: {
  call: CallWire;
  meId: string;
  channelName: string;
  joining: boolean;
  onJoin: () => void;
}) {
  const { colors } = useTheme();
  const rejoin = call.participants.some((participant) => participant.id === meId);
  const action = rejoin ? 'Rejoin' : 'Join';
  const participantCount = call.participants.length;
  const participantLabel = participantCount === 1 ? '1 participant' : `${participantCount} participants`;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        borderBottomColor: colors.borderSoft,
        borderBottomWidth: 1,
        backgroundColor: colors.bgElevated,
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          backgroundColor: colors.accentBg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name="call" size={16} color={colors.accent} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
          <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }}>
            {call.status === 'ringing' ? 'Call ringing' : 'Live call'}
          </Text>
          <Text numberOfLines={1} style={{ flex: 1, color: colors.textMuted, fontSize: font.xs }}>
            {channelName}
          </Text>
        </View>
        <Text numberOfLines={1} style={{ color: colors.textMuted, fontSize: font.xs }}>
          {participantLabel}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${action} call in ${channelName}`}
        disabled={joining}
        onPress={onJoin}
        hitSlop={8}
        style={{
          minHeight: 36,
          minWidth: 86,
          borderRadius: radius.sm,
          backgroundColor: joining ? colors.bgPressed : colors.accent,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 5,
          paddingHorizontal: space.sm,
          opacity: joining ? 0.65 : 1,
        }}
      >
        <Ionicons name="enter-outline" size={15} color={joining ? colors.textMuted : colors.onAccent} />
        <Text
          numberOfLines={1}
          style={{
            color: joining ? colors.textMuted : colors.onAccent,
            fontSize: font.xs,
            fontWeight: '800',
          }}
        >
          {action}
        </Text>
      </Pressable>
    </View>
  );
}

export function InCallPanel({
  call,
  meId,
  channelName,
  onToggleMute,
  onLeave,
}: {
  call: ActiveCallState;
  meId: string;
  channelName: string;
  onToggleMute: () => void;
  onLeave: () => void;
}) {
  const { colors } = useTheme();
  const remoteCount = call.participants.filter((p) => p.id !== meId).length;
  const label =
    call.phase === 'connecting'
      ? 'Connecting'
      : call.call.status === 'ringing' && remoteCount === 0
        ? 'Calling'
        : call.phase === 'ended'
          ? 'Call ended'
          : 'In call';
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        borderBottomColor: colors.borderSoft,
        borderBottomWidth: 1,
        backgroundColor: colors.bgElevated,
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }}>{label}</Text>
            <Text numberOfLines={1} style={{ flex: 1, color: colors.textMuted, fontSize: font.xs }}>
              {channelName}
            </Text>
          </View>
          {call.error ? (
            <Text style={{ marginTop: space.xxs, color: colors.danger, fontSize: font.xs }}>{call.error}</Text>
          ) : (
            <View style={{ marginTop: space.xs, flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
              {call.participants.map((participant) => {
                const speaking = call.activeSpeakerIds.has(participant.id);
                return (
                  <View
                    key={participant.id}
                    style={{
                      maxWidth: 150,
                      minHeight: 28,
                      borderRadius: radius.sm,
                      borderColor: speaking ? colors.accent : colors.border,
                      borderWidth: 1,
                      backgroundColor: speaking ? colors.accentBg : colors.bg,
                      paddingHorizontal: 6,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 5,
                    }}
                  >
                    <Avatar name={participant.displayName} seed={participant.id} size={18} />
                    <Text numberOfLines={1} style={{ color: colors.textSecondary, fontSize: font.xs }}>
                      {participant.id === meId ? 'You' : participant.displayName}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={call.muted ? 'Unmute microphone' : 'Mute microphone'}
          disabled={call.phase === 'ended'}
          onPress={onToggleMute}
          hitSlop={8}
          style={{
            width: 40,
            height: 40,
            borderRadius: radius.xl,
            borderColor: call.muted ? colors.warningBorder : colors.border,
            borderWidth: 1,
            backgroundColor: call.muted ? colors.warningSurface : colors.bg,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: call.phase === 'ended' ? 0.5 : 1,
          }}
        >
          <Ionicons
            name={call.muted ? 'mic-off' : 'mic'}
            size={18}
            color={call.muted ? colors.warning : colors.textSecondary}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Leave call"
          onPress={onLeave}
          hitSlop={8}
          style={{
            width: 40,
            height: 40,
            borderRadius: radius.xl,
            backgroundColor: colors.dangerSurface,
            borderColor: colors.dangerBorder,
            borderWidth: 1,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="call" size={18} color={colors.danger} style={{ transform: [{ rotate: '135deg' }] }} />
        </Pressable>
      </View>
    </View>
  );
}
