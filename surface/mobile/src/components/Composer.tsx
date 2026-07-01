// Message composer: multiline input, image/file attachments (uploaded on
// pick, presigned PUT), optimistic send, and an inline edit mode.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Keyboard,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Image } from 'expo-image';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  matchMentionPrefix,
  type AttachmentMeta,
  type AttachmentRef,
  type UserRef,
} from '@atrium/surface-client';
import { font, radius, space, useTheme } from '../lib/theme';
import { createDraftChangeDebouncer } from '../lib/outbox';
import { Avatar } from './Avatar';
import { lightImpactHaptic } from '../lib/haptics';
import {
  downsamplePeaks,
  formatVoiceDuration,
  normalizeMetering,
  type VoiceSendMeta,
} from '../lib/voice';

interface PendingAttachment {
  key: string;
  previewUri: string | null;
  meta: (AttachmentMeta & { uploadKey: string; localUri: string }) | null; // null while uploading
  failed: boolean;
}

export interface ComposerProps {
  placeholder: string;
  onSend: (
    text: string,
    attachments: AttachmentMeta[],
    attachmentRefs?: AttachmentRef[],
    voice?: VoiceSendMeta,
  ) => void;
  onTyping: () => void;
  /** Non-null puts the composer into edit mode for that message text. */
  editingText?: string | null;
  onSubmitEdit?: (text: string) => void;
  onCancelEdit?: () => void;
  draftKey?: string;
  initialDraft?: string;
  onDraftChange?: (key: string, text: string) => void | Promise<void>;
  onDraftPersisted?: (key: string, text: string) => void | Promise<void>;
  onDraftTouched?: (key: string) => void;
  mentionUsers?: UserRef[] | null;
  onMentionTrigger?: () => void;
  allowAttachments?: boolean;
  uploadFile?: (file: {
    uri: string;
    name: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
  }) => Promise<AttachmentMeta & { uploadKey: string; localUri: string }>;
}

const VOICE_RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

