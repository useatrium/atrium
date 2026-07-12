import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  formatBytes,
  formatRelativeTimestamp,
  lineDiffOps,
  type Api,
  type HubFile,
  type HubFileVersion,
} from '@atrium/surface-client';
import { useAccessibilityAnnouncement, useModalAccessibilityFocus } from '../lib/accessibility';
import { font, radius, space, useTheme } from '../lib/theme';
import { TimestampText } from './TimestampText';

function authorLabel(author: string): string {
  const stripped = author
    .replace(/^human:/i, '')
    .replace(/^agent:/i, '')
    .trim();
  return stripped || author || 'Unknown';
}

function bytesLabel(value: number | null | undefined): string {
  return value == null ? 'Unknown size' : formatBytes(value);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function VersionBadge({ version }: { version: HubFileVersion }) {
  const { colors } = useTheme();
  const text = version.isLatest ? 'latest' : version.kind;
  const conflict = version.status === 'conflict';
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: conflict ? colors.dangerBorder : version.isLatest ? colors.accent : colors.border,
        borderRadius: radius.sm,
        backgroundColor: conflict ? colors.dangerSurface : version.isLatest ? colors.accentBg : colors.bgPressed,
        paddingHorizontal: space.sm,
        paddingVertical: 2,
      }}
    >
      <Text
        style={{
          color: conflict ? colors.danger : version.isLatest ? colors.accent : colors.textSecondary,
          fontSize: font.xs,
          fontWeight: '800',
          textTransform: 'uppercase',
        }}
      >
        {conflict ? 'conflict' : text}
      </Text>
    </View>
  );
}

function InlineNotice({ tone, message }: { tone: 'success' | 'error'; message: string }) {
  const { colors } = useTheme();
  const isError = tone === 'error';
  return (
    <Text
      accessibilityRole={isError ? 'alert' : 'text'}
      accessibilityLiveRegion="polite"
      style={{
        color: isError ? colors.danger : colors.online,
        fontSize: font.xs,
        borderWidth: 1,
        borderColor: isError ? colors.dangerBorder : colors.online,
        backgroundColor: isError ? colors.dangerSurface : colors.accentBg,
        borderRadius: radius.sm,
        paddingHorizontal: space.sm,
        paddingVertical: space.sm,
      }}
    >
      {message}
    </Text>
  );
}

