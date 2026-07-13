// Small presentational pieces shared across screens.

import { Pressable, Text, View } from 'react-native';
import {
  connectionHost,
  formatRelativeTimestamp,
  reconnectingLabel,
  wsStatusKind,
  type UnreadLevel,
  type WsStatus,
} from '@atrium/surface-client';
import { font, space, useTheme } from '../lib/theme';
import type { TypingEntry } from '../lib/chat';

export function DayDivider({ label }: { label?: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
      }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: colors.borderSoft }} />
      <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '600' }}>{label}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.borderSoft }} />
    </View>
  );
}

export function ConnectionBanner({
  status,
  serverUrl,
  lastSyncedAt,
  onSignInAgain,
}: {
  status: WsStatus;
  serverUrl: string;
  lastSyncedAt: string | null;
  onSignInAgain: () => void;
}) {
  const { colors } = useTheme();
  const terminal = wsStatusKind(status) === 'unreachable';
  const label = reconnectingLabel(status, connectionHost(serverUrl));
  if (!label) return null;
  return (
    <View
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={{
        backgroundColor: colors.warningSurface,
        borderBottomColor: colors.warningBorder,
        borderBottomWidth: 1,
        minHeight: terminal ? 48 : 24,
        paddingVertical: space.xs,
        alignItems: 'center',
      }}
    >
      <Text style={{ color: colors.warning, fontSize: font.xs, lineHeight: 15 }}>{label}</Text>
      {terminal && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text style={{ color: colors.textMuted, fontSize: font.xs, lineHeight: 15 }}>
            Saved messages · synced {lastSyncedAt ? formatRelativeTimestamp(lastSyncedAt) : 'unknown'}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Sign in again" onPress={onSignInAgain} hitSlop={6}>
            <Text style={{ color: colors.warning, fontSize: font.xs, fontWeight: '700', lineHeight: 15 }}>
              Sign in again
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/** Fixed-height "X is typing…" line — always present so the layout never shifts. */
export function TypingLine({ typing }: { typing: Record<string, TypingEntry> }) {
  const { colors } = useTheme();
  const names = Object.values(typing).map((t) => t.user.displayName);
  const label =
    names.length === 0
      ? ''
      : names.length === 1
        ? `${names[0]} is typing…`
        : names.length === 2
          ? `${names[0]} and ${names[1]} are typing…`
          : 'Several people are typing…';
  return (
    <Text
      style={{
        minHeight: 18,
        lineHeight: font.xs * 1.35,
        paddingHorizontal: space.lg,
        color: colors.textMuted,
        fontSize: font.xs,
      }}
      numberOfLines={1}
    >
      {label}
    </Text>
  );
}

export function UnreadBadge({ level }: { level: UnreadLevel }) {
  const { colors } = useTheme();
  if (!level) return null;
  if (level === 'mention') {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          minWidth: 18,
          minHeight: 18,
          borderRadius: 9,
          backgroundColor: colors.mention,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 5,
        }}
      >
        <Text style={{ color: colors.onMention, fontSize: 11, fontWeight: '800' }}>@</Text>
      </View>
    );
  }
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: colors.text }}
    />
  );
}
