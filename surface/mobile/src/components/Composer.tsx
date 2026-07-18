// Message composer: multiline input, image/file attachments (uploaded on
// pick, presigned PUT), optimistic send, and an inline edit mode.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Switch,
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
  looksLikeSummonSigil,
  matchMentionPrefix,
  parseSummonSigil,
  suggestMentions,
  type AttachmentMeta,
  type AttachmentRef,
  type MentionCandidate,
  type MentionRange,
  type UserRef,
  audienceAfterAgentSend,
  type AgentComposerRequest,
  type ComposerDestination,
  type ComposerSubmission,
} from '@atrium/surface-client';
import { extractEntryLinkHandles } from '../lib/entryLinks';
import type { EntryResolver } from '../lib/entryResolve';
import { font, radius, space, useTheme } from '../lib/theme';
import { useAccessibilityAnnouncement } from '../lib/accessibility';
import { createDraftChangeDebouncer } from '../lib/outbox';
import { Avatar } from './Avatar';
import { AudienceSwitch } from './SessionAudienceToggle';
import { EntryInlineChip } from './EntryInlineChip';
import { lightImpactHaptic } from '../lib/haptics';
import { downsamplePeaks, formatVoiceDuration, normalizeMetering, type VoiceSendMeta } from '../lib/voice';
import {
  decodeEditingText,
  insertMentionCandidate,
  pruneWarnedMentions,
  trimMentionSubmission,
  updateMentionRangesForEdit,
} from '../lib/mentionComposer';

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
    broadcast?: boolean,
    mentionRanges?: MentionRange[],
  ) => void;
  onTyping: () => void;
  /** Non-null puts the composer into edit mode for that message text. */
  editingText?: string | null;
  onSubmitEdit?: (text: string, mentionRanges: MentionRange[]) => void;
  onCancelEdit?: () => void;
  draftKey?: string;
  initialDraft?: string;
  /** The restored draft was written for an agent — re-show the "draft kept" strip. */
  initialDraftAgentIntent?: boolean;
  onDraftChange?: (key: string, text: string, agentIntent: boolean) => void | Promise<void>;
  onDraftPersisted?: (key: string, text: string, agentIntent: boolean) => void | Promise<void>;
  onDraftTouched?: (key: string) => void;
  mentionUsers?: UserRef[] | null;
  mentionMembers?: UserRef[] | null;
  includeSpecialMentions?: boolean;
  resolveUser?: (id: string) => UserRef | undefined;
  onMentionTrigger?: () => void;
  /** Invite a mentioned non-member to the channel (private channels). */
  onInviteMember?: (userId: string) => Promise<void> | void;
  allowAttachments?: boolean;
  showBroadcastToggle?: boolean;
  /** Destination label for the broadcast toggle, e.g. "#engineering". */
  broadcastChannelLabel?: string;
  previewEntryLinks?: boolean;
  serverUrl?: string;
  resolveEntry?: EntryResolver;
  onOpenChannel?: (channelId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  uploadFile?: (file: {
    uri: string;
    name: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
  }) => Promise<AttachmentMeta & { uploadKey: string; localUri: string }>;
  onConfigureAgent?: (fullText: string) => void;
  peopleDestination?: Extract<ComposerDestination, { audience: 'people' }>;
  /** Agent mode owns the same draft and uploads, but dispatches through this typed route. */
  agentRouting?: {
    destination: Extract<ComposerDestination, { audience: 'agent' }>;
    onSubmit: (request: AgentComposerRequest, submission: ComposerSubmission) => void;
  };
  /** Attached-session threads start with the agent audience selected. */
  initialAgentMode?: boolean;
  onConfigureAgentMode?: () => void;
  onJumpToEvent?: (eventId: number) => void;
}

