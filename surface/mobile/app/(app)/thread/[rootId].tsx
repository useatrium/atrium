import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { emptyTimeline, sessionDriverId, type ChatMessage, type HubFile } from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { font, space, useTheme } from '../../../src/lib/theme';
import { attachmentToHubFile } from '../../../src/components/attachmentPreview';
import { Composer, type ComposerHandle } from '../../../src/components/Composer';
import { MediaLightbox } from '../../../src/components/MediaLightbox';
import { MessageActions, MessageActionSheet } from '../../../src/components/MessageActions';
import { AgentModeConfig, type AgentEffort, type AgentModeTarget } from '../../../src/components/AgentModeConfig';
import { Timeline } from '../../../src/components/Timeline';

interface AttachmentLightboxState {
  files: HubFile[];
  initialIndex: number;
}

export default function ThreadScreen() {
  const {
    rootId: rootIdParam,
    channelId,
    prefill,
  } = useLocalSearchParams<{
    rootId: string;
    channelId: string;
    prefill?: string;
  }>();
  const rootId = Number(rootIdParam);
  const chat = useChat();
  const { colors } = useTheme();
  const { state, me } = chat;
  const { getDraft, setDraft } = chat;
  const headerHeight = useHeaderHeight();

  useEffect(() => {
    if (channelId && Number.isFinite(rootId)) chat.openThread(channelId, rootId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, rootId]);

  const timeline = (channelId && state.timelines[channelId]) || emptyTimeline;
  const root = timeline.main.find((m) => m.id === rootId) ?? null;
  const replies = timeline.threads[rootId];
  const replyError = chat.threadErrors[rootId] ?? null;
  const messages = root ? [root, ...(replies ?? [])] : (replies ?? []);

  const [actionsTarget, setActionsTarget] = useState<ChatMessage | null>(null);
  const [attachmentLightbox, setAttachmentLightbox] = useState<AttachmentLightboxState | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [initialDraft, setInitialDraft] = useState('');
  const [initialDraftAgentIntent, setInitialDraftAgentIntent] = useState(false);
  const [agentConfigVisible, setAgentConfigVisible] = useState(false);
  const [agentTarget, setAgentTarget] = useState<AgentModeTarget>('steer');
  const [agentEffort, setAgentEffort] = useState<AgentEffort>('medium');
  const composerRef = useRef<ComposerHandle>(null);
  const draftKey = channelId && Number.isFinite(rootId) ? `channel:${channelId}:thread:${rootId}` : '';
  const attachedSession = useMemo(
    () =>
      Object.values(state.sessions).find(
        (session) => session.channelId === channelId && session.threadRootEventId === rootId,
      ) ?? null,
    [channelId, rootId, state.sessions],
  );
  // Canonical seat resolution: null driverId falls back to the spawner.
  const isDriver = attachedSession != null && sessionDriverId(attachedSession) === me.id;
  const agentTargetLabel = attachedSession
    ? `${agentTarget === 'new' ? 'New session' : isDriver ? 'Steer' : 'Suggest'} · ${attachedSession.title}`
    : 'New agent · this thread';

  useEffect(() => {
    if (!draftKey) return;
    chat.setActiveDraftKey(draftKey, true);
    return () => chat.setActiveDraftKey(draftKey, false);
  }, [chat.setActiveDraftKey, draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    let disposed = false;
    setInitialDraft('');
    setInitialDraftAgentIntent(false);
    void getDraft(draftKey)
      .then((draft) => {
        if (disposed) return;
        const nextDraft = draft?.text || prefill || '';
        setInitialDraft(nextDraft);
        setInitialDraftAgentIntent(draft?.agentIntent === true);
        if (!draft?.text && prefill) void setDraft(draftKey, prefill);
      })
      .catch((err: unknown) => {
        console.warn('failed to load thread draft', err);
      });
    return () => {
      disposed = true;
    };
  }, [draftKey, getDraft, prefill, setDraft]);

  const saveDraft = useCallback(
    (key: string, text: string, agentIntent: boolean) => setDraft(key, text, agentIntent),
    [setDraft],
  );

  const openAttachment = useCallback((message: ChatMessage, index: number) => {
    const attachments = message.attachments ?? [];
    if (index < 0 || index >= attachments.length) return;
    setAttachmentLightbox({
      files: attachments.map((attachment) => attachmentToHubFile(attachment, message)),
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

  if (!channelId || !Number.isFinite(rootId)) return null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={headerHeight}
      >
        {replyError && replies === undefined ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Replies failed. Tap to retry."
              onPress={() => chat.retryThread(channelId, rootId)}
              style={{ minHeight: 44, justifyContent: 'center' }}
            >
              <Text style={{ color: colors.danger, fontSize: font.sm }}>Replies failed — tap to retry</Text>
            </Pressable>
          </View>
        ) : (
          <Timeline
            messages={messages}
            loaded={replies !== undefined}
            hasMoreBefore={false}
            sessions={state.sessions}
            meId={me.id}
            meHandle={state.meHandle}
            highlightId={null}
            inThread
            emptyLabel="No replies yet."
            fileUrl={chat.fileUrl}
            api={chat.api}
            serverUrl={chat.serverUrl}
            resolveEntry={chat.resolveEntry}
            resolveArtifactContent={chat.resolveArtifactContent}
            resolveUser={chat.resolveUser}
            fileHeaders={chat.fileHeaders}
            onLoadEarlier={() => Promise.resolve()}
            onLongPress={setActionsTarget}
            onToggleReaction={(m, e) => void chat.react(m, e)}
            onRetry={chat.retry}
            onOpenAttachment={openAttachment}
            onOpenChannel={(channelId) => router.push(`/channel/${channelId}`)}
            onOpenSession={(sessionId) => router.push(`/session/${sessionId}`)}
            onAnswerSessionQuestion={chat.answerSessionQuestion}
            onSuggestSessionAnswer={chat.suggestToSession}
          />
        )}
        <Composer
          ref={composerRef}
          placeholder="Reply in thread"
          onSend={(text, attachments, attachmentRefs, voice, broadcast, mentionRanges) =>
            chat.send(channelId, text, rootId, attachments, attachmentRefs, voice, broadcast, mentionRanges)
          }
          onTyping={() => chat.notifyTyping(channelId)}
          draftKey={draftKey}
          initialDraft={initialDraft}
          initialDraftAgentIntent={initialDraftAgentIntent}
          onDraftChange={saveDraft}
          onDraftPersisted={chat.enqueueDraft}
          onDraftTouched={chat.markDraftTouched}
          mentionUsers={chat.mentionUsers}
          mentionMembers={
            state.channels.find((candidate) => candidate.id === channelId)?.kind === 'public'
              ? chat.mentionUsers
              : (chat.mentionMembers[channelId] ?? null)
          }
          includeSpecialMentions={state.channels.some(
            (candidate) => candidate.id === channelId && candidate.kind !== 'dm' && candidate.kind !== 'gdm',
          )}
          resolveUser={chat.resolveUser}
          onMentionTrigger={() => {
            chat.loadMentionUsers();
            // Public channels have no explicit membership — the members endpoint 404s there.
            const kind = state.channels.find((candidate) => candidate.id === channelId)?.kind;
            if (kind != null && kind !== 'public') chat.loadMentionMembers(channelId);
          }}
          onInviteMember={async (userId) => {
            await chat.addChannelMember(channelId, userId);
            await chat.channelMembers(channelId);
          }}
          editingText={editing?.text ?? null}
          onSubmitEdit={(text, mentionRanges) => {
            if (editing) void chat.editMessage(editing, text, mentionRanges);
            setEditing(null);
          }}
          onCancelEdit={() => setEditing(null)}
          allowAttachments
          showBroadcastToggle
          previewEntryLinks
          serverUrl={chat.serverUrl}
          resolveEntry={chat.resolveEntry}
          onOpenChannel={(channelId) => router.push(`/channel/${channelId}`)}
          onOpenSession={(sessionId) => router.push(`/session/${sessionId}`)}
          uploadFile={chat.uploadFile}
          onAgentSend={(text, anchorEventId) => {
            if (attachedSession && agentTarget === 'steer') {
              if (isDriver) void chat.steerSession(attachedSession.id, text, agentEffort, { postToThread: true });
              else void chat.suggestToSession(attachedSession.id, text);
              return;
            }
            chat.spawnSession(channelId, text, rootId, {
              broadcastCard: true,
              ...(anchorEventId != null ? { anchorEventId } : {}),
            });
          }}
          agentTargetLabel={agentTargetLabel}
          chatTargetLabel="this thread"
          onConfigureAgentMode={() => setAgentConfigVisible(true)}
        />
      </KeyboardAvoidingView>

      <MessageActions
        message={actionsTarget}
        mine={actionsTarget?.author.id === me.id}
        canReply={false}
        canMarkupReply={false}
        onClose={() => setActionsTarget(null)}
        onReact={(m, e) => void chat.react(m, e)}
        onReply={() => {}}
        onEdit={setEditing}
        onDelete={(m) => void chat.deleteMessage(m)}
        onDelegate={(m) => {
          if (m.id == null) return;
          composerRef.current?.activateAgentMode({ eventId: m.id, label: m.text || 'message' });
        }}
      />
      <MessageActionSheet
        visible={agentConfigVisible}
        actions={[]}
        onClose={() => setAgentConfigVisible(false)}
        content={
          <AgentModeConfig
            sessionTitle={attachedSession?.title}
            isDriver={isDriver}
            target={agentTarget}
            effort={agentEffort}
            onTarget={setAgentTarget}
            onEffort={setAgentEffort}
            onClearAnchor={() => composerRef.current?.clearAgentAnchor()}
          />
        }
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
