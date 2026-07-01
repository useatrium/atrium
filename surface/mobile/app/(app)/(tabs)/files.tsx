import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import type { ComponentProps } from 'react';
import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  channelLabel,
  formatBytes,
  type FileOrigin,
  type HubFile,
  type HubFileListQuery,
} from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { mediaIconName, mediaKindLabel, MediaLightbox, thumbnailSource } from '../../../src/components/MediaLightbox';
import { ConnectionBanner } from '../../../src/components/bits';
import { MobileHeader } from '../../../src/components/MobileHeader';
import { font, radius, space, useTheme } from '../../../src/lib/theme';

const PAGE_SIZE = 40;
const ORIGINS: Array<{ value: 'all' | FileOrigin; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'upload', label: 'Uploads' },
  { value: 'agent', label: 'Agents' },
  { value: 'workspace', label: 'Workspace' },
];
const MEDIA_KINDS = ['all', 'image', 'video', 'audio', 'document', 'code', 'text', 'data', 'opaque'] as const;

type MediaFilter = (typeof MEDIA_KINDS)[number];

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        minHeight: 36,
        justifyContent: 'center',
        borderRadius: 18,
        borderWidth: 1,
        borderColor: selected ? colors.accent : colors.border,
        backgroundColor: selected ? colors.accentBg : colors.bgElevated,
        paddingHorizontal: space.md,
      }}
    >
      <Text
        style={{
          color: selected ? colors.accent : colors.textSecondary,
          fontSize: font.xs,
          fontWeight: '800',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ToggleChip({
  label,
  selected,
  icon,
  onPress,
}: {
  label: string;
  selected: boolean;
  icon: ComponentProps<typeof Ionicons>['name'];
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        minHeight: 38,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderRadius: 19,
        borderWidth: 1,
        borderColor: selected ? colors.accent : colors.border,
        backgroundColor: selected ? colors.accentBg : colors.bgElevated,
        paddingHorizontal: space.md,
      }}
    >
      <Ionicons name={icon} size={15} color={selected ? colors.accent : colors.textMuted} />
      <Text
        style={{
          color: selected ? colors.accent : colors.textSecondary,
          fontSize: font.xs,
          fontWeight: '800',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function metaLine(file: HubFile): string {
  const parts = [file.origin, file.uploader?.name].filter(Boolean);
  if (file.sizeBytes != null) parts.push(formatBytes(file.sizeBytes));
  return parts.join(' · ');
}

function FileTile({
  file,
  width,
  fileContentUrl,
  fileHeaders,
  onPress,
  onToggleStar,
}: {
  file: HubFile;
  width: number;
  fileContentUrl: (artifactId: string) => string;
  fileHeaders?: Record<string, string>;
  onPress: () => void;
  onToggleStar: () => void;
}) {
  const { colors } = useTheme();
  const thumb = thumbnailSource(file, fileContentUrl, fileHeaders);
  const icon = mediaIconName(file);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${file.name}, ${mediaKindLabel(file)}`}
      onPress={onPress}
      style={({ pressed }) => ({
        width,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: file.tombstoned ? colors.dangerBorder : colors.border,
        backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
        overflow: 'hidden',
      })}
    >
      <View
        style={{
          height: Math.round(width * 0.72),
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {thumb ? (
          <Image source={thumb} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={120} />
        ) : (
          <Ionicons name={icon} size={34} color={colors.textMuted} />
        )}
        {file.tombstoned ? (
          <View
            style={{
              position: 'absolute',
              left: space.sm,
              top: space.sm,
              borderRadius: 999,
              backgroundColor: colors.dangerSurface,
              borderWidth: 1,
              borderColor: colors.dangerBorder,
              paddingHorizontal: space.sm,
              paddingVertical: 3,
            }}
          >
            <Text style={{ color: colors.danger, fontSize: font.xs, fontWeight: '900' }}>REMOVED</Text>
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={file.starred ? 'Unstar file' : 'Star file'}
          onPress={onToggleStar}
          hitSlop={8}
          style={{
            position: 'absolute',
            right: space.sm,
            top: space.sm,
            width: 34,
            height: 34,
            borderRadius: 17,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.bgElevated,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Ionicons name={file.starred ? 'star' : 'star-outline'} size={17} color={file.starred ? colors.warning : colors.textMuted} />
        </Pressable>
      </View>
      <View style={{ padding: space.sm, gap: 3 }}>
        <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }} numberOfLines={2}>
          {file.name}
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: font.xs }} numberOfLines={1}>
          {mediaKindLabel(file)} · {metaLine(file)}
        </Text>
      </View>
    </Pressable>
  );
}

export default function FilesTab() {
  const chat = useChat();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ channelId?: string | string[] }>();
  const channelId = firstParam(params.channelId);
  const workspaceId = chat.state.channels[0]?.workspaceId ?? null;
  const channel = channelId ? chat.state.channels.find((item) => item.id === channelId) : null;
  const title = channel ? `${channelLabel(channel, chat.me.id)} files` : 'Files';
  const [origin, setOrigin] = useState<'all' | FileOrigin>('all');
  const [mediaKind, setMediaKind] = useState<MediaFilter>('all');
  const [starred, setStarred] = useState(false);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 250);
  const [files, setFiles] = useState<HubFile[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const loadSeq = useRef(0);
  const tileGap = space.md;
  const tileWidth = Math.floor((width - space.lg * 2 - tileGap) / 2);

  const queryBase = useMemo<HubFileListQuery>(
    () => ({
      ...(origin !== 'all' ? { origin: [origin] } : {}),
      ...(mediaKind !== 'all' ? { mediaKind: [mediaKind] } : {}),
      ...(starred ? { starred: true } : {}),
      ...(debouncedSearch.trim() ? { q: debouncedSearch.trim() } : {}),
      includeDeleted,
      includeScratch: true,
      sort: 'recent',
      limit: PAGE_SIZE,
    }),
    [debouncedSearch, includeDeleted, mediaKind, origin, starred],
  );

  const updateFile = useCallback((artifactId: string, patch: Partial<HubFile>) => {
    setFiles((current) => current.map((file) => (file.artifactId === artifactId ? { ...file, ...patch } : file)));
  }, []);

  const loadFiles = useCallback(
    async ({ reset, cursor }: { reset: boolean; cursor?: string | null }) => {
      if (!channelId && !workspaceId) return;
      const seq = ++loadSeq.current;
      if (reset) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const query = { ...queryBase, ...(cursor ? { cursor } : {}) };
        const result = channelId
          ? await chat.api.listChannelFiles(channelId, query)
          : await chat.api.listWorkspaceFiles(workspaceId!, query);
        if (seq !== loadSeq.current) return;
        setFiles((current) => (reset ? result.files : [...current, ...result.files]));
        setNextCursor(result.nextCursor ?? null);
      } catch (err) {
        if (seq !== loadSeq.current) return;
        setError(err instanceof Error ? err.message : 'Could not load files');
      } finally {
        if (seq === loadSeq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [channelId, chat.api, queryBase, workspaceId],
  );

  useEffect(() => {
    void loadFiles({ reset: true });
  }, [loadFiles]);

  const toggleStar = useCallback(
    async (file: HubFile) => {
      const previous = file.starred;
      updateFile(file.artifactId, { starred: !previous });
      try {
        const result = previous ? await chat.api.unstarFile(file.artifactId) : await chat.api.starFile(file.artifactId);
        updateFile(result.artifactId, { starred: result.starred });
      } catch (err) {
        updateFile(file.artifactId, { starred: previous });
        Alert.alert('Could not update star', err instanceof Error ? err.message : undefined);
      }
    },
    [chat.api, updateFile],
  );

  const openExternal = useCallback(
    async (file: HubFile) => {
      const { url } = await chat.api.fileSignedUrl(file.artifactId);
      const absoluteUrl = /^https?:\/\//i.test(url)
        ? url
        : `${new URL(chat.api.fileContentUrl(file.artifactId)).origin}${url}`;
      await Linking.openURL(absoluteUrl);
    },
    [chat.api],
  );

  const footer = loading ? (
    <View style={{ height: 72, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={colors.textMuted} />
    </View>
  ) : nextCursor ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Load more files"
      onPress={() => void loadFiles({ reset: false, cursor: nextCursor })}
      style={{ minHeight: 56, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text style={{ color: colors.accent, fontSize: font.sm, fontWeight: '800' }}>Load more</Text>
    </Pressable>
  ) : (
    <View style={{ height: 90 }} />
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <MobileHeader title={title} />
      <ConnectionBanner status={chat.state.wsStatus} queuedChangesCount={chat.queuedChangesCount} />
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm }}>
        <View
          style={{
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.bgInput,
            paddingHorizontal: space.md,
          }}
        >
          <Ionicons name="search" size={16} color={colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search files"
            placeholderTextColor={colors.textMuted}
            returnKeyType="search"
            style={{ flex: 1, color: colors.text, fontSize: font.md, paddingVertical: 10 }}
          />
          {search ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setSearch('')} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          {ORIGINS.map((item) => (
            <Chip key={item.value} label={item.label} selected={origin === item.value} onPress={() => setOrigin(item.value)} />
          ))}
        </ScrollView>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          {MEDIA_KINDS.map((kind) => (
            <Chip
              key={kind}
              label={kind === 'all' ? 'All media' : kind}
              selected={mediaKind === kind}
              onPress={() => setMediaKind(kind)}
            />
          ))}
        </ScrollView>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <ToggleChip label="Starred" icon="star-outline" selected={starred} onPress={() => setStarred((value) => !value)} />
          <ToggleChip
            label="Show removed"
            icon="trash-outline"
            selected={includeDeleted}
            onPress={() => setIncludeDeleted((value) => !value)}
          />
        </View>
      </View>
      {error ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Files failed to load. Tap to retry."
          onPress={() => void loadFiles({ reset: true })}
          style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: space.lg }}
        >
          <Text style={{ color: colors.danger, fontSize: font.sm }}>{error}</Text>
        </Pressable>
      ) : null}
      <FlatList
        data={files}
        keyExtractor={(item) => item.artifactId}
        numColumns={2}
        columnWrapperStyle={{ gap: tileGap, paddingHorizontal: space.lg }}
        contentContainerStyle={{ gap: tileGap, paddingTop: space.md }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void loadFiles({ reset: true })} tintColor={colors.textMuted} />
        }
        renderItem={({ item, index }) => (
          <FileTile
            file={item}
            width={tileWidth}
            fileContentUrl={chat.api.fileContentUrl}
            fileHeaders={chat.fileHeaders}
            onPress={() => setLightboxIndex(index)}
            onToggleStar={() => void toggleStar(item)}
          />
        )}
        ListEmptyComponent={
          !refreshing && !loading ? (
            <View style={{ minHeight: 220, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm }}>
              <Ionicons name="folder-open-outline" size={38} color={colors.textMuted} />
              <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '800' }}>No files</Text>
              <Text style={{ color: colors.textMuted, fontSize: font.sm, textAlign: 'center' }}>
                Files from messages, agents, and workspace artifacts will appear here.
              </Text>
            </View>
          ) : null
        }
        ListFooterComponent={footer}
      />
      <MediaLightbox
        visible={lightboxIndex != null}
        files={files}
        initialIndex={lightboxIndex ?? 0}
        fileContentUrl={chat.api.fileContentUrl}
        fileHeaders={chat.fileHeaders}
        onClose={() => setLightboxIndex(null)}
        onOpenExternal={openExternal}
      />
    </View>
  );
}
