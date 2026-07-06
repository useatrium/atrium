import { useCallback, useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Linking, Platform, Pressable, Text, View } from 'react-native';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import {
  channelLabel,
  emptyTimeline,
  type ChatMessage,
  type HubFile,
} from '@atrium/surface-client';
import { Ionicons } from '@expo/vector-icons';
import { useChat } from '../../../src/lib/chat';
import { font, useTheme } from '../../../src/lib/theme';
import { attachmentToHubFile } from '../../../src/components/attachmentPreview';
import { ConnectionBanner, TypingLine } from '../../../src/components/bits';
import { Composer } from '../../../src/components/Composer';
import { MediaLightbox } from '../../../src/components/MediaLightbox';
import { MessageActions } from '../../../src/components/MessageActions';
import { Timeline } from '../../../src/components/Timeline';
import {
  loadMarkupDraftFromEntry,
  messageEntryHandleForMarkup,
  putPendingMarkupDraft,
} from '../../../src/lib/markupAuthoring';

interface AttachmentLightboxState {
  files: HubFile[];
  initialIndex: number;
}

export default function ChannelScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chat = useChat();
  const { colors } = useTheme();
  const { state, me } = chat;
  const { calls } = chat;
  const { getDraft, setDraft } = chat;

  useFocusEffect(
    useCallback(() => {
      if (id) chat.openChannel(id);
      // Leaving is handled by the list screen's focus effect; threads keep focus.
    }, [id]), // eslint-disable-line react-hooks/exhaustive-deps
  );

  const channel = state.channels.find((c) => c.id === id) ?? null;
  const timeline = (id && state.timelines[id]) || emptyTimeline;
  const presentCount = id ? (state.presence[id]?.length ?? 0) : 0;
  const headerHeight = useHeaderHeight();

  // Kicked from a private channel (or it was deleted) while viewing it: the
  // channel drops out of state. Leave rather than sit on a dead screen whose
  // composer would 403 on send.
  const channelGone = id != null && channel == null && state.channels.length > 0;
  useEffect(() => {
    if (channelGone && router.canGoBack()) router.back();
  }, [channelGone]);

  const [actionsTarget, setActionsTarget] = useState<ChatMessage | null>(null);
  const [attachmentLightbox, setAttachmentLightbox] = useState<AttachmentLightboxState | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [initialDraft, setInitialDraft] = useState('');

  const title = channel ? channelLabel(channel, me.id) : '';
  const isDm = channel?.kind === 'dm';
  const isGroupLike = channel?.kind === 'private' || channel?.kind === 'gdm';
  const draftKey = id ? `channel:${id}` : '';
  const channelRecoverableCall = id
    ? calls.recoverableCalls.find((call) => call.channelId === id) ?? null
    : null;
  const channelCallAction = channelRecoverableCall
    ? channelRecoverableCall.participants.some((participant) => participant.id === me.id)
      ? 'Rejoin voice call'
      : 'Join voice call'
    : 'Start voice call';
  const channelCallDisabled =
    !channel || calls.starting || calls.answering || calls.activeCall != null;

  useEffect(() => {
    if (!draftKey) return;
    chat.setActiveDraftKey(draftKey, true);
    return () => chat.setActiveDraftKey(draftKey, false);
  }, [chat.setActiveDraftKey, draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    let disposed = false;
    setInitialDraft('');
    void getDraft(draftKey)
      .then((draft) => {
        if (!disposed) setInitialDraft(draft ?? '');
      })
      .catch((err: unknown) => {
        console.warn('failed to load draft', err);
      });
    return () => {
      disposed = true;
    };
  }, [draftKey, getDraft]);

  const saveDraft = useCallback((key: string, text: string) => setDraft(key, text), [setDraft]);

  const openThread = useCallback(
    (m: ChatMessage) => {
      const threadRootEventId = m.threadRootEventId ?? m.id;
      if (threadRootEventId == null || !id) return;
      router.push({ pathname: '/thread/[rootId]', params: { rootId: String(threadRootEventId), channelId: id } });
    },
    [id],
  );

  const openAttachment = useCallback((message: ChatMessage, index: number) => {
    const attachments = message.attachments ?? [];
    if (index < 0 || index >= attachments.length) return;
    setAttachmentLightbox({
      files: attachments.map(attachmentToHubFile),
      initialIndex: index,
    });
  }, []);

  const openExternal = useCallback(
    async (file: HubFile) => {
      const { url } = await chat.api.fileSignedUrl(file.artifactId);
      const absoluteUrl = /^https?:\/\//i.test(url)
        ? url
        : `${new URL(chat.api.fileUrl(file.artifactId)).origin}${url}`;
      await Linking.openURL(absoluteUrl);
    },
    [chat.api],
  );

  const openMarkupReply = useCallback(
    async (message: ChatMessage) => {
      const handle = messageEntryHandleForMarkup(message);
      const threadRootEventId = message.threadRootEventId ?? message.id;
      if (!handle || threadRootEventId == null) return;
      try {
        const draft = await loadMarkupDraftFromEntry({
          api: chat.api,
          serverUrl: chat.serverUrl,
          fileHeaders: chat.fileHeaders,
          handle,
          mode: { kind: 'reply', channelId: message.channelId, threadRootEventId },
        });
        const draftId = putPendingMarkupDraft(draft);
        router.push({ pathname: '/markup-editor', params: { draftId } });
      } catch (err) {
        Alert.alert('Markup', err instanceof Error ? err.message : 'Could not open markup editor.');
      }
    },
    [chat.api, chat.fileHeaders, chat.serverUrl],
  );

  const showMembers = useCallback(async () => {
    if (!id) return;
    try {
      const members = await chat.channelMembers(id);
      Alert.alert('Members', members.map((u) => u.displayName).join('\n') || 'No members');
    } catch {
      Alert.alert('Members', 'Could not load members.');
    }
  }, [chat, id]);

  const addPerson = useCallback(async () => {
    if (!id) return;
    try {
      const [members, { users }] = await Promise.all([chat.channelMembers(id), chat.api.users()]);
      const memberIds = new Set(members.map((u) => u.id));
      const candidates = users.filter((u) => !memberIds.has(u.id));
      if (candidates.length === 0) {
        Alert.alert('Add person', 'Everyone is already a member.');
        return;
      }
      Alert.alert(
        'Add person',
        undefined,
        [
          ...candidates.slice(0, 8).map((u) => ({
            text: u.displayName,
            onPress: () => void chat.addChannelMember(id, u.id),
          })),
          { text: 'Cancel', style: 'cancel' as const },
        ],
      );
    } catch {
      Alert.alert('Add person', 'Could not load people.');
    }
  }, [chat, id]);

  const leave = useCallback(() => {
    if (!id) return;
    Alert.alert('Leave channel', 'You can be invited again later.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          void chat.leaveMembership(id).then(() => router.back());
        },
      },
    ]);
  }, [chat, id]);

  const openHeaderMenu = useCallback(() => {
    Alert.alert(title, undefined, [
      { text: 'Members', onPress: () => void showMembers() },
      { text: 'Add person', onPress: () => void addPerson() },
      { text: 'Leave', style: 'destructive', onPress: leave },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [addPerson, leave, showMembers, title]);

  if (!id) return null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View>
              <Text style={{ color: colors.text, fontSize: font.lg, fontWeight: '700' }}>
                {isDm || channel?.kind === 'gdm' ? title : `${channel?.kind === 'private' ? '🔒' : '#'}${title}`}
              </Text>
              {presentCount > 0 && (
                <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
                  {presentCount} here now
                </Text>
              )}
            </View>
          ),
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={channelCallAction}
                disabled={channelCallDisabled}
                onPress={() => {
                  if (!id) return;
                  if (channelRecoverableCall) {
                    void calls.joinRecoverableCall(channelRecoverableCall.id);
                  } else {
                    void calls.startCall(id);
                  }
                }}
                hitSlop={8}
                style={{
                  minWidth: 44,
                  minHeight: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: channelCallDisabled ? 0.45 : 1,
                }}
              >
                <Ionicons
                  name={channelRecoverableCall ? 'call' : 'call-outline'}
                  size={21}
                  color={channelRecoverableCall ? colors.accent : colors.textSecondary}
                />
              </Pressable>
              {isGroupLike ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open channel menu"
                  onPress={openHeaderMenu}
                  hitSlop={8}
                  style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Ionicons name="ellipsis-horizontal" size={22} color={colors.textSecondary} />
                </Pressable>
              ) : null}
            </View>
          ),
          headerBackButtonDisplayMode: 'minimal',
        }}
      />
      <ConnectionBanner status={state.wsStatus} queuedChangesCount={chat.queuedChangesCount} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={headerHeight}
      >
        <Timeline
          messages={timeline.main}
          emptyLabel="No messages yet. Say hello — or type @agent <task> to put an agent on it."
          loaded={timeline.loaded}
          hasMoreBefore={timeline.hasMoreBefore}
          sessions={state.sessions}
          meId={me.id}
          meHandle={state.meHandle}
          highlightId={chat.highlightId}
          fileUrl={chat.fileUrl}
          api={chat.api}
          serverUrl={chat.serverUrl}
          resolveEntry={chat.resolveEntry}
          resolveArtifactContent={chat.resolveArtifactContent}
          fileHeaders={chat.fileHeaders}
          onLoadEarlier={() => chat.loadEarlier(id)}
          onLongPress={setActionsTarget}
          onOpenThread={openThread}
          onToggleReaction={(m, e) => void chat.react(m, e)}
          onRetry={chat.retry}
          onOpenAttachment={openAttachment}
          onOpenChannel={(channelId) => router.push(`/channel/${channelId}`)}
          onOpenSession={(sessionId) => router.push(`/session/${sessionId}`)}
        />
        <TypingLine typing={chat.typing} />
        <Composer
          placeholder={isDm || channel?.kind === 'gdm' ? `Message ${title}` : `Message ${channel?.kind === 'private' ? '🔒' : '#'}${title}`}
          onSend={(text, attachments, attachmentRefs, voice) =>
            chat.send(id, text, undefined, attachments, attachmentRefs, voice)
          }
          onTyping={() => chat.notifyTyping(id)}
          draftKey={draftKey}
          initialDraft={initialDraft}
          onDraftChange={saveDraft}
          onDraftPersisted={chat.enqueueDraft}
          onDraftTouched={chat.markDraftTouched}
          mentionUsers={chat.mentionUsers}
          onMentionTrigger={chat.loadMentionUsers}
          editingText={editing?.text ?? null}
          onSubmitEdit={(text) => {
            if (editing) void chat.editMessage(editing, text);
            setEditing(null);
          }}
          onCancelEdit={() => setEditing(null)}
          allowAttachments
          uploadFile={chat.uploadFile}
        />
      </KeyboardAvoidingView>

      <MessageActions
        message={actionsTarget}
        mine={actionsTarget?.author.id === me.id}
        canReply={actionsTarget?.threadRootEventId == null}
        canMarkupReply={actionsTarget != null && messageEntryHandleForMarkup(actionsTarget) != null}
        onClose={() => setActionsTarget(null)}
        onReact={(m, e) => void chat.react(m, e)}
        onReply={openThread}
        onMarkupReply={(m) => void openMarkupReply(m)}
        onEdit={setEditing}
        onDelete={(m) => void chat.deleteMessage(m)}
      />
      <MediaLightbox
        visible={attachmentLightbox != null}
        files={attachmentLightbox?.files ?? []}
        initialIndex={attachmentLightbox?.initialIndex ?? 0}
        fileContentUrl={chat.api.fileUrl}
        fileHeaders={chat.fileHeaders}
        onClose={() => setAttachmentLightbox(null)}
        onOpenExternal={openExternal}
      />
    </View>
  );
}
