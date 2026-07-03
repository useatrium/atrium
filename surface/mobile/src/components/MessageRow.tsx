import { memo } from 'react';
import { Pressable, Text, View, type AccessibilityActionEvent } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import {
  formatTime,
  formatBytes,
  type Api,
  type ChatMessage,
  type MessageReaction,
  type Session,
} from '@atrium/surface-client';
import { encodeEventHandle } from '@atrium/surface-client/handle';
import { font, radius, space, useTheme } from '../lib/theme';
import { lightImpactHaptic, selectionHaptic } from '../lib/haptics';
import { Avatar } from './Avatar';
import { EntryQuoteCards } from './EntryQuoteCards';
import { MarkdownText } from './Markdown';
import { MessageText } from './MessageText';
import { VoiceMessage } from './VoiceMessage';
import type { ArtifactContentResolver, EntryResolver } from '../lib/entryResolve';

const IMAGE_MAX_W = 240;

type MessageActionTarget = ChatMessage & {
  actionCopyText?: string;
  actionCopyLink?: string;
};

export interface MessageRowProps {
  message: ChatMessage;
  grouped: boolean;
  meId: string;
  meHandle: string | null;
  highlighted?: boolean;
  /** Agent-session entity for session.spawned rows. */
  session?: Session;
  /** Hide the reply-count pill (inside a thread screen). */
  inThread?: boolean;
  fileUrl: (id: string) => string;
  api: Api;
  serverUrl: string;
  resolveEntry: EntryResolver;
  resolveArtifactContent?: ArtifactContentResolver;
  /** Auth headers for in-app image loads. */
  fileHeaders?: Record<string, string>;
  onLongPress: (m: ChatMessage) => void;
  onOpenThread?: (m: ChatMessage) => void;
  onToggleReaction: (m: ChatMessage, emoji: string) => void;
  onRetry: (m: ChatMessage) => void;
  onOpenAttachment: (message: ChatMessage, index: number) => void;
  onOpenChannel?: (channelId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}

function ReactionChips({
  reactions,
  meId,
  onToggle,
}: {
  reactions: MessageReaction[];
  meId: string;
  onToggle: (emoji: string) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
      {reactions.map((r) => {
        const mine = r.userIds.includes(meId);
        return (
          <Pressable
            key={r.emoji}
            accessibilityRole="button"
            accessibilityLabel={`${r.emoji} ${r.userIds.length}${mine ? ', you reacted' : ''}`}
            accessibilityState={{ selected: mine }}
            onPress={() => onToggle(r.emoji)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              minHeight: 44,
              paddingHorizontal: 12,
              paddingVertical: 3,
              borderRadius: 999,
              backgroundColor: mine ? colors.accentBg : colors.bgElevated,
              borderWidth: 1,
              borderColor: mine ? colors.accent : colors.border,
            }}
          >
            <Text style={{ fontSize: 13 }}>{r.emoji}</Text>
            <Text
              style={{
                fontSize: font.xs,
                fontWeight: '600',
                color: mine ? colors.accent : colors.textSecondary,
              }}
            >
              {r.userIds.length}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Attachments({
  message,
  fileUrl,
  fileHeaders,
  onOpenAttachment,
}: {
  message: ChatMessage;
  fileUrl: (id: string) => string;
  fileHeaders?: Record<string, string>;
  onOpenAttachment: (message: ChatMessage, index: number) => void;
}) {
  const { colors } = useTheme();
  if (!message.attachments?.length) return null;
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      {message.attachments.map((a, index) => {
        if (a.contentType.startsWith('image/')) {
          const ratio = a.width && a.height ? a.width / a.height : 4 / 3;
          const w = Math.min(IMAGE_MAX_W, a.width ?? IMAGE_MAX_W);
          return (
            <Pressable
              key={a.id}
              accessibilityRole="imagebutton"
              accessibilityLabel={a.filename}
              onPress={() => onOpenAttachment(message, index)}
            >
              <Image
                source={{ uri: fileUrl(a.id), headers: fileHeaders }}
                style={{
                  width: w,
                  height: Math.round(w / ratio),
                  borderRadius: radius.md,
                  backgroundColor: colors.bgElevated,
                }}
                contentFit="cover"
                transition={120}
              />
            </Pressable>
          );
        }
        return (
          <Pressable
            key={a.id}
            accessibilityRole="button"
            accessibilityLabel={`${a.filename}, ${formatBytes(a.size)}`}
            onPress={() => onOpenAttachment(message, index)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              padding: space.sm,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.bgElevated,
              alignSelf: 'flex-start',
              maxWidth: 280,
            }}
          >
            <Ionicons name="attach-outline" size={18} color={colors.textSecondary} />
            <View style={{ flexShrink: 1 }}>
              <Text style={{ color: colors.text, fontSize: font.sm }} numberOfLines={1}>
                {a.filename}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: font.xs }}>{formatBytes(a.size)}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Agent-session rows render as a compact status card; tap through to the mobile viewer. */
function SessionCard({
  message,
  session,
  onOpen,
}: {
  message: ChatMessage;
  session?: Session;
  onOpen?: (sessionId: string) => void;
}) {
  const { colors } = useTheme();
  const status = session?.status ?? 'spawning';
  const needsInput = session?.pendingQuestion != null;
  const statusColor = needsInput
    ? colors.warning
    : status === 'completed'
      ? colors.online
      : status === 'failed' || status === 'cancelled'
        ? colors.danger
        : colors.warning;
  return (
    <Pressable
      disabled={!message.sessionId || !onOpen}
      onPress={() => {
        if (message.sessionId) onOpen?.(message.sessionId);
      }}
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgElevated,
        borderRadius: radius.md,
        padding: space.md,
        gap: 4,
        marginTop: 2,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name="hardware-chip-outline" size={13} color={colors.textMuted} />
        <Text style={{ fontSize: font.xs, color: colors.textMuted, fontWeight: '700' }}>AGENT SESSION</Text>
        <Text style={{ fontSize: font.xs, color: statusColor, fontWeight: '700' }}>
          {needsInput ? 'NEEDS INPUT' : status.toUpperCase()}
        </Text>
      </View>
      <Text style={{ color: colors.text, fontSize: font.sm, lineHeight: 20 }}>{session?.title ?? message.text}</Text>
      {session?.resultText ? (
        <Text style={{ color: colors.textSecondary, fontSize: font.xs, lineHeight: 18 }}>{session.resultText}</Text>
      ) : null}
      <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '700' }}>Open full transcript</Text>
    </Pressable>
  );
}

function SessionEventLine({ message, onOpen }: { message: ChatMessage; onOpen?: (sessionId: string) => void }) {
  const { colors } = useTheme();
  const payload = message.sessionEventPayload ?? {};
  const questions = questionPayloadPrompts(payload);
  const answers = questionPayloadAnswers(payload);
  const questionText = questions[0]?.question ?? 'Agent asked a question';
  const label = sessionQuestionEventLabel(message.sessionEventType, payload.reason);

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.sm,
        backgroundColor: colors.bgElevated,
        padding: space.sm,
        gap: 6,
        marginTop: 4,
      }}
    >
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '800' }}>{label}</Text>
        <Text style={{ color: colors.textMuted, fontSize: font.xs }}>{formatTime(message.createdAt)}</Text>
      </View>
      {message.sessionEventType === 'question_requested' ? (
        <MarkdownText text={questionText} variant="compact" />
      ) : null}
      {answers.map((answer) => (
        <View
          key={answer.id}
          style={{
            borderWidth: 1,
            borderColor: colors.accent,
            backgroundColor: colors.accentBg,
            borderRadius: radius.sm,
            padding: space.sm,
            gap: 3,
          }}
        >
          <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '900' }}>{answer.header}</Text>
          <MarkdownText
            text={
              answer.answers.length > 0
                ? answer.answers.join('\n')
                : answer.count === 1
                  ? '1 answer recorded'
                  : `${answer.count} answers recorded`
            }
            variant="compact"
          />
        </View>
      ))}
      {message.sessionId && onOpen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open session pane for this question event"
          onPress={() => onOpen(message.sessionId!)}
          hitSlop={8}
          style={{ alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center' }}
        >
          <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '700' }}>Open pane</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function questionPayloadPrompts(payload: Record<string, unknown>): Array<{ question: string }> {
  if (!Array.isArray(payload.questions)) return [];
  return payload.questions
    .map((item): { question: string } | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const raw = item as Record<string, unknown>;
      return typeof raw.question === 'string' && raw.question.trim() ? { question: raw.question } : null;
    })
    .filter((item): item is { question: string } => item !== null);
}

function questionPayloadAnswers(
  payload: Record<string, unknown>,
): Array<{ id: string; header: string; answers: string[]; count: number }> {
  if (!Array.isArray(payload.answers)) return [];
  return payload.answers
    .map((item): { id: string; header: string; answers: string[]; count: number } | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const raw = item as Record<string, unknown>;
      if (typeof raw.id !== 'string') return null;
      const answers = Array.isArray(raw.answers)
        ? raw.answers.filter((answer): answer is string => typeof answer === 'string')
        : [];
      return {
        id: raw.id,
        header: typeof raw.header === 'string' ? raw.header : raw.id,
        answers,
        count: typeof raw.count === 'number' && Number.isFinite(raw.count) ? raw.count : answers.length,
      };
    })
    .filter((item): item is { id: string; header: string; answers: string[]; count: number } => item !== null);
}

