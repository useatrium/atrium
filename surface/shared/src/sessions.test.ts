import { describe, expect, it } from 'vitest';
import { decodeSessionListResponse, decodeSessionResponse } from './api';
import {
  attachedSessionForRoot,
  formatCost,
  formatOutcome,
  matchSteerProvenance,
  maxSessionStatus,
  normalizeSteerProvenanceText,
  questionAnswerSummaryText,
  questionAnswerTraceText,
  questionPayloadAnswers,
  questionPayloadPrompts,
  sessionAnsweredQuestion,
  sessionAttentionKind,
  sessionFromWire,
  sessionQuestionEventLabel,
  steerProvenanceKey,
  type SessionAnsweredQuestion,
  type SessionQuestionEvent,
  type SessionSuggestion,
} from './sessions';

describe('session list wire decoding', () => {
  it('defaults attention and result fields from an older server payload', () => {
    const decoded = decodeSessionListResponse({
      sessions: [
        {
          id: 's-1',
          channelId: 'c-1',
          channelName: 'general',
          title: 'legacy session',
          status: 'running',
          harness: 'codex',
          spawnedBy: 'u-1',
          spawnerName: 'Ada',
          costUsd: 0,
          createdAt: '2026-07-15T00:00:00.000Z',
          completedAt: null,
        },
      ],
    });

    expect(decoded.sessions[0]).toMatchObject({
      needsAttention: false,
      attentionReason: null,
      resultText: null,
    });
  });
});

describe('session outcome formatting', () => {
  it('formats costs to two decimal places', () => {
    expect(formatCost(0.42)).toBe('$0.42');
  });

  it('formats terminal outcomes and leaves active work blank', () => {
    expect(formatOutcome('completed', 102_000)).toBe('Done in 1m');
    expect(formatOutcome('failed', 3_600_000)).toBe('Failed after 1h 00m');
    expect(formatOutcome('cancelled', 42_000)).toBe('Stopped after 42s');
    expect(formatOutcome('running', 42_000)).toBe('');
  });
});

describe('maxSessionStatus', () => {
  it('keeps completed ahead of failed regardless of event order', () => {
    expect(maxSessionStatus('completed', 'failed')).toBe('completed');
    expect(maxSessionStatus('failed', 'completed')).toBe('completed');
  });

  it('ranks completed ahead of cancelled', () => {
    expect(maxSessionStatus('completed', 'cancelled')).toBe('completed');
  });

  it('ranks completed ahead of running', () => {
    expect(maxSessionStatus('running', 'completed')).toBe('completed');
  });
});

describe('sessionAttentionKind', () => {
  const base = {
    status: 'running' as const,
    pendingQuestion: null,
    providerAuthRequired: null,
    pendingSeatRequests: [],
  };

  it('does not treat normal running work as attention', () => {
    expect(sessionAttentionKind(base)).toBeNull();
  });

  it('classifies actionable live states by priority', () => {
    expect(
      sessionAttentionKind({
        ...base,
        pendingQuestion: { questionId: 'q-1', questions: [] },
        providerAuthRequired: {
          provider: 'codex',
          userId: 'u-1',
          reason: 'missing_token',
          message: 'Connect Codex',
          at: '2026-07-11T00:00:00.000Z',
        },
      }),
    ).toBe('question');
    expect(
      sessionAttentionKind({
        ...base,
        providerAuthRequired: {
          provider: 'github',
          userId: 'u-1',
          reason: 'invalid_token',
          message: 'Reconnect GitHub',
          at: '2026-07-11T00:00:00.000Z',
        },
      }),
    ).toBe('authentication');
    expect(
      sessionAttentionKind({
        ...base,
        pendingSeatRequests: [{ userId: 'u-2', displayName: 'Morgan' }],
      }),
    ).toBe('seat-request');
    expect(sessionAttentionKind({ ...base, status: 'failed' })).toBe('failed');
  });

  it('does not keep terminal success or cancellation in Attention', () => {
    expect(sessionAttentionKind({ ...base, status: 'completed' })).toBeNull();
    expect(sessionAttentionKind({ ...base, status: 'cancelled' })).toBeNull();
  });
});

