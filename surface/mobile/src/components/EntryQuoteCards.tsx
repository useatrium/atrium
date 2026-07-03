import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { font, radius, space, useTheme } from '../lib/theme';
import { extractEntryLinkHandles } from '../lib/entryLinks';
import type { EntryResolver, ResolvedEntry } from '../lib/entryResolve';

const EXCERPT_LIMIT = 200;

function excerptFor(entry: ResolvedEntry): string {
  if (entry.tombstoned) return 'Entry deleted';
  const normalized = entry.text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= EXCERPT_LIMIT) return normalized;
  return `${normalized.slice(0, EXCERPT_LIMIT - 3).trimEnd()}...`;
}

function iconFor(entry: ResolvedEntry): keyof typeof Ionicons.glyphMap {
  if (entry.tombstoned) return 'remove-circle-outline';
  if (entry.targetType === 'record') return 'document-text-outline';
  if (entry.targetType === 'artifact') return 'cube-outline';
  return 'chatbubble-ellipses-outline';
}

function contextFor(entry: ResolvedEntry): string {
  if (entry.targetType === 'record' && entry.location.sessionTitle) {
    return entry.location.sessionTitle;
  }
  if (entry.location.channelName) return `#${entry.location.channelName}`;
  if (entry.location.sessionTitle) return entry.location.sessionTitle;
  return entry.kind;
}

function labelFor(entry: ResolvedEntry): string {
  return entry.kind.replace(/_/g, ' ').toUpperCase();
}

function EntryQuoteCard({
  entry,
  onOpenChannel,
  onOpenSession,
}: {
  entry: ResolvedEntry;
  onOpenChannel?: (channelId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { colors } = useTheme();
  const canOpen =
    (entry.targetType === 'record' && entry.location.sessionId != null && onOpenSession != null) ||
    (entry.targetType !== 'record' && entry.location.channelId != null && onOpenChannel != null);

  const open = () => {
    if (entry.targetType === 'record' && entry.location.sessionId) {
      onOpenSession?.(entry.location.sessionId);
      return;
    }
    if (entry.location.channelId) onOpenChannel?.(entry.location.channelId);
  };

  const context = contextFor(entry);
  const excerpt = excerptFor(entry);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${labelFor(entry)}, ${context}: ${excerpt}`}
      accessibilityState={{ disabled: !canOpen }}
      disabled={!canOpen}
      onPress={open}
      style={({ pressed }) => ({
        borderWidth: 1,
        borderColor: entry.tombstoned ? colors.borderSoft : colors.border,
        backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
        borderRadius: radius.md,
        padding: space.sm,
        gap: 6,
        opacity: entry.tombstoned ? 0.72 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name={iconFor(entry)} size={14} color={entry.tombstoned ? colors.textFaint : colors.textMuted} />
        <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>
          {labelFor(entry)}
        </Text>
        <Text style={{ color: colors.textFaint, fontSize: font.xs }} numberOfLines={1}>
          {context}
        </Text>
      </View>
      <Text
        style={{
          color: entry.tombstoned ? colors.textMuted : colors.text,
          fontSize: font.sm,
          lineHeight: 19,
          fontStyle: entry.tombstoned ? 'italic' : 'normal',
        }}
        numberOfLines={5}
      >
        {excerpt}
      </Text>
      {entry.actor ? (
        <Text style={{ color: colors.textFaint, fontSize: font.xs }} numberOfLines={1}>
          {entry.actor}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function EntryQuoteCards({
  text,
  serverUrl,
  resolveEntry,
  onOpenChannel,
  onOpenSession,
}: {
  text: string;
  serverUrl: string;
  resolveEntry: EntryResolver;
  onOpenChannel?: (channelId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const handles = useMemo(() => extractEntryLinkHandles(text, serverUrl), [text, serverUrl]);
  const [entries, setEntries] = useState<ResolvedEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    if (handles.length === 0) return;

    void Promise.all(handles.map((handle) => resolveEntry(handle))).then((resolved) => {
      if (cancelled) return;
      setEntries(resolved.filter((entry): entry is ResolvedEntry => entry != null));
    });

    return () => {
      cancelled = true;
    };
  }, [handles, resolveEntry]);

  if (entries.length === 0) return null;

  return (
    <View style={{ alignSelf: 'stretch', gap: 6, marginTop: 6 }}>
      {entries.map((entry) => (
        <EntryQuoteCard
          key={entry.handle}
          entry={entry}
          onOpenChannel={onOpenChannel}
          onOpenSession={onOpenSession}
        />
      ))}
    </View>
  );
}
