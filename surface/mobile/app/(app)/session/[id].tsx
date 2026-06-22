import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import {
  formatCost,
  formatElapsed,
  formatTime,
  isStalledSessionStatus,
  isTerminalSessionStatus,
  mergeSpawnResponse,
  sessionDriverId,
  sessionFromWire,
  type QuestionPrompt,
  type Session,
  type SessionQuestionAnswerSummary,
  type SessionQuestionEvent,
  type SessionStatus,
} from '@atrium/surface-client';
import type { QuestionItem, TextItem, ToolCallItem } from '@atrium/centaur-client';
import { useChat } from '../../../src/lib/chat';
import { font, radius, space, useTheme, type Colors } from '../../../src/lib/theme';
import { normalizeExecutionStatus } from '../../../src/lib/sessionStreamCore';
import { useSessionStream } from '../../../src/lib/useSessionStream';
import {
  artifactCount,
  changedPaths,
  collectArtifacts,
  collectFileChanges,
  collectSideEffects,
  sideEffectCount,
} from '@atrium/centaur-client';
import { ArtifactsSurface } from '../../../src/components/work/ArtifactsSurface';
import { ChangesSurface } from '../../../src/components/work/ChangesSurface';
import { SideEffectsSurface } from '../../../src/components/work/SideEffectsSurface';
import { MobileWorkSheet, type WorkSurfaceTab } from '../../../src/components/work/MobileWorkSheet';
import { WorkStrips, type WorkStripItem } from '../../../src/components/work/WorkStrips';
import { TurnsSheet } from '../../../src/components/work/TurnsSheet';
import { TurnCard } from '../../../src/components/work/TurnCard';
import { deriveTurns } from '../../../src/components/work/turns';

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

function textExcerpt(value: string, limit = 600): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
}

function ToolCard({ item }: { item: ToolCallItem }) {
  const { colors } = useTheme();
  const isError = item.result?.is_error === true;
  const command = typeof item.input.command === 'string' ? item.input.command : null;
  const keys = Object.keys(item.input);
  const summary = command ?? (keys.length ? JSON.stringify(item.input).slice(0, 160) : '');
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: isError ? colors.dangerBorder : colors.border,
        backgroundColor: isError ? colors.dangerSurface : colors.bgElevated,
        borderRadius: radius.sm,
        padding: space.sm,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: colors.text, fontSize: font.xs, fontWeight: '800' }}>
          {item.name}
        </Text>
        <Text
          style={{
            marginLeft: 'auto',
            color: item.result ? (isError ? colors.danger : colors.textMuted) : colors.accent,
            fontSize: font.xs,
            fontWeight: '700',
          }}
        >
          {item.result ? (isError ? 'ERROR' : 'DONE') : 'RUNNING'}
        </Text>
      </View>
      {summary ? (
        <Text style={{ color: colors.textMuted, fontSize: font.xs, fontFamily: 'monospace' }}>
          {textExcerpt(summary, 180)}
        </Text>
      ) : null}
      {item.result ? (
        <Text
          style={{
            color: isError ? colors.danger : colors.textSecondary,
            fontSize: font.xs,
            fontFamily: 'monospace',
          }}
        >
          {textExcerpt(item.result.content)}
        </Text>
      ) : null}
    </View>
  );
}