describe('matchSteerProvenance', () => {
  const suggestion = (overrides: Partial<SessionSuggestion> = {}): SessionSuggestion => ({
    id: 'suggestion-1',
    authorId: 'proposer-1',
    authorName: 'Allan Niemerg',
    text: 'Please inspect the failing test',
    status: 'sent',
    resolvedBy: 'driver-1',
    resolvedByName: 'Gary Basin',
    sentText: null,
    createdAt: '2026-07-06T18:35:00.000Z',
    resolvedAt: '2026-07-06T18:41:00.000Z',
    ...overrides,
  });

  it('matches an exact sent suggestion by text and time', () => {
    const matched = matchSteerProvenance(
      [
        {
          id: 'msg-1',
          text: 'Please inspect the failing test',
          ts: '2026-07-06T18:41:02.000Z',
        },
      ],
      [suggestion()],
    );

    expect(matched.get('msg-1')).toEqual({
      proposerName: 'Allan Niemerg',
      resolvedByName: 'Gary Basin',
      edited: false,
      resolvedAt: '2026-07-06T18:41:00.000Z',
    });
  });

  it('matches edited suggestions using sentText', () => {
    const matched = matchSteerProvenance(
      [
        {
          id: 'msg-1',
          text: 'Please inspect the failing Vitest test',
          ts: '2026-07-06T18:41:02.000Z',
        },
      ],
      [
        suggestion({
          sentText: 'Please inspect the failing Vitest test',
        }),
      ],
    );

    expect(matched.get('msg-1')?.edited).toBe(true);
  });

  it('consumes duplicate-text transcript rows in resolvedAt order', () => {
    const matched = matchSteerProvenance(
      [
        {
          id: 'msg-early',
          text: 'retry the deploy',
          ts: '2026-07-06T18:41:01.000Z',
        },
        {
          id: 'msg-late',
          text: 'retry the deploy',
          ts: '2026-07-06T18:45:02.000Z',
        },
      ],
      [
        suggestion({
          id: 'suggestion-late',
          text: 'retry the deploy',
          resolvedAt: '2026-07-06T18:45:00.000Z',
        }),
        suggestion({
          id: 'suggestion-early',
          text: 'retry the deploy',
          authorName: 'Maya Chen',
          resolvedAt: '2026-07-06T18:41:00.000Z',
        }),
      ],
    );

    expect(matched.get('msg-early')?.proposerName).toBe('Maya Chen');
    expect(matched.get('msg-late')?.proposerName).toBe('Allan Niemerg');
  });

  it('does not match normal driver-typed steers', () => {
    const matched = matchSteerProvenance(
      [
        {
          id: 'msg-1',
          text: 'A driver typed this directly',
          ts: '2026-07-06T18:41:02.000Z',
        },
      ],
      [suggestion()],
    );

    expect(matched.size).toBe(0);
  });

  it('ignores dismissed and pending suggestions', () => {
    const matched = matchSteerProvenance(
      [
        {
          id: 'msg-1',
          text: 'Please inspect the failing test',
          ts: '2026-07-06T18:41:02.000Z',
        },
      ],
      [
        suggestion({ id: 'pending', status: 'pending', resolvedAt: null }),
        suggestion({ id: 'dismissed', status: 'dismissed' }),
      ],
    );

    expect(matched.size).toBe(0);
  });
});

describe('steer provenance helpers', () => {
  it('normalizes whitespace consistently for transcript echo matching', () => {
    expect(normalizeSteerProvenanceText('  inspect\n\tthe   test  ')).toBe('inspect the test');
  });

  it('keys every provenance field used to detect a changed attribution', () => {
    expect(
      steerProvenanceKey({
        proposerName: 'Maya Chen',
        resolvedByName: 'Gary Basin',
        edited: true,
        resolvedAt: '2026-07-06T18:41:00.000Z',
      }),
    ).toBe('2026-07-06T18:41:00.000Z\u0000Maya Chen\u0000Gary Basin\u0000edited');
  });
});

