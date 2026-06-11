// Message composer: multiline input, image/file attachments (uploaded on
// pick, presigned PUT), optimistic send, and an inline edit mode.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Image } from 'expo-image';
import type { AttachmentMeta } from '@atrium/surface-client';
import { colors, font, radius, space } from '../lib/theme';
import { createDraftChangeDebouncer } from '../lib/outbox';
import { lightImpactHaptic } from '../lib/haptics';

interface PendingAttachment {
  key: string;
  previewUri: string | null;
  meta: AttachmentMeta | null; // null while uploading
  failed: boolean;
}

export interface ComposerProps {
  placeholder: string;
  onSend: (text: string, attachments: AttachmentMeta[]) => void;
  onTyping: () => void;
  /** Non-null puts the composer into edit mode for that message text. */
  editingText?: string | null;
  onSubmitEdit?: (text: string) => void;
  onCancelEdit?: () => void;
  draftKey?: string;
  initialDraft?: string;
  onDraftChange?: (key: string, text: string) => void;
  allowAttachments?: boolean;
  uploadFile?: (file: {
    uri: string;
    name: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
  }) => Promise<AttachmentMeta>;
}

export function Composer({
  placeholder,
  onSend,
  onTyping,
  editingText,
  onSubmitEdit,
  onCancelEdit,
  draftKey,
  initialDraft,
  onDraftChange,
  allowAttachments,
  uploadFile,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const inputRef = useRef<TextInput>(null);
  const editing = editingText != null;
  const draftWriter = useMemo(
    () => createDraftChangeDebouncer((key, value) => onDraftChange?.(key, value)),
    [onDraftChange],
  );

  useEffect(() => () => draftWriter.cancel(), [draftWriter]);

  // Reset on conversation switch; apply the async-loaded draft only into an
  // untouched input — never clobber text the user already started typing.
  useEffect(() => {
    if (!editing) setText('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);
  useEffect(() => {
    if (editing || !initialDraft) return;
    setText((prev) => (prev === '' ? initialDraft : prev));
  }, [editing, initialDraft]);

  useEffect(() => {
    if (editingText != null) {
      setText(editingText);
      inputRef.current?.focus();
    }
  }, [editingText]);

  const startUpload = async (file: {
    uri: string;
    name: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
  }) => {
    if (!uploadFile) return;
    const key = `${Date.now()}-${file.name}-${Math.random()}`;
    const isImage = file.mimeType.startsWith('image/');
    setAttachments((prev) => [
      ...prev,
      { key, previewUri: isImage ? file.uri : null, meta: null, failed: false },
    ]);
    try {
      const meta = await uploadFile(file);
      setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, meta } : a)));
    } catch {
      setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, failed: true } : a)));
    }
  };

  const pickImages = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 5,
      quality: 0.8,
    });
    if (res.canceled) return;
    for (const asset of res.assets) {
      void startUpload({
        uri: asset.uri,
        name: asset.fileName ?? 'photo.jpg',
        mimeType: asset.mimeType ?? 'image/jpeg',
        size: asset.fileSize ?? 0,
        width: asset.width,
        height: asset.height,
      });
    }
  };

  const pickDocument = async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled) return;
    for (const asset of res.assets) {
      void startUpload({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType ?? 'application/octet-stream',
        size: asset.size ?? 0,
      });
    }
  };

  const pickAttachment = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Photo library', 'File', 'Cancel'], cancelButtonIndex: 2 },
        (i) => {
          if (i === 0) void pickImages();
          if (i === 1) void pickDocument();
        },
      );
    } else {
      Alert.alert('Attach', undefined, [
        { text: 'Photo library', onPress: () => void pickImages() },
        { text: 'File', onPress: () => void pickDocument() },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  const uploading = attachments.some((a) => !a.meta && !a.failed);
  const ready = attachments.filter((a) => a.meta != null).map((a) => a.meta!);
  const canSend = !uploading && (text.trim().length > 0 || ready.length > 0);

  const submit = () => {
    const trimmed = text.trim();
    if (editing) {
      if (!trimmed) return;
      onSubmitEdit?.(trimmed);
      setText('');
      return;
    }
    if (!canSend) return;
    lightImpactHaptic();
    onSend(trimmed, ready);
    if (draftKey) draftWriter.saveNow(draftKey, '');
    setText('');
    setAttachments([]);
  };

  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.bg,
        paddingHorizontal: space.md,
        paddingTop: space.sm,
        paddingBottom: space.sm,
        gap: space.sm,
      }}
    >
      {editing && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '700' }}>
            Editing message
          </Text>
          <Pressable
            onPress={() => {
              setText('');
              onCancelEdit?.();
            }}
          >
            <Text style={{ color: colors.textMuted, fontSize: font.xs }}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {attachments.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {attachments.map((a) => (
            <View key={a.key} style={{ position: 'relative' }}>
              {a.previewUri ? (
                <Image
                  source={{ uri: a.previewUri }}
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: radius.sm,
                    opacity: a.meta ? 1 : 0.5,
                  }}
                  contentFit="cover"
                />
              ) : (
                <View
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: radius.sm,
                    backgroundColor: colors.bgElevated,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 18 }}>{a.failed ? '⚠️' : '📎'}</Text>
                </View>
              )}
              {!a.meta && !a.failed && (
                <ActivityIndicator
                  size="small"
                  color={colors.text}
                  style={{ position: 'absolute', top: 18, left: 18 }}
                />
              )}
              <Pressable
                onPress={() => setAttachments((prev) => prev.filter((x) => x.key !== a.key))}
                hitSlop={8}
                style={{
                  position: 'absolute',
                  top: -6,
                  right: -6,
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  backgroundColor: colors.bgPressed,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: colors.text, fontSize: 10, fontWeight: '800' }}>✕</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
        {allowAttachments && !editing && (
          <Pressable
            onPress={pickAttachment}
            hitSlop={8}
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              backgroundColor: colors.bgElevated,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 2,
            }}
          >
            <Text style={{ color: colors.textSecondary, fontSize: 20, lineHeight: 22 }}>+</Text>
          </Pressable>
        )}
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={(v) => {
            setText(v);
            if (!editing && draftKey) draftWriter.schedule(draftKey, v);
            if (v.trim()) onTyping();
          }}
          placeholder={placeholder}
          placeholderTextColor={colors.textFaint}
          multiline
          style={{
            flex: 1,
            minHeight: 38,
            maxHeight: 120,
            backgroundColor: colors.bgInput,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
            color: colors.text,
            fontSize: font.md,
            paddingHorizontal: space.md,
            paddingTop: 9,
            paddingBottom: 9,
          }}
        />
        <Pressable
          onPress={submit}
          disabled={editing ? text.trim().length === 0 : !canSend}
          hitSlop={8}
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            backgroundColor: (editing ? text.trim().length > 0 : canSend)
              ? colors.accent
              : colors.bgElevated,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 2,
          }}
        >
          <Text style={{ color: colors.bg, fontSize: 16, fontWeight: '800' }}>
            {editing ? '✓' : '↑'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
