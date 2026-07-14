import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, Text, View, type GestureResponderEvent } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { containsCriticMarkup, parseCriticMarkup, type Api, type AttachmentMeta } from '@atrium/surface-client';
import { font, radius, space, useTheme } from '../lib/theme';
import { extractEntryLinkHandles } from '../lib/entryLinks';
import type { ArtifactContentResolver, EntryResolver, ResolvedEntry } from '../lib/entryResolve';
import { loadCollapsedUnfurls, persistCollapsedUnfurl } from '../lib/prefsStorage';
import { CriticMarkupBlocks, countCriticMarkupChanges } from './CriticMarkupText';

const EXCERPT_LIMIT = 200;
const ARTIFACT_HANDLE_PREFIX = 'art_';
const MARKUP_PREVIEW_MAX_LINES = 14;
const MARKUP_PREVIEW_LINE_HEIGHT = 20;
const CARD_LIMIT = 3;
const THUMBNAIL_SIZE = 96;
const MAX_IMAGE_THUMBNAILS = 4;
const IMAGE_ARTIFACT_RE = /\.(?:png|jpe?g|gif|webp|svg|avif)$/i;

export interface UnfurlManagement {
  messageEventId?: number | null;
  suppressed?: readonly string[];
  canManage?: boolean;
}

type EntryAttachment = AttachmentMeta;

type EntryOpenHandlers = {
  onOpenChannel?: (channelId: string) => void;
  onOpenSession?: (sessionId: string) => void;
};

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

function metaString(entry: ResolvedEntry, key: string): string | null {
  const value = entry.meta[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function entryAttachments(entry: ResolvedEntry): EntryAttachment[] {
  const attachments = entry.meta.attachments;
  if (!Array.isArray(attachments)) return [];

  return attachments.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.id !== 'string' ||
      !candidate.id ||
      typeof candidate.filename !== 'string' ||
      !candidate.filename ||
      typeof candidate.contentType !== 'string' ||
      typeof candidate.size !== 'number' ||
      !Number.isFinite(candidate.size) ||
      candidate.size < 0
    ) {
      return [];
    }
    return [
      {
        id: candidate.id,
        filename: candidate.filename,
        contentType: candidate.contentType,
        size: candidate.size,
        ...(finitePositive(candidate.width) != null ? { width: finitePositive(candidate.width) } : {}),
        ...(finitePositive(candidate.height) != null ? { height: finitePositive(candidate.height) } : {}),
      },
    ];
  });
}

function artifactImageUrl(entry: ResolvedEntry, serverUrl: string): string | null {
  if (entry.targetType !== 'artifact') return null;
  const path = metaString(entry, 'path');
  const artifactId = artifactIdFromHandle(entry.handle);
  if (!path || !artifactId || !IMAGE_ARTIFACT_RE.test(path)) return null;
  return `${serverUrl.replace(/\/+$/, '')}/api/files/artifact/${encodeURIComponent(artifactId)}/content`;
}

function actorFor(entry: ResolvedEntry): string {
  return entry.actorLabel || entry.actor || entry.kind;
}

function artifactIdFromHandle(handle: string): string | null {
  return handle.startsWith(ARTIFACT_HANDLE_PREFIX) ? handle.slice(ARTIFACT_HANDLE_PREFIX.length) : null;
}

function canOpenEntry(entry: ResolvedEntry, { onOpenChannel, onOpenSession }: EntryOpenHandlers): boolean {
  return (
    (entry.targetType === 'record' && entry.location.sessionId != null && onOpenSession != null) ||
    (entry.targetType !== 'record' && entry.location.channelId != null && onOpenChannel != null)
  );
}

