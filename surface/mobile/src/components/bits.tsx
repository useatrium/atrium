// Small presentational pieces shared across screens.

import { Text, View } from 'react-native';
import type { UnreadLevel } from '@atrium/surface-client';
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

export function ConnectionBanner({ status }: { status: 'connecting' | 'open' | 'closed' }) {
  const { colors } = useTheme();
  if (status !== 'closed') return null;
  return (
    <View
      style={{
        backgroundColor: colors.warningSurface,
        borderBottomColor: colors.warningBorder,
        borderBottomWidth: 1,
        paddingVertical: 4,
        alignItems: 'center',
      }}
    >
      <Text style={{ color: colors.warning, fontSize: font.xs }}>
        Connection lost — reconnecting…
      </Text>
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
