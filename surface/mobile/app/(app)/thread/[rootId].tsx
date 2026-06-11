import { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { emptyTimeline, type ChatMessage } from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { colors } from '../../../src/lib/theme';
import { Composer } from '../../../src/components/Composer';
import { MessageActions } from '../../../src/components/MessageActions';
import { Timeline } from '../../../src/components/Timeline';

export default function ThreadScreen() {
  const { rootId: rootIdParam, channelId } = useLocalSearchParams<{
    rootId: string;
    channelId: string;
  }>();
  const rootId = Number(rootIdParam);
  const chat = useChat();
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
  const messages = root ? [root, ...(replies ?? [])] : (replies ?? []);

  const [actionsTarget, setActionsTarget] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [initialDraft, setInitialDraft] = useState('');
  const draftKey =
    channelId && Number.isFinite(rootId) ? `channel:${channelId}:thread:${rootId}` : '';

  useEffect(() => {
    if (!draftKey) return;
    let disposed = false;
    setInitialDraft('');
    void getDraft(draftKey)
      .then((draft) => {
        if (!disposed) setInitialDraft(draft ?? '');
      })
      .catch((err: unknown) => {
        console.warn('failed to load thread draft', err);
      });
    return () => {
      disposed = true;
    };
  }, [draftKey, getDraft]);

  const saveDraft = useCallback(
    (key: string, text: string) => {
      void setDraft(key, text).catch((err: unknown) => {
        console.warn('failed to save thread draft', err);
      });
    },
    [setDraft],
  );

  const openAttachment = useCallback(
    (fileId: string) => {
      void chat.openAttachment(fileId);
    },
    [chat],
  );

  if (!channelId || !Number.isFinite(rootId)) return null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={headerHeight}
      >
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
          fileHeaders={chat.fileHeaders}
          onLoadEarlier={() => Promise.resolve()}
          onLongPress={setActionsTarget}
          onToggleReaction={(m, e) => void chat.react(m, e)}
          onRetry={chat.retry}
          onOpenAttachment={openAttachment}
          onOpenSession={(sessionId) => router.push(`/session/${sessionId}`)}
        />
        <Composer
          placeholder="Reply in thread"
          onSend={(text, attachments) => chat.send(channelId, text, rootId, attachments)}
          onTyping={() => chat.notifyTyping(channelId)}
          draftKey={draftKey}
          initialDraft={initialDraft}
          onDraftChange={saveDraft}
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
        canReply={false}
        onClose={() => setActionsTarget(null)}
        onReact={(m, e) => void chat.react(m, e)}
        onReply={() => {}}
        onEdit={setEditing}
        onDelete={(m) => void chat.deleteMessage(m)}
      />
    </View>
  );
}
