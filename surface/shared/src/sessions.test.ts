import { describe, expect, it } from 'vitest';
import {
  matchSteerProvenance,
  maxSessionStatus,
  normalizeSteerProvenanceText,
  questionAnswerSummaryText,
  questionPayloadAnswers,
  questionPayloadPrompts,
  sessionAttentionKind,
  sessionQuestionEventLabel,
  steerProvenanceKey,
  type SessionSuggestion,
} from './sessions';

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
});
