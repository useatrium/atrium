import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  ApiError,
  type Api,
  type HubFile,
  type HubFileConflict,
  type HubFileResolveChoice,
  type HubFileSaveResult,
} from '@atrium/surface-client';
import { ConflictSurface } from './ConflictSurface';
import { font, space, useTheme } from '../lib/theme';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; text: string; baseSeq: number };

export function TextEditorPane(props: {
  file: HubFile;
  api: Api;
  fileContentUrl: (artifactId: string) => string;
  fileHeaders?: Record<string, string>;
  onClose: () => void;
  onSaved?: (result: HubFileSaveResult) => void;
}): JSX.Element {
  const { file, api, fileContentUrl, fileHeaders, onClose, onSaved } = props;
  const { colors } = useTheme();
  const mountedRef = useRef(true);
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<HubFileConflict | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoadState({ status: 'loading' });
    setError(null);
    setConflict(null);

    async function load() {
      try {
        const [res, versionResult] = await Promise.all([
          fetch(fileContentUrl(file.artifactId), { headers: fileHeaders, signal: controller.signal }),
          api.listFileVersions(file.artifactId),
        ]);
        if (!res.ok) throw new Error(res.statusText || `Could not load file (${res.status})`);
        const text = await res.text();
        const baseSeq = versionResult.versions.find((version) => version.isLatest)?.seq ?? versionResult.versions[0]?.seq;
        if (baseSeq == null) throw new Error('Could not find a base version for this file.');
        if (!cancelled && mountedRef.current) {
          setDraft(text);
          setLoadState({ status: 'ready', text, baseSeq });
        }
      } catch (err: unknown) {
        if (cancelled || !mountedRef.current) return;
        if (isAbortError(err)) return;
        setLoadState({ status: 'error', message: messageForError(err, 'Could not load file.') });
      }
    }

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, file.artifactId, fileContentUrl, fileHeaders, retryKey]);

  const closeAfterInlineError = useCallback(
    (message: string) => {
      if (!mountedRef.current) return;
      setError(message);
      onClose();
    },
    [onClose],
  );

  const handleApiFailure = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError) {
        if (err.status === 403) {
          setError("You don't have permission to edit this file.");
          return;
        }
        if (err.status === 409) {
          closeAfterInlineError('File changed on the server - reopen and retry.');
          return;
        }
        if (err.status === 415) {
          setError(err.message || 'This file type cannot be edited as text.');
          return;
        }
      }
      setError(messageForError(err, 'Could not save file.'));
    },
    [closeAfterInlineError],
  );

  const runSave = useCallback(
    async (operation: () => Promise<HubFileSaveResult>) => {
      if (saving) return;
      setSaving(true);
      setError(null);
      try {
        const result = await operation();
        if (!mountedRef.current) return;
        if (result.status === 'normal') {
          onSaved?.(result);
          onClose();
          return;
        }
        const nextConflict = await api.loadFileConflict(file.artifactId);
        if (mountedRef.current) setConflict(nextConflict);
      } catch (err: unknown) {
        if (mountedRef.current) handleApiFailure(err);
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [api, file.artifactId, handleApiFailure, onClose, onSaved, saving],
  );

  const save = useCallback(async () => {
    if (loadState.status !== 'ready') return;
    await runSave(() =>
      api.saveTextFile(file.artifactId, draft, loadState.baseSeq, file.mime ?? 'text/plain'),
    );
  }, [api, draft, file.artifactId, file.mime, loadState, runSave]);

  const resolveConflict = useCallback(
    async (choice: HubFileResolveChoice) => {
      if (!conflict) return;
      await runSave(() =>
        api.resolveFileConflict(file.artifactId, conflict, choice, file.mime ?? 'text/plain'),
      );
    },
    [api, conflict, file.artifactId, file.mime, runSave],
  );

  if (conflict) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {error ? <InlineError message={error} /> : null}
        <ConflictSurface conflict={conflict} onResolve={resolveConflict} onCancel={() => setConflict(null)} busy={saving} />
      </View>
    );
  }

  if (loadState.status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.sm, backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.textMuted} />
        <Text style={{ color: colors.textMuted, fontSize: font.sm }}>Loading editor...</Text>
      </View>
    );
  }

  if (loadState.status === 'error') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md, backgroundColor: colors.bg }}>
        <Text style={{ color: colors.danger, fontSize: font.sm, textAlign: 'center' }}>{loadState.message}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry loading file"
          onPress={() => setRetryKey((key) => key + 1)}
          style={{
            minHeight: 44,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: space.sm,
            paddingHorizontal: space.lg,
            backgroundColor: colors.bgElevated,
          }}
        >
          <Ionicons name="refresh-outline" size={18} color={colors.textSecondary} />
          <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          backgroundColor: colors.bgElevated,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }} numberOfLines={1}>
            {file.name}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: font.xs }} numberOfLines={1}>
            Editing from v{loadState.baseSeq}
          </Text>
        </View>
        <HeaderButton label="Cancel" icon="close" disabled={saving} onPress={onClose} />
        <HeaderButton label="Save" icon="save-outline" disabled={saving} onPress={() => void save()} emphasized />
      </View>

      {error ? <InlineError message={error} /> : null}

      <TextInput
        accessibilityLabel="Text file editor"
        editable={!saving}
        multiline
        value={draft}
        onChangeText={setDraft}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        textAlignVertical="top"
        style={{
          flex: 1,
          color: colors.text,
          backgroundColor: colors.bg,
          fontFamily: monoFont(),
          fontSize: font.xs,
          lineHeight: 18,
          padding: space.md,
          opacity: saving ? 0.65 : 1,
        }}
      />
    </View>
  );

  function HeaderButton({
    label,
    icon,
    disabled,
    emphasized,
    onPress,
  }: {
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
    disabled?: boolean;
    emphasized?: boolean;
    onPress: () => void;
  }) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        style={{
          minHeight: 36,
          borderRadius: 8,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: space.xs,
          paddingHorizontal: space.md,
          backgroundColor: emphasized ? colors.accent : 'transparent',
          opacity: disabled ? 0.55 : 1,
        }}
      >
        <Ionicons name={icon} size={16} color={emphasized ? colors.onAccent : colors.textSecondary} />
        <Text style={{ color: emphasized ? colors.onAccent : colors.textSecondary, fontSize: font.sm, fontWeight: '800' }}>
          {label}
        </Text>
      </Pressable>
    );
  }

  function InlineError({ message }: { message: string }) {
    return (
      <View
        style={{
          borderBottomWidth: 1,
          borderBottomColor: colors.dangerBorder,
          backgroundColor: colors.dangerSurface,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
        }}
      >
        <Text style={{ color: colors.danger, fontSize: font.sm }}>{message}</Text>
      </View>
    );
  }
}

function messageForError(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function monoFont() {
  return Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
}