describe('session question event helpers', () => {
  it('parses valid prompts and ignores malformed payload entries', () => {
    expect(
      questionPayloadPrompts({ questions: [null, 'bad', { question: '  ' }, { question: 'Choose one' }] }),
    ).toEqual([{ question: 'Choose one' }]);
  });

  it('parses answer summaries with safe fallbacks', () => {
    expect(
      questionPayloadAnswers({
        answers: [null, { header: 'missing id' }, { id: 'choice', answers: ['A', 2], count: Number.NaN }],
      }),
    ).toEqual([{ id: 'choice', header: 'choice', answers: ['A'], count: 1 }]);
  });

  it('formats recorded answers and question event outcomes', () => {
    expect(questionAnswerSummaryText({ id: 'q', header: 'Q', answers: ['A', 'B'], count: 2 })).toBe('A\nB');
    expect(questionAnswerSummaryText({ id: 'q', header: 'Q', answers: [], count: 1 })).toBe('1 answer recorded');
    expect(sessionQuestionEventLabel('question_requested', undefined)).toBe('Question asked');
    expect(sessionQuestionEventLabel('question_resolved', 'empty')).toBe('Question expired without an answer');
  });

  it('joins the chosen option labels for the one-line answered trace', () => {
    expect(
      questionAnswerTraceText([
        { id: 'lock', header: 'Write lock', answers: ['Run now'], count: 1 },
        { id: 'tests', header: 'Tests', answers: ['Skip', 'Notify'], count: 2 },
      ]),
    ).toBe('Run now, Skip, Notify');
    // A secret answer arrives redacted from the server; nothing to echo otherwise.
    expect(questionAnswerTraceText([{ id: 'q', header: 'Q', answers: [], count: 2 }])).toBe('2 answers recorded');
  });
});

describe('sessionAnsweredQuestion', () => {
  const asked = (id: number, questionId: string): SessionQuestionEvent => ({
    id,
    questionId,
    kind: 'requested',
    at: '2026-07-13T02:00:00.000Z',
  });
  const answered = (id: number, questionId: string, by: string): SessionQuestionEvent => ({
    id,
    questionId,
    kind: 'answered',
    at: '2026-07-13T02:05:00.000Z',
    actorId: 'u-maya',
    actorName: by,
    answers: [{ id: 'lock', header: 'Write lock', answers: ['Run now'], count: 1 }],
  });

  it('names who answered the most recent question, and what they picked', () => {
    expect(sessionAnsweredQuestion({ questionEvents: [asked(1, 'q-1'), answered(2, 'q-1', 'Maya')] })).toEqual({
      questionId: 'q-1',
      at: '2026-07-13T02:05:00.000Z',
      answeredById: 'u-maya',
      answeredByName: 'Maya',
      answerText: 'Run now',
    });
  });

  it('falls back to the actor id when the event carried no display name', () => {
    const event = { ...answered(2, 'q-1', 'Maya') };
    delete event.actorName;
    expect(sessionAnsweredQuestion({ questionEvents: [event] })?.answeredByName).toBe('u-maya');
  });

  it('is null while the newest question is unanswered — it never shows a stale answer', () => {
    const events = [asked(1, 'q-1'), answered(2, 'q-1', 'Maya'), asked(3, 'q-2')];
    expect(sessionAnsweredQuestion({ questionEvents: events })).toBeNull();
    // …but that earlier answer is still addressable by id.
    expect(sessionAnsweredQuestion({ questionEvents: events }, 'q-1')?.answeredByName).toBe('Maya');
  });

  it('is null for a cancelled question rather than the answer before it', () => {
    const events: SessionQuestionEvent[] = [
      asked(1, 'q-1'),
      answered(2, 'q-1', 'Maya'),
      asked(3, 'q-2'),
      { id: 4, questionId: 'q-2', kind: 'resolved', at: '2026-07-13T02:10:00.000Z', reason: 'cancelled' },
    ];
    expect(sessionAnsweredQuestion({ questionEvents: events })).toBeNull();
  });

  it('is null with no question history at all', () => {
    expect(sessionAnsweredQuestion({ questionEvents: [] })).toBeNull();
    expect(sessionAnsweredQuestion({})).toBeNull();
  });

  const durable: SessionAnsweredQuestion = {
    questionId: 'q-1',
    at: '2026-07-13T02:05:00.000Z',
    answeredById: 'u-maya',
    answeredByName: 'Maya',
    answerText: 'Run now',
  };

  it('falls back to the session row on a cold load that folded no events', () => {
    // The pane a week later: the session row still names the answerer.
    expect(sessionAnsweredQuestion({ questionEvents: [], answeredQuestion: durable })).toEqual(durable);
  });

  it('trusts the row for the current question when its answered event is outside the window', () => {
    expect(sessionAnsweredQuestion({ questionEvents: [asked(1, 'q-1')], answeredQuestion: durable })).toEqual(durable);
  });

  it('never lets a stale row resurface an answer to a superseded question', () => {
    // A newer question is open; the row's answer belongs to the previous one.
    expect(
      sessionAnsweredQuestion({ questionEvents: [asked(1, 'q-1'), asked(3, 'q-2')], answeredQuestion: durable }),
    ).toBeNull();
  });
});

