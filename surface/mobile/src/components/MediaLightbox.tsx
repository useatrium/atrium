import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, Ref } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Share,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Image } from 'expo-image';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { VideoView, useVideoPlayer, type VideoSource } from 'expo-video';
import Pdf from 'react-native-pdf';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatBytes, formatRelativeTimestamp, type Api, type HubFile } from '@atrium/surface-client';
// @ts-expect-error react-native-syntax-highlighter does not publish TypeScript declarations.
import SyntaxHighlighter from 'react-native-syntax-highlighter';
import { SessionMarkdown } from './Markdown';
import { TextEditorPane } from './TextEditorPane';
import { VersionHistoryPanel } from './VersionHistoryPanel';
import { TimestampText } from './TimestampText';
import { AppPreviewPane } from './AppPreviewPane';
import { PptxPane } from './PptxPane';
import { artifactEntryHandle, EntryReferencesChip } from './EntryReferencesChip';
import type { EntryReferenceMap, EntryReferenceSummary } from '../lib/entryReferences';
import { useModalAccessibilityFocus } from '../lib/accessibility';
import { font, space, useTheme, type Colors } from '../lib/theme';

type HubFileWithThumbnail = HubFile & { thumbnailUrl?: string };

export interface MediaLightboxProps {
  visible: boolean;
  files: HubFile[];
  initialIndex: number;
  fileContentUrl: (artifactId: string, atSeq?: number) => string;
  fileHeaders?: Record<string, string>;
  references?: EntryReferenceMap;
  onOpenReferences?: (summary: EntryReferenceSummary) => void;
  onClose: () => void;
  onOpenExternal: (file: HubFile) => Promise<void>;
  /** When provided, unlocks the parity affordances: version history,
   * text editing, and HTML/app preview. Omit for a plain read-only viewer. */
  api?: Api;
  /** Called after an edit / revert / restore lands, so the opener can refresh. */
  onFileChanged?: () => void;
}

const APP_EXTENSIONS = new Set(['html', 'htm', 'jsx', 'tsx']);
const PPTX_EXTENSIONS = new Set(['pptx', 'pptm', 'ppsx']);

function isAppFile(file: HubFile): boolean {
  const ext = extension(file);
  const mime = (file.mime ?? '').toLowerCase();
  return APP_EXTENSIONS.has(ext) || mime === 'text/html';
}

function isPptxFile(file: HubFile): boolean {
  const ext = extension(file);
  const mime = (file.mime ?? '').toLowerCase();
  return PPTX_EXTENSIONS.has(ext) || mime.includes('presentationml');
}

function isEditableText(file: HubFile): boolean {
  if (file.tombstoned) return false;
  if (isAppFile(file) || isPptxFile(file)) return false;
  return file.isText === true || TEXT_KINDS.has(normalizedKind(file));
}

const TEXT_KINDS = new Set(['code', 'text', 'data']);
const CODE_EXTENSIONS = new Set([
  'bash',
  'c',
  'css',
  'go',
  'html',
  'java',
  'js',
  'json',
  'jsx',
  'kt',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'swift',
  'toml',
  'ts',
  'tsx',
  'xml',
  'yaml',
  'yml',
]);

