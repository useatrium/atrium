import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
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
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
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
import {
  artifactEntryHandle,
  EntryReferencesChip,
  openEntryReferenceSummary,
} from '../../../src/components/EntryReferencesChip';
import { ConnectionBanner } from '../../../src/components/bits';
import { MobileHeader } from '../../../src/components/MobileHeader';
import { font, radius, space, useTheme } from '../../../src/lib/theme';
import { createEntryReferenceQuery, type EntryReferenceMap, type EntryReferenceSummary } from '../../../src/lib/entryReferences';
import { useRequiredSession } from '../../../src/lib/session';

const PAGE_SIZE = 40;
const ORIGINS: Array<{ value: 'all' | FileOrigin; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'upload', label: 'Uploads' },
  { value: 'agent', label: 'Agents' },
  { value: 'workspace', label: 'Workspace' },
];
const MEDIA_KINDS = ['all', 'image', 'video', 'audio', 'document', 'code', 'text', 'data', 'opaque'] as const;

type MediaFilter = (typeof MEDIA_KINDS)[number];

interface FolderEntry {
  name: string;
  path: string;
  fileCount: number;
}

type FileListItem =
  | { kind: 'folder'; folder: FolderEntry }
  | { kind: 'file'; file: HubFile; fileIndex: number };

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function dirname(path: string): string {
  const segments = pathSegments(path);
  return segments.slice(0, -1).join('/');
}

function dirSegments(dir: string): string[] {
  return dir ? dir.split('/').filter(Boolean) : [];
}

function joinDir(segments: string[]): string {
  return segments.join('/');
}

function hasPrefix(segments: string[], prefix: string[]): boolean {
  return prefix.every((segment, index) => segments[index] === segment);
}

