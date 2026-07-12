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
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  channelLabel,
  FILE_CATEGORIES,
  fileTypeLabel,
  formatBytes,
  formatRelativeTimestamp,
  type FileCategory,
  type HubFile,
  type HubFileListQuery,
} from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { mediaIconName, MediaLightbox, thumbnailSource } from '../../../src/components/MediaLightbox';
import { TextSnippetTile } from '../../../src/components/TextSnippetTile';
import {
  artifactEntryHandle,
  EntryReferencesChip,
  openEntryReferenceSummary,
} from '../../../src/components/EntryReferencesChip';
import { ConnectionBanner } from '../../../src/components/bits';
import { MobileHeader } from '../../../src/components/MobileHeader';
import { font, radius, space, useTheme } from '../../../src/lib/theme';
import {
  createEntryReferenceQuery,
  type EntryReferenceMap,
  type EntryReferenceSummary,
} from '../../../src/lib/entryReferences';
import { useRequiredSession } from '../../../src/lib/session';

const PAGE_SIZE = 40;
const CATEGORY_CHIPS: Array<{ key: 'all' | FileCategory; label: string }> = [
  { key: 'all', label: 'All' },
  ...FILE_CATEGORIES,
];
const FILE_PARAM_KEYS = ['q', 'category', 'channelId', 'file', 'starred', 'includeDeleted'] as const;

type FilesRouteParamKey = (typeof FILE_PARAM_KEYS)[number];
type FilesRouteParams = Partial<Record<FilesRouteParamKey, string | string[]>>;
type FilesRouteParamPatch = Partial<Record<FilesRouteParamKey, string | undefined>>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function cleanRouteParam(value: string | string[] | undefined): string | null {
  const first = firstParam(value)?.trim();
  return first ? first : null;
}

function boolParam(value: string | string[] | undefined): boolean {
  return firstParam(value) === 'true';
}

function isFileCategory(value: string | null): value is FileCategory {
  return value != null && FILE_CATEGORIES.some((category) => category.key === value);
}