function compactLines(lines: Array<string | null | undefined>): string {
  return lines
    .map((line) => line?.trim() ?? '')
    .filter((line) => line.length > 0)
    .join('\n');
}

function sessionQuestionEventLabel(type: ChatMessage['sessionEventType'], reason: unknown): string {
  if (type === 'question_requested') return 'Question asked';
  if (type === 'question_answered') return 'Question answered';
  if (reason === 'empty') return 'Question expired without an answer';
  if (reason === 'cancelled') return 'Question cancelled';
  return 'Question resolved';
}

function sessionEventVisibleText(message: ChatMessage): string {
  const payload = message.sessionEventPayload ?? {};
  const questions = questionPayloadPrompts(payload);
  const answers = questionPayloadAnswers(payload);
  const questionText = questions[0]?.question ?? 'Agent asked a question';
  const lines = [sessionQuestionEventLabel(message.sessionEventType, payload.reason)];
  if (message.sessionEventType === 'question_requested') lines.push(questionText);
  for (const answer of answers) {
    lines.push(answer.header);
    lines.push(
      answer.answers.length > 0
        ? answer.answers.join('\n')
        : answer.count === 1
          ? '1 answer recorded'
          : `${answer.count} answers recorded`,
    );
  }
  return compactLines(lines);
}