function TextBlock({ item }: { item: TextItem }) {
  const { colors } = useTheme();
  return (
    <Text style={{ color: colors.text, fontSize: font.md, lineHeight: font.md * 1.4 }}>
      {item.text}
    </Text>
  );
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

function answerValueText(summary: SessionQuestionAnswerSummary): string {
  if (summary.answers.length > 0) return summary.answers.join('\n');
  return summary.count === 1 ? '1 answer recorded' : `${summary.count} answers recorded`;
}

function MobileQuestionTranscriptCard({
  item,
  events,
}: {
  item: QuestionItem;
  events: SessionQuestionEvent[];
}) {
  const { colors } = useTheme();
  const requested = latestQuestionEvent(events, 'requested');
  const prompts = item.questions.length > 0 ? item.questions : requested?.questions ?? [];
  const answerSummaries = answerByPromptId(events);
  const status = questionStatusLabel(item, events);
  return (
    <View
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
                    {answerValueText(summary)}
                  </Text>
                </View>
              ) : null}
            </View>
          );
        })
      ) : (
        <Text style={{ color: colors.text, fontSize: font.sm }}>Agent asked a question.</Text>
      )}
    </View>
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
                    accessibilityState={{ checked: selected, disabled: !isDriver || submitting }}
                    key={option.label}
                    disabled={!isDriver || submitting}
                    onPress={() => (q.multiSelect ? toggleOption(q, option.label) : setValue(q.id, option.label))}
                    style={{
                      borderWidth: 1,
                      borderColor: selected ? colors.warning : colors.border,
                      backgroundColor: selected ? colors.accentBg : colors.bgElevated,
                      borderRadius: radius.sm,
                      padding: space.sm,
                      opacity: !isDriver || submitting ? 0.6 : 1,
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
              editable={isDriver && !submitting}
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
        <Text accessibilityLiveRegion="polite" style={{ color: colors.danger, fontSize: font.xs }}>
          {error}
        </Text>
      ) : null}
      {isDriver ? (
        <Pressable
          onPress={onSubmit}
          disabled={!complete || submitting}
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
            {submitting ? 'Answering...' : 'Submit answer'}
          </Text>
        </Pressable>
      ) : (
        <Text style={{ color: colors.textMuted, fontSize: font.xs }}>
          Waiting for the driver to answer.
        </Text>
      )}
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
  const { colors, reduceMotion } = useTheme();
  const { api, me, state, upsertSession, setActiveSessionId } = chat;
  const { stream, connected } = useSessionStream(id ?? null);
  const headerHeight = useHeaderHeight();
  const cached = id ? (state.sessions[id] ?? null) : null;
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
  const scrollRef = useRef<ScrollView>(null);
  const stickRef = useRef(true);
  // Transcript item y-offsets (captured via onLayout) so the Turns▾ sheet can
  // jump to a turn — ScrollView has no scrollToItem the way FlatList does.
  const itemOffsets = useRef<Record<string, number>>({});

  useFocusEffect(
    useCallback(() => {
      if (!id) return;
      let disposed = false;
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
        setActiveSessionId(null);
      };
    }, [api, id, upsertSession, setActiveSessionId]),
  );

  const session = snapshot ? mergeSpawnResponse(cached ?? undefined, snapshot) : cached;
  const streamStatus = stream.status !== 'idle' ? normalizeExecutionStatus(stream.status) : null;
  const displayStatus = (streamStatus ?? session?.status ?? 'spawning') as SessionStatus;
  const terminal = isTerminalSessionStatus(displayStatus);
  const now = useNow(!terminal);
  const stalled = session ? !terminal && isStalledSessionStatus(session, now) : false;
  const costUsd = Math.max(session?.costUsd ?? 0, stream.costUsd);
  const resultText = stream.resultText || session?.resultText || '';
  const isDriver = !!session && sessionDriverId(session) === me.id;
  const isSpawner = !!session && session.spawnedBy === me.id;
  const canCancel = !!session && (isDriver || isSpawner) && !terminal;
  const canSteer = !!session && isDriver && !terminal;

  // Work surfaces (Phase 4 parity): derive from the shared stream exactly like
  // web — Changes · Side-effects · Artifacts. Each non-empty surface gets a strip
  // chip + a full-screen sheet tab.
  const fileChanges = useMemo(() => collectFileChanges(stream), [stream.items, stream.fileChanges]);
  const changedFileCount = useMemo(() => changedPaths(fileChanges).length, [fileChanges]);
  const sideEffects = useMemo(() => collectSideEffects(stream.items), [stream.items]);
  const sideEffectsN = useMemo(() => sideEffectCount(sideEffects), [sideEffects]);
  const sideEffectsDanger = useMemo(() => sideEffects.some((e) => e.risk === 'danger'), [sideEffects]);
  const artifacts = useMemo(() => collectArtifacts(stream), [stream.artifacts]);
  const artifactsN = useMemo(() => artifactCount(artifacts), [artifacts]);
  const turns = useMemo(() => deriveTurns(stream.items), [stream.items]);
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
            artifactUri={(artifactId) => chat.artifactUrl(id, artifactId)}
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

  const displayCancelAsk = id && chat.failedSessionCancels[id] ? 'failed' : cancelAsk;
  const elapsed = session ? formatElapsed(sessionElapsedMs(session, now)) : '';
  const pendingQuestion =
    session?.pendingQuestion !== undefined ? (session.pendingQuestion ?? null) : stream.pendingQuestion;
  const questionEvents = session?.questionEvents ?? [];
  const questionEventsByQuestion = useMemo(
    () => groupQuestionEventsByQuestion(questionEvents),
    [questionEvents],
  );

  useEffect(() => {
    setQuestionValues({});
    setQuestionSubmitting(false);
    setQuestionCleared(null);
    setQuestionError(null);
  }, [pendingQuestion?.questionId]);

  useEffect(() => {
    if (cancelAsk !== 'confirm') return;
    const timer = setTimeout(() => setCancelAsk('idle'), 5000);
    return () => clearTimeout(timer);
  }, [cancelAsk]);

  useEffect(() => {
    if (stickRef.current) scrollRef.current?.scrollToEnd({ animated: !reduceMotion });
  }, [reduceMotion, stream.lastEventId, resultText]);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    stickRef.current =
      contentSize.height - contentOffset.y - layoutMeasurement.height < 96;
  };

  const sendSteer = () => {
    if (!id) return;
    const text = steerText.trim();
    if (!text) return;
    setSteerText('');
    setSteerError(null);
    chat.clearFailedSessionSteer(id);
    chat.steerSession(id, text).catch(() => setSteerError(text));
  };

  const retrySteer = () => {
    const visibleSteerError = id ? (steerError ?? chat.failedSessionSteers[id] ?? null) : steerError;
    if (!id || !visibleSteerError) return;
    const text = visibleSteerError;
    setSteerError(null);
    chat.clearFailedSessionSteer(id);
    chat.steerSession(id, text).catch(() => setSteerError(text));
  };

  const cancel = () => {
    if (!id) return;
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

  const headerSubtitle = useMemo(() => {
    if (!session) return '';
    const pieces = [formatCost(costUsd), elapsed];
    if (stalled) pieces.push(`started ${formatTime(session.createdAt)}`);
    if (!connected && !terminal) pieces.push('reconnecting...');
    return pieces.filter(Boolean).join('  ');
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
              <Text style={{ color: colors.textMuted, fontSize: font.xs }} numberOfLines={1}>
                {headerSubtitle}
              </Text>
            </View>
          ),
          headerRight: canCancel
            ? () => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={displayCancelAsk === 'confirm' ? 'Confirm cancel session' : 'Cancel session'}
                  accessibilityState={{ disabled: false }}
                  onPress={cancel}
                  hitSlop={8}
                  style={{ minHeight: 44, justifyContent: 'center' }}
                >
                  <Text
                    style={{
                      color: displayCancelAsk === 'confirm' ? colors.danger : colors.textSecondary,
                      fontSize: font.xs,
                      fontWeight: '800',
                    }}
                  >
                    {displayCancelAsk === 'confirm'
                      ? 'CONFIRM'
                      : displayCancelAsk === 'failed'
                        ? 'RETRY CANCEL'
                        : 'CANCEL'}
                  </Text>
                </Pressable>
              )
            : undefined,
          headerBackButtonDisplayMode: 'minimal',
        }}
      />
      {displayCancelAsk === 'failed' && (
        <View style={{ backgroundColor: colors.dangerSurface, padding: space.sm }}>
          <Text style={{ color: colors.danger, fontSize: font.xs, textAlign: 'center' }}>
            Cancel failed. Tap retry cancel.
          </Text>
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
          scrollEventThrottle={80}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: space.md, gap: space.md }}
        >
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
              onSubmit={answerQuestion}
            />
          ) : null}

          {stream.items.length === 0 ? (
            <View style={{ paddingVertical: space.xl, alignItems: 'center' }}>
              <Text style={{ color: colors.textMuted, fontSize: font.sm }}>
                {terminal ? 'No transcript.' : 'Waiting for agent output...'}
              </Text>
            </View>
          ) : (
            stream.items.map((item) => (
              <View
                key={item.id}
                onLayout={(e) => {
                  itemOffsets.current[item.id] = e.nativeEvent.layout.y;
                }}
              >
                {item.type === 'text' ? (
                  <TextBlock item={item} />
                ) : item.type === 'user_message' ? (
                  <View
                    style={{ borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: space.sm }}
                  >
                    <Text style={{ color: colors.text, fontSize: font.sm }}>{item.text}</Text>
                  </View>
                ) : item.type === 'question' ? (
                  <MobileQuestionTranscriptCard
                    item={item}
                    events={questionEventsByQuestion.get(item.questionId) ?? []}
                  />
                ) : (
                  <ToolCard item={item} />
                )}
              </View>
            ))
          )}
        </ScrollView>

        <WorkStrips items={workStripItems} onOpen={setWorkTab} />

        {(steerError ?? chat.failedSessionSteers[id] ?? null) ? (
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: colors.dangerBorder,
              backgroundColor: colors.dangerSurface,
              padding: space.sm,
              gap: space.sm,
            }}
          >
            <Text style={{ color: colors.danger, fontSize: font.xs }} numberOfLines={2}>
              Message did not send: "{steerError ?? chat.failedSessionSteers[id] ?? ''}"
            </Text>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry sending session message"
                onPress={retrySteer}
                hitSlop={10}
                style={{ minHeight: 44, justifyContent: 'center' }}
              >
                <Text style={{ color: colors.text, fontSize: font.xs, fontWeight: '800' }}>Retry</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Dismiss failed session message"
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

        {terminal ? (
          <View style={{ borderTopWidth: 1, borderTopColor: colors.border, padding: space.sm }}>
            <Text style={{ color: colors.textMuted, fontSize: font.xs, textAlign: 'center' }}>
              Session ended. Transcript is read-only.
            </Text>
          </View>
        ) : canSteer ? (
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
              value={steerText}
              onChangeText={setSteerText}
              placeholder="Message this session"
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
          <View style={{ borderTopWidth: 1, borderTopColor: colors.border, padding: space.sm }}>
            <Text style={{ color: colors.textMuted, fontSize: font.xs, textAlign: 'center' }}>
              Spectating. Only the driver can steer this session.
            </Text>
          </View>
        )}
      </KeyboardAvoidingView>

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
    </View>
  );
}