function openEntryReference(entry: ResolvedEntry, { onOpenChannel, onOpenSession }: EntryOpenHandlers): void {
  if (entry.targetType === 'record' && entry.location.sessionId) {
    onOpenSession?.(entry.location.sessionId);
    return;
  }
  if (entry.location.channelId) onOpenChannel?.(entry.location.channelId);
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
  collapsed,
  onToggleCollapsed,
  onRemove,
}: {
  entry: ResolvedEntry;
  context: string;
  canOpen: boolean;
  open: () => void;
  collapsed: boolean;
  onToggleCollapsed: (event: GestureResponderEvent) => void;
  onRemove?: (event: GestureResponderEvent) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={collapsed ? 'Expand preview' : 'Collapse preview'}
        accessibilityState={{ expanded: !collapsed }}
        onPress={onToggleCollapsed}
        style={({ pressed }) => ({
          width: 44,
          minHeight: 44,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: radius.sm,
          backgroundColor: pressed ? colors.bgPressed : 'transparent',
        })}
      >
        <Ionicons name={collapsed ? 'chevron-forward' : 'chevron-down'} size={16} color={colors.textMuted} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${labelFor(entry)}, ${context}`}
        accessibilityState={{ disabled: !canOpen }}
        disabled={!canOpen}
        onPress={(event) => {
          event.stopPropagation();
          open();
        }}
        style={({ pressed }) => ({
          flex: 1,
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          borderRadius: radius.sm,
          backgroundColor: pressed ? colors.bgPressed : 'transparent',
        })}
      >
        <Ionicons name={iconFor(entry)} size={14} color={entry.tombstoned ? colors.textFaint : colors.textMuted} />
        <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }} numberOfLines={1}>
          {collapsed ? actorFor(entry) : labelFor(entry)}
        </Text>
        <Text style={{ flex: 1, color: colors.textFaint, fontSize: font.xs }} numberOfLines={1}>
          {context}
        </Text>
      </Pressable>
      {onRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove preview"
          onPress={onRemove}
          style={({ pressed }) => ({
            width: 44,
            minHeight: 44,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radius.sm,
            backgroundColor: pressed ? colors.bgPressed : 'transparent',
          })}
        >
          <Ionicons name="close" size={18} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
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

function EntryAttachmentPreviews({
  attachments,
  serverUrl,
  fileHeaders,
  onOpenAttachments,
}: {
  attachments: EntryAttachment[];
  serverUrl: string;
  fileHeaders?: Record<string, string>;
  onOpenAttachments?: (attachments: AttachmentMeta[], index: number) => void;
}) {
  const { colors } = useTheme();
  const images = attachments
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) => attachment.contentType.toLowerCase().startsWith('image/'));
  const files = attachments.filter((attachment) => !attachment.contentType.toLowerCase().startsWith('image/'));
  const overflow = Math.max(0, images.length - MAX_IMAGE_THUMBNAILS);

  if (attachments.length === 0) return null;
  return (
    <View style={{ gap: space.xs }}>
      {images.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
          {images.slice(0, MAX_IMAGE_THUMBNAILS).map(({ attachment, index }) => (
            <Pressable
              key={attachment.id}
              accessibilityRole="imagebutton"
              accessibilityLabel={`Open ${attachment.filename}`}
              onPress={(event) => {
                event.stopPropagation();
                onOpenAttachments?.(attachments, index);
              }}
              disabled={!onOpenAttachments}
            >
              <Image
                testID={`entry-attachment-thumbnail-${attachment.id}`}
                source={{
                  uri: `${serverUrl.replace(/\/+$/, '')}/api/files/${encodeURIComponent(attachment.id)}`,
                  headers: fileHeaders,
                }}
                style={{
                  width: THUMBNAIL_SIZE,
                  height: THUMBNAIL_SIZE,
                  maxHeight: THUMBNAIL_SIZE,
                  borderRadius: radius.sm,
                  backgroundColor: colors.bgPressed,
                }}
                contentFit="cover"
              />
            </Pressable>
          ))}
          {overflow > 0 ? (
            <View
              accessibilityLabel={`${overflow} more images`}
              style={{
                width: THUMBNAIL_SIZE,
                height: THUMBNAIL_SIZE,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: radius.sm,
                backgroundColor: colors.bgPressed,
              }}
            >
              <Text style={{ color: colors.textSecondary, fontSize: font.sm, fontWeight: '800' }}>+{overflow}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {files.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
          {files.map((attachment) => (
            <View
              key={attachment.id}
              accessibilityLabel={attachment.filename}
              style={{
                minHeight: 28,
                maxWidth: '100%',
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.xxs,
                paddingHorizontal: space.sm,
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.bgElevated,
              }}
            >
              <Ionicons name="document-attach-outline" size={14} color={colors.textMuted} />
              <Text style={{ color: colors.textSecondary, fontSize: font.xs }} numberOfLines={1}>
                {attachment.filename}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function EntryQuoteCard({
  entry,
  serverUrl,
  resolveArtifactContent,
  fileHeaders,
  messageEventId,
  canManage,
  onRemove,
  onOpenAttachments,
  onOpenChannel,
  onOpenSession,
}: {
  entry: ResolvedEntry;
  serverUrl: string;
  resolveArtifactContent?: ArtifactContentResolver;
  fileHeaders?: Record<string, string>;
  messageEventId?: number | null;
  canManage?: boolean;
  onRemove?: (handle: string) => void;
  onOpenAttachments?: (attachments: AttachmentMeta[], index: number) => void;
  onOpenChannel?: (channelId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { colors } = useTheme();
  const [artifactBody, setArtifactBody] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const openHandlers = { onOpenChannel, onOpenSession };
  const canOpen = canOpenEntry(entry, openHandlers);
  const open = () => openEntryReference(entry, openHandlers);

  const context = contextFor(entry);
  const excerpt = excerptFor(entry);
  const artifactId = entry.targetType === 'artifact' ? artifactIdFromHandle(entry.handle) : null;
  const hasMarkup = artifactBody != null && containsCriticMarkup(artifactBody);
  const attachments = useMemo(() => entryAttachments(entry), [entry]);
  const imageArtifactUrl = artifactImageUrl(entry, serverUrl);
  const collapseKey = messageEventId != null ? `${messageEventId}:${entry.handle}` : null;

  useEffect(() => {
    let cancelled = false;
    setCollapsed(false);
    if (!collapseKey) return;
    void loadCollapsedUnfurls().then((stored) => {
      if (!cancelled) setCollapsed(stored.includes(collapseKey));
    });
    return () => {
      cancelled = true;
    };
  }, [collapseKey]);

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

  const toggleCollapsed = (event: GestureResponderEvent) => {
    event.stopPropagation();
    const next = !collapsed;
    setCollapsed(next);
    if (collapseKey) void persistCollapsedUnfurl(collapseKey, next);
  };
  const remove =
    canManage && onRemove
      ? (event: GestureResponderEvent) => {
          event.stopPropagation();
          onRemove(entry.handle);
        }
      : undefined;

  if (collapsed) {
    return (
      <View
        style={{
          borderWidth: 1,
          borderColor: entry.tombstoned ? colors.borderSoft : colors.border,
          backgroundColor: colors.bgElevated,
          borderRadius: radius.md,
          paddingHorizontal: space.xxs,
          opacity: entry.tombstoned ? 0.72 : 1,
        }}
      >
        <EntryQuoteHeader
          entry={entry}
          context={context}
          canOpen={canOpen}
          open={open}
          collapsed
          onToggleCollapsed={toggleCollapsed}
          onRemove={remove}
        />
      </View>
    );
  }

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
        <EntryQuoteHeader
          entry={entry}
          context={context}
          canOpen={canOpen}
          open={open}
          collapsed={false}
          onToggleCollapsed={toggleCollapsed}
          onRemove={remove}
        />
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
    <View
      style={{
        borderWidth: 1,
        borderColor: entry.tombstoned ? colors.borderSoft : colors.border,
        backgroundColor: colors.bgElevated,
        borderRadius: radius.md,
        padding: space.sm,
        gap: 6,
        opacity: entry.tombstoned ? 0.72 : 1,
      }}
    >
      <EntryQuoteHeader
        entry={entry}
        context={context}
        canOpen={canOpen}
        open={open}
        collapsed={false}
        onToggleCollapsed={toggleCollapsed}
        onRemove={remove}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${labelFor(entry)}, ${context}: ${excerpt}`}
        accessibilityState={{ disabled: !canOpen }}
        disabled={!canOpen}
        onPress={open}
        style={({ pressed }) => ({
          gap: 6,
          borderRadius: radius.sm,
          backgroundColor: pressed ? colors.bgPressed : 'transparent',
        })}
      >
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
        {imageArtifactUrl ? (
          <Image
            testID={`entry-artifact-thumbnail-${entry.handle}`}
            accessibilityLabel={metaString(entry, 'path') ?? 'Artifact image preview'}
            source={{ uri: imageArtifactUrl, headers: fileHeaders }}
            style={{ width: '100%', height: THUMBNAIL_SIZE, maxHeight: THUMBNAIL_SIZE, borderRadius: radius.sm }}
            contentFit="cover"
          />
        ) : null}
        {entry.actor ? (
          <Text style={{ color: colors.textFaint, fontSize: font.xs }} numberOfLines={1}>
            {entry.actor}
          </Text>
        ) : null}
      </Pressable>
      <EntryAttachmentPreviews
        attachments={attachments}
        serverUrl={serverUrl}
        fileHeaders={fileHeaders}
        onOpenAttachments={onOpenAttachments}
      />
    </View>
  );
}

