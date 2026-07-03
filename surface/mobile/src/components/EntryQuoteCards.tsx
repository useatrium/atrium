import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { containsCriticMarkup, parseCriticMarkup } from '@atrium/surface-client';
import { font, radius, space, useTheme } from '../lib/theme';
import { extractEntryLinkHandles } from '../lib/entryLinks';
import type { ArtifactContentResolver, EntryResolver, ResolvedEntry } from '../lib/entryResolve';
import { CriticMarkupBlocks, countCriticMarkupChanges } from './CriticMarkupText';

const EXCERPT_LIMIT = 200;
const ARTIFACT_HANDLE_PREFIX = 'art_';
const MARKUP_PREVIEW_MAX_LINES = 14;
const MARKUP_PREVIEW_LINE_HEIGHT = 20;

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

function artifactIdFromHandle(handle: string): string | null {
  return handle.startsWith(ARTIFACT_HANDLE_PREFIX) ? handle.slice(ARTIFACT_HANDLE_PREFIX.length) : null;
}

export function stripYamlFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '');
  const firstNewline = normalized.startsWith('---\r\n') ? '\r\n' : normalized.startsWith('---\n') ? '\n' : null;
  if (!firstNewline) return normalized;

  const closeMarker = `${firstNewline}---`;
  const closeIndex = normalized.indexOf(closeMarker, 3);
  if (closeIndex < 0) return normalized;
  const bodyStart = closeIndex + closeMarker.length;
  if (normalized.startsWith(firstNewline, bodyStart)) return normalized.slice(bodyStart + firstNewline.length);
  return normalized.slice(bodyStart);
}

function EntryQuoteHeader({
  entry,
  context,
  canOpen,
  open,
}: {
  entry: ResolvedEntry;
  context: string;
  canOpen: boolean;
  open: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${labelFor(entry)}, ${context}`}
      accessibilityState={{ disabled: !canOpen }}
      disabled={!canOpen}
      onPress={open}
      hitSlop={8}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 28,
        borderRadius: radius.sm,
        backgroundColor: pressed ? colors.bgPressed : 'transparent',
      })}
    >
      <Ionicons name={iconFor(entry)} size={14} color={entry.tombstoned ? colors.textFaint : colors.textMuted} />
      <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>
        {labelFor(entry)}
      </Text>
      <Text style={{ flex: 1, color: colors.textFaint, fontSize: font.xs }} numberOfLines={1}>
        {context}
      </Text>
    </Pressable>
  );
}

function MarkupArtifactPreview({ text }: { text: string }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const blocks = useMemo(() => parseCriticMarkup(text), [text]);
  const changeCount = useMemo(() => countCriticMarkupChanges(blocks), [blocks]);

  return (
    <View style={{ gap: space.xs }}>
      <View
        style={{
          maxHeight: expanded ? undefined : MARKUP_PREVIEW_MAX_LINES * MARKUP_PREVIEW_LINE_HEIGHT,
          overflow: 'hidden',
        }}
      >
        <CriticMarkupBlocks blocks={blocks} />
      </View>
      {!expanded ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Show all changes, ${changeCount}`}
          onPress={() => setExpanded(true)}
          hitSlop={8}
          style={{ minHeight: 36, justifyContent: 'center', alignSelf: 'flex-start' }}
        >
          <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '800' }}>
            Show all changes ({changeCount})
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function EntryQuoteCard({
  entry,
  resolveArtifactContent,
  onOpenChannel,
  onOpenSession,
}: {
  entry: ResolvedEntry;
  resolveArtifactContent?: ArtifactContentResolver;
  onOpenChannel?: (channelId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { colors } = useTheme();
  const [artifactBody, setArtifactBody] = useState<string | null>(null);
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
  const artifactId = entry.targetType === 'artifact' ? artifactIdFromHandle(entry.handle) : null;
  const hasMarkup = artifactBody != null && containsCriticMarkup(artifactBody);

  useEffect(() => {
    let cancelled = false;
    setArtifactBody(null);
    if (!artifactId || !resolveArtifactContent || entry.tombstoned) return;

    void resolveArtifactContent(artifactId).then((content) => {
      if (cancelled || content == null) return;
      setArtifactBody(stripYamlFrontmatter(content));
    });

    return () => {
      cancelled = true;
    };
  }, [artifactId, entry.tombstoned, resolveArtifactContent]);

  if (hasMarkup) {
    return (
      <View
        testID="entry-quote-markup-card"
        accessibilityLabel={`${labelFor(entry)}, ${context}`}
        style={{
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.bgElevated,
          borderRadius: radius.md,
          padding: space.sm,
          gap: 6,
        }}
      >
        <EntryQuoteHeader entry={entry} context={context} canOpen={canOpen} open={open} />
        <MarkupArtifactPreview text={artifactBody} />
        {entry.actor ? (
          <Text style={{ color: colors.textFaint, fontSize: font.xs }} numberOfLines={1}>
            {entry.actor}
          </Text>
        ) : null}
      </View>
    );
  }

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
  resolveArtifactContent,
  onOpenChannel,
  onOpenSession,
}: {
  text: string;
  serverUrl: string;
  resolveEntry: EntryResolver;
  resolveArtifactContent?: ArtifactContentResolver;
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
          resolveArtifactContent={resolveArtifactContent}
          onOpenChannel={onOpenChannel}
          onOpenSession={onOpenSession}
        />
      ))}
    </View>
  );
}