function extension(file: HubFile): string {
  const name = file.name || file.path;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function normalizedKind(file: HubFile): string {
  const ext = extension(file);
  const mime = file.mime?.toLowerCase() ?? '';
  if (file.mediaKind === 'image' || mime.startsWith('image/')) return 'image';
  if (file.mediaKind === 'video' || mime.startsWith('video/')) return 'video';
  if (file.mediaKind === 'audio' || mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime === 'text/markdown' || ext === 'md' || ext === 'markdown') return 'markdown';
  if (mime.includes('csv') || ext === 'csv' || ext === 'tsv') return 'csv';
  if (file.mediaKind === 'code' || CODE_EXTENSIONS.has(ext)) return 'code';
  if (file.isText || file.mediaKind === 'text' || mime.startsWith('text/')) return 'text';
  if (file.mediaKind && TEXT_KINDS.has(file.mediaKind)) return file.mediaKind;
  return 'opaque';
}

function languageFor(file: HubFile): string {
  const ext = extension(file);
  if (ext === 'js' || ext === 'jsx') return 'javascript';
  if (ext === 'ts' || ext === 'tsx') return 'typescript';
  if (ext === 'yml') return 'yaml';
  if (ext === 'md') return 'markdown';
  if (ext === 'sh') return 'bash';
  return ext || 'text';
}

function sourceFor(file: HubFile, fileContentUrl: (artifactId: string) => string, fileHeaders?: Record<string, string>) {
  return { uri: fileContentUrl(file.artifactId), headers: fileHeaders };
}

function syntaxTheme(colors: Colors) {
  return {
    hljs: { backgroundColor: colors.bg, color: colors.textSecondary },
    'hljs-comment': { color: colors.textMuted },
    'hljs-keyword': { color: '#ff7b72' },
    'hljs-literal': { color: '#79c0ff' },
    'hljs-number': { color: '#79c0ff' },
    'hljs-string': { color: '#a5d6ff' },
    'hljs-title': { color: '#d2a8ff' },
    'hljs-built_in': { color: '#7ee787' },
    'hljs-attribute': { color: '#f2cc60' },
  };
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted && ch === '"' && next === '"') {
      cell += '"';
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && ch === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((items) => items.some((item) => item.length > 0));
}

function useTextContent(
  file: HubFile,
  enabled: boolean,
  fileContentUrl: (artifactId: string) => string,
  fileHeaders?: Record<string, string>,
) {
  const [state, setState] = useState<{ loading: boolean; text: string; error: string | null }>({
    loading: false,
    text: '',
    error: null,
  });

  useEffect(() => {
    if (!enabled) {
      setState({ loading: false, text: '', error: null });
      return;
    }
    let cancelled = false;
    setState({ loading: true, text: '', error: null });
    fetch(fileContentUrl(file.artifactId), { headers: fileHeaders })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.statusText || 'Could not load file');
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setState({ loading: false, text, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ loading: false, text: '', error: err instanceof Error ? err.message : 'Could not load file' });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, file.artifactId, fileContentUrl, fileHeaders]);

  return state;
}

function LoadingText({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm }}>
      <ActivityIndicator color={colors.textMuted} />
      <Text style={{ color: colors.textMuted, fontSize: font.sm }}>{label}</Text>
    </View>
  );
}

function ImagePane({
  file,
  fileContentUrl,
  fileHeaders,
  onClose,
}: {
  file: HubFile;
  fileContentUrl: (artifactId: string) => string;
  fileHeaders?: Record<string, string>;
  onClose: () => void;
}) {
  const { height, width } = useWindowDimensions();
  const [zoomed, setZoomed] = useState(false);
  const lastTapRef = useRef(0);
  const ratio = file.width && file.height ? file.width / file.height : 1;
  const maxHeight = height - 170;
  let imageWidth = width;
  let imageHeight = imageWidth / ratio;
  if (imageHeight > maxHeight) {
    imageHeight = maxHeight;
    imageWidth = imageHeight * ratio;
  }
  const scale = zoomed ? 2 : 1;
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          !zoomed && Math.abs(gesture.dy) > 18 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dy > 90) onClose();
        },
      }),
    [onClose, zoomed],
  );
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ minHeight: maxHeight, alignItems: 'center', justifyContent: 'center' }}
      centerContent
      maximumZoomScale={Platform.OS === 'ios' ? 4 : 1}
      minimumZoomScale={1}
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      {...panResponder.panHandlers}
    >
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={file.name}
        accessibilityHint={zoomed ? 'Double tap to zoom out' : 'Double tap to zoom in'}
        onPress={() => {
          const now = Date.now();
          if (now - lastTapRef.current < 280) setZoomed((value) => !value);
          lastTapRef.current = now;
        }}
        style={{ width: imageWidth * scale, height: imageHeight * scale, alignItems: 'center', justifyContent: 'center' }}
      >
        <Image
          source={sourceFor(file, fileContentUrl, fileHeaders)}
          style={{ width: imageWidth, height: imageHeight, transform: [{ scale }] }}
          contentFit="contain"
          transition={120}
        />
      </Pressable>
    </ScrollView>
  );
}

