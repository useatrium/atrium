import { memo, useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  deriveSessionGlance,
  formatExactTimestamp,
  formatTime,
  formatBytes,
  mentionsUser,
  questionAnswerSummaryText,
  questionPayloadAnswers,
  questionPayloadPrompts,
  sessionAnsweredQuestion,
  sessionDriverId,
  sessionGlanceClockLabel,
  sessionQuestionEventLabel,
  type Api,
  type ChatMessage,
  type MessageReaction,
  type Session,
  type UserRef,
} from '@atrium/surface-client';
import { encodeEventHandle } from '@atrium/surface-client/handle';
import { font, radius, space, useTheme } from '../lib/theme';
import { useAccessibilityAnnouncement } from '../lib/accessibility';
import { lightImpactHaptic, selectionHaptic } from '../lib/haptics';
import { partitionEntryLinks, unsuppressedEntryHandles } from '../lib/entryLinks';
import { AnsweredQuestionTrace } from './AnsweredQuestionTrace';
import { Avatar } from './Avatar';
import { EntryQuoteCards } from './EntryQuoteCards';
import { EntryReferenceMarkdownProvider, MarkdownText } from './Markdown';
import { MessageText } from './MessageText';
import { TimestampText } from './TimestampText';
import { VoiceMessage } from './VoiceMessage';
import type { ArtifactContentResolver, EntryResolver } from '../lib/entryResolve';
import { glanceColor } from '../lib/sessionGlance';

const IMAGE_MAX_W = 240;
const SWIPE_REPLY_THRESHOLD = 64;
const SWIPE_REPLY_MAX = 96;
const SWIPE_REPLY_SPRING = { damping: 18, stiffness: 260 };

type SwipePanEvent = { translationX: number };
type PanGestureBuilder = {
  enabled: (value: boolean) => PanGestureBuilder;
  activeOffsetX: (value: number | [number, number]) => PanGestureBuilder;
  failOffsetY: (value: [number, number]) => PanGestureBuilder;
  onUpdate: (handler: (event: SwipePanEvent) => void) => PanGestureBuilder;
  onEnd: (handler: (event: SwipePanEvent) => void) => PanGestureBuilder;
  onFinalize: (handler: () => void) => PanGestureBuilder;
};
type GestureRuntime = {
  Gesture: { Pan: () => PanGestureBuilder };
  GestureDetector: ComponentType<{ gesture: PanGestureBuilder; children: ReactNode }>;
};
type SharedValue<T> = { value: T };
type AnimatedViewComponent = ComponentType<{
  children?: ReactNode;
  pointerEvents?: 'box-none' | 'none' | 'box-only' | 'auto';
  style?: StyleProp<ViewStyle>;
}>;
type ReanimatedRuntime = {
  default: { View: AnimatedViewComponent };
  Extrapolation: { CLAMP: string | number };
  interpolate: (
    value: number,
    input: readonly number[],
    output: readonly number[],
    extrapolate?: string | number,
  ) => number;
  runOnJS: <T extends () => void>(fn: T) => T;
  useAnimatedStyle: <T>(updater: () => T) => T;
  useSharedValue: <T>(initialValue: T) => SharedValue<T>;
  withSpring: <T>(toValue: T, config?: Record<string, number>) => T;
};

declare const require: (id: string) => unknown;

function createNoopPanGesture(): PanGestureBuilder {
  const chain: PanGestureBuilder = {
    enabled: () => chain,
    activeOffsetX: () => chain,
    failOffsetY: () => chain,
    onUpdate: () => chain,
    onEnd: () => chain,
    onFinalize: () => chain,
  };
  return chain;
}

function interpolateForTest(value: number, input: readonly number[], output: readonly number[]) {
  const inputStart = input[0] ?? 0;
  const inputEnd = input[1] ?? inputStart;
  const outputStart = output[0] ?? 0;
  const outputEnd = output[1] ?? outputStart;
  if (inputEnd === inputStart) return outputEnd;
  const progress = Math.max(0, Math.min(1, (value - inputStart) / (inputEnd - inputStart)));
  return outputStart + (outputEnd - outputStart) * progress;
}

function loadGestureRuntime(): GestureRuntime {
  if (process.env.NODE_ENV === 'test') {
    return {
      Gesture: { Pan: createNoopPanGesture },
      GestureDetector: ({ children }) => <>{children}</>,
    };
  }
  return require('react-native-gesture-handler') as GestureRuntime;
}

function loadReanimatedRuntime(): ReanimatedRuntime {
  if (process.env.NODE_ENV === 'test') {
    return {
      default: { View },
      Extrapolation: { CLAMP: 'clamp' },
      interpolate: interpolateForTest,
      runOnJS: (fn) => fn,
      useAnimatedStyle: (updater) => updater(),
      useSharedValue: (initialValue) => ({ value: initialValue }),
      withSpring: (toValue) => toValue,
    };
  }
  return require('react-native-reanimated') as ReanimatedRuntime;
}

