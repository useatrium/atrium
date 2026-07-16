// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import type { QuestionItem } from '@atrium/centaur-client';
import { afterEach, describe, expect, it } from 'vitest';
import { groupQuestionEventsByQuestion, QuestionTranscriptCard } from '../src/sessions/SessionQuestionTranscript';
import type { QuestionPrompt, SessionQuestionEvent } from '../src/sessions/types';

afterEach(cleanup);

describe('SessionQuestionTranscript', () => {
  it('groups question events by question id in event-id order', () => {
    const grouped = groupQuestionEventsByQuestion([
      event({ id: 3, questionId: 'q-b', kind: 'requested' }),
      event({ id: 2, questionId: 'q-a', kind: 'answered' }),
      event({ id: 1, questionId: 'q-a', kind: 'requested' }),
    ]);

    expect([...grouped.keys()]).toEqual(['q-b', 'q-a']);
    expect(grouped.get('q-a')?.map((item) => item.id)).toEqual([1, 2]);
  });

  it('renders pending questions from the transcript item', () => {
    render(<QuestionTranscriptCard item={questionItem()} events={[]} />);

    expect(screen.getByText('Agent question')).toBeTruthy();
    expect(screen.getByText('Waiting for answer')).toBeTruthy();
    expect(screen.getByText('Deploy target')).toBeTruthy();
    expect(screen.getByText('Which environment should receive this change?')).toBeTruthy();
    expect(screen.getByText('Production')).toBeTruthy();
  });

  it('renders answered questions with answer summaries and event details', () => {
    render(
      <QuestionTranscriptCard
        item={questionItem({ status: 'resolved', sourceEventIds: [10, 11, 12] })}
        events={[
          event({ id: 10, kind: 'requested', questions: [prompt()] }),
          event({
            id: 11,
            kind: 'answered',
            actorName: 'Ada',
            answers: [{ id: 'target', header: 'Deploy target', answers: ['Staging'], count: 1 }],
          }),
          event({ id: 12, kind: 'resolved', reason: 'answered' }),
        ]}
      />,
    );

    expect(screen.getAllByText('Answered')).toHaveLength(2);
    expect(screen.getByText(/by Ada at \d{2}:\d{2}/)).toBeTruthy();
    expect(screen.getByText('Answer')).toBeTruthy();
    expect(screen.getAllByText('Staging')).toHaveLength(2);
    expect(screen.getByText('10, 11, 12')).toBeTruthy();
  });

  it('falls back to requested-event prompts when the item has none', () => {
    render(
      <QuestionTranscriptCard
        item={questionItem({ questions: [] })}
        events={[event({ kind: 'requested', questions: [prompt({ question: 'Fallback prompt?' })] })]}
      />,
    );

    expect(screen.getByText('Fallback prompt?')).toBeTruthy();
    expect(screen.queryByText('Agent asked a question.')).toBeNull();
  });
});

function questionItem(overrides: Partial<QuestionItem> = {}): QuestionItem {
  return {
    type: 'question',
    id: 'question:q-1',
    questionId: 'q-1',
    questions: [prompt()],
    status: 'pending',
    sourceEventIds: [10],
    ...overrides,
    executionId: overrides.executionId ?? null,
  };
}

function prompt(overrides: Partial<QuestionPrompt> = {}): QuestionPrompt {
  return {
    id: 'target',
    header: 'Deploy target',
    question: 'Which environment should receive this change?',
    options: [
      { label: 'Production', description: 'Ship to all users.' },
      { label: 'Staging', description: 'Validate before production.' },
    ],
    ...overrides,
  };
}

function event(overrides: Partial<SessionQuestionEvent> = {}): SessionQuestionEvent {
  return {
    id: 10,
    questionId: 'q-1',
    kind: 'requested',
    at: '2026-06-28T13:05:00.000Z',
    ...overrides,
  };
}