function categoryParam(value: string | string[] | undefined): 'all' | FileCategory {
  const first = firstParam(value);
  return isFileCategory(first) ? first : 'all';
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        minHeight: 44,
        justifyContent: 'center',
        borderRadius: 22,
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
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderRadius: 22,
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
  const parts: string[] = [];
  if (file.sizeBytes != null) parts.push(formatBytes(file.sizeBytes));
  parts.push(formatRelativeTimestamp(file.createdAt) || file.createdAt);
  if (file.uploader?.name) parts.push(file.uploader.name);
  return parts.join(' · ');
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
  const typeLabel = fileTypeLabel(file);
  const iconFallback = <Ionicons name={icon} size={34} color={colors.textMuted} />;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${file.name}, ${typeLabel}`}
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
          <TextSnippetTile
            file={file}
            fileContentUrl={fileContentUrl}
            fileHeaders={fileHeaders}
            fallback={iconFallback}
          />
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
          <Ionicons
            name={file.starred ? 'star' : 'star-outline'}
            size={17}
            color={file.starred ? colors.warning : colors.textMuted}
          />
        </Pressable>
      </View>
      <View style={{ padding: space.sm, gap: 3 }}>
        <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }} numberOfLines={2}>
          {file.name}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 22 }}>
          <View
            style={{
              borderRadius: 999,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.bg,
              paddingHorizontal: 6,
              paddingVertical: 2,
            }}
          >
            <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '900' }}>{typeLabel}</Text>
          </View>
          <Text style={{ flex: 1, color: colors.textMuted, fontSize: font.xs }} numberOfLines={1}>
            {metaLine(file)}
          </Text>
        </View>
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
  const params = useLocalSearchParams<FilesRouteParams>();
  const routeQ = firstParam(params.q) ?? '';
  const routeCategory = categoryParam(params.category);
  const routeChannelId = cleanRouteParam(params.channelId);
  const routeFileId = cleanRouteParam(params.file);
  const routeStarred = boolParam(params.starred);
  const routeIncludeDeleted = boolParam(params.includeDeleted);
  const channelId = routeChannelId;
  const workspaceId = chat.state.channels[0]?.workspaceId ?? null;
  const channel = channelId ? chat.state.channels.find((item) => item.id === channelId) : null;
  const title = channel ? `${channelLabel(channel, chat.me.id)} gallery` : 'Gallery';
  const [category, setCategory] = useState<'all' | FileCategory>(routeCategory);
  const [starred, setStarred] = useState(routeStarred);
  const [includeDeleted, setIncludeDeleted] = useState(routeIncludeDeleted);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [search, setSearch] = useState(routeQ);
  const [openFileId, setOpenFileId] = useState<string | null>(routeFileId);
  const openFileIdRef = useRef<string | null>(routeFileId);
  const [files, setFiles] = useState<HubFile[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [references, setReferences] = useState<EntryReferenceMap>({});
  const [referenceFocusSeq, setReferenceFocusSeq] = useState(0);
  const loadSeq = useRef(0);
  const referenceCache = useRef<Record<string, EntryReferenceMap>>({});
  const referenceFetchKeys = useRef<Set<string>>(new Set());
  const focusedForReferences = useRef(false);
  const tileGap = space.md;
  const tileWidth = Math.floor((width - space.lg * 2 - tileGap) / 2);
  const queryEntryReferences = useMemo(() => createEntryReferenceQuery(authSession), [authSession]);

  const setRouteParams = useCallback(
    (patch: FilesRouteParamPatch) => {
      const next: FilesRouteParamPatch = {};
      let changed = false;
      for (const key of FILE_PARAM_KEYS) {
        if (!Object.hasOwn(patch, key)) continue;
        const nextValue = patch[key];
        const currentValue = firstParam(params[key]) ?? undefined;
        if (nextValue !== currentValue) {
          next[key] = nextValue;
          changed = true;
        }
      }
      if (changed) router.setParams?.(next);
    },
    [params.category, params.channelId, params.file, params.includeDeleted, params.q, params.starred],
  );

  useEffect(() => {
    setOpenFileId((current) => (current === routeFileId ? current : routeFileId));
  }, [routeFileId]);

  // Filter params adopt from the route only when explicitly present. Pressing
  // the tab-bar button re-navigates to a bare /files (params cleared) — that
  // must not wipe the user's filters, so absent params get the local state
  // written back instead (deep links with explicit params still win).
  const qPresent = params.q != null;
  const categoryPresent = params.category != null;
  const starredPresent = params.starred != null;
  const includeDeletedPresent = params.includeDeleted != null;

  useEffect(() => {
    if (qPresent) {
      setSearch((current) => (current === routeQ ? current : routeQ));
      return;
    }
    if (search.trim()) setRouteParams({ q: search.trim() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qPresent, routeQ]);

  useEffect(() => {
    if (categoryPresent) {
      setCategory((current) => (current === routeCategory ? current : routeCategory));
      return;
    }
    if (category !== 'all') setRouteParams({ category });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryPresent, routeCategory]);

  useEffect(() => {
    if (starredPresent) {
      setStarred((current) => (current === routeStarred ? current : routeStarred));
      return;
    }
    if (starred) setRouteParams({ starred: 'true' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starredPresent, routeStarred]);

  useEffect(() => {
    if (includeDeletedPresent) {
      setIncludeDeleted((current) => (current === routeIncludeDeleted ? current : routeIncludeDeleted));
      return;
    }
    if (includeDeleted) setRouteParams({ includeDeleted: 'true' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDeletedPresent, routeIncludeDeleted]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const nextQ = search.trim();
      const currentQ = routeQ.trim();
      if (nextQ !== currentQ) setRouteParams({ q: nextQ || undefined });
    }, 250);
    return () => clearTimeout(timer);
  }, [routeQ, search, setRouteParams]);

  const queryBase = useMemo<HubFileListQuery>(
    () => ({
      ...(category !== 'all' ? { category } : {}),
      ...(starred ? { starred: true } : {}),
      ...(routeQ.trim() ? { q: routeQ.trim() } : {}),
      includeDeleted,
      includeScratch: false,
      sort: 'recent',
      limit: PAGE_SIZE,
    }),
    [category, includeDeleted, routeQ, starred],
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
        setLoadedOnce(false);
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
        setLoadedOnce(true);
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
  const visibleFiles = files;
  const visibleItemCount = visibleFiles.length;
  const routedLightboxIndex = openFileId ? visibleFiles.findIndex((file) => file.artifactId === openFileId) : -1;
  const lightboxVisible = routedLightboxIndex >= 0;
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

  // The lightbox is an RN Modal, which floats above the navigator — without
  // this, an incoming deep link navigates underneath while the modal keeps
  // covering the screen. Close it whenever this tab loses focus. (Read via a
  // ref: depending on openFileId would rerun the effect — and its cleanup —
  // on every open.)
  openFileIdRef.current = openFileId;
  useFocusEffect(
    useCallback(() => {
      return () => {
        if (openFileIdRef.current) {
          setOpenFileId(null);
          setRouteParams({ file: undefined });
        }
      };
    }, [setRouteParams]),
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

  useEffect(() => {
    if (!openFileId || !loadedOnce || loading || refreshing) return;
    if (visibleFiles.some((file) => file.artifactId === openFileId)) return;
    if (nextCursor) {
      void loadFiles({ reset: false, cursor: nextCursor });
      return;
    }
    setOpenFileId(null);
    setRouteParams({ file: undefined });
  }, [loadedOnce, loadFiles, loading, nextCursor, openFileId, refreshing, setRouteParams, visibleFiles]);

  const updateSearch = useCallback(
    (value: string) => {
      setSearch(value);
      if (openFileId) {
        setOpenFileId(null);
        setRouteParams({ file: undefined });
      }
    },
    [openFileId, setRouteParams],
  );

  const updateCategory = useCallback(
    (value: 'all' | FileCategory) => {
      setCategory(value);
      setRouteParams({ category: value === 'all' ? undefined : value });
    },
    [setRouteParams],
  );

  const updateStarred = useCallback(() => {
    const next = !starred;
    setStarred(next);
    setRouteParams({ starred: next ? 'true' : undefined });
  }, [setRouteParams, starred]);

  const updateIncludeDeleted = useCallback(() => {
    const next = !includeDeleted;
    setIncludeDeleted(next);
    setRouteParams({ includeDeleted: next ? 'true' : undefined });
  }, [includeDeleted, setRouteParams]);

  const openLightbox = useCallback(
    (file: HubFile) => {
      setOpenFileId(file.artifactId);
      setRouteParams({ file: file.artifactId });
    },
    [setRouteParams],
  );

  const closeLightbox = useCallback(() => {
    setOpenFileId(null);
    setRouteParams({ file: undefined });
  }, [setRouteParams]);

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
          <Text style={{ color: colors.textMuted, fontSize: font.sm, fontWeight: '800' }}>{visibleItemCount}</Text>
        }
      />
      <ConnectionBanner status={chat.state.wsStatus} />
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <View
            style={{
              flex: 1,
              minHeight: 44,
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.bgInput,
              paddingLeft: space.md,
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
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                onPress={() => updateSearch('')}
                style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
              >
                <Ionicons name="close-circle" size={18} color={colors.textMuted} />
              </Pressable>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: filtersExpanded }}
            accessibilityLabel={filtersExpanded ? 'Hide filters' : 'Show filters'}
            onPress={() => setFiltersExpanded((value) => !value)}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: starred || includeDeleted || filtersExpanded ? colors.accent : colors.border,
              backgroundColor: pressed
                ? colors.bgPressed
                : starred || includeDeleted || filtersExpanded
                  ? colors.accentBg
                  : colors.bgElevated,
              alignItems: 'center',
              justifyContent: 'center',
            })}
          >
            <Ionicons
              name="options-outline"
              size={18}
              color={starred || includeDeleted || filtersExpanded ? colors.accent : colors.textMuted}
            />
          </Pressable>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          {CATEGORY_CHIPS.map((item) => (
            <Chip
              key={item.key}
              label={item.label}
              selected={category === item.key}
              onPress={() => updateCategory(item.key)}
            />
          ))}
        </ScrollView>
        {filtersExpanded ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            <ToggleChip
              label="Starred"
              icon="star-outline"
              selected={starred}
              hint="Filters the file list to starred files"
              onPress={updateStarred}
            />
            <ToggleChip
              label="Show removed"
              icon="trash-outline"
              selected={includeDeleted}
              hint="Includes removed files in the list"
              onPress={updateIncludeDeleted}
            />
          </View>
        ) : null}
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
        data={visibleFiles}
        keyExtractor={(file) => file.artifactId}
        numColumns={2}
        columnWrapperStyle={{ gap: tileGap, paddingHorizontal: space.lg }}
        contentContainerStyle={{ gap: tileGap, paddingTop: space.md }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void loadFiles({ reset: true })}
            tintColor={colors.textMuted}
          />
        }
        renderItem={({ item }) => (
          <FileTile
            file={item}
            width={tileWidth}
            fileContentUrl={chat.api.fileContentUrl}
            fileHeaders={chat.fileHeaders}
            reference={references[artifactEntryHandle(item.artifactId)] ?? null}
            onOpenReference={() => openEntryReferenceSummary(references[artifactEntryHandle(item.artifactId)] ?? null)}
            onPress={() => openLightbox(item)}
            onToggleStar={() => void toggleStar(item)}
          />
        )}
        ListEmptyComponent={
          !refreshing && !loading ? (
            <View
              style={{
                minHeight: 220,
                alignItems: 'center',
                justifyContent: 'center',
                padding: space.xl,
                gap: space.sm,
              }}
            >
              <Ionicons name="images-outline" size={38} color={colors.textMuted} />
              <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '800' }}>
                {searchActive ? 'No matching files' : 'No files'}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: font.sm, textAlign: 'center' }}>
                {searchActive
                  ? 'Files matching the current search and filters will appear here.'
                  : 'Files from messages, agents, and workspace artifacts will appear here.'}
              </Text>
            </View>
          ) : null
        }
        ListFooterComponent={footer}
      />
      <MediaLightbox
        visible={lightboxVisible}
        files={visibleFiles}
        initialIndex={Math.min(Math.max(routedLightboxIndex, 0), Math.max(visibleFiles.length - 1, 0))}
        fileContentUrl={chat.api.fileContentUrl}
        fileHeaders={chat.fileHeaders}
        references={references}
        onOpenReferences={openEntryReferenceSummary}
        onClose={closeLightbox}
        onOpenExternal={openExternal}
        api={chat.api}
        onFileChanged={() => void loadFiles({ reset: true })}
      />
    </View>
  );
}