type PickedAttachment = {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
};

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
  onDraftPersisted,
  onDraftTouched,
  mentionUsers,
  onMentionTrigger,
  allowAttachments,
  uploadFile,
}: ComposerProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const audioRecorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(audioRecorder, 125);
  const inputRef = useRef<TextInput>(null);
  const meterSamplesRef = useRef<number[]>([]);
  const editing = editingText != null;
  const draftWriter = useMemo(
    () =>
      createDraftChangeDebouncer(
        (key, value) => onDraftChange?.(key, value),
        400,
        (key, value) => onDraftPersisted?.(key, value),
      ),
    [onDraftChange, onDraftPersisted],
  );

  useEffect(() => () => draftWriter.cancel(), [draftWriter]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

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

  const startUpload = async (file: PickedAttachment) => {
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

  const addPickedAttachments = (picked: PickedAttachment[]) => {
    const remaining = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    const oversized: string[] = [];
    for (const file of picked.slice(0, remaining)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        oversized.push(file.name || 'File');
        continue;
      }
      void startUpload(file);
    }
    if (oversized.length > 0) {
      Alert.alert(
        'File too large',
        `${oversized[0]} is larger than 100 MB${oversized.length > 1 ? `, along with ${oversized.length - 1} more` : ''}.`,
      );
    }
  };

  const sizeForUri = async (uri: string, reportedSize?: number | null) => {
    if (reportedSize != null) return reportedSize;
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists ? (info.size ?? 0) : 0;
  };

  const attachmentFromImageAsset = async (
    asset: ImagePicker.ImagePickerAsset,
  ): Promise<PickedAttachment> => ({
    uri: asset.uri,
    name: asset.fileName ?? 'photo.jpg',
    mimeType: asset.mimeType ?? 'image/jpeg',
    size: await sizeForUri(asset.uri, asset.fileSize),
    width: asset.width,
    height: asset.height,
  });

  const pickImages = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: MAX_ATTACHMENTS,
      quality: 0.8,
    });
    if (res.canceled) return;
    addPickedAttachments(await Promise.all(res.assets.map(attachmentFromImageAsset)));
  };

  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Camera access needed', 'Enable camera access to take a photo.');
      return;
    }
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.8,
    });
    if (res.canceled) return;
    addPickedAttachments(await Promise.all(res.assets.map(attachmentFromImageAsset)));
  };

  const pickDocument = async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled) return;
    addPickedAttachments(
      await Promise.all(res.assets.map(async (asset) => ({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType ?? 'application/octet-stream',
        size: await sizeForUri(asset.uri, asset.size),
      }))),
    );
  };

  const pickAttachment = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Take photo', 'Photo library', 'File', 'Cancel'], cancelButtonIndex: 3 },
        (i) => {
          if (i === 0) void takePhoto();
          if (i === 1) void pickImages();
          if (i === 2) void pickDocument();
        },
      );
    } else {
      Alert.alert('Attach', undefined, [
        { text: 'Take photo', onPress: () => void takePhoto() },
        { text: 'Photo library', onPress: () => void pickImages() },
        { text: 'File', onPress: () => void pickDocument() },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  const uploading = attachments.some((a) => !a.meta && !a.failed);
  const ready = attachments.filter(
    (a): a is PendingAttachment & { meta: AttachmentMeta & { uploadKey: string; localUri: string } } =>
      a.meta != null,
  );
  const readyMeta = ready.map(({ meta }) => ({
    id: meta.id,
    filename: meta.filename,
    contentType: meta.contentType,
    size: meta.size,
    ...(meta.width ? { width: meta.width } : {}),
    ...(meta.height ? { height: meta.height } : {}),
  }));
  const readyRefs = ready.map(({ meta }) => ({ uploadKey: meta.uploadKey }));
  const canSend = !uploading && (text.trim().length > 0 || readyMeta.length > 0);
  const mentionMatch = !editing ? matchMentionPrefix(text) : null;
  const mentionPrefix = mentionMatch?.prefix.toLowerCase() ?? '';
  // @agent only spawns when the whole message starts with it — don't offer
  // the suggestion for mid-text mentions.
  const agentMatches =
    mentionMatch != null && mentionMatch.start === 0 && 'agent'.startsWith(mentionPrefix);
  const matchedUsers = useMemo(() => {
    if (!mentionMatch || !mentionUsers) return [];
    return mentionUsers
      .filter((u) => {
        const handle = u.handle.toLowerCase();
        const displayName = u.displayName.toLowerCase();
        return handle.startsWith(mentionPrefix) || displayName.includes(mentionPrefix);
      })
      .slice(0, agentMatches ? 4 : 5);
  }, [agentMatches, mentionMatch, mentionPrefix, mentionUsers]);
  const showMentionSuggestions = mentionMatch != null && (agentMatches || matchedUsers.length > 0);

  useEffect(() => {
    if (mentionMatch) onMentionTrigger?.();
  }, [mentionMatch, onMentionTrigger]);

  useEffect(() => {
    if (!recorderState.isRecording) return;
    const peak = normalizeMetering(recorderState.metering);
    if (peak != null) meterSamplesRef.current.push(peak);
  }, [recorderState.isRecording, recorderState.metering]);

  const insertMention = (value: string) => {
    if (!mentionMatch) return;
    const next = `${text.slice(0, mentionMatch.start)}@${value} `;
    setText(next);
    if (draftKey) {
      onDraftTouched?.(draftKey);
      draftWriter.saveNow(draftKey, next);
    }
    setTimeout(() => inputRef.current?.focus(), 0);
  };

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
    onSend(trimmed, readyMeta, readyRefs.length > 0 ? readyRefs : undefined);
    if (draftKey) {
      onDraftTouched?.(draftKey);
      draftWriter.saveNow(draftKey, '');
    }
    setText('');
    setAttachments([]);
  };

  const startRecording = async () => {
    if (!uploadFile || editing || recordingBusy || uploading) return;
    try {
      setRecordingError(null);
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Microphone access needed', 'Enable microphone access to send voice messages.');
        return;
      }
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });
      meterSamplesRef.current = [];
      await audioRecorder.prepareToRecordAsync(VOICE_RECORDING_OPTIONS);
      audioRecorder.record();
      lightImpactHaptic();
    } catch (err) {
      console.warn('failed to start recording', err);
      setRecordingError('Could not start recording.');
      Alert.alert('Voice message', 'Could not start recording.');
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    }
  };

  const finishRecording = async (sendVoice: boolean) => {
    if (recordingBusy) return;
    setRecordingBusy(true);
    try {
      await audioRecorder.stop();
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      const status = audioRecorder.getStatus();
      const uri = audioRecorder.uri ?? status.url;
      const durationMs = Math.max(
        status.durationMillis,
        Math.round(audioRecorder.currentTime * 1000),
      );
      if (!sendVoice) {
        if (uri) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
        return;
      }
      if (!uri || durationMs < 300) {
        if (uri) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
        Alert.alert('Voice message', 'Recording was too short to send.');
        return;
      }
      if (!uploadFile) return;
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) throw new Error('recording file is unavailable');
      const contentType = Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4';
      const extension = Platform.OS === 'web' ? 'webm' : 'm4a';
      const filename = `voice-${Date.now()}.${extension}`;
      const meta = await uploadFile({
        uri,
        name: filename,
        mimeType: contentType,
        size: info.size ?? 0,
      });
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      const waveform = downsamplePeaks(meterSamplesRef.current);
      onSend(
        '',
        [
          {
            id: meta.id,
            filename: meta.filename,
            contentType: meta.contentType,
            size: meta.size,
          },
        ],
        [{ uploadKey: meta.uploadKey }],
        { durationMs, ...(waveform ? { waveform } : {}) },
      );
      lightImpactHaptic();
    } catch (err) {
      console.warn('failed to finish recording', err);
      setRecordingError('Could not send voice message.');
      Alert.alert('Voice message', 'Could not send the recording.');
    } finally {
      meterSamplesRef.current = [];
      setRecordingBusy(false);
    }
  };

  const recording = recorderState.isRecording;

  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.bg,
        paddingHorizontal: space.md,
        paddingTop: space.sm,
        paddingBottom: keyboardVisible ? space.sm : Math.max(8, insets.bottom),
        gap: space.sm,
      }}
    >
      {editing && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '700' }}>
            Editing message
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel edit"
            onPress={() => {
              setText('');
              onCancelEdit?.();
            }}
          >
            <Text style={{ color: colors.textMuted, fontSize: font.xs }}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {showMentionSuggestions && (
        <View
          style={{
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.md,
            backgroundColor: colors.bgElevated,
            overflow: 'hidden',
          }}
        >
          {agentMatches && (
            <Pressable
              onPress={() => insertMention('agent')}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.sm,
                paddingHorizontal: space.md,
                paddingVertical: space.sm,
                backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
              })}
            >
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: radius.sm,
                  backgroundColor: colors.accentBg,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: colors.accent, fontSize: font.sm, fontWeight: '800' }}>@</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '700' }}>
                  @agent
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: font.xs }}>run an agent task</Text>
              </View>
            </Pressable>
          )}
          {matchedUsers.map((u) => (
            <Pressable
              key={u.id}
              onPress={() => insertMention(u.handle)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.sm,
                paddingHorizontal: space.md,
                paddingVertical: space.sm,
                backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
              })}
            >
              <Avatar name={u.displayName} seed={u.id} size={28} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '700' }}>
                  {u.displayName}
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: font.xs }}>@{u.handle}</Text>
              </View>
            </Pressable>
          ))}
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
                  <Ionicons
                    name={a.failed ? 'alert-circle-outline' : 'attach-outline'}
                    size={21}
                    color={a.failed ? colors.danger : colors.textSecondary}
                  />
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
                accessibilityRole="button"
                accessibilityLabel="Remove attachment"
                onPress={() => setAttachments((prev) => prev.filter((x) => x.key !== a.key))}
                hitSlop={13}
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
                <Ionicons name="close-outline" size={14} color={colors.text} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {(recording || recordingBusy || recordingError) && !editing && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            paddingHorizontal: space.sm,
            paddingVertical: space.xs,
            borderRadius: radius.md,
            backgroundColor: recording ? colors.dangerSurface : colors.bgElevated,
            borderWidth: 1,
            borderColor: recording ? colors.dangerBorder : colors.border,
          }}
        >
          {recordingBusy ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: recording ? colors.danger : colors.textMuted,
              }}
            />
          )}
          <Text
            style={{
              flex: 1,
              color: recording ? colors.text : colors.textMuted,
              fontSize: font.sm,
              fontVariant: ['tabular-nums'],
            }}
          >
            {recording
              ? `Recording ${formatVoiceDuration(recorderState.durationMillis)}`
              : recordingBusy
                ? 'Finishing voice message...'
                : recordingError}
          </Text>
          {recording && (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel voice recording"
                onPress={() => void finishRecording(false)}
                hitSlop={8}
                style={{ minHeight: 36, justifyContent: 'center' }}
              >
                <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '700' }}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Stop and send voice recording"
                onPress={() => void finishRecording(true)}
                hitSlop={8}
                style={{
                  minWidth: 36,
                  minHeight: 36,
                  borderRadius: 18,
                  backgroundColor: colors.danger,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="stop" size={16} color="#ffffff" />
              </Pressable>
            </>
          )}
        </View>
      )}

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
        {allowAttachments && !editing && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach file"
            onPress={pickAttachment}
            hitSlop={8}
            style={{
              minWidth: 44,
              minHeight: 44,
              borderRadius: 22,
              backgroundColor: colors.bgElevated,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 2,
            }}
          >
            <Ionicons name="attach-outline" size={21} color={colors.textSecondary} />
          </Pressable>
        )}
        {allowAttachments && !editing && uploadFile && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={recording ? 'Stop and send voice message' : 'Record voice message'}
            accessibilityState={{ disabled: recordingBusy || uploading }}
            onPress={() => {
              if (recording) void finishRecording(true);
              else void startRecording();
            }}
            disabled={recordingBusy || uploading}
            hitSlop={8}
            style={{
              minWidth: 44,
              minHeight: 44,
              borderRadius: 22,
              backgroundColor: recording
                ? colors.dangerSurface
                : recordingBusy || uploading
                  ? colors.bgElevated
                  : colors.bgElevated,
              borderWidth: recording ? 1 : 0,
              borderColor: recording ? colors.dangerBorder : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 2,
            }}
          >
            <Ionicons
              name={recording ? 'stop' : 'mic-outline'}
              size={21}
              color={recording ? colors.danger : colors.textSecondary}
            />
          </Pressable>
        )}
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={(v) => {
            setText(v);
            if (!editing && draftKey) {
              onDraftTouched?.(draftKey);
              draftWriter.schedule(draftKey, v);
            }
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
          accessibilityRole="button"
          accessibilityLabel={editing ? 'Save edit' : 'Send message'}
          accessibilityState={{
            disabled: recording || recordingBusy || (editing ? text.trim().length === 0 : !canSend),
          }}
          onPress={submit}
          disabled={recording || recordingBusy || (editing ? text.trim().length === 0 : !canSend)}
          hitSlop={8}
          style={{
            minWidth: 44,
            minHeight: 44,
            borderRadius: 22,
            backgroundColor: (editing ? text.trim().length > 0 : canSend)
              ? colors.accent
              : colors.bgElevated,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 2,
          }}
        >
          <Ionicons
            name={editing ? 'checkmark-outline' : 'arrow-up-circle'}
            size={editing ? 21 : 25}
            color={(editing ? text.trim().length > 0 : canSend) ? colors.onAccent : colors.textFaint}
          />
        </Pressable>
      </View>
    </View>
  );
}
