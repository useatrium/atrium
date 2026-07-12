import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import {
  ApiError,
  formatCost,
  formatElapsed,
  formatExactTimestamp,
  formatTime,
  isStalledSessionStatus,
  isTerminalSessionStatus,
  matchSteerProvenance,
  mergeSpawnResponse,
  normalizeSteerProvenanceText,
  questionAnswerSummaryText,
  randomId,
  sessionDriverId,
  sessionFromWire,
  steerProvenanceKey,
  type QuestionPrompt,
  type Session,
  type SessionQuestionAnswerSummary,
  type SessionQuestionEvent,
  type SessionStatus,
  type SteerProvenance,
} from '@atrium/surface-client';
import { HARNESS_EFFORT_PICKER_OPTIONS } from '@atrium/surface-client/effort';
import {
  focusTranscriptRows,
  fullTranscriptRows,
  toolDefaultOpen,
  type QuestionItem,
  type SessionItem,
  type TextItem,
  type ToolCallItem,
  type UserMessageItem,
} from '@atrium/centaur-client';
import { useChat } from '../../../src/lib/chat';
import { useAccessibilityAnnouncement, useModalAccessibilityFocus } from '../../../src/lib/accessibility';
import { font, radius, space, useTheme, type Colors } from '../../../src/lib/theme';
import { normalizeExecutionStatus } from '../../../src/lib/sessionStreamCore';
import { useSessionStream } from '../../../src/lib/useSessionStream';
import {
  artifactCount,
  changedPaths,
  codexInlineFileChanges,
  collectArtifacts,
  collectFileChanges,
  collectSideEffects,
  deriveTurnStatus,
  fileChangeFromToolCall,
  turnStatusLabel,
  sideEffectCount,
  toolDisplay,
} from '@atrium/centaur-client';
import { ArtifactsSurface } from '../../../src/components/work/ArtifactsSurface';
import { ChangesSurface } from '../../../src/components/work/ChangesSurface';
import { InlineFileChange } from '../../../src/components/work/fileChangeView';
import { SideEffectsSurface } from '../../../src/components/work/SideEffectsSurface';
import { MobileWorkSheet, type WorkSurfaceTab } from '../../../src/components/work/MobileWorkSheet';
import { WorkStrips, type WorkStripItem } from '../../../src/components/work/WorkStrips';
import { TurnsSheet } from '../../../src/components/work/TurnsSheet';
import { TurnCard } from '../../../src/components/work/TurnCard';
import { TranscriptActiveEntryFrame } from '../../../src/components/work/TranscriptEntryActions';
import { SteerRow, type SteerRowProvenance } from '../../../src/components/work/SteerRow';
import { deriveTurns } from '../../../src/components/work/turns';
import { SeatRequestBanner, SeatFooter } from '../../../src/components/work/SeatControls';
import {
  SuggestionsStrip,
  type OptimisticSuggestionSend,
} from '../../../src/components/work/SuggestionsStrip';
import { AnswerProposals } from '../../../src/components/work/AnswerProposals';
import { EntryInlineChip } from '../../../src/components/EntryQuoteCards';
import { SessionMarkdown } from '../../../src/components/Markdown';
import { PlanPanel } from '../../../src/components/PlanPanel';
import { ReasoningBlock } from '../../../src/components/ReasoningBlock';
import { TurnStatusLine } from '../../../src/components/TurnStatusLine';
import { HiddenWorkChip } from '../../../src/components/HiddenWorkChip';
import { MessageActionSheet, type MessageActionListItem } from '../../../src/components/MessageActions';
import {
  createEntryReferenceQuery,
  type EntryReference,
  type EntryReferenceMap,
  type EntryReferenceSummary,
} from '../../../src/lib/entryReferences';
import { useRequiredSession, useSession } from '../../../src/lib/session';
import { extractEntryLinkHandles, isEntryHandle } from '../../../src/lib/entryLinks';
import { lightImpactHaptic, selectionHaptic } from '../../../src/lib/haptics';
import {
  loadTranscriptView,
  persistTranscriptView,
  type TranscriptView,
} from '../../../src/lib/prefsStorage';
import {
  loadMarkupDraftFromEntry,
  putPendingMarkupDraft,
} from '../../../src/lib/markupAuthoring';

function transcriptEntryHandle(item: SessionItem): string | null {
  const handle = item.handle;
  return typeof handle === 'string' && isEntryHandle(handle) ? handle : null;
}

function canDiscussTranscriptHandle(handle: string | null): handle is string {
  return typeof handle === 'string' && handle.startsWith('rec_');
}

function entryUrl(serverUrl: string, handle: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/e/${encodeURIComponent(handle)} `;
}

function entryLink(serverUrl: string, handle: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/e/${encodeURIComponent(handle)}`;
}

function sessionLink(serverUrl: string, sessionId: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/s/${encodeURIComponent(sessionId)}`;
}

type PendingSteer = {
  id: string;
  text: string;
  ts: string;
  provenance: SteerProvenance;
  acceptedByMe: boolean;
};

function referenceLabel(ref: EntryReference): string {
  const actor = ref.actorLabel?.trim() || 'Someone';
  const excerpt = ref.excerpt.replace(/\s+/g, ' ').trim();
  return excerpt ? `${actor}: ${excerpt}` : actor;
}

function DiscussedChip({
  count,
  onPress,
}: {
  count: number;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${count} discussion reference${count === 1 ? '' : 's'}`}
      onPress={onPress}
      style={({ pressed }) => ({
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 3,
      })}
    >
      <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '900' }}>
        ↗ {count}
      </Text>
    </Pressable>
  );
}

function TranscriptRowFrame({
  reference,
  onOpenReference,
  children,
}: {
  reference: EntryReferenceSummary | null;
  onOpenReference: () => void;
  children: ReactNode;
}) {
  if (!reference || reference.count <= 0) return <>{children}</>;
  return (
    <View style={{ gap: 6 }}>
      {children}
      <DiscussedChip count={reference.count} onPress={onOpenReference} />
    </View>
  );
}

type TranscriptActionTarget = {
  id: string;
  handle: string | null;
  copyText: string | null;
  link: string | null;
  canDiscuss: boolean;
};

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function sessionElapsedMs(session: Session, now: number): number {
  const start = new Date(session.createdAt).getTime();
  const end = session.completedAt ? new Date(session.completedAt).getTime() : now;
  return end - start;
}

function statusColor(status: SessionStatus, stalled: boolean, colors: Colors): string {
  if (stalled) return colors.textMuted;
  if (status === 'completed') return colors.online;
  if (status === 'failed' || status === 'cancelled') return colors.danger;
  return colors.warning;
}

function StatusChip({ status, stalled }: { status: SessionStatus; stalled: boolean }) {
  const { colors } = useTheme();
  const color = statusColor(status, stalled, colors);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: color,
        paddingHorizontal: 8,
        paddingVertical: 3,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <Text style={{ color, fontSize: font.xs, fontWeight: '800' }}>
        {(stalled ? 'stalled' : status).toUpperCase()}
      </Text>
    </View>
  );
}