describe('session wire decoding of the answered trace', () => {
  const wire = {
    id: 's-1',
    workspaceId: 'ws-1',
    channelId: 'c-1',
    threadRootEventId: null,
    title: 'migrate the ledger',
    status: 'running',
    harness: 'claude-code',
    spawnedBy: 'u-kay',
    driverId: 'u-maya',
    pendingQuestion: null,
    answeredQuestion: {
      questionId: 'q-1',
      at: '2026-07-13T02:05:00.000Z',
      answeredById: 'u-maya',
      answeredByName: 'Maya',
      answerText: 'Run now',
    },
    costUsd: 0,
    resultText: null,
    createdAt: '2026-07-13T02:00:00.000Z',
    completedAt: null,
    lastEventId: 7,
    permalink: '/s/s-1',
  };

  // Effect Schema DROPS unknown fields, and sessionFromWire narrows explicitly:
  // a field that is missing from either one works in a unit test and vanishes
  // in prod. Both seams are asserted here.
  it('keeps answeredQuestion through the REST decode and the wire→entity seam', () => {
    const decoded = decodeSessionResponse({ session: wire }).session;
    expect(decoded.answeredQuestion).toEqual(wire.answeredQuestion);
    expect(sessionFromWire(decoded).answeredQuestion).toEqual(wire.answeredQuestion);
  });

  it('decodes an older payload that carries no trace at all', () => {
    const { answeredQuestion: _omitted, ...older } = wire;
    expect(sessionFromWire(decodeSessionResponse({ session: older }).session).answeredQuestion).toBeNull();
  });
});

describe('attachedSessionForRoot', () => {
  const sess = (id: string, channelId: string, threadRootEventId: number | null) => ({
    id,
    channelId,
    threadRootEventId,
  });

  it('prefers the explicit root.sessionId', () => {
    const sessions = { 's-1': sess('s-1', 'ch-1', 5), 's-2': sess('s-2', 'ch-1', 7) };
    expect(attachedSessionForRoot(sessions, { id: 7, sessionId: 's-1' }, 'ch-1')?.id).toBe('s-1');
  });

  it('falls back to threadRootEventId within the channel', () => {
    const sessions = { 's-1': sess('s-1', 'ch-1', 7) };
    expect(attachedSessionForRoot(sessions, { id: 7 }, 'ch-1')?.id).toBe('s-1');
  });

  it('never attaches a session from another channel', () => {
    const sessions = { 's-1': sess('s-1', 'ch-OTHER', 7) };
    expect(attachedSessionForRoot(sessions, { id: 7 }, 'ch-1')).toBeUndefined();
  });

  it('returns undefined for a rootless message or no match', () => {
    const sessions = { 's-1': sess('s-1', 'ch-1', 5) };
    expect(attachedSessionForRoot(sessions, { id: null }, 'ch-1')).toBeUndefined();
    expect(attachedSessionForRoot(sessions, { id: 9 }, 'ch-1')).toBeUndefined();
  });
});