export interface ComposerHandle {
  captureForConfigure: () => string;
  restore: (value: string) => void;
  activateAgentMode: (anchor?: { eventId: number; label: string }) => void;
  clearAgentAnchor: () => void;
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

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    placeholder,
    onSend,
    onTyping,
    editingText,
    onSubmitEdit,
    onCancelEdit,
    draftKey,
    initialDraft,
    initialDraftAgentIntent,
    onDraftChange,
    onDraftPersisted,
    onDraftTouched,
    mentionUsers,
    mentionMembers,
    includeSpecialMentions = false,
    resolveUser,
    onMentionTrigger,
    onInviteMember,
    allowAttachments,
    showBroadcastToggle,
    broadcastChannelLabel,
    previewEntryLinks,
    serverUrl,
    resolveEntry,
    onOpenChannel,
    onOpenSession,
    uploadFile,
    onConfigureAgent,
    peopleDestination,
    agentRouting,
    initialAgentMode = false,
    onConfigureAgentMode,
    onJumpToEvent,
  }: ComposerProps,
  ref,
) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [mentionRanges, setMentionRanges] = useState<MentionRange[]>([]);
  /** Mentions of users outside a private channel — the server won't notify them. */
  const [warnedNonMembers, setWarnedNonMembers] = useState<UserRef[]>([]);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [alsoSendToChannel, setAlsoSendToChannel] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState(initialAgentMode);
  const [inputFocused, setInputFocused] = useState(false);
  const [agentAnchor, setAgentAnchor] = useState<{ eventId: number; label: string } | null>(null);
  const [agentMentionHintDismissed, setAgentMentionHintDismissed] = useState(false);
  const [audienceAnnouncement, setAudienceAnnouncement] = useState<string | null>(null);
  const audioRecorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(audioRecorder, 125);
  const inputRef = useRef<TextInput>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const lastEditingTextRef = useRef<string | null>(null);
  const editDirtyRef = useRef(false);
  const capturedMentionRangesRef = useRef<MentionRange[]>([]);
  const meterSamplesRef = useRef<number[]>([]);
  const editing = editingText != null;
  useAccessibilityAnnouncement(recordingError);
  useAccessibilityAnnouncement(audienceAnnouncement);
  const draftWriter = useMemo(
    () =>
      createDraftChangeDebouncer(
        (key, value, agentIntent) => onDraftChange?.(key, value, agentIntent),
        400,
        (key, value, agentIntent) => onDraftPersisted?.(key, value, agentIntent),
      ),
    [onDraftChange, onDraftPersisted],
  );

  useEffect(() => () => draftWriter.cancel(), [draftWriter]);

  useEffect(() => {
    if (initialAgentMode && !editing && textRef.current.trim().length === 0) setAgentMode(true);
  }, [editing, initialAgentMode]);

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
    if (!editing) {
      setText('');
      setMentionRanges([]);
      setWarnedNonMembers([]);
      setSelection({ start: 0, end: 0 });
      setAgentMode(initialAgentMode);
      setAgentAnchor(null);
      setAudienceAnnouncement(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);
  useEffect(() => {
    if (editing || !initialDraft) return;
    if (textRef.current !== '') return;
    setText(initialDraft);
    setSelection({ start: initialDraft.length, end: initialDraft.length });
    // A restored draft brings either saved audience with it. This matters in
    // attached threads, whose empty composer otherwise defaults to Agent.
    setAgentMode(initialDraftAgentIntent === true);
  }, [editing, initialDraft, initialDraftAgentIntent]);

  useEffect(() => {
    if (editingText != null) {
      const enteringEdit = lastEditingTextRef.current !== editingText;
      if (!enteringEdit && editDirtyRef.current) return;
      lastEditingTextRef.current = editingText;
      editDirtyRef.current = false;
      const decoded = decodeEditingText(editingText, resolveUser);
      setText(decoded.text);
      setMentionRanges(decoded.ranges);
      setSelection({ start: decoded.text.length, end: decoded.text.length });
      inputRef.current?.focus();
    } else {
      lastEditingTextRef.current = null;
      editDirtyRef.current = false;
    }
  }, [editingText, resolveUser]);

  useImperativeHandle(
    ref,
    () => ({
      captureForConfigure() {
        const captured = text;
        if (!editing) {
          capturedMentionRangesRef.current = mentionRanges;
          setText('');
          setMentionRanges([]);
          setSelection({ start: 0, end: 0 });
          if (draftKey) {
            onDraftTouched?.(draftKey);
            draftWriter.saveNow(draftKey, '');
          }
        }
        return captured;
      },
      restore(value: string) {
        if (editing) return;
        setText(value);
        setMentionRanges(capturedMentionRangesRef.current);
        capturedMentionRangesRef.current = [];
        setSelection({ start: value.length, end: value.length });
        if (draftKey) {
          onDraftTouched?.(draftKey);
          draftWriter.saveNow(draftKey, value);
        }
        setTimeout(() => {
          inputRef.current?.focus();
          inputRef.current?.setNativeProps({ selection: { start: value.length, end: value.length } });
        }, 0);
      },
      activateAgentMode(anchor) {
        if (editing) return;
        setAgentAnchor(anchor ?? null);
        setAgentMode(true);
        setTimeout(() => inputRef.current?.focus(), 0);
      },
      clearAgentAnchor() {
        setAgentAnchor(null);
      },
    }),
    [draftKey, draftWriter, editing, mentionRanges, onDraftTouched, text],
  );

  const persistDraftValue = useCallback(
    (value: string, agentIntent: boolean) => {
      if (!draftKey) return;
      onDraftTouched?.(draftKey);
      draftWriter.saveNow(draftKey, value, agentIntent);
    },
    [draftKey, draftWriter, onDraftTouched],
  );

  const leaveAgentMode = useCallback(() => {
    setAgentMode(false);
    setAgentAnchor(null);
    persistDraftValue(textRef.current, false);
    setAudienceAnnouncement(`People mode. ${peopleDestination?.description ?? 'Posts without prompting the agent'}.`);
  }, [peopleDestination?.description, persistDraftValue]);

  const enterAgentMode = useCallback(() => {
    setAgentMode(true);
    const hasDraft = textRef.current.trim().length > 0;
    persistDraftValue(textRef.current, hasDraft);
    setAudienceAnnouncement(`Agent mode. ${agentRouting?.destination.description ?? 'Prompts the agent'}.`);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [agentRouting?.destination.description, persistDraftValue]);

  const startUpload = async (file: PickedAttachment) => {
    if (!uploadFile) return;
    const key = `${Date.now()}-${file.name}-${Math.random()}`;
    const isImage = file.mimeType.startsWith('image/');
    setAttachments((prev) => [...prev, { key, previewUri: isImage ? file.uri : null, meta: null, failed: false }]);
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

  const attachmentFromImageAsset = async (asset: ImagePicker.ImagePickerAsset): Promise<PickedAttachment> => ({
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
      await Promise.all(
        res.assets.map(async (asset) => ({
          uri: asset.uri,
          name: asset.name,
          mimeType: asset.mimeType ?? 'application/octet-stream',
          size: await sizeForUri(asset.uri, asset.size),
        })),
      ),
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
    (a): a is PendingAttachment & { meta: AttachmentMeta & { uploadKey: string; localUri: string } } => a.meta != null,
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
  const audienceAvailable = !editing && agentRouting != null && peopleDestination != null;
  const activeDestination = agentMode ? agentRouting?.destination : peopleDestination;
  const showConfigureAgentChip = !editing && onConfigureAgent != null && looksLikeSummonSigil(text);
  const showAgentMentionHint = !editing && !agentMentionHintDismissed && /^@agent(?:\s|$)/i.test(text);
  const mentionMatch = !editing ? matchMentionPrefix(text.slice(0, selection.start)) : null;
  const mentionPrefix = mentionMatch?.prefix.toLowerCase() ?? '';
  const mentionCandidates = useMemo(
    () =>
      mentionMatch
        ? suggestMentions({
            prefix: mentionPrefix,
            members: mentionMembers,
            users: mentionUsers,
            includeSpecials: includeSpecialMentions,
            limit: 8,
          })
        : [],
    [includeSpecialMentions, mentionMatch, mentionMembers, mentionPrefix, mentionUsers],
  );
  const showMentionSuggestions = mentionMatch != null && mentionCandidates.length > 0;
  const entryLinkHandles = useMemo(
    () => (previewEntryLinks && serverUrl ? extractEntryLinkHandles(text, serverUrl) : []),
    [previewEntryLinks, serverUrl, text],
  );

  useEffect(() => {
    if (mentionMatch) onMentionTrigger?.();
  }, [mentionMatch, onMentionTrigger]);

  useEffect(() => {
    if (!recorderState.isRecording) return;
    const peak = normalizeMetering(recorderState.metering);
    if (peak != null) meterSamplesRef.current.push(peak);
  }, [recorderState.isRecording, recorderState.metering]);

  const insertMention = (candidate: MentionCandidate) => {
    if (!mentionMatch) return;
    const value = candidate.kind === 'user' ? candidate.user.handle : candidate.name;
    const inserted = insertMentionCandidate(text, mentionRanges, mentionMatch.start, selection.start, value, candidate);
    if (candidate.kind === 'user' && !candidate.inChannel && includeSpecialMentions) {
      setWarnedNonMembers((current) =>
        current.some((user) => user.id === candidate.user.id) ? current : [...current, candidate.user],
      );
    }
    setText(inserted.text);
    setMentionRanges(inserted.ranges);
    setSelection({ start: inserted.caret, end: inserted.caret });
    if (draftKey) {
      onDraftTouched?.(draftKey);
      draftWriter.saveNow(draftKey, inserted.text, agentMode);
    }
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setNativeProps({ selection: { start: inserted.caret, end: inserted.caret } });
    }, 0);
  };

  const submit = () => {
    const trimmed = text.trim();
    if (editing) {
      if (!trimmed) return;
      const submission = trimMentionSubmission(text, mentionRanges);
      onSubmitEdit?.(submission.text, submission.ranges);
      setText('');
      setMentionRanges([]);
      setWarnedNonMembers([]);
      setSelection({ start: 0, end: 0 });
      return;
    }
    if (!canSend) return;
    lightImpactHaptic();
    if (agentMode && agentRouting) {
      const request = {
        ...agentRouting.destination.request,
        ...(agentAnchor?.eventId != null ? { anchorEventId: agentAnchor.eventId } : {}),
      } as AgentComposerRequest;
      agentRouting.onSubmit(request, {
        text: trimmed,
        ...(readyMeta.length > 0 ? { attachments: readyMeta } : {}),
        ...(readyRefs.length > 0 ? { attachmentRefs: readyRefs } : {}),
      });
      if (draftKey) {
        onDraftTouched?.(draftKey);
        draftWriter.saveNow(draftKey, '');
      }
      setText('');
      setMentionRanges([]);
      setWarnedNonMembers([]);
      setSelection({ start: 0, end: 0 });
      setAttachments([]);
      setAgentAnchor(null);
      setAgentMode(audienceAfterAgentSend(request) === 'agent');
      return;
    }
    const broadcast = showBroadcastToggle && alsoSendToChannel;
    const submission = trimMentionSubmission(text, mentionRanges);
    onSend(
      submission.text,
      readyMeta,
      readyRefs.length > 0 ? readyRefs : undefined,
      undefined,
      broadcast ? true : undefined,
      submission.ranges,
    );
    if (draftKey) {
      onDraftTouched?.(draftKey);
      draftWriter.saveNow(draftKey, '');
    }
    setAlsoSendToChannel(false);
    setText('');
    setMentionRanges([]);
    setWarnedNonMembers([]);
    setSelection({ start: 0, end: 0 });
    setAttachments([]);
  };

  const startRecording = async () => {
    if (!uploadFile || editing || agentMode || recordingBusy || uploading) return;
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
      const durationMs = Math.max(status.durationMillis, Math.round(audioRecorder.currentTime * 1000));
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
        showBroadcastToggle && alsoSendToChannel ? true : undefined,
      );
      setAlsoSendToChannel(false);
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
        backgroundColor: agentMode ? colors.accentBg : colors.bg,
        paddingHorizontal: space.md,
        paddingTop: space.sm,
        paddingBottom: keyboardVisible ? space.sm : Math.max(8, insets.bottom),
        gap: space.sm,
      }}
    >
      {editing && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '700' }}>Editing message</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel edit"
            onPress={() => {
              setText('');
              setMentionRanges([]);
              setWarnedNonMembers([]);
              setSelection({ start: 0, end: 0 });
              onCancelEdit?.();
            }}
          >
            <Text style={{ color: colors.textMuted, fontSize: font.xs }}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {/* The pill in the input frame already names the target — this strip is
          only the options that change it (target, anchor). */}
      {agentMode && !editing ? (
        <View
          testID="agent-mode-strip"
          style={{
            alignItems: 'center',
            flexDirection: 'row',
            gap: space.sm,
            minHeight: 32,
            paddingHorizontal: space.xs,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Configure agent target"
            onPress={onConfigureAgentMode}
            hitSlop={8}
            style={{
              backgroundColor: colors.bgElevated,
              borderColor: colors.border,
              borderRadius: radius.md,
              borderWidth: 1,
              flex: agentAnchor ? undefined : 1,
              minHeight: 32,
              justifyContent: 'center',
              paddingHorizontal: space.sm,
            }}
          >
            <Text numberOfLines={1} style={{ color: colors.text, fontSize: font.xs, fontWeight: '700' }}>
              Options ▾
            </Text>
          </Pressable>
          {agentAnchor ? (
            <View
              style={{
                alignItems: 'stretch',
                backgroundColor: colors.bgElevated,
                borderColor: colors.border,
                borderRadius: radius.md,
                borderWidth: 1,
                flex: 1,
                flexDirection: 'row',
                minWidth: 0,
                overflow: 'hidden',
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Jump to anchored message"
                accessibilityState={{ disabled: onJumpToEvent == null }}
                disabled={onJumpToEvent == null}
                onPress={() => onJumpToEvent?.(agentAnchor.eventId)}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? colors.bgPressed : 'transparent',
                  flex: 1,
                  justifyContent: 'center',
                  minHeight: 30,
                  minWidth: 0,
                  paddingHorizontal: space.sm,
                })}
              >
                <Text numberOfLines={1} style={{ color: colors.textSecondary, fontSize: font.xs }}>
                  ⚓ {agentAnchor.label}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear anchor"
                onPress={() => setAgentAnchor(null)}
                hitSlop={8}
                style={({ pressed }) => ({
                  alignItems: 'center',
                  backgroundColor: pressed ? colors.bgPressed : 'transparent',
                  justifyContent: 'center',
                  minHeight: 30,
                  width: 32,
                })}
              >
                <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '700' }}>✕</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}

      {showAgentMentionHint ? (
        <View testID="agent-mention-hint" style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Text style={{ color: colors.textSecondary, flex: 1, fontSize: font.xs }}>
            Summon agents with !! or ⚡ — mentions are for people now.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss agent mention hint"
            onPress={() => setAgentMentionHintDismissed(true)}
            hitSlop={8}
          >
            <Text style={{ color: colors.textMuted, fontSize: font.sm }}>✕</Text>
          </Pressable>
        </View>
      ) : null}

      {showBroadcastToggle && !editing && (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: colors.textSecondary, fontSize: font.sm }}>
            Also send to {broadcastChannelLabel ?? 'channel'}
          </Text>
          <Switch
            accessibilityLabel={`Also send to ${broadcastChannelLabel ?? 'channel'}`}
            value={alsoSendToChannel}
            onValueChange={setAlsoSendToChannel}
            trackColor={{ false: colors.switchTrackOff, true: colors.accent }}
            thumbColor={alsoSendToChannel ? colors.onAccent : colors.switchThumbOff}
          />
        </View>
      )}

      {showMentionSuggestions && (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          style={{
            maxHeight: 320,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.md,
            backgroundColor: colors.bgElevated,
            overflow: 'hidden',
          }}
        >
          {mentionCandidates.map((candidate, index) =>
            candidate.kind === 'user' ? (
              <Pressable
                key={candidate.user.id}
                accessibilityRole="button"
                accessibilityLabel={`Mention ${candidate.user.displayName}, @${candidate.user.handle}`}
                onPress={() => insertMention(candidate)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.sm,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
                })}
              >
                <Avatar name={candidate.user.displayName} seed={candidate.user.id} size={28} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '700' }}>
                    {candidate.user.displayName}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                    <Text style={{ color: colors.textMuted, fontSize: font.xs }}>@{candidate.user.handle}</Text>
                    {!candidate.inChannel ? (
                      <Text style={{ color: colors.textFaint, fontSize: font.xs }}>Not in channel</Text>
                    ) : null}
                  </View>
                </View>
              </Pressable>
            ) : (
              <Pressable
                key={candidate.name}
                accessibilityRole="button"
                accessibilityLabel={`Mention ${candidate.name}`}
                onPress={() => insertMention(candidate)}
                style={({ pressed }) => ({
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
                  borderTopWidth: index === 0 || mentionCandidates[index - 1]?.kind === 'special' ? 0 : 1,
                  borderTopColor: colors.border,
                })}
              >
                <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '700' }}>@{candidate.name}</Text>
                <Text style={{ color: colors.textMuted, fontSize: font.xs }}>{candidate.description}</Text>
              </Pressable>
            ),
          )}
        </ScrollView>
      )}

      {warnedNonMembers.length > 0 && (
        <View
          style={{
            borderWidth: 1,
            borderColor: colors.warning,
            borderRadius: radius.md,
            backgroundColor: colors.warningSurface,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            gap: space.xs,
          }}
        >
          {warnedNonMembers.map((user) => (
            <View key={user.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Text style={{ color: colors.warning, fontSize: font.xs, flex: 1 }} numberOfLines={2}>
                @{user.handle} isn’t in this channel and won’t be notified
              </Text>
              {onInviteMember ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Invite ${user.displayName} to this channel`}
                  onPress={() => {
                    void onInviteMember(user.id);
                    setWarnedNonMembers((current) => current.filter((candidate) => candidate.id !== user.id));
                  }}
                  style={({ pressed }) => ({
                    borderWidth: 1,
                    borderColor: colors.warning,
                    borderRadius: radius.sm,
                    paddingHorizontal: space.sm,
                    paddingVertical: space.xs,
                    backgroundColor: pressed ? colors.warningSurface : 'transparent',
                  })}
                >
                  <Text style={{ color: colors.warning, fontSize: font.xs, fontWeight: '700' }}>Invite</Text>
                </Pressable>
              ) : null}
            </View>
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
                accessibilityHint="Removes this attachment from the message"
                onPress={() => setAttachments((prev) => prev.filter((x) => x.key !== a.key))}
                hitSlop={13}
                style={{
                  position: 'absolute',
                  top: -4,
                  right: -4,
                  width: 20,
                  height: 20,
                  borderRadius: radius.md,
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
            accessibilityLiveRegion={recordingError ? 'polite' : undefined}
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
                accessibilityHint="Discards the recording"
                onPress={() => void finishRecording(false)}
                hitSlop={8}
                style={{ minHeight: 48, justifyContent: 'center' }}
              >
                <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '700' }}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Stop and send voice recording"
                accessibilityHint="Sends the recording as a voice message"
                onPress={() => void finishRecording(true)}
                hitSlop={8}
                style={{
                  minWidth: 48,
                  minHeight: 48,
                  borderRadius: 24,
                  backgroundColor: colors.danger,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="stop" size={16} color={colors.onMention} />
              </Pressable>
            </>
          )}
        </View>
      )}

      {entryLinkHandles.length > 0 ? (
        <View
          testID="composer-entry-link-preview"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: space.xs,
            paddingHorizontal: space.xs,
          }}
        >
          <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '700' }}>referencing:</Text>
          {entryLinkHandles.map((handle) => (
            <EntryInlineChip
              key={handle}
              handle={handle}
              resolveEntry={resolveEntry}
              onOpenChannel={onOpenChannel}
              onOpenSession={onOpenSession}
            />
          ))}
        </View>
      ) : null}

      {showConfigureAgentChip && !agentMode ? (
        <View style={{ alignItems: 'flex-start' }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Configure and start an agent"
            onPress={() => onConfigureAgent?.(text)}
            hitSlop={8}
            style={({ pressed }) => ({
              alignItems: 'center',
              backgroundColor: pressed ? colors.bgPressed : colors.accentBg,
              borderColor: colors.accent,
              borderRadius: radius.md,
              borderWidth: 1,
              flexDirection: 'row',
              minHeight: 32,
              paddingHorizontal: space.md,
              paddingVertical: space.xs,
            })}
          >
            <Text maxFontSizeMultiplier={2} style={{ color: colors.accent, fontSize: font.sm, fontWeight: '800' }}>
              ✦ Start an agent · Configure ▸
            </Text>
          </Pressable>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm }}>
        {allowAttachments && !editing && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach file"
            accessibilityHint="Opens attachment options"
            onPress={pickAttachment}
            hitSlop={8}
            style={{
              minWidth: 48,
              minHeight: 48,
              borderRadius: radius.md,
              backgroundColor: colors.bgElevated,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="attach-outline" size={21} color={colors.textSecondary} />
          </Pressable>
        )}
        {allowAttachments && !editing && uploadFile && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              agentMode
                ? 'Voice messages unavailable in Agent mode'
                : recording
                  ? 'Stop and send voice message'
                  : 'Record voice message'
            }
            accessibilityHint={
              agentMode
                ? 'Voice messages are only available for People messages.'
                : recording
                  ? 'Stops recording and sends the voice message'
                  : 'Starts recording a voice message'
            }
            accessibilityState={{ disabled: agentMode || recordingBusy || uploading }}
            onPress={() => {
              if (recording) void finishRecording(true);
              else void startRecording();
            }}
            disabled={agentMode || recordingBusy || uploading}
            hitSlop={8}
            style={{
              minWidth: 48,
              minHeight: 48,
              borderRadius: radius.md,
              backgroundColor: recording
                ? colors.dangerSurface
                : recordingBusy || uploading
                  ? colors.bgElevated
                  : colors.bgElevated,
              borderWidth: recording ? 1 : 0,
              borderColor: recording ? colors.dangerBorder : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: agentMode ? 0.45 : 1,
            }}
          >
            <Ionicons
              name={recording ? 'stop' : 'mic-outline'}
              size={21}
              color={recording ? colors.danger : colors.textSecondary}
            />
          </Pressable>
        )}
        <View
          style={{
            alignItems: 'center',
            backgroundColor: agentMode ? colors.accentBg : colors.bgInput,
            borderColor: inputFocused ? colors.accent : colors.border,
            borderRadius: radius.lg,
            borderWidth: 2,
            flex: 1,
            flexDirection: 'row',
            gap: space.xs,
            minHeight: 48,
            paddingHorizontal: space.xs,
          }}
        >
          {audienceAvailable && activeDestination ? (
            <AudienceSwitch
              testID="composer-audience-toggle"
              accessibilityHint={activeDestination.description}
              audience={agentMode ? 'agent' : 'people'}
              onToggle={() => {
                if (recording || recordingBusy) return;
                if (agentMode) leaveAgentMode();
                else enterAgentMode();
              }}
              disabled={recording || recordingBusy}
            />
          ) : null}
          <TextInput
            accessibilityLabel={editing ? 'Edit message' : agentMode ? 'Prompt agent' : 'Message'}
            ref={inputRef}
            value={text}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            onChangeText={(v) => {
              // The summon sigil is strictly position-zero. Swallow it as soon as
              // it is complete so `!! task` feels like entering a mode, not a
              // message grammar. `parseSummonSigil` remains the shared source of
              // truth for the task-bearing form.
              const summon = parseSummonSigil(v);
              const enteredAgentMode = !editing && !agentMode && (summon != null || v === '!!' || v.startsWith('!! '));
              const nextAgentModeNow = enteredAgentMode || agentMode;
              const swallowed = enteredAgentMode ? (summon?.task ?? v.slice(2).replace(/^\s/, '')) : v;
              // Typing "!!" swallows the sigil and empties the input, so the space in
              // "!! task" would otherwise land as a leading space on an empty draft.
              const next = !editing && nextAgentModeNow && text === '' ? swallowed.replace(/^\s+/, '') : swallowed;
              if (enteredAgentMode) setAgentMode(true);
              if (editing) editDirtyRef.current = true;
              setMentionRanges((current) => {
                const nextRanges = updateMentionRangesForEdit(text, next, current);
                setWarnedNonMembers((warned) => pruneWarnedMentions(warned, nextRanges));
                return nextRanges;
              });
              setText(next);
              // The draft carries its audience from the first keystroke, so a
              // reload (or another device) restores it as an agent draft.
              const nextIntent = !editing && next.trim().length > 0 && nextAgentModeNow;
              if (!editing && draftKey) {
                onDraftTouched?.(draftKey);
                draftWriter.schedule(draftKey, next, nextIntent);
              }
              if (next.trim()) onTyping();
            }}
            selection={selection}
            onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
            placeholder={
              editing
                ? placeholder
                : audienceAvailable
                  ? agentMode
                    ? 'Prompt agent…'
                    : 'Message people…'
                  : placeholder
            }
            placeholderTextColor={colors.textFaint}
            multiline
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 44,
              maxHeight: 120,
              backgroundColor: 'transparent',
              color: colors.text,
              fontSize: font.md,
              includeFontPadding: false,
              paddingHorizontal: space.sm,
              paddingVertical: space.md,
              textAlignVertical: 'top',
            }}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={editing ? 'Save edit' : (activeDestination?.sendLabel ?? 'Send message')}
          accessibilityState={{
            disabled: recording || recordingBusy || (editing ? text.trim().length === 0 : !canSend),
          }}
          onPress={submit}
          disabled={recording || recordingBusy || (editing ? text.trim().length === 0 : !canSend)}
          hitSlop={8}
          style={{
            minWidth: 48,
            minHeight: 48,
            borderRadius: radius.md,
            backgroundColor: (editing ? text.trim().length > 0 : canSend) ? colors.accent : colors.bgElevated,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons
            name={editing ? 'checkmark-outline' : 'arrow-up-outline'}
            size={21}
            color={(editing ? text.trim().length > 0 : canSend) ? colors.onAccent : colors.textFaint}
          />
        </Pressable>
      </View>
    </View>
  );
});
