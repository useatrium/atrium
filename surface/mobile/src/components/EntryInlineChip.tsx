import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { font, radius, space, useTheme } from '../lib/theme';
import type { EntryResolver, ResolvedEntry } from '../lib/entryResolve';

const INLINE_LABEL_LIMIT = 40;

type EntryOpenHandlers = {
  onOpenChannel?: (channelId: string) => void;
  onOpenSession?: (sessionId: string) => void;
};

function shortText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= INLINE_LABEL_LIMIT) return normalized;
  return `${normalized.slice(0, INLINE_LABEL_LIMIT - 3).trimEnd()}...`;
}

function iconFor(entry: ResolvedEntry): keyof typeof Ionicons.glyphMap {
  if (entry.tombstoned) return 'remove-circle-outline';
  if (entry.targetType === 'record') return 'document-text-outline';
  if (entry.targetType === 'artifact') return 'cube-outline';
  return 'chatbubble-ellipses-outline';
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

function metaString(entry: ResolvedEntry, key: string): string | null {
  const value = entry.meta[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function actorFor(entry: ResolvedEntry): string {
  return entry.actorLabel || entry.actor || entry.kind;
}

function inlineLabelFor(entry: ResolvedEntry): string {
  if (entry.tombstoned) return 'deleted entry';
  if (entry.targetType === 'artifact') {
    const path = metaString(entry, 'path');
    const title = metaString(entry, 'title');
    return (path ? basename(path) : null) || title || entry.text.trim() || 'Artifact';
  }
  return `${actorFor(entry)}: "${shortText(entry.text)}"`;
}

function canOpenEntry(entry: ResolvedEntry, handlers: EntryOpenHandlers): boolean {
  return (
    (entry.targetType === 'record' && entry.location.sessionId != null && handlers.onOpenSession != null) ||
    (entry.targetType !== 'record' && entry.location.channelId != null && handlers.onOpenChannel != null)
  );
}

function openEntryReference(entry: ResolvedEntry, handlers: EntryOpenHandlers): void {
  if (entry.targetType === 'record' && entry.location.sessionId) {
    handlers.onOpenSession?.(entry.location.sessionId);
  } else if (entry.location.channelId) {
    handlers.onOpenChannel?.(entry.location.channelId);
  }
}

export function EntryInlineChip({
  handle,
  resolveEntry,
  onOpenChannel,
  onOpenSession,
  compact = false,
}: {
  handle: string;
  resolveEntry?: EntryResolver;
  onOpenChannel?: (channelId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  compact?: boolean;
}) {
  const { colors } = useTheme();
  const [entry, setEntry] = useState<ResolvedEntry | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntry(null);
    if (!resolveEntry) return undefined;
    void resolveEntry(handle)
      .then((resolved) => {
        if (!cancelled) setEntry(resolved);
      })
      .catch(() => {
        if (!cancelled) setEntry(null);
      });
    return () => {
      cancelled = true;
    };
  }, [handle, resolveEntry]);

  const handlers = { onOpenChannel, onOpenSession };
  const canOpen = entry != null && canOpenEntry(entry, handlers);
  const label = entry ? inlineLabelFor(entry) : 'Atrium entry';

  if (compact) {
    return (
      <Text
        accessibilityRole="button"
        onPress={() => {
          if (entry) openEntryReference(entry, handlers);
        }}
        style={{ color: colors.accent, fontWeight: '600' }}
        numberOfLines={1}
      >
        {label}
      </Text>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entry ? `Open ${label}` : 'Atrium entry'}
      accessibilityState={{ disabled: !canOpen }}
      disabled={!canOpen}
      onPress={() => {
        if (entry) openEntryReference(entry, handlers);
      }}
      hitSlop={6}
      style={({ pressed }) => ({
        alignItems: 'center',
        alignSelf: 'center',
        backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
        borderColor: entry?.tombstoned ? colors.borderSoft : colors.border,
        borderRadius: radius.pill,
        borderWidth: 1,
        flexDirection: 'row',
        flexShrink: 1,
        gap: space.xs,
        marginHorizontal: space.xxs,
        marginVertical: 1,
        maxWidth: '100%',
        minHeight: 24,
        paddingHorizontal: 7,
        paddingVertical: space.xxs,
        opacity: entry?.tombstoned ? 0.72 : 1,
      })}
    >
      <Ionicons
        name={entry ? iconFor(entry) : 'link-outline'}
        size={13}
        color={entry?.tombstoned ? colors.textFaint : colors.textMuted}
      />
      <Text
        style={{
          color: entry?.tombstoned ? colors.textMuted : colors.textSecondary,
          flexShrink: 1,
          fontSize: font.xs,
          fontWeight: '700',
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}