export function ToolCard({ item, onLongPress }: { item: ToolCallItem; onLongPress?: () => void }) {
  const { colors } = useTheme();
  const running = item.result === undefined;
  const [open, setOpen] = useState(() => toolDefaultOpen(item));
  const manuallyToggled = useRef(false);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && !manuallyToggled.current) setOpen(false);
    wasRunning.current = running;
  }, [running]);
  const descriptor = toolDisplay(item);
  const isError = item.result?.is_error === true;
  const command = typeof item.input.command === 'string' ? item.input.command : null;
  const rest = Object.fromEntries(Object.entries(item.input).filter(([key]) => key !== 'command'));
  const restJson = Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : null;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: isError ? colors.dangerBorder : colors.border,
        backgroundColor: isError ? colors.dangerSurface : colors.bgElevated,
        borderRadius: radius.sm,
        overflow: 'hidden',
      }}
    >
      <Pressable
        onPress={() => {
          manuallyToggled.current = true;
          setOpen((value) => !value);
        }}
        onLongPress={onLongPress}
        delayLongPress={250}
        accessibilityRole="button"
        accessibilityLabel={onLongPress ? `Message actions: ${descriptor.title}` : descriptor.title}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          padding: space.sm,
          backgroundColor: pressed ? colors.bgPressed : 'transparent',
        })}
      >
        <Text style={{ color: colors.textMuted, fontSize: font.xs, width: 10 }}>
          {open ? '▾' : '▸'}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            minWidth: 0,
            flexShrink: 1,
            color: colors.text,
            fontSize: font.xs,
            fontFamily: 'monospace',
            fontWeight: '800',
          }}
        >
          {descriptor.title}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            minWidth: 0,
            color: colors.textMuted,
            fontSize: font.xs,
            fontFamily: 'monospace',
          }}
        >
          {!open ? descriptor.subtitle : ''}
        </Text>
        <Text
          style={{
            color: running ? colors.accent : isError ? colors.danger : colors.textMuted,
            fontSize: font.xs,
            fontWeight: '700',
          }}
        >
          {running ? 'RUNNING' : isError ? 'ERROR' : 'DONE'}
        </Text>
      </Pressable>
      {open ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: colors.borderSoft,
            padding: space.sm,
            gap: space.sm,
          }}
        >
          {command !== null ? (
            <Text
              style={{
                color: colors.textSecondary,
                fontSize: font.xs,
                fontFamily: 'monospace',
                lineHeight: 16,
              }}
            >
              {command}
            </Text>
          ) : null}
          {restJson ? (
            <Text
              style={{
                color: colors.textMuted,
                fontSize: font.xs,
                fontFamily: 'monospace',
                lineHeight: 16,
              }}
            >
              {restJson}
            </Text>
          ) : null}
          {item.result ? (
            <ScrollView
              style={{ maxHeight: 288 }}
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
            <Text selectable
              style={{
                color: isError ? colors.danger : colors.textSecondary,
                fontSize: font.xs,
                fontFamily: 'monospace',
                lineHeight: 16,
              }}
            >
              {item.result.content}
            </Text>
            </ScrollView>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function TranscriptTool({ item, onLongPress }: { item: ToolCallItem; onLongPress?: () => void }) {
  const fileChange = fileChangeFromToolCall(item);
  if (fileChange) {
    const status = item.result === undefined ? 'running' : item.result.is_error ? 'error' : 'done';
    return <InlineFileChange change={fileChange} status={status} onLongPress={onLongPress} />;
  }
  return <ToolCard item={item} onLongPress={onLongPress} />;
}

function TextBlock({ item }: { item: TextItem }) {
  return <SessionMarkdown text={item.text} />;
}

function groupQuestionEventsByQuestion(events: SessionQuestionEvent[]): Map<string, SessionQuestionEvent[]> {
  const grouped = new Map<string, SessionQuestionEvent[]>();
  for (const event of events) {
    const current = grouped.get(event.questionId) ?? [];
    current.push(event);
    grouped.set(event.questionId, current);
  }
  for (const [questionId, current] of grouped) {
    grouped.set(questionId, [...current].sort((a, b) => a.id - b.id));
  }
  return grouped;
}

function latestQuestionEvent(
  events: SessionQuestionEvent[],
  kind: SessionQuestionEvent['kind'],
): SessionQuestionEvent | undefined {
  return [...events].reverse().find((event) => event.kind === kind);
}

function answerByPromptId(events: SessionQuestionEvent[]): Map<string, SessionQuestionAnswerSummary> {
  const answered = latestQuestionEvent(events, 'answered');
  const summaries = new Map<string, SessionQuestionAnswerSummary>();
  for (const summary of answered?.answers ?? []) {
    summaries.set(summary.id, summary);
  }
  return summaries;
}

function questionResolutionText(reason: QuestionItem['reason'] | undefined): string {
  if (reason === 'empty') return 'Expired without an answer';
  if (reason === 'cancelled') return 'Cancelled';
  return 'Answered';
}

function questionStatusLabel(item: QuestionItem, events: SessionQuestionEvent[]): string {
  const answered = latestQuestionEvent(events, 'answered');
  const resolved = latestQuestionEvent(events, 'resolved');
  const reason = item.reason ?? resolved?.reason ?? (answered ? 'answered' : undefined);
  if (item.status === 'pending' && !answered && !resolved) return 'Waiting for answer';
  return questionResolutionText(reason);
}

function MobileQuestionTranscriptCard({
  item,
  events,
  onLongPress,
}: {
  item: QuestionItem;
  events: SessionQuestionEvent[];
  onLongPress?: () => void;
}) {
  const { colors } = useTheme();
  const requested = latestQuestionEvent(events, 'requested');
  const prompts = item.questions.length > 0 ? item.questions : requested?.questions ?? [];
  const answerSummaries = answerByPromptId(events);
  const status = questionStatusLabel(item, events);
  const Root = onLongPress ? Pressable : View;
  return (
    <Root
      {...(onLongPress
        ? {
            accessibilityRole: 'button' as const,
            accessibilityLabel: 'Message actions: Agent question',
            onLongPress,
            delayLongPress: 250,
          }
        : {})}
      style={{
        borderWidth: 1,
        borderColor: colors.warningBorder,
        backgroundColor: colors.warningSurface,
        borderRadius: radius.sm,
        padding: space.sm,
        gap: space.sm,
      }}
    >
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <Text style={{ color: colors.text, fontSize: font.xs, fontWeight: '900' }}>
          AGENT QUESTION
        </Text>
        <Text style={{ color: colors.warning, fontSize: font.xs, fontWeight: '800' }}>
          {status.toUpperCase()}
        </Text>
      </View>
      {prompts.length > 0 ? (
        prompts.map((question) => {
          const summary = answerSummaries.get(question.id);
          return (
            <View key={question.id} style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>
                  {question.header}
                </Text>
                {question.isSecret ? (
                  <Text style={{ color: colors.textMuted, fontSize: font.xs }}>secret</Text>
                ) : null}
              </View>
              <Text style={{ color: colors.text, fontSize: font.sm, lineHeight: 20 }}>
                {question.question}
              </Text>
              {question.options?.length ? (
                <View style={{ gap: 6 }}>
                  {question.options.map((option) => (
                    <View
                      key={option.label}
                      style={{
                        borderWidth: 1,
                        borderColor: colors.border,
                        backgroundColor: colors.bgElevated,
                        borderRadius: radius.sm,
                        padding: space.sm,
                        gap: 2,
                      }}
                    >
                      <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }}>
                        {option.label}
                      </Text>
                      <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
                        {option.description}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {summary ? (
                <View
                  style={{
                    borderWidth: 1,
                    borderColor: colors.accent,
                    backgroundColor: colors.accentBg,
                    borderRadius: radius.sm,
                    padding: space.sm,
                    gap: 3,
                  }}
                >
                  <Text style={{ color: colors.accent, fontSize: font.xs, fontWeight: '900' }}>
                    ANSWER
                  </Text>
                  <Text style={{ color: colors.text, fontSize: font.sm, lineHeight: 20 }}>
                    {questionAnswerSummaryText(summary)}
                  </Text>
                </View>
              ) : null}
            </View>
          );
        })
      ) : (
        <Text style={{ color: colors.text, fontSize: font.sm }}>Agent asked a question.</Text>
      )}
    </Root>
  );
}

function MobileQuestionBanner({
  pending,
  isDriver,
  values,
  setValue,
  submitting,
  error,
  onSubmit,
}: {
  pending: { questionId: string; questions: QuestionPrompt[] };
  isDriver: boolean;
  values: Record<string, QuestionDraftValue>;
  setValue: (id: string, value: QuestionDraftValue) => void;
  submitting: boolean;
  error: string | null;
  onSubmit: () => void;
}) {
  const { colors } = useTheme();
  const complete = pending.questions.every((q) => answerValuesForPrompt(q, values[q.id]).length > 0);
  useAccessibilityAnnouncement(error);
  const toggleOption = (q: QuestionPrompt, label: string) => {
    const current = answerArrayValue(values[q.id]);
    setValue(
      q.id,
      current.includes(label)
        ? current.filter((selected) => selected !== label)
        : [...current, label],
    );
  };
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.warningBorder,
        backgroundColor: colors.warningSurface,
        borderRadius: radius.md,
        padding: space.md,
        gap: space.sm,
      }}
    >
      <Text style={{ color: colors.warning, fontSize: font.xs, fontWeight: '900' }}>
        NEEDS INPUT
      </Text>
      {pending.questions.map((q) => (
        <View key={q.id} style={{ gap: 6 }}>
          <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>
            {q.header}
          </Text>
          <Text style={{ color: colors.text, fontSize: font.sm, lineHeight: 20 }}>
            {q.question}
          </Text>
          {q.options?.length ? (
            <View style={{ gap: 6 }}>
              {q.options.map((option) => {
                const current = values[q.id];
                const selected = q.multiSelect
                  ? Array.isArray(current) && current.includes(option.label)
                  : current === option.label;
                return (
                  <Pressable
                    accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                    accessibilityLabel={`${option.label}. ${option.description}`}
                    accessibilityState={{ checked: selected, disabled: submitting }}
                    key={option.label}
                    disabled={submitting}
                    onPress={() => (q.multiSelect ? toggleOption(q, option.label) : setValue(q.id, option.label))}
                    style={{
                      borderWidth: 1,
                      borderColor: selected ? colors.warning : colors.border,
                      backgroundColor: selected ? colors.accentBg : colors.bgElevated,
                      borderRadius: radius.sm,
                      padding: space.sm,
                      opacity: submitting ? 0.6 : 1,
                    }}
                  >
                    <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }}>
                      {option.label}
                    </Text>
                    <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
                      {option.description}
                    </Text>
                    {option.preview ? (
                      <Text
                        style={{
                          marginTop: 6,
                          borderWidth: 1,
                          borderColor: colors.border,
                          borderRadius: radius.sm,
                          padding: space.sm,
                          color: colors.textSecondary,
                          fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
                          fontSize: font.xs,
                        }}
                      >
                        {option.preview}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <TextInput
              accessibilityLabel={`Answer for ${q.header}`}
              value={answerTextValue(values[q.id])}
              onChangeText={(value) => setValue(q.id, value)}
              editable={!submitting}
              secureTextEntry={q.isSecret === true}
              placeholder="Answer"
              placeholderTextColor={colors.textFaint}
              style={{
                borderRadius: radius.md,
                backgroundColor: colors.bgInput,
                color: colors.text,
                paddingHorizontal: space.md,
                paddingVertical: space.sm,
                fontSize: font.md,
              }}
            />
          )}
        </View>
      ))}
      {error ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ color: colors.danger, fontSize: font.xs }}
        >
          {error}
        </Text>
      ) : null}
      <Pressable
        onPress={onSubmit}
        disabled={!complete || submitting}
        accessibilityRole="button"
        accessibilityLabel={isDriver ? 'Submit answer' : 'Propose answer'}
        style={{
          alignSelf: 'flex-start',
          borderRadius: radius.md,
          backgroundColor: complete ? colors.warning : colors.bgElevated,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          opacity: submitting ? 0.6 : 1,
        }}
      >
        <Text style={{ color: complete ? colors.onAccent : colors.textFaint, fontSize: font.sm, fontWeight: '900' }}>
          {isDriver
            ? submitting
              ? 'Answering...'
              : 'Submit answer'
            : submitting
              ? 'Proposing...'
              : 'Propose answer'}
        </Text>
      </Pressable>
    </View>
  );
}

type QuestionDraftValue = string | string[];

function answerValuesForPrompt(q: QuestionPrompt, value: QuestionDraftValue | undefined): string[] {
  if (q.options?.length && q.multiSelect) {
    return answerArrayValue(value).filter((answer) => answer.trim().length > 0);
  }
  const trimmed = answerTextValue(value).trim();
  return trimmed ? [trimmed] : [];
}

function answerArrayValue(value: QuestionDraftValue | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function answerTextValue(value: QuestionDraftValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chat = useChat();
  const { invalidate } = useSession();
  const authSession = useRequiredSession();
  const { colors, reduceMotion } = useTheme();
  const { api, me, state, upsertSession, setActiveSessionId } = chat;
  const cached = id ? (state.sessions[id] ?? null) : null;
  const { stream, connected, lastFrameAt, clockSkewMs } = useSessionStream(
    id ?? null,
    cached ? !isTerminalSessionStatus(cached.status) : false,
  );
  const headerHeight = useHeaderHeight();
  const [snapshot, setSnapshot] = useState<Session | null>(cached);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [steerText, setSteerText] = useState('');
  const [steerError, setSteerError] = useState<string | null>(null);
  const [questionValues, setQuestionValues] = useState<Record<string, QuestionDraftValue>>({});
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const [questionCleared, setQuestionCleared] = useState<string | null>(null);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [cancelAsk, setCancelAsk] = useState<'idle' | 'confirm' | 'failed'>('idle');
  const [workTab, setWorkTab] = useState<string | null>(null);
  const [turnsOpen, setTurnsOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [effortChoice, setEffortChoice] = useState<string | null>(null);
  const [seatAsk, setSeatAsk] = useState<'idle' | 'confirm-take'>('idle');
  const [ignoredSeatRequests, setIgnoredSeatRequests] = useState<ReadonlySet<string>>(() => new Set());
  const [suggestText, setSuggestText] = useState('');
  const [pendingSteers, setPendingSteers] = useState<PendingSteer[]>([]);
  const [optimisticProvenanceByMessageId, setOptimisticProvenanceByMessageId] = useState<
    Map<string, SteerRowProvenance>
  >(new Map());
  const [references, setReferences] = useState<EntryReferenceMap>({});
  const [referenceFocusSeq, setReferenceFocusSeq] = useState(0);
  const [transcriptActionTarget, setTranscriptActionTarget] = useState<TranscriptActionTarget | null>(null);
  const [activeTranscriptEntryId, setActiveTranscriptEntryId] = useState<string | null>(null);
  const [transcriptCopied, setTranscriptCopied] = useState<'text' | 'link' | null>(null);
  const [transcriptView, setTranscriptViewState] = useState<TranscriptView>('focus');
  const [sessionLinkCopied, setSessionLinkCopied] = useState(false);
  const referenceCache = useRef<Record<string, EntryReferenceMap>>({});
  const referenceFetchKeys = useRef<Set<string>>(new Set());
  const sessionLinkResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptCopyCloseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedForReferences = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const effortTitleRef = useRef<Text>(null);
  const stickRef = useRef(true);
  // Transcript item y-offsets (captured via onLayout) so the Turns▾ sheet can
  // jump to a turn — ScrollView has no scrollToItem the way FlatList does.
  const itemOffsets = useRef<Record<string, number>>({});

  useEffect(() => {
    let active = true;
    void loadTranscriptView().then((view) => {
      if (active) setTranscriptViewState(view);
    });
    return () => { active = false; };
  }, []);

  const setTranscriptView = useCallback((view: TranscriptView) => {
    setTranscriptViewState(view);
    void persistTranscriptView(view).catch((err: unknown) => {
      console.warn('failed to persist transcript view', err);
    });
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!id) return;
      let disposed = false;
      focusedForReferences.current = true;
      setReferenceFocusSeq((seq) => seq + 1);
      setActiveSessionId(id); // subscribe the WS to this session's presence key
      setLoading(true);
      setLoadError(null);
      api
        .getSession(id)
        .then(({ session }) => {
          if (disposed) return;
          const entity = sessionFromWire(session);
          setSnapshot(entity);
          upsertSession(entity);
        })
        .catch((err: unknown) => {
          if (!disposed) setLoadError(err instanceof Error ? err.message : 'Session not found');
        })
        .finally(() => {
          if (!disposed) setLoading(false);
        });
      return () => {
        disposed = true;
        focusedForReferences.current = false;
        setActiveSessionId(null);
      };
    }, [api, id, upsertSession, setActiveSessionId]),
  );

  const session = snapshot ? mergeSpawnResponse(cached ?? undefined, snapshot) : cached;
  const streamStatus = stream.status !== 'idle' ? normalizeExecutionStatus(stream.status) : null;
  const displayStatus = (streamStatus ?? session?.status ?? 'spawning') as SessionStatus;
  const terminal = isTerminalSessionStatus(displayStatus);
  // Folded from the durable terminal event (reducer `stoppedByUser`) — same for
  // every viewer, survives replay/reload, clears when a new turn starts.
  const stoppedByUser = stream.stoppedByUser === true;
  const isEnded = displayStatus === 'failed' || (displayStatus === 'cancelled' && !stoppedByUser);
  const now = useNow(!terminal);
  const stalled = session ? !terminal && isStalledSessionStatus(session, now) : false;
  const costUsd = Math.max(session?.costUsd ?? 0, stream.costUsd);
  const resultText = stream.resultText || session?.resultText || '';
  const isDriver = !!session && sessionDriverId(session) === me.id;
  const isSpawner = !!session && session.spawnedBy === me.id;
  const canCancel = !!session && (isDriver || isSpawner) && !terminal;
  // A completed session is resumable (a steer regresses it to queued) — only
  // failed/cancelled are read-only, matching web and the server.
  const canSteer = !!session && isDriver && !isEnded;
  const pendingQuestion =
    session?.pendingQuestion !== undefined ? (session.pendingQuestion ?? null) : stream.pendingQuestion;
  const activeTurn = !terminal && !stalled;
  const starting = displayStatus === 'spawning' || displayStatus === 'queued';
  const canStopTurn = activeTurn && !starting;
  const mountedAtRef = useRef(Date.now());
  const disconnectedAtRef = useRef<number>(Date.now());
  const prevConnectedRef = useRef<boolean>(connected);
  if (prevConnectedRef.current !== connected) {
    prevConnectedRef.current = connected;
    if (!connected) disconnectedAtRef.current = Date.now();
  }
  const turnStatus = useMemo(
    () =>
      deriveTurnStatus({
        stream,
        now,
        connected,
        lastFrameAt,
        clockSkewMs,
        mountedAt: mountedAtRef.current,
        disconnectedAt: disconnectedAtRef.current,
        activeTurn,
        starting,
        completed: displayStatus === 'completed',
        pendingQuestionId: pendingQuestion?.questionId ?? null,
        suppressed: Boolean(session?.providerAuthRequired),
      }),
    [
      activeTurn,
      clockSkewMs,
      connected,
      displayStatus,
      lastFrameAt,
      now,
      pendingQuestion?.questionId,
      session?.providerAuthRequired,
      starting,
      stream,
    ],
  );
  const modelEffort = session?.modelEffort ?? null;
  const effortOptions = session ? HARNESS_EFFORT_PICKER_OPTIONS[session.harness] : undefined;
  const effortSelection = effortChoice ?? modelEffort ?? '';
  const canPickEffort = !!session && isDriver && !isEnded && effortOptions !== undefined;
  const nameFor = useCallback(
    (userId: string | null | undefined): string => {
      if (!userId) return 'someone';
      if (userId === me.id) return me.displayName;
      const member = state.channels
        .find((channel) => channel.id === session?.channelId)
        ?.members?.find((user) => user.id === userId);
      if (member) return member.displayName;
      if (userId === session?.driverId && session.driverName) return session.driverName;
      if (userId === session?.spawnedBy && session.spawnerName) return session.spawnerName;
      const req = session?.pendingSeatRequests.find((request) => request.userId === userId);
      if (req) return req.displayName;
      return userId;
    },
    [
      me.displayName,
      me.id,
      session?.channelId,
      session?.driverId,
      session?.driverName,
      session?.pendingSeatRequests,
      session?.spawnedBy,
      session?.spawnerName,
      state.channels,
    ],
  );
  const confirmedUserMessages = useMemo(
    () => stream.items.filter((item): item is UserMessageItem => item.type === 'user_message'),
    [stream.items],
  );
  const steerProvenanceByMessageId = useMemo(
    () => matchSteerProvenance(confirmedUserMessages, session?.suggestions ?? []),
    [confirmedUserMessages, session?.suggestions],
  );
  const acceptedByMeProvenanceKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const suggestion of session?.suggestions ?? []) {
      if (suggestion.status !== 'sent' || suggestion.resolvedBy !== me.id) continue;
      keys.add(
        steerProvenanceKey({
          proposerName: suggestion.authorName ?? suggestion.authorId,
          resolvedByName: suggestion.resolvedByName ?? suggestion.resolvedBy ?? 'someone',
          edited: suggestion.sentText != null,
          resolvedAt: suggestion.resolvedAt ?? suggestion.createdAt,
        }),
      );
    }
    return keys;
  }, [session?.suggestions, me.id]);
  const steerProvenanceForMessage = useCallback(
    (messageId: string): SteerRowProvenance | null => {
      const matched = steerProvenanceByMessageId.get(messageId);
      const optimistic = optimisticProvenanceByMessageId.get(messageId);
      const provenance = matched ?? optimistic?.provenance;
      if (!provenance) return null;
      return {
        provenance,
        acceptedByMe:
          optimistic?.acceptedByMe === true || acceptedByMeProvenanceKeys.has(steerProvenanceKey(provenance)),
      };
    },
    [acceptedByMeProvenanceKeys, optimisticProvenanceByMessageId, steerProvenanceByMessageId],
  );
  const addOptimisticSuggestionSteer = useCallback(
    ({ suggestion, text, edited }: OptimisticSuggestionSend): string => {
      const ts = new Date().toISOString();
      const pendingId = randomId();
      setPendingSteers((prev) => [
        ...prev,
        {
          id: pendingId,
          text,
          ts,
          provenance: {
            proposerName: suggestion.authorName ?? nameFor(suggestion.authorId),
            resolvedByName: me.displayName,
            edited,
            resolvedAt: ts,
          },
          acceptedByMe: true,
        },
      ]);
      return pendingId;
    },
    [me.displayName, nameFor],
  );
  const removeOptimisticSteer = useCallback((pendingId: string) => {
    setPendingSteers((prev) => prev.filter((pending) => pending.id !== pendingId));
  }, []);

  useEffect(() => {
    setPendingSteers([]);
    setOptimisticProvenanceByMessageId(new Map());
  }, [session?.id]);

  useEffect(() => {
    if (pendingSteers.length === 0) return;
    const echoed = new Map<string, UserMessageItem[]>();
    for (const item of stream.items) {
      if (item.type !== 'user_message') continue;
      const text = normalizeSteerProvenanceText(item.text);
      const matches = echoed.get(text);
      if (matches) matches.push(item);
      else echoed.set(text, [item]);
    }

    const consumedEchoes = new Set<string>();
    const carriedProvenance = new Map<string, SteerRowProvenance>();
    const keep = pendingSteers.filter((pending) => {
      const text = normalizeSteerProvenanceText(pending.text);
      const match = echoed.get(text)?.find((item) => !consumedEchoes.has(item.id));
      if (!match) return true;
      consumedEchoes.add(match.id);
      carriedProvenance.set(match.id, {
        provenance: pending.provenance,
        acceptedByMe: pending.acceptedByMe,
      });
      return false;
    });

    if (keep.length !== pendingSteers.length) setPendingSteers(keep);
    if (carriedProvenance.size > 0) {
      setOptimisticProvenanceByMessageId((prev) => {
        const next = new Map(prev);
        for (const [messageId, provenance] of carriedProvenance) next.set(messageId, provenance);
        return next;
      });
    }
  }, [pendingSteers, stream.items]);

  // Work surfaces (Phase 4 parity): derive from the shared stream exactly like
  // web — Changes · Side-effects · Artifacts. Each non-empty surface gets a strip
  // chip + a full-screen sheet tab.
  const fileChanges = useMemo(() => collectFileChanges(stream), [stream.items, stream.fileChanges]);
  const inlineCodexChanges = useMemo(
    () => codexInlineFileChanges(stream),
    [stream.items, stream.fileChanges],
  );
  const codexChangesAt = useCallback(
    (index: number) => inlineCodexChanges.filter((change) => change.index === index),
    [inlineCodexChanges],
  );
  const transcriptRows = useMemo(
    () => transcriptView === 'focus'
      ? focusTranscriptRows(stream.items, codexChangesAt)
      : fullTranscriptRows(stream.items, codexChangesAt),
    [codexChangesAt, stream.items, transcriptView],
  );
  const changedFileCount = useMemo(() => changedPaths(fileChanges).length, [fileChanges]);
  const sideEffects = useMemo(() => collectSideEffects(stream.items), [stream.items]);
  const sideEffectsN = useMemo(() => sideEffectCount(sideEffects), [sideEffects]);
  const sideEffectsDanger = useMemo(() => sideEffects.some((e) => e.risk === 'danger'), [sideEffects]);
  const artifacts = useMemo(() => collectArtifacts(stream), [stream.artifacts]);
  const artifactsN = useMemo(() => artifactCount(artifacts), [artifacts]);
  const turns = useMemo(() => deriveTurns(stream.items), [stream.items]);
  const entryHandles = useMemo(() => {
    const seen = new Set<string>();
    for (const item of stream.items) {
      const handle = transcriptEntryHandle(item);
      if (handle) seen.add(handle);
    }
    return [...seen].sort();
  }, [stream.items]);
  const entryHandlesKey = entryHandles.join('\n');
  const queryEntryReferences = useMemo(() => createEntryReferenceQuery(authSession), [authSession]);
  const workTabs = useMemo<WorkSurfaceTab[]>(() => {
    const tabs: WorkSurfaceTab[] = [];
    if (changedFileCount > 0) {
      tabs.push({
        key: 'changes',
        label: 'Changes',
        count: changedFileCount,
        render: () => <ChangesSurface changes={fileChanges} />,
      });
    }
    if (sideEffectsN > 0) {
      tabs.push({
        key: 'sideEffects',
        label: 'Side-effects',
        count: sideEffectsN,
        danger: sideEffectsDanger,
        render: () => <SideEffectsSurface effects={sideEffects} />,
      });
    }
    if (id && artifactsN > 0) {
      tabs.push({
        key: 'artifacts',
        label: 'Artifacts',
        count: artifactsN,
        render: () => (
          <ArtifactsSurface
            artifacts={artifacts}
            artifactUri={(artifact) => chat.artifactUrl(id, artifact)}
            imageHeaders={chat.fileHeaders}
          />
        ),
      });
    }
    return tabs;
  }, [
    fileChanges,
    changedFileCount,
    sideEffects,
    sideEffectsN,
    sideEffectsDanger,
    artifacts,
    artifactsN,
    chat,
    id,
  ]);
  const workStripItems = useMemo<WorkStripItem[]>(
    () => workTabs.map((t) => ({ key: t.key, label: t.label, count: t.count, danger: t.danger })),
    [workTabs],
  );

  const jumpToItem = useCallback((itemId: string) => {
    const y = itemOffsets.current[itemId];
    if (typeof y === 'number') scrollRef.current?.scrollTo({ y: Math.max(y - 8, 0), animated: true });
  }, []);
  const openEntryChannel = useCallback((channelId: string) => {
    router.push(`/channel/${channelId}`);
  }, []);
  const openEntrySession = useCallback((sessionId: string) => {
    router.push(`/session/${sessionId}`);
  }, []);

  const displayCancelAsk = id && chat.failedSessionCancels[id] ? 'failed' : cancelAsk;
  const visibleSteerError = id ? (steerError ?? chat.failedSessionSteers[id] ?? null) : steerError;
  const steerEntryLinkHandles = useMemo(
    () => extractEntryLinkHandles(steerText, chat.serverUrl),
    [chat.serverUrl, steerText],
  );
  const cancelErrorMessage =
    displayCancelAsk === 'failed'
      ? canStopTurn
        ? 'Stop turn failed. Tap retry.'
        : 'Cancel failed. Tap retry cancel.'
      : null;
  useModalAccessibilityFocus(effortTitleRef, effortOpen && canPickEffort);
  useAccessibilityAnnouncement(sessionLinkCopied ? 'Copied session link.' : null);
  useAccessibilityAnnouncement(
    transcriptCopied === 'text'
      ? 'Transcript text copied.'
      : transcriptCopied === 'link'
        ? 'Transcript link copied.'
        : null,
  );
  useAccessibilityAnnouncement(cancelErrorMessage);
  useAccessibilityAnnouncement(visibleSteerError ? `Message did not send: ${visibleSteerError}` : null);
  const elapsedMsForHeader = session
    ? terminal
      ? sessionElapsedMs(session, now)
      : turnStatus.elapsedMs
    : 0;
  const elapsed = elapsedMsForHeader > 0 ? formatElapsed(elapsedMsForHeader) : '';
  const questionEvents = session?.questionEvents ?? [];
  const questionEventsByQuestion = useMemo(
    () => groupQuestionEventsByQuestion(questionEvents),
    [questionEvents],
  );

  // Control loop (Phase 4 parity): seat hand-off, suggestion queue, answer
  // proposals — read off the WS-folded entity (mergeSpawnResponse keeps the live
  // arrays). Core steering already works; this is the collaborative layer.
  const driverId = session ? sessionDriverId(session) : null;
  const driverName = session?.driverName ?? 'the driver';
  const waitingDriverName = session?.driverName ?? session?.spawnerName ?? 'the driver';
  const turnPhase = turnStatus.phase;
  const statusLabel = stoppedByUser
    ? 'stopped by you'
    : turnStatusLabel({
        phase: turnPhase,
        starting,
        headline: turnStatus.headline,
        openTool: turnStatus.openTool,
        waitingLabel:
          driverId === me.id ? 'Waiting for your reply' : `Waiting for ${waitingDriverName}`,
      });
  const visibleSeatRequests = (session?.pendingSeatRequests ?? []).filter(
    (r) => !ignoredSeatRequests.has(r.userId),
  );
  const firstSeatRequest = visibleSeatRequests[0] ?? null;
  const iRequestedSeat = (session?.pendingSeatRequests ?? []).some((r) => r.userId === me.id);
  const seatFooterMode: 'request' | 'take' | 'confirm' | 'waiting' = iRequestedSeat
    ? 'waiting'
    : seatAsk === 'confirm-take'
      ? 'confirm'
      : driverId != null
        ? 'request'
        : 'take';
  const proposalsForQuestion = (session?.answerProposals ?? []).filter(
    (p) => p.status === 'pending' && p.questionId === pendingQuestion?.questionId,
  );

  useEffect(() => {
    setQuestionValues({});
    setQuestionSubmitting(false);
    setQuestionCleared(null);
    setQuestionError(null);
  }, [pendingQuestion?.questionId]);

  useEffect(() => {
    setEffortChoice(null);
    setEffortOpen(false);
  }, [session?.id]);

  // Close the picker whenever it becomes unpickable — a stale open flag would
  // pop the modal unprompted when pickability returns (e.g. a later revive).
  useEffect(() => {
    if (!canPickEffort) setEffortOpen(false);
  }, [canPickEffort]);

  useEffect(() => {
    if (cancelAsk !== 'confirm') return;
    const timer = setTimeout(() => setCancelAsk('idle'), 5000);
    return () => clearTimeout(timer);
  }, [cancelAsk]);

  useEffect(() => {
    return () => {
      if (sessionLinkResetRef.current) clearTimeout(sessionLinkResetRef.current);
    };
  }, []);

  useEffect(() => {
    if (!id || !focusedForReferences.current) return;
    if (entryHandles.length === 0) {
      setReferences({});
      return;
    }

    const cacheKey = `${id}:${entryHandlesKey}`;
    const cachedReferences = referenceCache.current[cacheKey];
    if (cachedReferences) {
      setReferences(cachedReferences);
    }
    const focusFetchKey = `${referenceFocusSeq}:${cacheKey}`;
    if (referenceFetchKeys.current.has(focusFetchKey)) return;
    referenceFetchKeys.current.add(focusFetchKey);

    let disposed = false;
    queryEntryReferences(entryHandles)
      .then((next) => {
        if (disposed || !focusedForReferences.current) return;
        referenceCache.current[cacheKey] = next;
        setReferences(next);
      })
      .catch((err: unknown) => {
        if (!disposed) console.warn('failed to load entry references', err);
      });

    return () => {
      disposed = true;
    };
  }, [entryHandles, entryHandlesKey, id, queryEntryReferences, referenceFocusSeq]);

  useEffect(() => {
    if (stickRef.current) scrollRef.current?.scrollToEnd({ animated: !reduceMotion });
  }, [pendingSteers.length, reduceMotion, stream.lastEventId, resultText]);

  useEffect(() => {
    setTranscriptCopied(null);
    if (transcriptCopyCloseRef.current) {
      clearTimeout(transcriptCopyCloseRef.current);
      transcriptCopyCloseRef.current = null;
    }
  }, [transcriptActionTarget]);

  useEffect(() => {
    return () => {
      if (transcriptCopyCloseRef.current) clearTimeout(transcriptCopyCloseRef.current);
    };
  }, []);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setActiveTranscriptEntryId(null);
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    stickRef.current =
      contentSize.height - contentOffset.y - layoutMeasurement.height < 96;
  };

  // The server re-attaches the recorded effort to effort-less steers; the
  // client only sends an explicit change, guarded to the harness vocabulary.
  const effortOverride = () =>
    canPickEffort &&
    effortSelection &&
    effortSelection !== (modelEffort ?? '') &&
    effortOptions?.includes(effortSelection)
      ? effortSelection
      : undefined;
  const reportSessionActionError = useCallback(
    (err: unknown, fallback: string, options: { alert?: boolean } = {}) => {
      if (err instanceof ApiError && err.status === 401) {
        void invalidate();
        return;
      }
      if (options.alert === false) return;
      Alert.alert('Action failed', err instanceof ApiError && err.message ? err.message : fallback);
    },
    [invalidate],
  );

  const copySessionLink = useCallback(() => {
    const url = sessionLink(chat.serverUrl, id);
    selectionHaptic();
    void Clipboard.setStringAsync(url)
      .then(() => {
        setSessionLinkCopied(true);
        if (sessionLinkResetRef.current) clearTimeout(sessionLinkResetRef.current);
        sessionLinkResetRef.current = setTimeout(() => {
          sessionLinkResetRef.current = null;
          setSessionLinkCopied(false);
        }, 1400);
      })
      .catch(() => {});
  }, [chat.serverUrl, id]);

  // Header overflow: pin/archive/transcript-view live behind one ⋯ button so
  // the title keeps room next to copy-link and cancel on small phones.
  const openHeaderActions = useCallback(() => {
    if (!session) return;
    const isArchived = session.archivedAt != null;
    Alert.alert(session.title, undefined, [
      ...(isArchived
        ? []
        : [
            {
              text: session.pinned ? 'Unpin' : 'Pin',
              onPress: () => chat.setSessionPinned(session.id, !session.pinned, session.pinned),
            },
          ]),
      {
        text: isArchived ? 'Unarchive' : 'Archive',
        onPress: () => chat.setSessionArchived(session.id, !isArchived, session.archivedAt),
      },
      {
        text: transcriptView === 'focus' ? 'Show full transcript' : 'Show focus transcript',
        onPress: () => setTranscriptView(transcriptView === 'focus' ? 'full' : 'focus'),
      },
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  }, [chat, session, setTranscriptView, transcriptView]);

  const sendSteer = () => {
    if (!id) return;
    const text = steerText.trim();
    if (!text) return;
    setSteerText('');
    setSteerError(null);
    chat.clearFailedSessionSteer(id);
    chat.steerSession(id, text, effortOverride()).catch(() => setSteerError(text));
  };

  const retrySteer = () => {
    if (!id || !visibleSteerError) return;
    const text = visibleSteerError;
    setSteerError(null);
    chat.clearFailedSessionSteer(id);
    chat.steerSession(id, text, effortOverride()).catch(() => setSteerError(text));
  };

  const cancel = () => {
    if (!id) return;
    if (canStopTurn) {
      setCancelAsk('idle');
      chat.clearFailedSessionCancel(id);
      chat.stopTurn(id).catch(() => setCancelAsk('failed'));
      return;
    }
    if (displayCancelAsk === 'idle') {
      setCancelAsk('confirm');
      return;
    }
    setCancelAsk('idle');
    chat.clearFailedSessionCancel(id);
    chat.cancelSession(id).catch(() => setCancelAsk('failed'));
  };

  const answerQuestion = () => {
    if (!id || !pendingQuestion) return;
    const answers: Record<string, { answers: string[] }> = {};
    for (const q of pendingQuestion.questions) {
      answers[q.id] = { answers: answerValuesForPrompt(q, questionValues[q.id]) };
    }
    setQuestionSubmitting(true);
    setQuestionError(null);
    chat
      .answerSessionQuestion(id, pendingQuestion.questionId, answers)
      .then(() => setQuestionCleared(pendingQuestion.questionId))
      .catch(() => setQuestionError("Answer didn't send. Try again."))
      .finally(() => setQuestionSubmitting(false));
  };

  // Spectator proposes an answer (vs the driver answering directly).
  const proposeAnswer = () => {
    if (!id || !pendingQuestion) return;
    const answers: Record<string, { answers: string[] }> = {};
    for (const q of pendingQuestion.questions) {
      answers[q.id] = { answers: answerValuesForPrompt(q, questionValues[q.id]) };
    }
    setQuestionSubmitting(true);
    setQuestionError(null);
    api
      .proposeAnswer(id, pendingQuestion.questionId, answers)
      .then(() => setQuestionCleared(pendingQuestion.questionId))
      .catch((err: unknown) => {
        reportSessionActionError(err, "Proposal didn't send. Try again.", { alert: false });
        setQuestionError("Proposal didn't send. Try again.");
      })
      .finally(() => setQuestionSubmitting(false));
  };

  // Seat hand-off. Take is two-step (confirm) and falls back to a request on 409.
  const requestSeatAction = () => {
    if (id) api.requestSeat(id).catch((err: unknown) => reportSessionActionError(err, "Couldn't request the seat."));
  };
  const takeSeatAction = () => {
    if (!id) return;
    setSeatAsk('idle');
    api.takeSeat(id).catch((err) => {
      if (err instanceof ApiError && err.status === 409) {
        api.requestSeat(id).catch((requestErr: unknown) =>
          reportSessionActionError(requestErr, "Couldn't request the seat."),
        );
        return;
      }
      reportSessionActionError(err, "Couldn't take the seat.");
    });
  };
  const grantSeatAction = (userId: string) => {
    if (id) api.grantSeat(id, userId).catch((err: unknown) => reportSessionActionError(err, "Couldn't grant the seat."));
  };
  const ignoreSeatRequest = (userId: string) =>
    setIgnoredSeatRequests((prev) => {
      const next = new Set(prev);
      next.add(userId);
      return next;
    });

  // Suggestion queue.
  const resolveSuggestionAction = (
    suggestionId: string,
    action: 'send' | 'dismiss',
    opts?: { text?: string; note?: string },
  ): Promise<void> => {
    if (!id) return Promise.resolve();
    return api
      .resolveSuggestion(id, suggestionId, action, opts ?? {}, { opId: randomId() })
      .then(() => undefined)
      .catch((err: unknown) => {
        const message = action === 'send' ? "Couldn't send the suggestion." : "Couldn't dismiss the suggestion.";
        reportSessionActionError(err, message);
        throw err;
      });
  };
  const sendSuggestion = () => {
    const text = suggestText.trim();
    if (!id || !text) return;
    setSuggestText('');
    api.createSuggestion(id, text, { opId: randomId() }).catch((err: unknown) => {
      setSuggestText((current) => (current === '' ? text : current));
      reportSessionActionError(err, "Couldn't send the suggestion.");
    });
  };

  const openReference = useCallback((ref: EntryReference) => {
    if (ref.threadRootEventId != null) {
      router.push({
        pathname: '/thread/[rootId]',
        params: { rootId: String(ref.threadRootEventId), channelId: ref.channelId },
      });
      return;
    }
    router.push(`/channel/${ref.channelId}`);
  }, []);

  const openReferenceSummary = useCallback(
    (summary: EntryReferenceSummary | null) => {
      const latest = summary?.latest ?? [];
      if (latest.length === 0) return;
      if (latest.length === 1) {
        openReference(latest[0]!);
        return;
      }
      Alert.alert(
        'Discussed in',
        undefined,
        [
          ...latest.slice(0, 6).map((ref) => ({
            text: referenceLabel(ref),
            onPress: () => openReference(ref),
          })),
          { text: 'Cancel', style: 'cancel' as const },
        ],
      );
    },
    [openReference],
  );

  const sessionChannelId = session?.channelId ?? null;
  const sessionThreadRootEventId = session?.threadRootEventId ?? null;

  const discussInThread = useCallback(
    (handle: string) => {
      if (sessionChannelId == null || sessionThreadRootEventId == null) {
        Alert.alert('Discuss in thread', 'This session does not have a channel thread.');
        return;
      }
      router.push({
        pathname: '/thread/[rootId]',
        params: {
          rootId: String(sessionThreadRootEventId),
          channelId: sessionChannelId,
          prefill: entryUrl(chat.serverUrl, handle),
        },
      });
    },
    [chat.serverUrl, sessionChannelId, sessionThreadRootEventId],
  );

  const openMarkupSteer = useCallback(
    async (handle: string) => {
      if (!id) return;
      try {
        const draft = await loadMarkupDraftFromEntry({
          api: chat.api,
          serverUrl: chat.serverUrl,
          fileHeaders: chat.fileHeaders,
          handle,
          mode: { kind: 'steer', sessionId: id },
        });
        const draftId = putPendingMarkupDraft(draft);
        router.push({ pathname: '/markup-editor', params: { draftId } });
      } catch (err) {
        Alert.alert('Markup', err instanceof Error ? err.message : 'Could not open markup editor.');
      }
    },
    [chat.api, chat.fileHeaders, chat.serverUrl, id],
  );

  const transcriptCopyTextForItem = useCallback((item: SessionItem): string | null => {
    if (item.type === 'text' || item.type === 'reasoning' || item.type === 'user_message') {
      const text = item.text.trim();
      return text ? text : null;
    }
    return null;
  }, []);

  const openTranscriptActions = useCallback(
    (item: SessionItem) => {
      const handle = transcriptEntryHandle(item);
      if (!handle) return;
      setActiveTranscriptEntryId(null);
      const canLinkEntry = sessionThreadRootEventId != null;
      setTranscriptActionTarget({
        id: item.id,
        handle,
        copyText: transcriptCopyTextForItem(item),
        link: canLinkEntry ? entryLink(chat.serverUrl, handle) : null,
        canDiscuss: canDiscussTranscriptHandle(handle),
      });
    },
    [chat.serverUrl, sessionThreadRootEventId, transcriptCopyTextForItem],
  );

  const closeTranscriptActions = useCallback(() => {
    setTranscriptActionTarget(null);
  }, []);

  const closeTranscriptActionsAfterCopy = useCallback(() => {
    if (transcriptCopyCloseRef.current) clearTimeout(transcriptCopyCloseRef.current);
    transcriptCopyCloseRef.current = setTimeout(() => {
      transcriptCopyCloseRef.current = null;
      setTranscriptCopied(null);
      closeTranscriptActions();
    }, 700);
  }, [closeTranscriptActions]);

  const copyTranscriptAction = useCallback(
    (kind: 'text' | 'link', value: string) => {
      selectionHaptic();
      void Clipboard.setStringAsync(value)
        .then(() => {
          setTranscriptCopied(kind);
          closeTranscriptActionsAfterCopy();
        })
        .catch(() => closeTranscriptActions());
    },
    [closeTranscriptActions, closeTranscriptActionsAfterCopy],
  );

  const transcriptActions = useMemo<MessageActionListItem[]>(() => {
    const target = transcriptActionTarget;
    if (!target) return [];
    const actions: MessageActionListItem[] = [];
    if (target.copyText) {
      actions.push({
        key: 'copy-text',
        label: transcriptCopied === 'text' ? 'Copied' : 'Copy text',
        hint: 'Copies the transcript text to the clipboard',
        onSelect: () => copyTranscriptAction('text', target.copyText ?? ''),
      });
    }
    if (target.link) {
      actions.push({
        key: 'copy-link',
        label: transcriptCopied === 'link' ? 'Copied link' : 'Copy link',
        hint: 'Copies a link to this transcript entry to the clipboard',
        onSelect: () => copyTranscriptAction('link', target.link ?? ''),
      });
    }
    if (target.canDiscuss && target.handle) {
      actions.push({
        key: 'discuss',
        label: 'Discuss in thread',
        hint: 'Opens a thread anchored to this transcript entry',
        onSelect: () => {
          closeTranscriptActions();
          discussInThread(target.handle ?? '');
        },
      });
      actions.push({
        key: 'markup',
        label: 'Mark up & send to agent',
        hint: 'Opens markup for this transcript entry',
        onSelect: () => {
          closeTranscriptActions();
          void openMarkupSteer(target.handle ?? '');
        },
      });
    }
    return actions;
  }, [
    closeTranscriptActions,
    copyTranscriptAction,
    discussInThread,
    openMarkupSteer,
    transcriptActionTarget,
    transcriptCopied,
  ]);

  // Answer proposals (driver-side resolution).
  const submitProposal = (proposalId: string) => {
    if (id) {
      api
        .resolveAnswerProposal(id, proposalId, 'submit')
        .catch((err: unknown) => reportSessionActionError(err, "Couldn't submit the proposal."));
    }
  };
  const dismissProposal = (proposalId: string, note?: string) => {
    if (id) {
      api
        .resolveAnswerProposal(id, proposalId, 'dismiss', note ? { note } : {})
        .catch((err: unknown) => reportSessionActionError(err, "Couldn't dismiss the proposal."));
    }
  };

  const headerSubtitle = useMemo(() => {
    if (!session) return '';
    const pieces = [formatCost(costUsd), elapsed];
    if (stalled) pieces.push(`started ${formatTime(session.createdAt)}`);
    if (!connected && !terminal) pieces.push('reconnecting...');
    return pieces.filter(Boolean).join('  ');
  }, [connected, costUsd, elapsed, session, stalled, terminal]);

  const headerSubtitleAccessibilityLabel = useMemo(() => {
    if (!session) return '';
    const pieces = [formatCost(costUsd), elapsed];
    if (stalled) pieces.push(`started ${formatExactTimestamp(session.createdAt) || formatTime(session.createdAt)}`);
    if (!connected && !terminal) pieces.push('reconnecting');
    return pieces.filter(Boolean).join(', ');
  }, [connected, costUsd, elapsed, session, stalled, terminal]);

  if (!id) return null;

  if (!session && (loading || !loadError)) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: space.lg, gap: space.md }}>
        <Stack.Screen options={{ title: 'Session' }} />
        <Text style={{ color: colors.text, fontSize: font.lg, fontWeight: '800' }}>
          Session unavailable
        </Text>
        <Text style={{ color: colors.textSecondary, fontSize: font.sm }}>
          {loadError ?? 'This session could not be loaded.'}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={() => router.back()}
          style={{
            alignSelf: 'flex-start',
            borderRadius: radius.sm,
            backgroundColor: colors.bgElevated,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
          }}
        >
          <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '700' }}>Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ maxWidth: 260, gap: 3 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <StatusChip status={displayStatus} stalled={stalled} />
              </View>
              <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }} numberOfLines={1}>
                {session.title}
              </Text>
              <Text
                accessibilityLabel={headerSubtitleAccessibilityLabel || undefined}
                style={{ color: colors.textMuted, fontSize: font.xs }}
                numberOfLines={1}
              >
                {headerSubtitle}
              </Text>
            </View>
          ),
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={sessionLinkCopied ? 'Copied agent link' : 'Copy link to this agent'}
                onPress={copySessionLink}
                hitSlop={8}
                style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', padding: 6 }}
              >
                <Ionicons
                  name={sessionLinkCopied ? 'checkmark' : 'link-outline'}
                  size={18}
                  color={sessionLinkCopied ? colors.accent : colors.textSecondary}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Agent actions"
                onPress={openHeaderActions}
                hitSlop={8}
                style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', padding: 6 }}
              >
                <Ionicons name="ellipsis-horizontal" size={18} color={colors.textSecondary} />
              </Pressable>
              {canCancel ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    canStopTurn
                      ? displayCancelAsk === 'failed'
                        ? 'Retry stop turn'
                        : 'Stop current turn'
                      : displayCancelAsk === 'confirm'
                        ? 'Confirm cancel agent'
                        : 'Cancel agent'
                  }
                  accessibilityState={{ disabled: false }}
                  onPress={cancel}
                  hitSlop={8}
                  style={{ minHeight: 44, justifyContent: 'center' }}
                >
                  <Text
                    style={{
                      color:
                        displayCancelAsk === 'failed' || displayCancelAsk === 'confirm'
                          ? colors.danger
                          : canStopTurn
                            ? colors.warning
                            : colors.textSecondary,
                      fontSize: font.xs,
                      fontWeight: '800',
                    }}
                  >
                    {canStopTurn
                      ? displayCancelAsk === 'failed'
                        ? 'RETRY TURN'
                        : 'STOP TURN'
                      : displayCancelAsk === 'confirm'
                        ? 'CONFIRM'
                        : displayCancelAsk === 'failed'
                          ? 'RETRY CANCEL'
                          : 'CANCEL'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ),
          headerBackButtonDisplayMode: 'minimal',
        }}
      />
      {cancelErrorMessage && (
        <View
          accessibilityLiveRegion="polite"
          style={{ backgroundColor: colors.dangerSurface, padding: space.sm }}
        >
          <Text style={{ color: colors.danger, fontSize: font.xs, textAlign: 'center' }}>
            {cancelErrorMessage}
          </Text>
        </View>
      )}
      {session.archivedAt != null && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            backgroundColor: colors.bgElevated,
            borderBottomWidth: 1,
            borderBottomColor: colors.borderSoft,
            paddingHorizontal: space.lg,
            paddingVertical: space.sm,
          }}
        >
          <Text style={{ flex: 1, color: colors.textMuted, fontSize: font.xs }}>
            Archived — new activity will bring it back.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Unarchive this agent"
            onPress={() => chat.setSessionArchived(session.id, false, session.archivedAt)}
            hitSlop={8}
            style={{ minHeight: 32, justifyContent: 'center' }}
          >
            <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '700' }}>
              UNARCHIVE
            </Text>
          </Pressable>
        </View>
      )}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={headerHeight}
      >
        {turns.length > 1 ? (
          <Pressable
            onPress={() => setTurnsOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`Turns: ${turns.length}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              alignSelf: 'flex-start',
              marginHorizontal: space.md,
              marginTop: space.sm,
              paddingHorizontal: space.sm,
              paddingVertical: 4,
              borderRadius: radius.sm,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.bgElevated,
            }}
          >
            <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '700' }}>
              Turns ▾ {turns.length}
            </Text>
          </Pressable>
        ) : null}
        <ScrollView
          ref={scrollRef}
          onScroll={onScroll}
          onTouchStart={() => setActiveTranscriptEntryId(null)}
          scrollEventThrottle={80}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: space.md, gap: space.md }}
        >
          <PlanPanel todos={stream.todos} plan={stream.plan} />

          {terminal ? (
            <TurnCard status={displayStatus} resultText={resultText} costUsd={costUsd} />
          ) : null}

          {pendingQuestion && pendingQuestion.questionId !== questionCleared && !terminal ? (
            <MobileQuestionBanner
              pending={pendingQuestion}
              isDriver={isDriver}
              values={questionValues}
              setValue={(qid, value) => {
                setQuestionError(null);
                setQuestionValues((prev) => ({ ...prev, [qid]: value }));
              }}
              submitting={questionSubmitting}
              error={questionError}
              onSubmit={isDriver ? answerQuestion : proposeAnswer}
            />
          ) : null}

          {isDriver && pendingQuestion && !terminal && proposalsForQuestion.length > 0 ? (
            <AnswerProposals
              proposals={proposalsForQuestion}
              prompts={pendingQuestion.questions}
              onSubmit={submitProposal}
              onDismiss={dismissProposal}
            />
          ) : null}

          {stream.items.length === 0 ? (
            <View style={{ paddingVertical: space.xl, alignItems: 'center' }}>
              <Text style={{ color: colors.textMuted, fontSize: font.sm }}>
                {terminal ? 'No transcript.' : 'Waiting for agent output...'}
              </Text>
            </View>
          ) : null}

          {transcriptRows.map((row) => {
            if (row.kind === 'hidden') {
              return (
                <HiddenWorkChip
                  key={`hidden-${row.key}`}
                  count={row.count}
                  onShowFull={() => setTranscriptView('full')}
                />
              );
            }
            if (row.kind === 'change') {
              return <InlineFileChange key={row.change.change.id} change={row.change.change} />;
            }
            const { item } = row;
            const handle = transcriptEntryHandle(item);
            const reference = handle ? (references[handle] ?? null) : null;
            const hasActions = handle != null;
            const revealActions = item.type === 'text' || item.type === 'reasoning' || item.type === 'user_message';
            const showReveal = revealActions && hasActions && activeTranscriptEntryId === item.id;
            const openActionsWithHaptic = () => {
              if (!hasActions) return;
              lightImpactHaptic();
              openTranscriptActions(item);
            };
            const revealOrMoveActions = () => {
              if (!hasActions || !revealActions) return;
              setActiveTranscriptEntryId(item.id);
            };
            const openActionsFromButton = () => {
              if (!hasActions) return;
              openTranscriptActions(item);
            };
            return (
              <Fragment key={item.id}>
                <View
                  onLayout={(e) => {
                    itemOffsets.current[item.id] = e.nativeEvent.layout.y;
                  }}
                >
                  <TranscriptRowFrame
                    reference={reference}
                    onOpenReference={() => openReferenceSummary(reference)}
                  >
                    <TranscriptActiveEntryFrame active={showReveal} onActions={openActionsFromButton}>
                      {item.type === 'text' ? (
                        hasActions ? (
                          <Pressable
                            testID={`transcript-entry-${item.type}`}
                            accessibilityRole="button"
                            accessibilityLabel={
                              item.text.trim() ? `Message actions: ${item.text}` : 'Message actions'
                            }
                            onPress={revealOrMoveActions}
                            onLongPress={openActionsWithHaptic}
                            delayLongPress={250}
                          >
                            <TextBlock item={item} />
                          </Pressable>
                        ) : (
                          <TextBlock item={item} />
                        )
                      ) : item.type === 'user_message' ? (
                        <SteerRow
                          text={item.text}
                          ts={item.ts}
                          provenance={steerProvenanceForMessage(item.id)}
                          serverUrl={chat.serverUrl}
                          resolveEntry={chat.resolveEntry}
                          onOpenChannel={openEntryChannel}
                          onOpenSession={openEntrySession}
                          onPress={hasActions ? revealOrMoveActions : undefined}
                          onLongPress={hasActions ? openActionsWithHaptic : undefined}
                          delayLongPress={250}
                        />
                      ) : item.type === 'question' ? (
                        <MobileQuestionTranscriptCard
                          item={item}
                          events={questionEventsByQuestion.get(item.questionId) ?? []}
                          onLongPress={hasActions ? openActionsWithHaptic : undefined}
                        />
                      ) : item.type === 'reasoning' ? (
                        hasActions ? (
                          <Pressable
                            testID={`transcript-entry-${item.type}`}
                            accessibilityRole="button"
                            accessibilityLabel={
                              item.text.trim() ? `Message actions: ${item.text}` : 'Message actions'
                            }
                            onPress={revealOrMoveActions}
                            onLongPress={openActionsWithHaptic}
                            delayLongPress={250}
                          >
                            {/* Header long-press forwards too: the block's own
                            expand Pressable wins the gesture over this wrapper. */}
                            <ReasoningBlock item={item} onLongPress={openActionsWithHaptic} />
                          </Pressable>
                        ) : (
                          <ReasoningBlock item={item} />
                        )
                      ) : item.type === 'tool_call' ? (
                        <TranscriptTool item={item} onLongPress={hasActions ? openActionsWithHaptic : undefined} />
                      ) : null}
                    </TranscriptActiveEntryFrame>
                  </TranscriptRowFrame>
                </View>
              </Fragment>
            );
          })}
          {pendingSteers.map((pending) => (
            <SteerRow
              key={pending.id}
              text={pending.text}
              ts={pending.ts}
              provenance={{ provenance: pending.provenance, acceptedByMe: pending.acceptedByMe }}
              serverUrl={chat.serverUrl}
              resolveEntry={chat.resolveEntry}
              onOpenChannel={openEntryChannel}
              onOpenSession={openEntrySession}
            />
          ))}
        </ScrollView>

        <WorkStrips items={workStripItems} onOpen={setWorkTab} />

        {!isEnded && turnPhase ? (
          <TurnStatusLine
            phase={turnPhase}
            liveness={turnStatus.liveness}
            label={statusLabel}
            elapsedMs={turnStatus.elapsedMs}
            quietMs={turnPhase === 'waiting' ? turnStatus.waitingMs : turnStatus.quietMs}
            pulse={stream.frameSeq}
            tokens={turnStatus.tokens}
            costUsd={costUsd}
            models={stream.models}
            effort={modelEffort}
            cancelLabel={
              canStopTurn
                ? 'Stop'
                : displayCancelAsk === 'confirm'
                  ? 'Confirm cancel'
                  : 'Cancel'
            }
            onCancel={isSpawner || isDriver ? cancel : undefined}
          />
        ) : null}

        {visibleSteerError ? (
          <View
            accessibilityLiveRegion="polite"
            style={{
              borderTopWidth: 1,
              borderTopColor: colors.dangerBorder,
              backgroundColor: colors.dangerSurface,
              padding: space.sm,
              gap: space.sm,
            }}
          >
            <Text style={{ color: colors.danger, fontSize: font.xs }} numberOfLines={2}>
              Message did not send: "{visibleSteerError}"
            </Text>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry sending session message"
                accessibilityHint="Attempts to send this message again"
                onPress={retrySteer}
                hitSlop={10}
                style={{ minHeight: 44, justifyContent: 'center' }}
              >
                <Text style={{ color: colors.text, fontSize: font.xs, fontWeight: '800' }}>Retry</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Dismiss failed session message"
                accessibilityHint="Removes this failed message notice"
                onPress={() => {
                  setSteerError(null);
                  if (id) chat.clearFailedSessionSteer(id);
                }}
                hitSlop={10}
                style={{ minHeight: 44, justifyContent: 'center' }}
              >
                <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '700' }}>Dismiss</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {!terminal && isDriver && firstSeatRequest ? (
          <SeatRequestBanner
            requesterName={firstSeatRequest.displayName}
            onGrant={() => grantSeatAction(firstSeatRequest.userId)}
            onIgnore={() => ignoreSeatRequest(firstSeatRequest.userId)}
          />
        ) : null}

        <SuggestionsStrip
          suggestions={session.suggestions}
          isDriver={isDriver}
          onSend={(sid) => resolveSuggestionAction(sid, 'send')}
          onEditSend={(sid, text) => resolveSuggestionAction(sid, 'send', { text })}
          onDismiss={(sid, note) => resolveSuggestionAction(sid, 'dismiss', note ? { note } : undefined)}
          onOptimisticSend={addOptimisticSuggestionSteer}
          onOptimisticSendFailed={removeOptimisticSteer}
        />

        {isEnded ? (
          <View style={{ borderTopWidth: 1, borderTopColor: colors.border, padding: space.sm }}>
            <Text style={{ color: colors.textMuted, fontSize: font.xs, textAlign: 'center' }}>
              Session ended. Transcript is read-only.
            </Text>
          </View>
        ) : canSteer ? (
          <View
            accessibilityViewIsModal
            style={{
              borderTopWidth: 1,
              borderTopColor: colors.border,
              backgroundColor: colors.bg,
              padding: space.sm,
              flexDirection: 'row',
              alignItems: 'flex-end',
              gap: space.sm,
            }}
          >
            {canPickEffort ? (
              <Pressable
                testID="effort-picker"
                accessibilityRole="button"
                accessibilityLabel="Reasoning effort for the next turn"
                onPress={() => setEffortOpen(true)}
                style={({ pressed }) => ({
                  minHeight: 38,
                  justifyContent: 'center',
                  borderRadius: radius.sm,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
                  paddingHorizontal: space.sm,
                })}
              >
                <Text style={{ color: colors.textSecondary, fontSize: font.xs, fontWeight: '800' }}>
                  {effortSelection || 'effort'}
                </Text>
              </Pressable>
            ) : null}
            <View style={{ flex: 1, gap: 6 }}>
              {steerEntryLinkHandles.length > 0 ? (
                <View
                  testID="session-steer-entry-link-preview"
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 6,
                    paddingHorizontal: space.xs,
                  }}
                >
                  <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '700' }}>
                    referencing:
                  </Text>
                  {steerEntryLinkHandles.map((handle) => (
                    <EntryInlineChip
                      key={handle}
                      handle={handle}
                      resolveEntry={chat.resolveEntry}
                      onOpenChannel={openEntryChannel}
                      onOpenSession={openEntrySession}
                    />
                  ))}
                </View>
              ) : null}
              <TextInput
                accessibilityLabel="Agent message"
                value={steerText}
                onChangeText={setSteerText}
                placeholder="Message this agent"
                placeholderTextColor={colors.textFaint}
                multiline
                style={{
                  alignSelf: 'stretch',
                  minHeight: 38,
                  maxHeight: 110,
                  borderRadius: radius.md,
                  backgroundColor: colors.bgInput,
                  color: colors.text,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  fontSize: font.md,
                }}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send session message"
              accessibilityState={{ disabled: !steerText.trim() }}
              onPress={sendSteer}
              disabled={!steerText.trim()}
              style={{
                borderRadius: radius.md,
                backgroundColor: steerText.trim() ? colors.accent : colors.bgElevated,
                paddingHorizontal: space.md,
                minHeight: 44,
                minWidth: 44,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }}>Send</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <SeatFooter
              mode={seatFooterMode}
              driverName={driverName}
              onRequest={requestSeatAction}
              onTake={() => setSeatAsk('confirm-take')}
              onConfirmTake={takeSeatAction}
              onCancelTake={() => setSeatAsk('idle')}
            />
            <View
              style={{
                borderTopWidth: 1,
                borderTopColor: colors.border,
                backgroundColor: colors.bg,
                padding: space.sm,
                flexDirection: 'row',
                alignItems: 'flex-end',
                gap: space.sm,
              }}
            >
              <TextInput
                accessibilityLabel={`Suggested message for ${driverName}`}
                value={suggestText}
                onChangeText={setSuggestText}
                placeholder={`Suggest a message — ${driverName} decides`}
                placeholderTextColor={colors.textFaint}
                multiline
                style={{
                  flex: 1,
                  minHeight: 38,
                  maxHeight: 110,
                  borderRadius: radius.md,
                  backgroundColor: colors.bgInput,
                  color: colors.text,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  fontSize: font.md,
                }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send suggestion"
                accessibilityState={{ disabled: !suggestText.trim() }}
                onPress={sendSuggestion}
                disabled={!suggestText.trim()}
                style={{
                  borderRadius: radius.md,
                  backgroundColor: suggestText.trim() ? colors.accent : colors.bgElevated,
                  paddingHorizontal: space.md,
                  minHeight: 44,
                  minWidth: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }}>Send</Text>
              </Pressable>
            </View>
          </>
        )}
      </KeyboardAvoidingView>

      <Modal
        visible={effortOpen && canPickEffort}
        transparent
        animationType={reduceMotion ? 'none' : 'slide'}
        onRequestClose={() => setEffortOpen(false)}
      >
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: colors.scrim }}>
          <Pressable
            accessible={false}
            onPress={() => setEffortOpen(false)}
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
          />
          <View
            style={{
              backgroundColor: colors.bg,
              borderTopLeftRadius: radius.lg,
              borderTopRightRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.border,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
                paddingHorizontal: space.md,
                height: 48,
              }}
            >
              <Text
                ref={effortTitleRef}
                accessibilityRole="header"
                style={{ flex: 1, color: colors.text, fontSize: font.md, fontWeight: '800' }}
              >
                Reasoning effort
              </Text>
              <Pressable
                onPress={() => setEffortOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Close effort picker"
                style={{ paddingHorizontal: space.sm, paddingVertical: space.sm }}
              >
                <Text style={{ color: colors.textMuted, fontSize: font.lg }}>✕</Text>
              </Pressable>
            </View>
            {modelEffort == null ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Use default reasoning effort"
                accessibilityHint="Closes the picker and uses the model default"
                onPress={() => {
                  setEffortChoice('');
                  setEffortOpen(false);
                }}
                style={({ pressed }) => ({
                  paddingHorizontal: space.md,
                  paddingVertical: space.md,
                  backgroundColor: pressed ? colors.bgPressed : colors.bg,
                })}
              >
                <Text style={{ color: colors.text, fontSize: font.sm, fontWeight: '700' }}>
                  default
                </Text>
              </Pressable>
            ) : null}
            {(effortOptions ?? []).map((level) => (
              <Pressable
                key={level}
                accessibilityRole="button"
                accessibilityLabel={`Set reasoning effort to ${level}`}
                accessibilityHint="Closes the picker and uses this effort for the next turn"
                accessibilityState={{ selected: effortSelection === level }}
                onPress={() => {
                  setEffortChoice(level);
                  setEffortOpen(false);
                }}
                style={({ pressed }) => ({
                  paddingHorizontal: space.md,
                  paddingVertical: space.md,
                  backgroundColor:
                    effortSelection === level
                      ? colors.accentBg
                      : pressed
                        ? colors.bgPressed
                        : colors.bg,
                })}
              >
                <Text
                  style={{
                    color: effortSelection === level ? colors.accent : colors.text,
                    fontSize: font.sm,
                    fontWeight: '800',
                  }}
                >
                  {level}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>

      <MobileWorkSheet
        visible={workTab != null}
        tabs={workTabs}
        activeKey={workTab}
        onTab={setWorkTab}
        onClose={() => setWorkTab(null)}
      />

      <TurnsSheet
        visible={turnsOpen}
        turns={turns}
        onJump={jumpToItem}
        onClose={() => setTurnsOpen(false)}
      />

      <MessageActionSheet
        visible={transcriptActionTarget != null}
        actions={transcriptActions}
        onClose={closeTranscriptActions}
      />
    </View>
  );
}