function VideoPane({
  file,
  fileContentUrl,
  fileHeaders,
}: {
  file: HubFile;
  fileContentUrl: (artifactId: string) => string;
  fileHeaders?: Record<string, string>;
}) {
  const source = useMemo<VideoSource>(
    () => ({ uri: fileContentUrl(file.artifactId), headers: fileHeaders, contentType: 'auto' }),
    [file.artifactId, fileContentUrl, fileHeaders],
  );
  const player = useVideoPlayer(source, (instance) => {
    instance.staysActiveInBackground = false;
  });
  return (
    <View style={{ flex: 1, justifyContent: 'center' }}>
      <VideoView
        player={player}
        nativeControls
        contentFit="contain"
        fullscreenOptions={{ enable: true }}
        allowsPictureInPicture={false}
        style={{ width: '100%', aspectRatio: file.width && file.height ? file.width / file.height : 16 / 9 }}
      />
    </View>
  );
}

function AudioPane({
  file,
  fileContentUrl,
  fileHeaders,
}: {
  file: HubFile;
  fileContentUrl: (artifactId: string) => string;
  fileHeaders?: Record<string, string>;
}) {
  const { colors } = useTheme();
  const source = useMemo(
    () => ({ uri: fileContentUrl(file.artifactId), headers: fileHeaders, name: file.name }),
    [file.artifactId, file.name, fileContentUrl, fileHeaders],
  );
  const player = useAudioPlayer(source, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const progress = status.duration > 0 ? Math.min(1, status.currentTime / status.duration) : 0;
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: space.xl, gap: space.lg }}>
      <View style={{ alignItems: 'center', gap: space.md }}>
        <View
          style={{
            width: 84,
            height: 84,
            borderRadius: 42,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.bgElevated,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Ionicons name="musical-notes" size={34} color={colors.accent} />
        </View>
        <Text style={{ color: colors.text, fontSize: font.lg, fontWeight: '800', textAlign: 'center' }} numberOfLines={2}>
          {file.name}
        </Text>
      </View>
      <View style={{ gap: space.sm }}>
        <View style={{ height: 4, backgroundColor: colors.border, borderRadius: 2, overflow: 'hidden' }}>
          <View style={{ width: `${progress * 100}%`, height: 4, backgroundColor: colors.accent }} />
        </View>
        <Text style={{ color: colors.textMuted, fontSize: font.xs, textAlign: 'center' }}>
          {Math.floor(status.currentTime)}s{status.duration > 0 ? ` / ${Math.floor(status.duration)}s` : ''}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={status.playing ? 'Pause audio' : 'Play audio'}
        onPress={() => (status.playing ? player.pause() : player.play())}
        style={{
          alignSelf: 'center',
          width: 64,
          height: 64,
          borderRadius: 32,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.accent,
        }}
      >
        <Ionicons name={status.playing ? 'pause' : 'play'} size={30} color={colors.onAccent} />
      </Pressable>
    </View>
  );
}

function TextPane({
  file,
  kind,
  fileContentUrl,
  fileHeaders,
}: {
  file: HubFile;
  kind: string;
  fileContentUrl: (artifactId: string) => string;
  fileHeaders?: Record<string, string>;
}) {
  const { colors } = useTheme();
  const content = useTextContent(file, true, fileContentUrl, fileHeaders);
  if (content.loading) return <LoadingText label="Loading file..." />;
  if (content.error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl }}>
        <Text style={{ color: colors.danger, fontSize: font.sm }}>{content.error}</Text>
      </View>
    );
  }
  if (kind === 'markdown') {
    return (
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl }}>
        <SessionMarkdown text={content.text} />
      </ScrollView>
    );
  }
  if (kind === 'csv') {
    const delimiter = extension(file) === 'tsv' ? '\t' : ',';
    const rows = parseDelimited(content.text, delimiter).slice(0, 250);
    const columnCount = Math.max(1, ...rows.map((row) => row.length));
    return (
      <ScrollView horizontal style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: space.md, paddingBottom: space.xl }}>
          {rows.map((row, rowIndex) => (
            <View key={rowIndex} style={{ flexDirection: 'row' }}>
              {Array.from({ length: columnCount }).map((_, colIndex) => (
                <View
                  key={`${rowIndex}-${colIndex}`}
                  style={{
                    width: 132,
                    minHeight: 36,
                    borderWidth: 1,
                    borderColor: colors.border,
                    backgroundColor: rowIndex === 0 ? colors.bgElevated : colors.bg,
                    padding: space.sm,
                  }}
                >
                  <Text
                    style={{
                      color: rowIndex === 0 ? colors.text : colors.textSecondary,
                      fontSize: font.xs,
                      fontWeight: rowIndex === 0 ? '800' : '400',
                    }}
                    numberOfLines={3}
                  >
                    {row[colIndex] ?? ''}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      </ScrollView>
    );
  }
  if (kind === 'code') {
    return (
      <SyntaxHighlighter
        highlighter="hljs"
        language={languageFor(file)}
        style={syntaxTheme(colors)}
        fontFamily={Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })}
        fontSize={font.xs}
        PreTag={ScrollView}
        CodeTag={ScrollView}
      >
        {content.text}
      </SyntaxHighlighter>
    );
  }
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl }}>
      <Text style={{ color: colors.text, fontSize: font.sm, lineHeight: 20 }}>{content.text}</Text>
    </ScrollView>
  );
}