function sessionCardVisibleText(message: ChatMessage, session?: Session): string {
  const title = (typeof session?.title === 'string' ? session.title : message.text).trim() || 'Agent session';
  const resultText = typeof session?.resultText === 'string' ? session.resultText : '';
  return compactLines([title, resultText]);
}

function actionCopyTextForMessage(message: ChatMessage, session: Session | undefined, rowText: string): string | null {
  if (message.deleted === true) return null;
  if (message.sessionEventType != null) return sessionEventVisibleText(message) || rowText;
  if (message.sessionId != null) return sessionCardVisibleText(message, session) || rowText;
  return message.text.trim() ? message.text : null;
}

type MessageWithHandle = ChatMessage & { handle?: string | null };

function entryHandleForAction(message: ChatMessage): string | null {
  if (message.deleted === true || message.status !== 'confirmed') return null;
  const explicitHandle = (message as MessageWithHandle).handle;
  if (typeof explicitHandle === 'string' && explicitHandle.length > 0) return explicitHandle;
  return message.id != null ? encodeEventHandle(message.id) : null;
}

function actionTargetForMessage(message: ChatMessage, copyText: string | null, copyLink: string | null): ChatMessage {
  const target =
    copyText == null || copyText === message.text ? message : ({ ...message, actionCopyText: copyText } as MessageActionTarget);
  if (copyLink == null) return target;
  return { ...target, actionCopyLink: copyLink } as MessageActionTarget;
}