function folderView(files: HubFile[], currentDir: string): { folders: FolderEntry[]; filesHere: HubFile[] } {
  const currentSegments = dirSegments(currentDir);
  const folderCounts = new Map<string, { path: string; fileCount: number }>();
  const filesHere: HubFile[] = [];

  for (const file of files) {
    const fileDirSegments = dirSegments(dirname(file.path));
    if (joinDir(fileDirSegments) === currentDir) {
      filesHere.push(file);
    }

    if (fileDirSegments.length <= currentSegments.length || !hasPrefix(fileDirSegments, currentSegments)) {
      continue;
    }

    const childName = fileDirSegments[currentSegments.length]!;
    const childPath = joinDir([...currentSegments, childName]);
    const current = folderCounts.get(childName);
    if (current) {
      current.fileCount += 1;
    } else {
      folderCounts.set(childName, { path: childPath, fileCount: 1 });
    }
  }

  const folders = [...folderCounts.entries()]
    .map(([name, value]) => ({ name, path: value.path, fileCount: value.fileCount }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { folders, filesHere };
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
  hint,
  onPress,
}: {
  label: string;
  selected: boolean;
  icon: ComponentProps<typeof Ionicons>['name'];
  hint?: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      accessibilityHint={hint}
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

function FolderTile({
  folder,
  width,
  onPress,
}: {
  folder: FolderEntry;
  width: number;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open folder ${folder.name}, ${folder.fileCount} ${folder.fileCount === 1 ? 'file' : 'files'}`}
      onPress={onPress}
      style={({ pressed }) => ({
        width,
        minHeight: Math.round(width * 0.72) + 86,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
        overflow: 'hidden',
        padding: space.sm,
        justifyContent: 'space-between',
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.bg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="folder-outline" size={23} color={colors.textMuted} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }} numberOfLines={2}>
            {folder.name}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: font.xs, marginTop: 3 }} numberOfLines={1}>
            {folder.fileCount} {folder.fileCount === 1 ? 'file' : 'files'}
          </Text>
        </View>
      </View>
      <Text style={{ color: colors.textMuted, fontSize: font.xs }} numberOfLines={1}>
        {folder.path}
      </Text>
    </Pressable>
  );
}

function FolderBreadcrumb({
  currentDir,
  onNavigate,
}: {
  currentDir: string;
  onNavigate: (dir: string) => void;
}) {
  const { colors } = useTheme();
  const segments = dirSegments(currentDir);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel="Folder breadcrumb"
      contentContainerStyle={{
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: space.lg,
        paddingBottom: space.sm,
      }}
    >
      {currentDir ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go up one folder"
          onPress={() => onNavigate(joinDir(segments.slice(0, -1)))}
          hitSlop={8}
          style={{
            minHeight: 28,
            minWidth: 28,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="arrow-up" size={15} color={colors.textMuted} />
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Go to Files" onPress={() => onNavigate('')} hitSlop={6}>
        <Text
          style={{
            color: currentDir ? colors.textMuted : colors.text,
            fontSize: font.xs,
            fontWeight: '800',
            paddingVertical: 4,
          }}
        >
          Files
        </Text>
      </Pressable>
      {segments.map((segment, index) => {
        const dir = joinDir(segments.slice(0, index + 1));
        const isCurrent = dir === currentDir;
        return (
          <View key={dir} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text style={{ color: colors.textMuted, fontSize: font.xs }}>/</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`Go to folder ${dir}`} onPress={() => onNavigate(dir)} hitSlop={6}>
              <Text
                style={{
                  maxWidth: 140,
                  color: isCurrent ? colors.text : colors.textMuted,
                  fontSize: font.xs,
                  fontWeight: isCurrent ? '800' : '700',
                  paddingVertical: 4,
                }}
                numberOfLines={1}
              >
                {segment}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

function FileTile({
  file,
  width,
  fileContentUrl,
  fileHeaders,
  reference,
  onOpenReference,
  onPress,
  onToggleStar,
}: {
  file: HubFile;
  width: number;
  fileContentUrl: (artifactId: string) => string;
  fileHeaders?: Record<string, string>;
  reference: EntryReferenceSummary | null;
  onOpenReference: () => void;
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
          accessibilityHint={file.starred ? 'Removes this file from starred files' : 'Adds this file to starred files'}
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
        {reference && reference.count > 0 ? (
          <EntryReferencesChip count={reference.count} onPress={onOpenReference} />
        ) : null}
      </View>
    </Pressable>
  );
}

export default function FilesTab() {
  const chat = useChat();
  const authSession = useRequiredSession();
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
  const [currentDir, setCurrentDir] = useState('');
  const [files, setFiles] = useState<HubFile[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [references, setReferences] = useState<EntryReferenceMap>({});
  const [referenceFocusSeq, setReferenceFocusSeq] = useState(0);
  const loadSeq = useRef(0);
  const referenceCache = useRef<Record<string, EntryReferenceMap>>({});
  const referenceFetchKeys = useRef<Set<string>>(new Set());
  const focusedForReferences = useRef(false);
  const tileGap = space.md;
  const tileWidth = Math.floor((width - space.lg * 2 - tileGap) / 2);
  const queryEntryReferences = useMemo(() => createEntryReferenceQuery(authSession), [authSession]);

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
  }, [chat.filesEventSeq, loadFiles]);

  const searchActive = search.trim().length > 0;
  const { folders, filesHere } = useMemo(() => folderView(files, currentDir), [currentDir, files]);
  const visibleFiles = searchActive ? files : filesHere;
  const visibleItemCount = searchActive ? visibleFiles.length : folders.length + visibleFiles.length;
  const showBreadcrumb = !searchActive && (currentDir !== '' || folders.length > 0);
  const listItems = useMemo<FileListItem[]>(
    () =>
      searchActive
        ? visibleFiles.map((file, fileIndex) => ({ kind: 'file', file, fileIndex }))
        : [
            ...folders.map((folder) => ({ kind: 'folder' as const, folder })),
            ...visibleFiles.map((file, fileIndex) => ({ kind: 'file' as const, file, fileIndex })),
          ],
    [folders, searchActive, visibleFiles],
  );
  const visibleEntryHandles = useMemo(() => {
    const seen = new Set<string>();
    for (const file of visibleFiles) {
      if (file.artifactId) seen.add(artifactEntryHandle(file.artifactId));
    }
    return [...seen].sort();
  }, [visibleFiles]);
  const visibleEntryHandlesKey = visibleEntryHandles.join('\n');

  useFocusEffect(
    useCallback(() => {
      focusedForReferences.current = true;
      setReferenceFocusSeq((seq) => seq + 1);
      return () => {
        focusedForReferences.current = false;
      };
    }, []),
  );

  useEffect(() => {
    if (!focusedForReferences.current) return;
    if (visibleEntryHandles.length === 0) {
      setReferences({});
      return;
    }

    const cacheKey = `${channelId ?? workspaceId ?? 'files'}:${visibleEntryHandlesKey}`;
    const cachedReferences = referenceCache.current[cacheKey];
    if (cachedReferences) {
      setReferences(cachedReferences);
    }
    const focusFetchKey = `${referenceFocusSeq}:${cacheKey}`;
    if (referenceFetchKeys.current.has(focusFetchKey)) return;
    referenceFetchKeys.current.add(focusFetchKey);

    let disposed = false;
    queryEntryReferences(visibleEntryHandles)
      .then((next) => {
        if (disposed || !focusedForReferences.current) return;
        referenceCache.current[cacheKey] = next;
        setReferences(next);
      })
      .catch((err: unknown) => {
        if (!disposed) console.warn('failed to load file references', err);
      });

    return () => {
      disposed = true;
    };
  }, [channelId, queryEntryReferences, referenceFocusSeq, visibleEntryHandles, visibleEntryHandlesKey, workspaceId]);

  const navigateToDir = useCallback((dir: string) => {
    setCurrentDir(dir);
    setLightboxIndex(null);
  }, []);

  const popCurrentDir = useCallback(() => {
    const segments = dirSegments(currentDir);
    if (segments.length === 0) return false;
    setCurrentDir(joinDir(segments.slice(0, -1)));
    setLightboxIndex(null);
    return true;
  }, [currentDir]);

  useFocusEffect(
    useCallback(() => {
      const handler = (BackHandler as unknown as {
        addEventListener?: (
          eventName: 'hardwareBackPress',
          handler: () => boolean,
        ) => { remove: () => void };
      }).addEventListener?.('hardwareBackPress', () => {
        if (popCurrentDir()) return true;
        return false;
      });
      return () => handler?.remove();
    }, [popCurrentDir]),
  );

  const updateSearch = useCallback((value: string) => {
    setSearch(value);
    setLightboxIndex(null);
    if (!value.trim()) {
      setCurrentDir('');
    }
  }, []);

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
      <MobileHeader
        title={title}
        right={
          <Text style={{ color: colors.textMuted, fontSize: font.sm, fontWeight: '800' }}>
            {visibleItemCount}
          </Text>
        }
      />
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
            accessibilityLabel="Search files"
            value={search}
            onChangeText={updateSearch}
            placeholder="Search files"
            placeholderTextColor={colors.textMuted}
            returnKeyType="search"
            style={{ flex: 1, color: colors.text, fontSize: font.md, paddingVertical: 10 }}
          />
          {search ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => updateSearch('')} hitSlop={8}>
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
          <ToggleChip
            label="Starred"
            icon="star-outline"
            selected={starred}
            hint="Filters the file list to starred files"
            onPress={() => setStarred((value) => !value)}
          />
          <ToggleChip
            label="Show removed"
            icon="trash-outline"
            selected={includeDeleted}
            hint="Includes removed files in the list"
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
        data={listItems}
        keyExtractor={(item) => (item.kind === 'folder' ? `folder:${item.folder.path}` : `file:${item.file.artifactId}`)}
        numColumns={2}
        columnWrapperStyle={{ gap: tileGap, paddingHorizontal: space.lg }}
        contentContainerStyle={{ gap: tileGap, paddingTop: space.md }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void loadFiles({ reset: true })} tintColor={colors.textMuted} />
        }
        renderItem={({ item }) =>
          item.kind === 'folder' ? (
            <FolderTile folder={item.folder} width={tileWidth} onPress={() => navigateToDir(item.folder.path)} />
          ) : (
            <FileTile
              file={item.file}
              width={tileWidth}
              fileContentUrl={chat.api.fileContentUrl}
              fileHeaders={chat.fileHeaders}
              reference={references[artifactEntryHandle(item.file.artifactId)] ?? null}
              onOpenReference={() => openEntryReferenceSummary(references[artifactEntryHandle(item.file.artifactId)] ?? null)}
              onPress={() => setLightboxIndex(item.fileIndex)}
              onToggleStar={() => void toggleStar(item.file)}
            />
          )
        }
        ListHeaderComponent={showBreadcrumb ? <FolderBreadcrumb currentDir={currentDir} onNavigate={navigateToDir} /> : null}
        ListEmptyComponent={
          !refreshing && !loading ? (
            <View style={{ minHeight: 220, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm }}>
              <Ionicons name="folder-open-outline" size={38} color={colors.textMuted} />
              <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '800' }}>
                {searchActive ? 'No matching files' : currentDir ? 'Empty folder' : 'No files'}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: font.sm, textAlign: 'center' }}>
                {searchActive
                  ? 'Files matching the current search and filters will appear here.'
                  : currentDir
                    ? 'Files added to this folder will appear here.'
                    : 'Files from messages, agents, and workspace artifacts will appear here.'}
              </Text>
            </View>
          ) : null
        }
        ListFooterComponent={footer}
      />
      <MediaLightbox
        visible={lightboxIndex != null}
        files={visibleFiles}
        initialIndex={Math.min(lightboxIndex ?? 0, Math.max(visibleFiles.length - 1, 0))}
        fileContentUrl={chat.api.fileContentUrl}
        fileHeaders={chat.fileHeaders}
        references={references}
        onOpenReferences={openEntryReferenceSummary}
        onClose={() => setLightboxIndex(null)}
        onOpenExternal={openExternal}
        api={chat.api}
        onFileChanged={() => void loadFiles({ reset: true })}
      />
    </View>
  );
}