function PdfPane({
  file,
  fileContentUrl,
  fileHeaders,
}: {
  file: HubFile;
  fileContentUrl: (artifactId: string) => string;
  fileHeaders?: Record<string, string>;
}) {
  const { colors } = useTheme();
  return (
    <Pdf
      source={{ uri: fileContentUrl(file.artifactId), headers: fileHeaders, cache: true }}
      trustAllCerts={false}
      enablePaging
      horizontal
      style={{ flex: 1, backgroundColor: colors.bg }}
      renderActivityIndicator={() => <LoadingText label="Loading PDF..." />}
      onPressLink={(url) => {
        void Linking.openURL(url).catch(() => {});
      }}
    />
  );
}

function UnknownPane({ file, onOpenExternal }: { file: HubFile; onOpenExternal: (file: HubFile) => Promise<void> }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md }}>
      <Ionicons name="document-outline" size={44} color={colors.textMuted} />
      <Text style={{ color: colors.text, fontSize: font.lg, fontWeight: '800', textAlign: 'center' }} numberOfLines={2}>
        {file.name}
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: font.sm, textAlign: 'center' }}>
        {file.mime ?? file.mediaKind ?? 'Unknown file'}{file.sizeBytes != null ? `, ${formatBytes(file.sizeBytes)}` : ''}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open externally"
        accessibilityHint="Opens this file in your browser"
        onPress={() => {
          void onOpenExternal(file);
        }}
        style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.lg }}
      >
        <Text style={{ color: colors.accent, fontSize: font.md, fontWeight: '800' }}>Open externally</Text>
      </Pressable>
    </View>
  );
}