const { Gesture, GestureDetector } = loadGestureRuntime();
const {
  default: Animated,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} = loadReanimatedRuntime();

type MessageActionTarget = ChatMessage & {
  actionCopyText?: string;
  actionCopyLink?: string;
};

type UserResolver = (id: string) => UserRef | undefined;

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
  resolveUser?: UserResolver;
  /** Auth headers for in-app image loads. */
  fileHeaders?: Record<string, string>;
  onLongPress: (m: ChatMessage) => void;
  onOpenThread?: (m: ChatMessage) => void;
  onToggleReaction: (m: ChatMessage, emoji: string) => void;
  onRetry: (m: ChatMessage) => void;
  onOpenAttachment: (message: ChatMessage, index: number) => void;
  onOpenChannel?: (channelId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onAnswerSessionQuestion?: (
    sessionId: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
  ) => Promise<void>;
  onSuggestSessionAnswer?: (sessionId: string, text: string) => Promise<void>;
}

function ReactionChips({
  reactions,
  meId,
  onToggle,
  resolveUser,
}: {
  reactions: MessageReaction[];
  meId: string;
  onToggle: (emoji: string) => void;
  resolveUser?: UserResolver;
}) {
  const { colors } = useTheme();
  const [selectedEmoji, setSelectedEmoji] = useState<string | null>(null);
  const selectedReaction = selectedEmoji ? reactions.find((r) => r.emoji === selectedEmoji) : undefined;
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: space.xs }}>
        {reactions.map((r) => {
          const mine = r.userIds.includes(meId);
          const countLabel = r.userIds.length === 1 ? '1 reaction' : `${r.userIds.length} reactions`;
          return (
            <Pressable
              key={r.emoji}
              accessibilityRole="button"
              accessibilityLabel={`${r.emoji} ${countLabel}${mine ? ', you reacted' : ''}`}
              accessibilityHint={resolveUser ? 'Long press to show who reacted' : undefined}
              accessibilityState={{ selected: mine }}
              onPress={(event: GestureResponderEvent) => {
                event.stopPropagation();
                onToggle(r.emoji);
              }}
              onLongPress={
                resolveUser
                  ? (event: GestureResponderEvent) => {
                      event.stopPropagation();
                      selectionHaptic();
                      setSelectedEmoji(r.emoji);
                    }
                  : undefined
              }
              delayLongPress={250}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.xs,
                minHeight: 44,
                paddingHorizontal: space.md,
                paddingVertical: 3,
                borderRadius: radius.pill,
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
      <ReactionUsersSheet
        reaction={selectedReaction}
        resolveUser={resolveUser}
        onClose={() => setSelectedEmoji(null)}
      />
    </>
  );
}

function reactorName(user: UserRef | undefined): string {
  const displayName = user?.displayName.trim();
  if (displayName) return displayName;
  const handle = user?.handle.trim();
  return handle || 'Unknown';
}

function ReactionUsersSheet({
  reaction,
  resolveUser,
  onClose,
}: {
  reaction: MessageReaction | undefined;
  resolveUser?: UserResolver;
  onClose: () => void;
}) {
  const { colors, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const reactors = useMemo(
    () =>
      reaction?.userIds.map((id, index) => {
        const user = resolveUser?.(id);
        return {
          id,
          key: `${id}:${index}`,
          name: reactorName(user),
        };
      }) ?? [],
    [reaction, resolveUser],
  );
  const count = reaction?.userIds.length ?? 0;
  const countLabel = count === 1 ? '1 reaction' : `${count} reactions`;
  const visible = reaction != null && resolveUser != null;

  return (
    <Modal visible={visible} transparent animationType={reduceMotion ? 'none' : 'slide'} onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: colors.scrim }}>
        <Pressable
          accessible={false}
          onPress={onClose}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        />
        <View
          style={{
            maxHeight: '70%',
            backgroundColor: colors.bgElevated,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
            overflow: 'hidden',
            paddingBottom: insets.bottom,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
              paddingHorizontal: space.md,
              minHeight: 52,
              gap: space.sm,
            }}
          >
            <Text style={{ color: colors.text, fontSize: 24 }}>{reaction?.emoji ?? ''}</Text>
            <Text style={{ flex: 1, color: colors.textSecondary, fontSize: font.sm, fontWeight: '700' }}>
              {countLabel}
            </Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close reactions"
              hitSlop={8}
              style={{
                minWidth: 44,
                minHeight: 44,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>
          {reactors.length === 0 ? (
            <View style={{ padding: space.lg, alignItems: 'center' }}>
              <Text style={{ color: colors.textMuted, fontSize: font.sm }}>No reactions</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={{ paddingVertical: space.xs }}>
              {reactors.map((reactor) => (
                <View
                  key={reactor.key}
                  accessible
                  accessibilityRole="text"
                  accessibilityLabel={reactor.name}
                  style={{
                    minHeight: 48,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.sm,
                    paddingHorizontal: space.md,
                    paddingVertical: space.sm,
                  }}
                >
                  <Avatar name={reactor.name} seed={reactor.id} size={28} />
                  <Text style={{ flex: 1, color: colors.text, fontSize: font.md, fontWeight: '600' }} numberOfLines={1}>
                    {reactor.name}
                  </Text>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
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
    <View style={{ gap: 6, marginTop: space.xs }}>
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
              gap: space.sm,
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

function AgentChip() {
  const { colors } = useTheme();
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xxs,
        borderRadius: radius.pill,
        backgroundColor: colors.accentBg,
        paddingHorizontal: 6,
        paddingVertical: space.xxs,
      }}
    >
      <Ionicons name="hardware-chip-outline" size={12} color={colors.accent} />
      <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '800' }}>AGENT</Text>
    </View>
  );
}

function SessionMetadata({ session }: { session: Session }) {
  const { colors } = useTheme();
  const repo = session.repo ? `${session.repo}${session.branch ? ` · ${session.branch}` : ''}` : null;
  const metadata = [
    `Started ${formatTime(session.createdAt)}`,
    session.spawnerName ? `Started by ${session.spawnerName}` : null,
    session.driverName && session.driverId !== session.spawnedBy ? `Driver ${session.driverName}` : null,
    repo,
    session.costUsd > 0 ? `$${session.costUsd.toFixed(2)}` : null,
  ].filter((item): item is string => item != null);

  return (
    <View testID="session-metadata" style={{ gap: space.xxs }}>
      {metadata.map((item) => (
        <Text key={item} style={{ color: colors.textMuted, fontSize: font.xs }}>
          {item}
        </Text>
      ))}
    </View>
  );
}

/** Agent-session rows render as a compact status card; tap through to the mobile viewer. */
function SessionCard({
  message,
  session,
  onOpen,
  onOpenPane,
}: {
  message: ChatMessage;
  session?: Session;
  /** Primary tap — the conversation (thread) when the caller can open one. */
  onOpen?: (sessionId: string) => void;
  /** The workbench ("Show the work") — full transcript screen. */
  onOpenPane?: (sessionId: string) => void;
}) {
  const { colors } = useTheme();
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const now = Date.now();
  // One status voice — the same six-word glance every other surface speaks.
  const glance = deriveSessionGlance(
    session ?? {
      status: 'spawning',
      pendingSeatRequests: [],
      createdAt: message.createdAt,
      completedAt: null,
    },
    now,
  );
  const clock = sessionGlanceClockLabel(glance, now);
  const statusColor = glanceColor(glance.kind, colors);
  const stateLine = [`● ${glance.label}${glance.detail ? ` · ${glance.detail}` : ''}`, ...(clock ? [clock] : [])].join(
    ' · ',
  );
  const terminal = session?.status === 'completed' || session?.status === 'failed' || session?.status === 'cancelled';
  const collapsedTerminal = terminal && session?.status !== 'failed';
  const canOpenConversation = Boolean(message.sessionId && onOpen);
  const canOpenWork = Boolean(message.sessionId && (onOpenPane ?? onOpen));

  if (collapsedTerminal) {
    // One status voice: the collapsed strip still NAMES the state ("Done",
    // "Stopped") the way every other surface does, then says how long it took.
    // Dropping the label left mobile saying only "worked 7s" while the web card
    // said "Done · Agent worked 7s".
    const terminalLine =
      session?.status === 'completed'
        ? `${glance.label} · worked${clock ? ` ${clock}` : ''}`
        : `${glance.label}${clock ? ` · after ${clock}` : ''}`;
    return (
      <View
        testID="session-card"
        style={{
          minHeight: 44,
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: space.xs,
          marginTop: space.xxs,
        }}
      >
        <AgentChip />
        {/* A finished session is still steerable — tapping the strip opens the
            conversation, same as the live card. Without this the only route off
            a done card is the read-only pane. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open agent conversation"
          accessibilityState={{ disabled: !canOpenConversation }}
          disabled={!canOpenConversation}
          onPress={() => {
            if (message.sessionId) onOpen?.(message.sessionId);
          }}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Text style={{ color: statusColor, fontSize: font.xs, fontWeight: '700' }}>{terminalLine}</Text>
        </Pressable>
        <Text style={{ color: colors.textFaint, fontSize: font.xs }}>·</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show the work — full transcript"
          accessibilityState={{ disabled: !canOpenWork }}
          disabled={!canOpenWork}
          onPress={() => {
            if (message.sessionId) (onOpenPane ?? onOpen)?.(message.sessionId);
          }}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '700' }}>Show the work →</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View
      testID="session-card"
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgElevated,
        borderRadius: radius.md,
        padding: space.md,
        gap: space.xs,
        marginTop: space.xxs,
      }}
    >
      <AgentChip />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open agent conversation"
        accessibilityState={{ disabled: !canOpenConversation }}
        disabled={!canOpenConversation}
        onPress={() => {
          if (message.sessionId) onOpen?.(message.sessionId);
        }}
        style={{ minHeight: 44, justifyContent: 'center', gap: space.xxs }}
      >
        <Text style={{ color: statusColor, fontSize: font.xs, fontWeight: '700' }}>{stateLine}</Text>
        {session?.latestActivity?.summary ? (
          <Text numberOfLines={1} style={{ color: colors.textSecondary, fontSize: font.xs }}>
            {session.latestActivity.summary}
          </Text>
        ) : null}
      </Pressable>
      {session?.status === 'failed' ? (
        <Text style={{ color: colors.textSecondary, fontSize: font.xs, lineHeight: 18 }}>
          {session.resultText || 'The run ended before reporting a result.'}
        </Text>
      ) : null}
      {session ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={detailsExpanded ? 'Hide session details' : 'Show session details'}
            accessibilityState={{ expanded: detailsExpanded }}
            onPress={() => setDetailsExpanded((expanded) => !expanded)}
            style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' }}
          >
            <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '700' }}>
              {detailsExpanded ? 'Hide details' : 'Details'}
            </Text>
          </Pressable>
          {detailsExpanded ? <SessionMetadata session={session} /> : null}
        </>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Show the work — full transcript"
        accessibilityState={{ disabled: !canOpenWork }}
        disabled={!canOpenWork}
        onPress={() => {
          if (message.sessionId) (onOpenPane ?? onOpen)?.(message.sessionId);
        }}
        style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' }}
      >
        <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '700' }}>Show the work →</Text>
      </Pressable>
    </View>
  );
}

function AgentReplyRow({ message }: { message: ChatMessage }) {
  const { colors } = useTheme();
  return (
    <View testID="agent-reply-row" style={{ gap: space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text numberOfLines={1} style={{ color: colors.text, flexShrink: 1, fontSize: font.md, fontWeight: '700' }}>
          Agent
        </Text>
        <AgentChip />
      </View>
      <MarkdownText text={message.text} />
    </View>
  );
}

function SessionEventLine({
  message,
  session,
  meId,
  onOpen,
  onAnswerSessionQuestion,
  onSuggestSessionAnswer,
}: {
  message: ChatMessage;
  session?: Session;
  meId: string;
  onOpen?: (sessionId: string) => void;
  onAnswerSessionQuestion?: (
    sessionId: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
  ) => Promise<void>;
  onSuggestSessionAnswer?: (sessionId: string, text: string) => Promise<void>;
}) {
  const { colors } = useTheme();
  const payload = message.sessionEventPayload ?? {};
  const questions = questionPayloadPrompts(payload);
  const answers = questionPayloadAnswers(payload);
  const questionText = questions[0]?.question ?? 'Agent asked a question';
  const label = sessionQuestionEventLabel(message.sessionEventType, payload.reason);
  // The asked-row keeps the seat once the question resolves: the answer form is
  // replaced by who answered it, and with what.
  const answeredTrace =
    session != null && typeof payload.questionId === 'string'
      ? sessionAnsweredQuestion(session, payload.questionId)
      : null;

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.sm,
        backgroundColor: colors.bgElevated,
        padding: space.sm,
        gap: 6,
        marginTop: space.xs,
      }}
    >
      {message.sessionEventType === 'question_requested' && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text numberOfLines={1} style={{ color: colors.text, flexShrink: 1, fontSize: font.md, fontWeight: '700' }}>
            Agent
          </Text>
          <AgentChip />
        </View>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '800' }}>{label}</Text>
        <Text style={{ color: colors.textMuted, fontSize: font.xs }}>{formatTime(message.createdAt)}</Text>
      </View>
      {message.sessionEventType === 'question_requested' ? (
        <MarkdownText text={questionText} variant="compact" />
      ) : null}
      {message.sessionEventType === 'question_requested' &&
      session?.pendingQuestion != null &&
      payload.questionId === session.pendingQuestion.questionId &&
      onAnswerSessionQuestion != null &&
      onSuggestSessionAnswer != null ? (
        <InlineQuestionAnswer
          session={session}
          meId={meId}
          onAnswerSessionQuestion={onAnswerSessionQuestion}
          onSuggestSessionAnswer={onSuggestSessionAnswer}
        />
      ) : null}
      {message.sessionEventType === 'question_requested' && answeredTrace ? (
        <AnsweredQuestionTrace trace={answeredTrace} />
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
          <MarkdownText text={questionAnswerSummaryText(answer)} variant="compact" />
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
          <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '700' }}>Show the work →</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function InlineQuestionAnswer({
  session,
  meId,
  onAnswerSessionQuestion,
  onSuggestSessionAnswer,
}: {
  session: Session;
  meId: string;
  onAnswerSessionQuestion: (
    sessionId: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
  ) => Promise<void>;
  onSuggestSessionAnswer: (sessionId: string, text: string) => Promise<void>;
}) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = session.pendingQuestion;
  const question = pending?.questions[0];
  const isDriver = sessionDriverId(session) === meId;

  const submit = useCallback(
    (value: string) => {
      const answer = value.trim();
      if (!pending || !question || !answer || busy || sent) return;
      setBusy(true);
      setError(null);
      const request = isDriver
        ? onAnswerSessionQuestion(session.id, pending.questionId, { [question.id]: { answers: [answer] } })
        : onSuggestSessionAnswer(session.id, answer);
      void request
        .then(() => {
          setSent(true);
          setDraft('');
        })
        .catch(() => setError(isDriver ? "Answer didn't send. Try again." : "Suggestion didn't send. Try again."))
        .finally(() => setBusy(false));
    },
    [busy, isDriver, onAnswerSessionQuestion, onSuggestSessionAnswer, pending, question, sent, session.id],
  );

  const submitDraft = useCallback(() => submit(draft), [draft, submit]);
  const setOptionAnswer = useCallback(
    (option: string) => (event: GestureResponderEvent) => {
      event.stopPropagation();
      submit(option);
    },
    [submit],
  );
  const stopPressPropagation = useCallback((event: GestureResponderEvent) => event.stopPropagation(), []);
  const submitDraftPress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      submitDraft();
    },
    [submitDraft],
  );

  if (!pending || !question) return null;

  return (
    <View
      testID="inline-question-answer"
      style={{ borderTopWidth: 1, borderTopColor: colors.warningBorder, paddingTop: space.sm, gap: space.sm }}
    >
      {question.options?.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
          {question.options.map((option) => (
            <Pressable
              key={option.label}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              accessibilityHint={option.description}
              accessibilityState={{ disabled: busy || sent }}
              disabled={busy || sent}
              onPress={setOptionAnswer(option.label)}
              style={({ pressed }) => ({
                minHeight: 44,
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: colors.warningBorder,
                borderRadius: radius.sm,
                backgroundColor: pressed ? colors.warningSurface : colors.bgElevated,
                paddingHorizontal: space.sm,
                opacity: busy || sent ? 0.55 : 1,
              })}
            >
              <Text style={{ color: colors.warning, fontSize: font.xs, fontWeight: '800' }}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <TextInput
          accessibilityLabel={isDriver ? 'Type an answer' : 'Suggest an answer'}
          value={draft}
          onChangeText={setDraft}
          onPressIn={stopPressPropagation}
          editable={!busy && !sent}
          placeholder={isDriver ? 'Type an answer…' : 'Suggest an answer…'}
          placeholderTextColor={colors.textFaint}
          returnKeyType="send"
          onSubmitEditing={submitDraft}
          style={{
            flex: 1,
            minHeight: 44,
            borderWidth: 1,
            borderColor: colors.warningBorder,
            borderRadius: radius.sm,
            backgroundColor: colors.bgInput,
            color: colors.text,
            fontSize: font.sm,
            paddingHorizontal: space.sm,
            paddingVertical: space.xs,
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isDriver ? 'Answer question' : 'Suggest an answer'}
          accessibilityState={{ disabled: !draft.trim() || busy || sent }}
          disabled={!draft.trim() || busy || sent}
          onPress={submitDraftPress}
          style={({ pressed }) => ({
            minWidth: 72,
            minHeight: 44,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radius.sm,
            backgroundColor: pressed ? colors.warningSurface : colors.warning,
            paddingHorizontal: space.sm,
            opacity: !draft.trim() || busy || sent ? 0.55 : 1,
          })}
        >
          <Text style={{ color: colors.bg, fontSize: font.xs, fontWeight: '900' }}>
            {busy ? 'Sending…' : isDriver ? 'Answer' : 'Suggest'}
          </Text>
        </Pressable>
      </View>
      {!isDriver && !sent ? (
        <Text style={{ color: colors.textMuted, fontSize: font.xs }}>The current driver decides what to send.</Text>
      ) : null}
      {sent ? (
        <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
          {isDriver ? 'Answer sent.' : 'Suggestion sent.'}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: font.xs }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function compactLines(lines: Array<string | null | undefined>): string {
  return lines
    .map((line) => line?.trim() ?? '')
    .filter((line) => line.length > 0)
    .join('\n');
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
    lines.push(questionAnswerSummaryText(answer));
  }
  return compactLines(lines);
}

function sessionSpawnVisibleText(message: ChatMessage): string {
  return message.sessionTask?.trim() || 'Agent session';
}

function actionCopyTextForMessage(message: ChatMessage, rowText: string): string | null {
  if (message.deleted === true) return null;
  if (message.sessionEventType != null) return sessionEventVisibleText(message) || rowText;
  if (message.sessionId != null) return sessionSpawnVisibleText(message) || rowText;
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
    copyText == null || copyText === message.text
      ? message
      : ({ ...message, actionCopyText: copyText } as MessageActionTarget);
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
  resolveUser,
  fileHeaders,
  onLongPress,
  onOpenThread,
  onToggleReaction,
  onRetry,
  onOpenAttachment,
  onOpenChannel,
  onOpenSession,
  onAnswerSessionQuestion,
  onSuggestSessionAnswer,
}: MessageRowProps) {
  const { colors, reduceMotion } = useTheme();
  const swipeTranslateX = useSharedValue(0);
  const pending = m.status === 'pending';
  const failed = m.status === 'failed';
  useAccessibilityAnnouncement(failed ? 'Message failed to send. Tap to retry.' : null);
  const tombstone = m.deleted === true;
  const isAgentReply = m.sessionEventType === 'replied';
  const isAgentVoice = isAgentReply || m.sessionEventType === 'question_requested';
  const sessionBlock = (m.sessionId != null || m.sessionEventType != null) && !isAgentReply;
  const hasInlineQuestionControls =
    m.sessionEventType === 'question_requested' &&
    session?.pendingQuestion != null &&
    m.sessionEventPayload?.questionId === session.pendingQuestion.questionId &&
    onAnswerSessionQuestion != null &&
    onSuggestSessionAnswer != null;
  const attachmentDescription = m.attachments?.length
    ? m.attachments.map((a) => `attachment ${a.filename}`).join(', ')
    : '';
  const blockRowText =
    m.sessionEventType != null ? sessionEventVisibleText(m) : m.sessionId != null ? sessionSpawnVisibleText(m) : '';
  const rowText = tombstone
    ? 'Message deleted'
    : (sessionBlock ? blockRowText : m.text.trim()) ||
      m.text.trim() ||
      (m.voice ? 'Voice message' : attachmentDescription) ||
      (m.sessionId ? 'Agent session' : 'Message');
  const exactCreatedAt = formatExactTimestamp(m.createdAt);
  const rowLabel = `${isAgentVoice ? 'Agent' : m.author.displayName}, ${exactCreatedAt || formatTime(m.createdAt)}: ${rowText}`;
  const own = m.author.id === meId;
  const mentionedMe = !tombstone && mentionsUser(m.text, { id: meId, handle: meHandle });
  const copyText = actionCopyTextForMessage(m, rowText);
  const entryHandle = entryHandleForAction(m);
  const copyLink = entryHandle ? `${serverUrl.replace(/\/+$/, '')}/e/${encodeURIComponent(entryHandle)}` : null;
  const partitionedEntryLinks = useMemo(() => partitionEntryLinks(m.text, serverUrl), [m.text, serverUrl]);
  const unfurlHandles = useMemo(
    () => unsuppressedEntryHandles(partitionedEntryLinks.allHandles, m.suppressedUnfurls),
    [m.suppressedUnfurls, partitionedEntryLinks.allHandles],
  );
  const entryReferenceMarkdown = useMemo(
    () => ({ resolveEntry, onOpenChannel, onOpenSession }),
    [resolveEntry, onOpenChannel, onOpenSession],
  );
  const canOpenActionMenu = !tombstone && (!sessionBlock || copyText != null || copyLink != null);
  const canSwipeReply = !inThread && onOpenThread != null && !tombstone && !sessionBlock;
  const showThreadReplyAffordance = !inThread && m.threadRootEventId != null && onOpenThread != null;
  const openSwipeReply = useCallback(() => {
    if (!canSwipeReply || !onOpenThread) return;
    lightImpactHaptic();
    onOpenThread(m);
  }, [canSwipeReply, m, onOpenThread]);
  const resetSwipe = useCallback(() => {
    swipeTranslateX.value = 0;
  }, [swipeTranslateX]);
  const swipeReplyGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(canSwipeReply)
        .activeOffsetX(15)
        .failOffsetY([-14, 14])
        .onUpdate((event) => {
          'worklet';
          swipeTranslateX.value = Math.max(0, Math.min(event.translationX, SWIPE_REPLY_MAX));
        })
        .onEnd((event) => {
          'worklet';
          if (event.translationX > SWIPE_REPLY_THRESHOLD) runOnJS(openSwipeReply)();
        })
        .onFinalize(() => {
          'worklet';
          swipeTranslateX.value = reduceMotion ? 0 : withSpring(0, SWIPE_REPLY_SPRING);
        }),
    [canSwipeReply, openSwipeReply, reduceMotion, swipeTranslateX],
  );
  const swipeRowStyle = useAnimatedStyle(() => {
    'worklet';
    return { transform: [{ translateX: swipeTranslateX.value }] };
  });
  const replyRevealStyle = useAnimatedStyle(() => {
    'worklet';
    const progress = interpolate(swipeTranslateX.value, [0, SWIPE_REPLY_THRESHOLD], [0, 1], Extrapolation.CLAMP);
    return {
      opacity: progress,
      transform: [
        {
          translateX: reduceMotion
            ? 0
            : interpolate(swipeTranslateX.value, [0, SWIPE_REPLY_THRESHOLD], [-8, 0], Extrapolation.CLAMP),
        },
        {
          scale: reduceMotion ? 1 : interpolate(progress, [0, 1], [0.92, 1], Extrapolation.CLAMP),
        },
      ],
    };
  });

  useEffect(() => {
    if (!canSwipeReply) resetSwipe();
  }, [canSwipeReply, resetSwipe]);
  const accessibilityActions = [
    ...(failed ? [{ name: 'retry', label: 'Retry sending' }] : []),
    ...(!tombstone && !sessionBlock && onOpenThread && !inThread ? [{ name: 'reply', label: 'Reply in thread' }] : []),
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

  const sessionTaskBody = m.sessionTask ? (
    <EntryReferenceMarkdownProvider value={entryReferenceMarkdown}>
      <MessageText text={m.sessionTask} meHandle={meHandle} meId={meId} resolveUser={resolveUser} muted={pending} />
    </EntryReferenceMarkdownProvider>
  ) : null;

  const sessionCard =
    m.sessionId != null && m.sessionEventType == null ? (
      <SessionCard
        message={m}
        session={session}
        // Primary tap lands on the conversation (the card's thread); the full
        // transcript stays one tap away via "Show the work".
        onOpen={!inThread && onOpenThread ? () => onOpenThread(m) : onOpenSession}
        onOpenPane={onOpenSession}
      />
    ) : null;

  const body = tombstone ? (
    <Text style={{ color: colors.textFaint, fontSize: font.md, fontStyle: 'italic' }}>Message deleted</Text>
  ) : isAgentReply ? (
    <AgentReplyRow message={m} />
  ) : m.sessionEventType != null ? (
    <SessionEventLine
      message={m}
      session={session}
      meId={meId}
      onOpen={onOpenSession}
      onAnswerSessionQuestion={onAnswerSessionQuestion}
      onSuggestSessionAnswer={onSuggestSessionAnswer}
    />
  ) : m.sessionId != null ? (
    <>
      {sessionTaskBody}
      {sessionCard}
    </>
  ) : (
    <>
      {partitionedEntryLinks.bodyText ? (
        <EntryReferenceMarkdownProvider value={entryReferenceMarkdown}>
          <MessageText
            text={partitionedEntryLinks.bodyText}
            meHandle={meHandle}
            meId={meId}
            resolveUser={resolveUser}
            muted={pending}
          />
        </EntryReferenceMarkdownProvider>
      ) : null}
      {m.voice ? (
        <VoiceMessage voice={m.voice} api={api} fileUrl={fileUrl} fileHeaders={fileHeaders} />
      ) : (
        <Attachments message={m} fileUrl={fileUrl} fileHeaders={fileHeaders} onOpenAttachment={onOpenAttachment} />
      )}
      {m.steeredSessionId ? (
        <View
          style={{
            alignSelf: 'flex-start',
            backgroundColor: colors.accentBg,
            borderRadius: radius.sm,
            marginTop: space.xs,
            paddingHorizontal: 6,
            paddingVertical: space.xxs,
          }}
        >
          <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '700' }}>→ agent</Text>
        </View>
      ) : null}
      {m.suggestedSessionId ? (
        <View
          style={{
            alignSelf: 'flex-start',
            backgroundColor: colors.warningSurface,
            borderRadius: radius.sm,
            marginTop: space.xs,
            paddingHorizontal: 6,
            paddingVertical: space.xxs,
          }}
        >
          <Text style={{ color: colors.warning, fontSize: font.xs, fontWeight: '700' }}>Suggested to agent</Text>
        </View>
      ) : null}
    </>
  );

  const avatar = (
    <View style={{ width: 36, alignItems: 'center' }}>
      {(!grouped || isAgentVoice) && (
        <Avatar
          name={isAgentVoice ? 'Agent' : m.author.displayName}
          seed={m.author.id}
          size={36}
          variant={isAgentVoice ? 'agent' : 'human'}
        />
      )}
    </View>
  );

  const header =
    !grouped && !isAgentVoice ? (
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.sm, minWidth: 0 }}>
        <Text style={{ flexShrink: 1, color: colors.text, fontSize: font.md, fontWeight: '700' }} numberOfLines={1}>
          {m.author.displayName}
        </Text>
        <TimestampText
          iso={m.createdAt}
          text={formatTime(m.createdAt)}
          style={{ flexShrink: 1, color: colors.textFaint, fontSize: font.xs }}
          numberOfLines={1}
        />
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

  // Pending question controls must not live inside a row-level Pressable: native
  // touch bubbling can fire the row action and unmount the button being pressed.
  if (m.sessionId != null && m.sessionEventType == null) {
    return (
      <View
        style={{
          ...containerStyle,
          backgroundColor: highlighted ? colors.accentBg : 'transparent',
        }}
      >
        {avatar}
        <View style={{ flex: 1, minWidth: 0 }}>
          {header}
          <Pressable
            accessibilityRole="text"
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
              backgroundColor: pressed ? colors.borderSoft : 'transparent',
            })}
          >
            {sessionTaskBody}
          </Pressable>
          {editedNote}
          {sessionCard}
        </View>
      </View>
    );
  }

  if (hasInlineQuestionControls) {
    return (
      <View
        style={{
          ...containerStyle,
          backgroundColor: highlighted ? colors.accentBg : 'transparent',
        }}
      >
        {avatar}
        <View style={{ flex: 1, minWidth: 0 }}>
          {header}
          {body}
          {editedNote}
        </View>
      </View>
    );
  }

  // Other session / tombstone rows have no inline controls, so keep them as a
  // single accessible row element (the card / tombstone is the whole content).
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
    <GestureDetector gesture={swipeReplyGesture}>
      <View
        style={{
          position: 'relative',
          overflow: 'hidden',
          backgroundColor: highlighted ? colors.accentBg : mentionedMe ? colors.warningSurface : 'transparent',
          borderLeftWidth: mentionedMe ? 3 : 0,
          borderLeftColor: mentionedMe ? colors.mention : 'transparent',
        }}
      >
        {canSwipeReply ? (
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: space.lg + 5,
                justifyContent: 'center',
              },
              replyRevealStyle,
            ]}
          >
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colors.accentBg,
                borderWidth: 1,
                borderColor: colors.accent,
              }}
            >
              <Ionicons name="arrow-undo-outline" size={19} color={colors.accent} />
            </View>
          </Animated.View>
        ) : null}
        <Animated.View style={[containerStyle, swipeRowStyle]}>
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
            {unfurlHandles.length > 0 ? (
              <EntryQuoteCards
                text={m.text}
                serverUrl={serverUrl}
                handles={unfurlHandles}
                resolveEntry={resolveEntry}
                resolveArtifactContent={resolveArtifactContent}
                api={api}
                fileHeaders={fileHeaders}
                onOpenAttachments={(attachments, index) => onOpenAttachment({ ...m, attachments }, index)}
                unfurlManagement={{ messageEventId: m.id, suppressed: m.suppressedUnfurls, canManage: own }}
                onOpenChannel={onOpenChannel}
                onOpenSession={onOpenSession}
              />
            ) : null}
            {showThreadReplyAffordance ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Replied to a thread"
                accessibilityHint="Opens the parent thread"
                onPress={() => onOpenThread(m)}
                hitSlop={10}
                style={{ marginTop: space.xs, minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
              >
                <Text style={{ color: colors.textMuted, fontSize: font.sm, fontWeight: '600' }}>
                  {'↳ replied to a thread'}
                </Text>
              </Pressable>
            ) : null}
            {failed && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Failed to send. Tap to retry."
                accessibilityHint="Attempts to send this message again"
                accessibilityLiveRegion="polite"
                onPress={() => onRetry(m)}
                hitSlop={10}
                style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
              >
                <Text style={{ color: colors.danger, fontSize: font.xs, marginTop: space.xxs }}>
                  Failed to send — tap to retry
                </Text>
              </Pressable>
            )}
            {m.reactions && m.reactions.length > 0 && (
              <ReactionChips
                reactions={m.reactions}
                meId={meId}
                resolveUser={resolveUser}
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
                style={{ marginTop: space.xs, minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
              >
                <Text style={{ color: colors.accent, fontSize: font.sm, fontWeight: '600' }}>
                  {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'} →
                </Text>
              </Pressable>
            )}
          </View>
        </Animated.View>
      </View>
    </GestureDetector>
  );
});
