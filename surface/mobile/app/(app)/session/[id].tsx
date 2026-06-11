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
  sessionDriverId,
  sessionFromWire,
  type QuestionPrompt,
  type Session,
  type SessionStatus,
} from '@atrium/surface-client';
import type { TextItem, ToolCallItem } from '@atrium/centaur-client';
import { useChat } from '../../../src/lib/chat';
import { font, radius, space, useTheme, type Colors } from '../../../src/lib/theme';
import { normalizeExecutionStatus } from '../../../src/lib/sessionStreamCore';
import { useSessionStream } from '../../../src/lib/useSessionStream';

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
    <Text style={{ color: colors.text, fontSize: font.md, lineHeight: 21 }}>
      {item.text}
    </Text>
  );
}

function MobileQuestionBanner({
  pending,
  isDriver,
  values,
  setValue,
  submitting,
  onSubmit,
}: {
  pending: { questionId: string; questions: QuestionPrompt[] };
  isDriver: boolean;
  values: Record<string, string>;
  setValue: (id: string, value: string) => void;
  submitting: boolean;
  onSubmit: () => void;
}) {
  const { colors } = useTheme();
  const complete = pending.questions.every((q) => (values[q.id] ?? '').trim().length > 0);
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
                const selected = values[q.id] === option.label;
                return (
                  <Pressable
                    key={option.label}
                    disabled={!isDriver || submitting}
                    onPress={() => setValue(q.id, option.label)}
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
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <TextInput
              value={values[q.id] ?? ''}
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

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chat = useChat();
  const { colors } = useTheme();
  const { api, me, state, upsertSession } = chat;
  const { stream, connected } = useSessionStream(id ?? null);
  const headerHeight = useHeaderHeight();
  const cached = id ? (state.sessions[id] ?? null) : null;
  const [snapshot, setSnapshot] = useState<Session | null>(cached);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [steerText, setSteerText] = useState('');
  const [steerError, setSteerError] = useState<string | null>(null);
  const [questionValues, setQuestionValues] = useState<Record<string, string>>({});
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const [questionCleared, setQuestionCleared] = useState<string | null>(null);
  const [cancelAsk, setCancelAsk] = useState<'idle' | 'confirm' | 'failed'>('idle');
  const scrollRef = useRef<ScrollView>(null);
  const stickRef = useRef(true);

  useFocusEffect(
    useCallback(() => {
      if (!id) return;
      let disposed = false;
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
      };
    }, [api, id, upsertSession]),
  );

  const session = snapshot ?? cached;
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
  const elapsed = session ? formatElapsed(sessionElapsedMs(session, now)) : '';
  const pendingQuestion =
    session?.pendingQuestion !== undefined ? (session.pendingQuestion ?? null) : stream.pendingQuestion;

  useEffect(() => {
    setQuestionValues({});
    setQuestionSubmitting(false);
    setQuestionCleared(null);
  }, [pendingQuestion?.questionId]);

  useEffect(() => {
    if (cancelAsk !== 'confirm') return;
    const timer = setTimeout(() => setCancelAsk('idle'), 5000);
    return () => clearTimeout(timer);
  }, [cancelAsk]);

  useEffect(() => {
    if (stickRef.current) scrollRef.current?.scrollToEnd({ animated: true });
  }, [stream.lastEventId, resultText]);

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
    api.steerSession(id, text).catch(() => setSteerError(text));
  };

  const retrySteer = () => {
    if (!id || !steerError) return;
    const text = steerError;
    setSteerError(null);
    api.steerSession(id, text).catch(() => setSteerError(text));
  };

  const cancel = () => {
    if (!id) return;
    if (cancelAsk === 'idle' || cancelAsk === 'failed') {
      setCancelAsk('confirm');
      return;
    }
    setCancelAsk('idle');
    api.cancelSession(id).catch(() => setCancelAsk('failed'));
  };

  const answerQuestion = () => {
    if (!id || !pendingQuestion) return;
    const answers: Record<string, { answers: string[] }> = {};
    for (const q of pendingQuestion.questions) answers[q.id] = { answers: [questionValues[q.id]!.trim()] };
    setQuestionSubmitting(true);
    api
      .answerSessionQuestion(id, pendingQuestion.questionId, answers)
      .then(() => setQuestionCleared(pendingQuestion.questionId))
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
                <Pressable onPress={cancel} hitSlop={8}>
                  <Text
                    style={{
                      color: cancelAsk === 'confirm' ? colors.danger : colors.textSecondary,
                      fontSize: font.xs,
                      fontWeight: '800',
                    }}
                  >
                    {cancelAsk === 'confirm'
                      ? 'CONFIRM'
                      : cancelAsk === 'failed'
                        ? 'RETRY CANCEL'
                        : 'CANCEL'}
                  </Text>
                </Pressable>
              )
            : undefined,
          headerBackButtonDisplayMode: 'minimal',
        }}
      />
      {cancelAsk === 'failed' && (
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
        <ScrollView
          ref={scrollRef}
          onScroll={onScroll}
          scrollEventThrottle={80}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: space.md, gap: space.md }}
        >
          {terminal && resultText ? (
            <View
              style={{
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radius.md,
                backgroundColor: colors.bgElevated,
                padding: space.md,
                gap: space.sm,
              }}
            >
              <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>
                RESULT
              </Text>
              <Text style={{ color: colors.text, fontSize: font.sm, lineHeight: 20 }}>
                {resultText}
              </Text>
            </View>
          ) : null}

          {pendingQuestion && pendingQuestion.questionId !== questionCleared && !terminal ? (
            <MobileQuestionBanner
              pending={pendingQuestion}
              isDriver={isDriver}
              values={questionValues}
              setValue={(qid, value) =>
                setQuestionValues((prev) => ({ ...prev, [qid]: value }))
              }
              submitting={questionSubmitting}
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
              <View key={item.id}>
                {item.type === 'text' ? <TextBlock item={item} /> : <ToolCard item={item} />}
              </View>
            ))
          )}
        </ScrollView>

        {steerError ? (
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
              Message did not send: "{steerError}"
            </Text>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Pressable onPress={retrySteer}>
                <Text style={{ color: colors.text, fontSize: font.xs, fontWeight: '800' }}>Retry</Text>
              </Pressable>
              <Pressable onPress={() => setSteerError(null)}>
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
              onPress={sendSteer}
              disabled={!steerText.trim()}
              style={{
                borderRadius: radius.md,
                backgroundColor: steerText.trim() ? colors.accent : colors.bgElevated,
                paddingHorizontal: space.md,
                height: 38,
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
    </View>
  );
}