export const MessageRow = memo(function MessageRow({
  message: m,
  grouped,
  meId,
  meHandle,
  highlighted,
  session,
  inThread,
  fileUrl,
  api,
  serverUrl,
  resolveEntry,
  resolveArtifactContent,
  fileHeaders,
  onLongPress,
  onOpenThread,
  onToggleReaction,
  onRetry,
  onOpenAttachment,
  onOpenChannel,
  onOpenSession,
}: MessageRowProps) {
  const { colors } = useTheme();
  const pending = m.status === 'pending';
  const failed = m.status === 'failed';
  const tombstone = m.deleted === true;
  const sessionBlock = m.sessionId != null || m.sessionEventType != null;
  const attachmentDescription = m.attachments?.length
    ? m.attachments.map((a) => `attachment ${a.filename}`).join(', ')
    : '';
  const blockRowText =
    m.sessionEventType != null ? sessionEventVisibleText(m) : m.sessionId != null ? sessionCardVisibleText(m, session) : '';
  const rowText = tombstone
    ? 'Message deleted'
    : (sessionBlock ? blockRowText : m.text.trim()) ||
      m.text.trim() ||
      (m.voice ? 'Voice message' : attachmentDescription) ||
      (m.sessionId ? 'Agent session' : 'Message');
  const rowLabel = `${m.author.displayName}, ${formatTime(m.createdAt)}: ${rowText}`;
  const own = m.author.id === meId;
  const copyText = actionCopyTextForMessage(m, session, rowText);
  const entryHandle = entryHandleForAction(m);
  const copyLink = entryHandle ? `${serverUrl.replace(/\/+$/, '')}/e/${encodeURIComponent(entryHandle)}` : null;
  const canOpenActionMenu = !tombstone && (!sessionBlock || copyText != null || copyLink != null);
  const accessibilityActions = [
    ...(failed ? [{ name: 'retry', label: 'Retry sending' }] : []),
    ...(!tombstone && !sessionBlock && onOpenThread && !inThread
      ? [{ name: 'reply', label: 'Reply in thread' }]
      : []),
    ...(!tombstone && !sessionBlock ? [{ name: 'react', label: 'React' }] : []),
    ...(copyText != null ? [{ name: 'copy', label: 'Copy text' }] : []),
    ...(copyLink != null ? [{ name: 'copy_link', label: 'Copy link' }] : []),
    ...(own && !tombstone && !sessionBlock
      ? [
          { name: 'edit', label: 'Edit message' },
          { name: 'delete', label: 'Delete message' },
        ]
      : []),
  ];

  const onAccessibilityAction = (event: AccessibilityActionEvent) => {
    const name = event.nativeEvent.actionName;
    if (name === 'retry') {
      onRetry(m);
      return;
    }
    if (name === 'reply' && onOpenThread) {
      onOpenThread(m);
      return;
    }
    if (['react', 'copy', 'copy_link', 'edit', 'delete'].includes(name) && canOpenActionMenu) {
      onLongPress(actionTargetForMessage(m, copyText, copyLink));
    }
  };

  const body = tombstone ? (
    <Text style={{ color: colors.textFaint, fontSize: font.md, fontStyle: 'italic' }}>Message deleted</Text>
  ) : m.sessionEventType != null ? (
    <SessionEventLine message={m} onOpen={onOpenSession} />
  ) : m.sessionId != null ? (
    <SessionCard message={m} session={session} onOpen={onOpenSession} />
  ) : (
    <>
      {m.text ? <MessageText text={m.text} meHandle={meHandle} muted={pending} /> : null}
      {m.voice ? (
        <VoiceMessage voice={m.voice} api={api} fileUrl={fileUrl} fileHeaders={fileHeaders} />
      ) : (
        <Attachments message={m} fileUrl={fileUrl} fileHeaders={fileHeaders} onOpenAttachment={onOpenAttachment} />
      )}
    </>
  );

  const avatar = (
    <View style={{ width: 36, alignItems: 'center' }}>
      {!grouped && <Avatar name={m.author.displayName} seed={m.author.id} size={36} />}
    </View>
  );

  const header = !grouped ? (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
      <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '700' }}>{m.author.displayName}</Text>
      <Text style={{ color: colors.textFaint, fontSize: font.xs }}>{formatTime(m.createdAt)}</Text>
    </View>
  ) : null;

  const editedNote =
    m.pendingEdit && !tombstone ? (
      <Text style={{ color: colors.warning, fontSize: font.xs }}>(saving edit)</Text>
    ) : m.edited && !tombstone ? (
      <Text style={{ color: colors.textFaint, fontSize: font.xs }}>(edited)</Text>
    ) : null;

  const containerStyle = {
    flexDirection: 'row' as const,
    paddingHorizontal: space.lg,
    paddingTop: grouped ? 1 : space.sm,
    paddingBottom: 1,
    gap: space.md,
    opacity: pending ? 0.55 : 1,
  };

  // Session / tombstone rows have no inline controls, so keep them as a single
  // accessible row element (the card / tombstone is the whole content).
  if (tombstone || m.sessionId != null || m.sessionEventType != null) {
    return (
      <Pressable
        accessible
        accessibilityRole="button"
        accessibilityLabel={rowLabel}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
        onLongPress={() => {
          if (!canOpenActionMenu) return;
          lightImpactHaptic();
          onLongPress(actionTargetForMessage(m, copyText, copyLink));
        }}
        delayLongPress={250}
        style={({ pressed }) => ({
          ...containerStyle,
          backgroundColor: highlighted ? colors.accentBg : pressed ? colors.borderSoft : 'transparent',
        })}
      >
        {avatar}
        <View style={{ flex: 1, minWidth: 0 }}>
          {header}
          {body}
          {editedNote}
        </View>
      </Pressable>
    );
  }

  // Regular message: the row container is NOT an accessibility element, so each
  // control below is an independent, individually-reachable button (VoiceOver +
  // UI test drivers). The message body keeps the label and the full action menu
  // (the long-press sheet: react / reply / copy / edit / delete) for VoiceOver.
  return (
    <View
      style={{
        ...containerStyle,
        backgroundColor: highlighted ? colors.accentBg : 'transparent',
      }}
    >
      {avatar}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Pressable
          accessibilityRole="text"
          accessibilityLabel={rowLabel}
          accessibilityActions={accessibilityActions}
          onAccessibilityAction={onAccessibilityAction}
          onLongPress={() => {
            lightImpactHaptic();
            onLongPress(actionTargetForMessage(m, copyText, copyLink));
          }}
          delayLongPress={250}
          style={({ pressed }) => ({
            backgroundColor: pressed ? colors.borderSoft : 'transparent',
          })}
        >
          {header}
          {body}
          {editedNote}
        </Pressable>
        {m.text ? (
          <EntryQuoteCards
            text={m.text}
            serverUrl={serverUrl}
            resolveEntry={resolveEntry}
            resolveArtifactContent={resolveArtifactContent}
            onOpenChannel={onOpenChannel}
            onOpenSession={onOpenSession}
          />
        ) : null}
        {failed && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Failed to send. Tap to retry."
            onPress={() => onRetry(m)}
            hitSlop={10}
            style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
          >
            <Text style={{ color: colors.danger, fontSize: font.xs, marginTop: 2 }}>Failed to send — tap to retry</Text>
          </Pressable>
        )}
        {m.reactions && m.reactions.length > 0 && (
          <ReactionChips
            reactions={m.reactions}
            meId={meId}
            onToggle={(emoji) => {
              selectionHaptic();
              onToggleReaction(m, emoji);
            }}
          />
        )}
        {!inThread && m.replyCount > 0 && onOpenThread && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}`}
            onPress={() => onOpenThread(m)}
            hitSlop={10}
            style={{ marginTop: 4, minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
          >
            <Text style={{ color: colors.accent, fontSize: font.sm, fontWeight: '600' }}>
              {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'} →
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
});