function DiffViewer({
  file,
  selectedVersion,
  latestVersion,
  fileContentUrl,
  fileHeaders,
}: {
  file: HubFile;
  selectedVersion: HubFileVersion | null;
  latestVersion: HubFileVersion | null;
  fileContentUrl: (artifactId: string, atSeq?: number) => string;
  fileHeaders?: Record<string, string>;
}) {
  const { colors } = useTheme();
  const mountedRef = useRef(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<ReturnType<typeof lineDiffOps>>([]);

  useAccessibilityAnnouncement(error);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedVersion || !latestVersion || !file.isText) {
      setLoading(false);
      setError(null);
      setLines([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLines([]);
    Promise.all([
      fetch(fileContentUrl(file.artifactId, selectedVersion.seq), { headers: fileHeaders }),
      fetch(fileContentUrl(file.artifactId), { headers: fileHeaders }),
    ])
      .then(async ([selectedResponse, latestResponse]) => {
        if (!selectedResponse.ok) throw new Error('Could not load selected version.');
        if (!latestResponse.ok) throw new Error('Could not load latest version.');
        return Promise.all([selectedResponse.text(), latestResponse.text()]);
      })
      .then(([selectedText, latestText]) => {
        if (!cancelled && mountedRef.current) setLines(lineDiffOps(selectedText, latestText));
      })
      .catch((err: unknown) => {
        if (!cancelled && mountedRef.current) setError(errorMessage(err, 'Could not load version diff.'));
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file.artifactId, file.isText, fileContentUrl, fileHeaders, latestVersion, selectedVersion]);

  if (!selectedVersion || !latestVersion) {
    return (
      <Text style={{ color: colors.textMuted, fontSize: font.sm, paddingVertical: space.md }}>
        Choose a version to compare with latest.
      </Text>
    );
  }

  if (!file.isText) {
    return (
      <View
        style={{
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius.md,
          backgroundColor: colors.bg,
          padding: space.md,
        }}
      >
        <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '700' }}>
          Changed: {bytesLabel(selectedVersion.sizeBytes)} {'->'} {bytesLabel(latestVersion.sizeBytes)}
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: font.xs, marginTop: space.xs }}>
          Text diff is available for text files only.
        </Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.lg }}>
        <ActivityIndicator color={colors.textMuted} />
        <Text style={{ color: colors.textMuted, fontSize: font.sm }}>Loading diff...</Text>
      </View>
    );
  }

  if (error) return <InlineNotice tone="error" message={error} />;

  return (
    <ScrollView horizontal style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md }}>
      <View style={{ minWidth: '100%', backgroundColor: colors.bg }}>
        {lines.length === 0 ? (
          <Text style={{ color: colors.textMuted, fontSize: font.sm, padding: space.md }}>No text changes.</Text>
        ) : (
          lines.slice(0, 600).map((line, index) => {
            const added = line.kind === 'add';
            const removed = line.kind === 'remove';
            return (
              <View
                key={`${index}-${line.kind}`}
                style={{
                  flexDirection: 'row',
                  backgroundColor: added ? 'rgba(52, 211, 153, 0.14)' : removed ? colors.dangerSurface : colors.bg,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.borderSoft,
                }}
              >
                <Text
                  style={{
                    width: 28,
                    color: added ? colors.online : removed ? colors.danger : colors.textFaint,
                    fontSize: font.xs,
                    paddingVertical: space.xs,
                    textAlign: 'center',
                  }}
                >
                  {added ? '+' : removed ? '-' : ' '}
                </Text>
                <Text
                  style={{
                    flexShrink: 0,
                    color: added ? colors.online : removed ? colors.danger : colors.textSecondary,
                    fontFamily: 'Menlo',
                    fontSize: font.xs,
                    lineHeight: 18,
                    paddingVertical: space.xs,
                    paddingRight: space.md,
                  }}
                >
                  {line.text || ' '}
                </Text>
              </View>
            );
          })
        )}
        {lines.length > 600 ? (
          <Text style={{ color: colors.textMuted, fontSize: font.xs, padding: space.md }}>
            Showing first 600 diff lines.
          </Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

function VersionRow({
  version,
  selected,
  canManage,
  fileTombstoned,
  busySeq,
  onCompare,
  onRevert,
}: {
  version: HubFileVersion;
  selected: boolean;
  canManage: boolean;
  fileTombstoned: boolean;
  busySeq: number | null;
  onCompare: (version: HubFileVersion) => void;
  onRevert: (version: HubFileVersion) => void;
}) {
  const { colors } = useTheme();
  const revertable =
    canManage && !fileTombstoned && !version.isLatest && version.kind !== 'deleted' && version.status === 'normal';
  const createdAtText = formatRelativeTimestamp(version.createdAt) || version.createdAt;

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: selected ? colors.accent : colors.border,
        borderRadius: radius.md,
        backgroundColor: selected ? colors.accentBg : colors.bg,
        padding: space.md,
        gap: space.sm,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }}>v{version.seq}</Text>
            <VersionBadge version={version} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.xs, minWidth: 0 }}>
            <Text style={{ flexShrink: 1, color: colors.textMuted, fontSize: font.xs }} numberOfLines={1}>
              {authorLabel(version.author)} /{' '}
            </Text>
            <TimestampText
              iso={version.createdAt}
              text={createdAtText}
              style={{ flexShrink: 1, color: colors.textMuted, fontSize: font.xs }}
              numberOfLines={1}
            />
          </View>
          <Text style={{ color: colors.textFaint, fontSize: font.xs, marginTop: 2 }} numberOfLines={1}>
            {bytesLabel(version.sizeBytes)} / {version.mime ?? 'unknown mime'}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {!version.isLatest ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Compare version ${version.seq} to latest`}
            accessibilityHint="Shows a diff against the latest version"
            onPress={() => onCompare(version)}
            style={({ pressed }) => ({
              minHeight: 36,
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radius.sm,
              backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
              paddingHorizontal: space.md,
            })}
          >
            <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '800' }}>Compare</Text>
          </Pressable>
        ) : null}
        {revertable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Restore version ${version.seq}`}
            accessibilityHint="Restores this version as the current file"
            disabled={busySeq === version.seq}
            onPress={() => onRevert(version)}
            style={({ pressed }) => ({
              minHeight: 36,
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: colors.accent,
              borderRadius: radius.sm,
              backgroundColor: pressed ? colors.accentBg : colors.bgElevated,
              opacity: busySeq === version.seq ? 0.6 : 1,
              paddingHorizontal: space.md,
            })}
          >
            <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '800' }}>
              {busySeq === version.seq ? 'Restoring...' : 'Restore this version'}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function VersionHistoryPanel(props: {
  file: HubFile;
  api: Api;
  fileContentUrl: (artifactId: string, atSeq?: number) => string;
  fileHeaders?: Record<string, string>;
  canManage?: boolean;
  onClose: () => void;
  onChanged?: () => void;
}): JSX.Element {
  const { file, api, fileContentUrl, fileHeaders, canManage = false, onClose, onChanged } = props;
  const { colors, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const mountedRef = useRef(true);
  const titleRef = useRef<Text>(null);
  const [versions, setVersions] = useState<HubFileVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busySeq, setBusySeq] = useState<number | null>(null);
  const [restoringFile, setRestoringFile] = useState(false);
  const [compareSeq, setCompareSeq] = useState<number | null>(null);

  const latestVersion = useMemo(() => versions.find((version) => version.isLatest) ?? versions[0] ?? null, [versions]);
  const selectedVersion = useMemo(
    () => versions.find((version) => version.seq === compareSeq) ?? null,
    [compareSeq, versions],
  );

  useModalAccessibilityFocus(titleRef, true);
  useAccessibilityAnnouncement(notice ?? error);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadVersions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { versions: nextVersions } = await api.listFileVersions(file.artifactId);
      if (!mountedRef.current) return;
      setVersions(nextVersions);
      setCompareSeq((current) => {
        if (current != null && nextVersions.some((version) => version.seq === current && !version.isLatest)) {
          return current;
        }
        return nextVersions.find((version) => !version.isLatest)?.seq ?? null;
      });
    } catch (err: unknown) {
      if (mountedRef.current) setError(errorMessage(err, 'Could not load version history.'));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [api, file.artifactId]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  const revertVersion = useCallback(
    async (version: HubFileVersion) => {
      if (busySeq != null || restoringFile) return;
      setBusySeq(version.seq);
      setError(null);
      setNotice(null);
      try {
        await api.revertFileVersion(file.artifactId, version.seq);
        if (!mountedRef.current) return;
        setNotice(`Restored v${version.seq}.`);
        await loadVersions();
        onChanged?.();
      } catch (err: unknown) {
        if (mountedRef.current) setError(errorMessage(err, 'Could not restore this version.'));
      } finally {
        if (mountedRef.current) setBusySeq(null);
      }
    },
    [api, busySeq, file.artifactId, loadVersions, onChanged, restoringFile],
  );

  const restoreFile = useCallback(async () => {
    if (restoringFile || busySeq != null) return;
    setRestoringFile(true);
    setError(null);
    setNotice(null);
    try {
      await api.restoreFile(file.artifactId);
      if (!mountedRef.current) return;
      setNotice('File restored.');
      await loadVersions();
      onChanged?.();
    } catch (err: unknown) {
      if (mountedRef.current) setError(errorMessage(err, 'Could not restore file.'));
    } finally {
      if (mountedRef.current) setRestoringFile(false);
    }
  }, [api, busySeq, file.artifactId, loadVersions, onChanged, restoringFile]);

  return (
    <Modal visible transparent animationType={reduceMotion ? 'none' : 'fade'} onRequestClose={onClose}>
      <Pressable
        accessible={false}
        importantForAccessibility="no"
        onPress={onClose}
        style={{ flex: 1, backgroundColor: colors.scrim, justifyContent: 'flex-end' }}
      >
        <Pressable
          accessible={false}
          accessibilityViewIsModal
          onPress={() => {}}
          style={{
            maxHeight: '88%',
            backgroundColor: colors.bgElevated,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            paddingBottom: insets.bottom + space.sm,
          }}
        >
          <View
            style={{
              minHeight: 56,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: space.md,
              paddingHorizontal: space.lg,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                ref={titleRef}
                accessibilityRole="header"
                style={{ color: colors.text, fontSize: font.md, fontWeight: '800' }}
              >
                Version history
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: font.xs, marginTop: 2 }} numberOfLines={1}>
                {file.name}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close version history"
              onPress={onClose}
              hitSlop={8}
              style={{
                width: 44,
                height: 44,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>

          <View style={{ padding: space.lg, gap: space.md }}>
            {file.tombstoned && canManage ? (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: colors.dangerBorder,
                  borderRadius: radius.md,
                  backgroundColor: colors.dangerSurface,
                  padding: space.md,
                  gap: space.sm,
                }}
              >
                <Text style={{ color: colors.danger, fontSize: font.sm, fontWeight: '800' }}>
                  This file is deleted.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Restore file"
                  accessibilityHint="Restores this deleted file"
                  disabled={restoringFile}
                  onPress={() => {
                    void restoreFile();
                  }}
                  style={({ pressed }) => ({
                    alignSelf: 'flex-start',
                    minHeight: 38,
                    justifyContent: 'center',
                    borderRadius: radius.sm,
                    backgroundColor: pressed ? colors.accentBg : colors.accent,
                    opacity: restoringFile ? 0.65 : 1,
                    paddingHorizontal: space.md,
                  })}
                >
                  <Text style={{ color: colors.onAccent, fontSize: font.sm, fontWeight: '800' }}>
                    {restoringFile ? 'Restoring...' : 'Restore file'}
                  </Text>
                </Pressable>
              </View>
            ) : null}
            {notice ? <InlineNotice tone="success" message={notice} /> : null}
            {error ? <InlineNotice tone="error" message={error} /> : null}
          </View>

          <FlatList
            data={versions}
            keyExtractor={(item) => String(item.seq)}
            style={{ maxHeight: 310 }}
            contentContainerStyle={{
              gap: space.sm,
              paddingHorizontal: space.lg,
              paddingBottom: space.lg,
            }}
            ListEmptyComponent={
              <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.xl }}>
                {loading ? (
                  <>
                    <ActivityIndicator color={colors.textMuted} />
                    <Text style={{ color: colors.textMuted, fontSize: font.sm }}>Loading versions...</Text>
                  </>
                ) : (
                  <Text style={{ color: colors.textMuted, fontSize: font.sm }}>No versions found.</Text>
                )}
              </View>
            }
            renderItem={({ item }) => (
              <VersionRow
                version={item}
                selected={compareSeq === item.seq}
                canManage={canManage}
                fileTombstoned={file.tombstoned}
                busySeq={busySeq}
                onCompare={(version) => setCompareSeq(version.seq)}
                onRevert={(version) => {
                  void revertVersion(version);
                }}
              />
            )}
          />

          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: colors.border,
              paddingHorizontal: space.lg,
              paddingTop: space.md,
              gap: space.sm,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Text style={{ flex: 1, color: colors.text, fontSize: font.sm, fontWeight: '800' }}>Diff</Text>
              {selectedVersion && latestVersion ? (
                <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
                  v{selectedVersion.seq} {'->'} v{latestVersion.seq}
                </Text>
              ) : null}
            </View>
            <ScrollView style={{ maxHeight: 230 }} contentContainerStyle={{ paddingBottom: space.lg }}>
              <DiffViewer
                file={file}
                selectedVersion={selectedVersion}
                latestVersion={latestVersion}
                fileContentUrl={fileContentUrl}
                fileHeaders={fileHeaders}
              />
            </ScrollView>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
