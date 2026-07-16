import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import {
  attachedSessionForRoot,
  channelLabel,
  deriveSessionGlance,
  emptyTimeline,
  isTerminalSessionStatus,
  sessionDriverId,
  sessionGlanceClockLabel,
  agentDestination,
  peopleDestination,
  type AgentComposerRequest,
  type ChatMessage,
  type HubFile,
} from '@atrium/surface-client';
import {
  artifactCount,
  changedPaths,
  collectArtifacts,
  collectFileChanges,
  foldedTurnRows,
  focusTranscriptRows,
  fullTranscriptRows,
  isLiveFold,
  isTerminalExecutionStatus,
} from '@atrium/centaur-client';
import { useChat } from '../../../src/lib/chat';
import { font, radius, space, useTheme } from '../../../src/lib/theme';
import { useSessionStream } from '../../../src/lib/useSessionStream';
import { mapFoldedTurnRow } from '../../../src/lib/threadWorkFold';
import { glanceColor } from '../../../src/lib/sessionGlance';
import { parseUnfurlPreviewArtifactId, unfurlPreviewContentUrl } from '../../../src/lib/unfurlPreview';
import { attachmentToHubFile } from '../../../src/components/attachmentPreview';
import { Composer, type ComposerHandle } from '../../../src/components/Composer';
import { MediaLightbox } from '../../../src/components/MediaLightbox';
import { AgentFileMarkdownProvider } from '../../../src/components/FilePathChip';
import { MessageActions, MessageActionSheet } from '../../../src/components/MessageActions';
import { AgentModeConfig, type AgentEffort, type AgentModeTarget } from '../../../src/components/AgentModeConfig';
import { Timeline } from '../../../src/components/Timeline';
import { AgentMark } from '../../../src/components/AgentMark';
import { HiddenWorkChip } from '../../../src/components/HiddenWorkChip';
import { ArtifactsSurface } from '../../../src/components/work/ArtifactsSurface';
import { ChangesSurface } from '../../../src/components/work/ChangesSurface';
import { MobileWorkSheet, type WorkSurfaceTab } from '../../../src/components/work/MobileWorkSheet';
import { WorkStrips, type WorkStripItem } from '../../../src/components/work/WorkStrips';

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
  const [workTab, setWorkTab] = useState<string | null>(null);
  const [agentTarget, setAgentTarget] = useState<AgentModeTarget>('steer');
  const [agentEffort, setAgentEffort] = useState<AgentEffort>('medium');
  const composerRef = useRef<ComposerHandle>(null);
  const draftKey = channelId && Number.isFinite(rootId) ? `channel:${channelId}:thread:${rootId}` : '';
  const composerChannel = state.channels.find((candidate) => candidate.id === channelId) ?? null;
  const broadcastChannelLabel = composerChannel
    ? composerChannel.kind === 'dm' || composerChannel.kind === 'gdm'
      ? channelLabel(composerChannel, me.id)
      : `#${composerChannel.name}`
    : undefined;
  const attachedSession = useMemo(
    () => attachedSessionForRoot(state.sessions, { id: rootId, sessionId: root?.sessionId }, channelId) ?? null,
    [channelId, root?.sessionId, rootId, state.sessions],
  );
  const sessionTerminal = attachedSession ? isTerminalSessionStatus(attachedSession.status) : false;
  const { stream } = useSessionStream(attachedSession?.id ?? null, attachedSession != null && !sessionTerminal);
  const fullRows = useMemo(() => fullTranscriptRows(stream.items, () => []), [stream.items]);
  const focusRows = useMemo(() => focusTranscriptRows(stream.items, () => []), [stream.items]);
  const transcriptItems = useMemo(() => fullRows.flatMap((row) => (row.kind === 'item' ? [row.item] : [])), [fullRows]);
  const turnFolds = useMemo(() => foldedTurnRows(transcriptItems), [transcriptItems]);
  const workFolds = useMemo(() => turnFolds.map(mapFoldedTurnRow), [turnFolds]);
  const fileChanges = useMemo(() => collectFileChanges(stream), [stream]);
  const changedFileCount = useMemo(() => changedPaths(fileChanges).length, [fileChanges]);
  const artifacts = useMemo(() => collectArtifacts(stream), [stream]);
  const artifactsN = useMemo(() => artifactCount(artifacts), [artifacts]);
  const stepCount = useMemo(
    () =>
      focusRows.reduce((count, row) => count + (row.kind === 'hidden' ? row.count : row.kind === 'item' ? 1 : 0), 0),
    [focusRows],
  );
  const workTabs = useMemo<WorkSurfaceTab[]>(() => {
    if (!attachedSession) return [];
    const tabs: WorkSurfaceTab[] = [];
    if (changedFileCount > 0) {
      tabs.push({
        key: 'files',
        label: 'Files',
        count: changedFileCount,
        render: () => <ChangesSurface changes={fileChanges} />,
      });
    }
    if (stepCount > 0) {
      tabs.push({
        key: 'whatRan',
        label: 'What it ran',
        count: stepCount,
        render: () => (
          <ScrollView contentContainerStyle={{ padding: space.md, gap: space.sm }}>
            {workFolds
              .flatMap((fold) => fold.steps)
              .map((step) => (
                <View key={step.id} style={{ gap: space.xxs }}>
                  <Text style={{ color: colors.text, fontFamily: 'monospace', fontSize: font.xs }}>{step.label}</Text>
                  {step.detail ? (
                    <Text style={{ color: colors.textMuted, fontFamily: 'monospace', fontSize: font.xs }}>
                      {step.detail}
                    </Text>
                  ) : null}
                </View>
              ))}
          </ScrollView>
        ),
      });
    }
    if (artifactsN > 0) {
      tabs.push({
        key: 'artifacts',
        label: 'Artifacts',
        count: artifactsN,
        render: () => (
          <ArtifactsSurface
            artifacts={artifacts}
            artifactUri={(artifact) => chat.artifactUrl(attachedSession.id, artifact)}
            imageHeaders={chat.fileHeaders}
          />
        ),
      });
    }
    return tabs;
  }, [
    artifacts,
    artifactsN,
    attachedSession,
    changedFileCount,
    chat,
    colors.text,
    colors.textMuted,
    fileChanges,
    stepCount,
    workFolds,
  ]);
  const workStripItems = useMemo<WorkStripItem[]>(
    () => [
      { key: 'files', label: '≡ files', count: changedFileCount },
      { key: 'whatRan', label: '⚙ steps', count: stepCount },
      { key: 'artifacts', label: '▣ artifacts', count: artifactsN },
    ],
    [artifactsN, changedFileCount, stepCount],
  );
  const workFoldNodes = useMemo(
    () =>
      turnFolds.map((fold, index) => {
        const view = workFolds[index];
        if (!view) return null;
        return (
          <HiddenWorkChip
            key={fold.key}
            count={view.steps.length}
            duration={view.duration}
            steps={view.steps}
            live={isLiveFold(fold, turnFolds, !sessionTerminal && !isTerminalExecutionStatus(stream.status))}
            onShowFull={() => setWorkTab('whatRan')}
          />
        );
      }),
    [sessionTerminal, stream.status, turnFolds, workFolds],
  );
  // Canonical seat resolution: null driverId falls back to the spawner.
  const isDriver = attachedSession != null && sessionDriverId(attachedSession) === me.id;
  const agentTargetLabel = attachedSession ? attachedSession.title : 'this thread';
  const agentRequest: AgentComposerRequest =
    attachedSession && agentTarget === 'steer'
      ? isDriver
        ? { target: 'steer', sessionId: attachedSession.id, threadRootEventId: rootId, effort: agentEffort }
        : { target: 'suggest', sessionId: attachedSession.id, threadRootEventId: rootId }
      : { target: 'spawn-thread', threadRootEventId: rootId, effort: agentEffort };

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
      const preview = parseUnfurlPreviewArtifactId(file.artifactId);
      if (preview) {
        await Linking.openURL(preview.targetUrl);
        return;
      }
      const { url } = await chat.api.fileSignedUrl(file.artifactId);
      const absoluteUrl = /^https?:\/\//i.test(url)
        ? url
        : `${new URL(chat.api.fileUrl(file.artifactId)).origin}${url}`;
      await Linking.openURL(absoluteUrl);
    },
    [chat.api],
  );

  const sessionGlance = attachedSession ? deriveSessionGlance(attachedSession, Date.now()) : null;
  const sessionClock = sessionGlance ? sessionGlanceClockLabel(sessionGlance, Date.now()) : null;

  if (!channelId || !Number.isFinite(rootId)) return null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {attachedSession && sessionGlance ? (
        <Stack.Screen
          options={{
            headerBackButtonDisplayMode: 'minimal',
            headerTitle: () => (
              <View style={{ maxWidth: 280, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <AgentMark size={18} />
                <Text numberOfLines={1} style={{ flex: 1, color: colors.text, fontSize: font.sm, fontWeight: '800' }}>
                  {attachedSession.title}
                </Text>
                <View
                  style={{
                    borderRadius: radius.lg,
                    backgroundColor: colors.bgElevated,
                    paddingHorizontal: space.sm,
                    paddingVertical: space.xxs,
                  }}
                >
                  <Text
                    numberOfLines={1}
                    style={{ color: glanceColor(sessionGlance.kind, colors), fontSize: font.xs, fontWeight: '700' }}
                  >
                    {sessionGlance.label}
                    {sessionClock ? ` · ${sessionClock}` : ''}
                  </Text>
                </View>
              </View>
            ),
          }}
        />
      ) : null}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={headerHeight}
      >
        {attachedSession ? <WorkStrips items={workStripItems} onOpen={setWorkTab} /> : null}
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
          <AgentFileMarkdownProvider
            value={{
              serverUrl: chat.serverUrl,
              fileHeaders: chat.fileHeaders,
              channelId,
              onOpenFile: (file) => setAttachmentLightbox({ files: [file], initialIndex: 0 }),
            }}
          >
            <Timeline
              messages={messages}
              loaded={replies !== undefined}
              hasMoreBefore={false}
              sessions={state.sessions}
              channels={state.channels}
              sessionSpineId={attachedSession?.id}
              threadWorkFolds={workFoldNodes}
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
              resolveUnfurls={chat.resolveUnfurls}
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
          </AgentFileMarkdownProvider>
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
          // Asides are thread-only by design: a session-attached thread never
          // offers "Also send to channel" (the terminal answer broadcasts itself).
          showBroadcastToggle={attachedSession == null}
          broadcastChannelLabel={broadcastChannelLabel}
          previewEntryLinks
          serverUrl={chat.serverUrl}
          resolveEntry={chat.resolveEntry}
          onOpenChannel={(channelId) => router.push(`/channel/${channelId}`)}
          onOpenSession={(sessionId) => router.push(`/session/${sessionId}`)}
          uploadFile={chat.uploadFile}
          peopleDestination={peopleDestination('thread', 'this thread')}
          agentRouting={{
            destination: agentDestination(agentRequest, agentTargetLabel),
            onSubmit: (request, submission) => {
              const media = {
                attachments: submission.attachments,
                attachmentRefs: submission.attachmentRefs,
              };
              if (request.target === 'steer') {
                void chat.steerSession(request.sessionId, submission.text, request.effort, {
                  postToThread: true,
                  ...media,
                });
              } else if (request.target === 'suggest') {
                void chat.suggestToSession(request.sessionId, submission.text, media);
              } else {
                chat.spawnSession(channelId, submission.text, rootId, {
                  broadcastCard: true,
                  effort: request.effort,
                  anchorEventId: request.anchorEventId,
                  ...media,
                });
              }
            },
          }}
          initialAgentMode={attachedSession != null}
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
        fileContentUrl={(artifactId) =>
          unfurlPreviewContentUrl(artifactId, chat.serverUrl) ?? chat.api.fileUrl(artifactId)
        }
        fileHeaders={chat.fileHeaders}
        onClose={() => setAttachmentLightbox(null)}
        onOpenExternal={openExternal}
      />
      <MobileWorkSheet
        visible={workTab != null}
        tabs={workTabs}
        activeKey={workTab}
        onTab={setWorkTab}
        onClose={() => setWorkTab(null)}
      />
    </View>
  );
}