export { EntryInlineChip } from './EntryInlineChip';

export function EntryQuoteCards({
  text,
  serverUrl,
  handles: providedHandles,
  resolveEntry,
  resolveArtifactContent,
  api,
  fileHeaders,
  onOpenAttachments,
  unfurlManagement,
  onOpenChannel,
  onOpenSession,
}: {
  text: string;
  serverUrl: string;
  handles?: string[];
  resolveEntry: EntryResolver;
  resolveArtifactContent?: ArtifactContentResolver;
  api?: Pick<Api, 'suppressMessageUnfurls'>;
  fileHeaders?: Record<string, string>;
  onOpenAttachments?: (attachments: AttachmentMeta[], index: number) => void;
  unfurlManagement?: UnfurlManagement;
  onOpenChannel?: (channelId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { colors } = useTheme();
  const extractedHandles = useMemo(() => extractEntryLinkHandles(text, serverUrl), [text, serverUrl]);
  const suppressedKey = (unfurlManagement?.suppressed ?? []).join('\n');
  const handlesKey = (providedHandles ?? extractedHandles)
    .filter((handle) => !(unfurlManagement?.suppressed ?? []).includes(handle))
    .join('\n');
  const [entries, setEntries] = useState<ResolvedEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [optimisticallyHidden, setOptimisticallyHidden] = useState<string[]>([]);

  useEffect(() => {
    setOptimisticallyHidden([]);
  }, [suppressedKey]);

  useEffect(() => {
    setExpanded(false);
  }, [handlesKey]);

  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    const handles = handlesKey ? handlesKey.split('\n') : [];
    if (handles.length === 0) return;

    void Promise.all(handles.map((handle) => resolveEntry(handle))).then((resolved) => {
      if (cancelled) return;
      setEntries(resolved.filter((entry): entry is ResolvedEntry => entry != null));
    });

    return () => {
      cancelled = true;
    };
  }, [handlesKey, resolveEntry]);

  const visibleEntries = entries.filter((entry) => !optimisticallyHidden.includes(entry.handle));
  if (visibleEntries.length === 0) return null;

  const shownEntries = expanded ? visibleEntries : visibleEntries.slice(0, CARD_LIMIT);
  const hiddenCount = visibleEntries.length - CARD_LIMIT;
  const messageEventId = unfurlManagement?.messageEventId;
  const canManage =
    unfurlManagement?.canManage === true && messageEventId != null && api?.suppressMessageUnfurls != null;

  const removePreview = (handle: string) => {
    if (!canManage || messageEventId == null || !api) return;
    const nextSuppressed = [...new Set([...(unfurlManagement?.suppressed ?? []), ...optimisticallyHidden, handle])];
    setOptimisticallyHidden((current) => (current.includes(handle) ? current : [...current, handle]));
    void api.suppressMessageUnfurls(messageEventId, nextSuppressed).catch(() => {
      setOptimisticallyHidden((current) => current.filter((value) => value !== handle));
      Alert.alert('Action failed', "Couldn't remove the preview.");
    });
  };

  return (
    <View style={{ alignSelf: 'stretch', gap: 6, marginTop: 6 }}>
      {shownEntries.map((entry) => (
        <EntryQuoteCard
          key={entry.handle}
          entry={entry}
          serverUrl={serverUrl}
          resolveArtifactContent={resolveArtifactContent}
          fileHeaders={fileHeaders}
          messageEventId={messageEventId}
          canManage={canManage}
          onRemove={removePreview}
          onOpenAttachments={onOpenAttachments}
          onOpenChannel={onOpenChannel}
          onOpenSession={onOpenSession}
        />
      ))}
      {hiddenCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Show fewer previews' : `Show ${hiddenCount} more previews`}
          onPress={() => setExpanded((current) => !current)}
          style={{ minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' }}
        >
          <Text style={{ color: colors.accent, fontSize: font.sm, fontWeight: '700' }}>
            {expanded ? 'Show fewer' : `Show ${hiddenCount} more`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