function InfoPanel({ file }: { file: HubFile }) {
  const { colors } = useTheme();
  const createdAtText = formatRelativeTimestamp(file.createdAt) || file.createdAt;
  const rows = [
    { label: 'Kind', value: normalizedKind(file) },
    { label: 'Size', value: file.sizeBytes != null ? formatBytes(file.sizeBytes) : 'Unknown' },
    { label: 'Origin', value: file.origin },
    { label: 'Uploader', value: file.uploader?.name ?? 'Unknown' },
    { label: 'Created', value: createdAtText, iso: file.createdAt },
    { label: 'Path', value: file.path },
  ];
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.bgElevated,
        padding: space.md,
        gap: space.xs,
      }}
    >
      {rows.map((row) => (
        <View key={row.label} style={{ flexDirection: 'row', gap: space.md }}>
          <Text style={{ width: 70, color: colors.textMuted, fontSize: font.xs, fontWeight: '700' }}>{row.label}</Text>
          {row.iso ? (
            <TimestampText
              iso={row.iso}
              text={row.value}
              style={{ flex: 1, color: colors.textSecondary, fontSize: font.xs }}
              numberOfLines={1}
            />
          ) : (
            <Text
              style={{ flex: 1, color: colors.textSecondary, fontSize: font.xs }}
              numberOfLines={row.label === 'Path' ? 2 : 1}
            >
              {row.value}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

function FilePane({
  file,
  fileContentUrl,
  fileHeaders,
  onClose,
  onOpenExternal,
  api,
}: {
  file: HubFile;
  fileContentUrl: (artifactId: string) => string;
  fileHeaders?: Record<string, string>;
  onClose: () => void;
  onOpenExternal: (file: HubFile) => Promise<void>;
  api?: Api;
}) {
  // Rich previews (need the API client for the embed-only preview fetch).
  if (api && isAppFile(file)) return <AppPreviewPane file={file} api={api} fileHeaders={fileHeaders} />;
  if (isPptxFile(file)) return <PptxPane file={file} fileContentUrl={fileContentUrl} fileHeaders={fileHeaders} />;
  const kind = normalizedKind(file);
  if (kind === 'image') return <ImagePane file={file} fileContentUrl={fileContentUrl} fileHeaders={fileHeaders} onClose={onClose} />;
  if (kind === 'video') return <VideoPane file={file} fileContentUrl={fileContentUrl} fileHeaders={fileHeaders} />;
  if (kind === 'audio') return <AudioPane file={file} fileContentUrl={fileContentUrl} fileHeaders={fileHeaders} />;
  if (kind === 'pdf') return <PdfPane file={file} fileContentUrl={fileContentUrl} fileHeaders={fileHeaders} />;
  if (kind === 'code' || kind === 'markdown' || kind === 'csv' || kind === 'text') {
    return <TextPane file={file} kind={kind} fileContentUrl={fileContentUrl} fileHeaders={fileHeaders} />;
  }
  return <UnknownPane file={file} onOpenExternal={onOpenExternal} />;
}

function ChromeButton({
  icon,
  label,
  hint,
  disabled,
  focusRef,
  onPress,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  label: string;
  hint?: string;
  disabled?: boolean;
  focusRef?: Ref<View>;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      ref={focusRef}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={{
        width: 42,
        height: 42,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.35 : 1,
      }}
    >
      <Ionicons name={icon} size={23} color={colors.text} />
    </Pressable>
  );
}

export function MediaLightbox({
  visible,
  files,
  initialIndex,
  fileContentUrl,
  fileHeaders,
  references,
  onOpenReferences,
  onClose,
  onOpenExternal,
  api,
  onFileChanged,
}: MediaLightboxProps) {
  const { colors, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const listRef = useRef<FlatList<HubFile>>(null);
  const closeButtonRef = useRef<View>(null);
  const [index, setIndex] = useState(initialIndex);
  const [infoOpen, setInfoOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const current = files[index];
  const currentReference = current ? (references?.[artifactEntryHandle(current.artifactId)] ?? null) : null;

  useModalAccessibilityFocus(closeButtonRef, visible && files.length > 0);

  useEffect(() => {
    if (!visible) return;
    setIndex(Math.max(0, Math.min(initialIndex, files.length - 1)));
    setInfoOpen(false);
    setEditing(false);
    setHistoryOpen(false);
    requestAnimationFrame(() => {
      listRef.current?.scrollToIndex({ index: Math.max(0, Math.min(initialIndex, files.length - 1)), animated: false });
    });
  }, [files.length, initialIndex, visible]);

  // Swiping to another file closes any per-file surface (editor/history).
  useEffect(() => {
    setEditing(false);
    setHistoryOpen(false);
  }, [index]);

  const handleFileChanged = useCallback(() => {
    setReloadKey((value) => value + 1);
    onFileChanged?.();
  }, [onFileChanged]);

  const jump = useCallback(
    (nextIndex: number) => {
      const clamped = Math.max(0, Math.min(nextIndex, files.length - 1));
      setIndex(clamped);
      listRef.current?.scrollToIndex({ index: clamped, animated: !reduceMotion });
    },
    [files.length, reduceMotion],
  );

  const handleMomentumEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setIndex(Math.round(event.nativeEvent.contentOffset.x / width));
  };

  if (!visible || files.length === 0 || !current) return null;

  return (
    <Modal visible transparent animationType={reduceMotion ? 'none' : 'fade'} onRequestClose={onClose}>
      <View accessibilityViewIsModal style={{ flex: 1, backgroundColor: colors.letterbox }}>
        <View
          style={{
            paddingTop: insets.top + 4,
            paddingHorizontal: space.sm,
            paddingBottom: space.xs,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
            backgroundColor: colors.bg,
            zIndex: 2,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
            <ChromeButton
              icon="close"
              label="Close lightbox"
              focusRef={closeButtonRef}
              onPress={onClose}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }} numberOfLines={1}>
                {current.name}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: font.xs }} numberOfLines={1}>
                {index + 1} of {files.length} · {normalizedKind(current)}
              </Text>
            </View>
            {currentReference && currentReference.count > 0 && onOpenReferences ? (
              <EntryReferencesChip count={currentReference.count} onPress={() => onOpenReferences(currentReference)} />
            ) : null}
            <ChromeButton icon="chevron-back" label="Previous file" disabled={index === 0} onPress={() => jump(index - 1)} />
            <ChromeButton icon="chevron-forward" label="Next file" disabled={index >= files.length - 1} onPress={() => jump(index + 1)} />
            <ChromeButton
              icon="share-outline"
              label="Share or open file"
              hint="Opens this file externally when possible, otherwise opens the share sheet"
              onPress={() => {
                void onOpenExternal(current).catch(() => {
                  void Share.share({ message: current.name }).catch(() => {});
                });
              }}
            />
            {api && isEditableText(current) ? (
              <ChromeButton
                icon={editing ? 'create' : 'create-outline'}
                label="Edit file"
                hint="Opens the file editor"
                onPress={() => setEditing(true)}
              />
            ) : null}
            {api ? (
              <ChromeButton
                icon="git-branch-outline"
                label="Version history"
                hint="Opens previous versions for this file"
                onPress={() => setHistoryOpen(true)}
              />
            ) : null}
            <ChromeButton
              icon={infoOpen ? 'information-circle' : 'information-circle-outline'}
              label={infoOpen ? 'Hide file info' : 'Show file info'}
              hint="Toggles file details"
              onPress={() => setInfoOpen((value) => !value)}
            />
          </View>
        </View>
        {editing && current && api ? (
          <View style={{ flex: 1, backgroundColor: colors.bg }}>
            <TextEditorPane
              file={current}
              api={api}
              fileContentUrl={fileContentUrl}
              fileHeaders={fileHeaders}
              onClose={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                handleFileChanged();
              }}
            />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={files}
            keyExtractor={(item) => item.artifactId}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={Math.max(0, Math.min(initialIndex, files.length - 1))}
            getItemLayout={(_, itemIndex) => ({ index: itemIndex, length: width, offset: width * itemIndex })}
            onMomentumScrollEnd={handleMomentumEnd}
            onScrollToIndexFailed={({ index: failedIndex }) => {
              setTimeout(() => jump(failedIndex), 50);
            }}
            renderItem={({ item }) => (
              <View style={{ width, flex: 1, backgroundColor: colors.bg }}>
                <FilePane
                  // Remount the current pane after an in-place edit so it refetches.
                  key={item.artifactId === current?.artifactId ? `cur-${reloadKey}` : item.artifactId}
                  file={item}
                  fileContentUrl={fileContentUrl}
                  fileHeaders={fileHeaders}
                  onClose={onClose}
                  onOpenExternal={onOpenExternal}
                  api={api}
                />
              </View>
            )}
          />
        )}
        {infoOpen ? <InfoPanel file={current} /> : null}
        {historyOpen && current && api ? (
          <VersionHistoryPanel
            file={current}
            api={api}
            fileContentUrl={fileContentUrl}
            fileHeaders={fileHeaders}
            canManage
            onClose={() => setHistoryOpen(false)}
            onChanged={handleFileChanged}
          />
        ) : null}
      </View>
    </Modal>
  );
}

export function thumbnailSource(
  file: HubFile,
  fileContentUrl: (artifactId: string) => string,
  fileHeaders?: Record<string, string>,
) {
  const thumb = (file as HubFileWithThumbnail).thumbnailUrl;
  if (thumb) return { uri: thumb, headers: fileHeaders };
  if (normalizedKind(file) === 'image') return sourceFor(file, fileContentUrl, fileHeaders);
  return null;
}

export function mediaIconName(file: HubFile): ComponentProps<typeof Ionicons>['name'] {
  const kind = normalizedKind(file);
  if (kind === 'video') return 'videocam-outline';
  if (kind === 'audio') return 'musical-notes-outline';
  if (kind === 'pdf') return 'document-text-outline';
  if (kind === 'code') return 'code-slash-outline';
  if (kind === 'markdown' || kind === 'text') return 'reader-outline';
  if (kind === 'csv') return 'grid-outline';
  return 'document-outline';
}

export function mediaKindLabel(file: HubFile): string {
  return normalizedKind(file);
}
