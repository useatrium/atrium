// Small presentational pieces shared across screens.

import { Text, View } from 'react-native';
import type { UnreadLevel } from '@atrium/surface-client';
import { colors, font, space } from '../lib/theme';
import type { TypingEntry } from '../lib/chat';

export function DayDivider({ label }: { label?: string }) {
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
  if (status !== 'closed') return null;
  return (
    <View
      style={{
        backgroundColor: colors.warningBg,
        borderBottomColor: 'rgba(146, 64, 14, 0.4)',
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
        height: 18,
        lineHeight: 18,
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
  if (!level) return null;
  if (level === 'mention') {
    return (
      <View
        style={{
          minWidth: 18,
          height: 18,
          borderRadius: 9,
          backgroundColor: colors.mention,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 5,
        }}
      >
        <Text style={{ color: 'white', fontSize: 11, fontWeight: '800' }}>@</Text>
      </View>
    );
  }
  return (
    <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: colors.text }} />
  );
}
