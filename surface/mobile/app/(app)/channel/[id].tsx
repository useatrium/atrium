import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Text, View } from 'react-native';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import {
  channelLabel,
  emptyTimeline,
  type ChatMessage,
} from '@atrium/surface-client';
import { useChat } from '../../../src/lib/chat';
import { colors, font } from '../../../src/lib/theme';
import { ConnectionBanner, TypingLine } from '../../../src/components/bits';
import { Composer } from '../../../src/components/Composer';
import { MessageActions } from '../../../src/components/MessageActions';
import { Timeline } from '../../../src/components/Timeline';

export default function ChannelScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chat = useChat();
  const { state, me } = chat;

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

  const [actionsTarget, setActionsTarget] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);

  const title = channel ? channelLabel(channel, me.id) : '';
  const isDm = channel?.kind === 'dm';

  const openThread = useCallback(
    (m: ChatMessage) => {
      if (m.id == null || !id) return;
      router.push({ pathname: '/thread/[rootId]', params: { rootId: String(m.id), channelId: id } });
    },
    [id],
  );

  const openAttachment = useCallback(
    (fileId: string) => {
      Linking.openURL(chat.fileUrl(fileId)).catch(() => {});
    },
    [chat],
  );

  if (!id) return null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View>
              <Text style={{ color: colors.text, fontSize: font.lg, fontWeight: '700' }}>
                {isDm ? title : `#${title}`}
              </Text>
              {presentCount > 0 && (
                <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
                  {presentCount} here now
                </Text>
              )}
            </View>
          ),
          headerBackButtonDisplayMode: 'minimal',
        }}
      />
      <ConnectionBanner status={state.wsStatus} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={headerHeight}
      >
        <Timeline
          messages={timeline.main}
          loaded={timeline.loaded}
          hasMoreBefore={timeline.hasMoreBefore}
          sessions={state.sessions}
          meId={me.id}
          meHandle={state.meHandle}
          highlightId={chat.highlightId}
          fileUrl={chat.fileUrl}
          onLoadEarlier={() => chat.loadEarlier(id)}
          onLongPress={setActionsTarget}
          onOpenThread={openThread}
          onToggleReaction={(m, e) => void chat.react(m, e)}
          onRetry={chat.retry}
          onOpenAttachment={openAttachment}
        />
        <TypingLine typing={chat.typing} />
        <Composer
          placeholder={isDm ? `Message ${title}` : `Message #${title}`}
          onSend={(text, attachments) => chat.send(id, text, undefined, attachments)}
          onTyping={() => chat.notifyTyping(id)}
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
        onClose={() => setActionsTarget(null)}
        onReact={(m, e) => void chat.react(m, e)}
        onReply={openThread}
        onEdit={setEditing}
        onDelete={(m) => void chat.deleteMessage(m)}
      />
    </View>
  );
}
