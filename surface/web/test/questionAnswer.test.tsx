// @vitest-environment jsdom
// A consequential answer is one irreversible click ("Run now" takes a 40-minute
// write lock), so the driver's answer is scheduled with a 5s undo window and
// leaves a durable "who answered what" trace behind.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appReducer, initialAppState, type AppState, type WireEvent } from '@atrium/surface-client';
import { QuestionCard } from '../src/sessions/SessionBanners';
import { sessionAnsweredQuestion, sessionDriverId } from '../src/sessions/types';
import { sessionsApi } from '../src/sessions/api';
import { resetScheduledAnswers } from '../src/sessions/pendingAnswers';

const spawner = { id: 'u-kay', handle: 'kay', displayName: 'Kay' };
const maya = { id: 'u-maya', handle: 'maya', displayName: 'Maya' };
const CH = 'ch-1';

let answerQuestion: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(sessionsApi, 'listPresentations').mockResolvedValue({ presentations: [] });
  answerQuestion = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(sessionsApi, 'answerQuestion').mockImplementation(
    answerQuestion as unknown as typeof sessionsApi.answerQuestion,
  );
});

afterEach(() => {
  cleanup();
  resetScheduledAnswers();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function wire(
  id: number,
  type: string,
  payload: Record<string, unknown>,
  author: { id: string; handle: string; displayName: string } = spawner,
): WireEvent {
  return {
    id,
    workspaceId: 'ws-1',
    channelId: CH,
    threadRootEventId: null,
    type,
    actorId: author.id,
    payload,
    createdAt: new Date(Date.now() - (200 - id) * 1000).toISOString(),
    author,
  };
}

/** A live session that is blocked on a two-option question. */
function askedState(): AppState {
  let s = appReducer(initialAppState, { type: 'history-loaded', channelId: CH, events: [], hasMore: false });
  s = appReducer(s, {
    type: 'server-event',
    event: wire(101, 'session.spawned', {
      sessionId: 'sess-1',
      title: 'migrate the ledger',
      harness: 'claude-code',
      by: spawner.id,
    }),
  });
  return appReducer(s, {
    type: 'server-event',
    event: wire(102, 'session.question_requested', {
      sessionId: 'sess-1',
      questionId: 'q-1',
      questions: [
        {
          id: 'q1',
          header: 'Write lock',
          question: 'Run it now or schedule for tonight?',
          options: [
            { label: 'Run now', description: 'takes a 40-minute write lock' },
            { label: 'Tonight', description: 'quiet window' },
          ],
        },
      ],
    }),
  });
}

/** The answer landing from the server (the same event that clears the question). */
function answeredState(s: AppState, author = spawner): AppState {
  return appReducer(s, {
    type: 'server-event',
    event: wire(
      103,
      'session.question_answered',
      {
        sessionId: 'sess-1',
        questionId: 'q-1',
        by: author.id,
        answers: [{ id: 'q1', header: 'Write lock', answers: ['Run now'], count: 1 }],
      },
      author,
    ),
  });
}

function cardFor(state: AppState, meId = spawner.id) {
  const session = state.sessions['sess-1'];
  if (!session) throw new Error('session entity missing');
  return (
    <QuestionCard
      variant="card"
      sessionId={session.id}
      pending={session.pendingQuestion}
      answered={sessionAnsweredQuestion(session)}
      isDriver={sessionDriverId(session) === meId}
      driverName={session.driverName ?? session.spawnerName ?? 'the driver'}
      proposals={session.answerProposals}
    />
  );
}

function answerRunNow(): void {
  fireEvent.click(screen.getByRole('radio', { name: /Run now/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
}

describe('the driver’s 5s undo window', () => {
  it('does not post until the window elapses, then posts exactly once', async () => {
    render(cardFor(askedState()));
    answerRunNow();

    // Committed, not sent: the options are gone and Undo is the only move.
    expect(screen.getByTestId('question-scheduled-answer').textContent).toContain('Run now');
    expect(screen.getByTestId('question-undo').textContent).toBe('Undo (5s)');
    expect(answerQuestion).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByTestId('question-undo').textContent).toBe('Undo (3s)');
    expect(answerQuestion).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(3_100);
    });
    expect(answerQuestion).toHaveBeenCalledTimes(1);
    expect(answerQuestion.mock.calls[0]?.slice(0, 3)).toEqual(['sess-1', 'q-1', { q1: { answers: ['Run now'] } }]);
  });

  it('Undo cancels the submit entirely and restores the options', async () => {
    render(cardFor(askedState()));
    answerRunNow();
    fireEvent.click(screen.getByTestId('question-undo'));

    expect(screen.queryByTestId('question-scheduled-answer')).toBeNull();
    expect(screen.getByRole('radio', { name: /Run now/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Answer' })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it('a second answer inside the window replaces the first', async () => {
    render(cardFor(askedState()));
    answerRunNow();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });

    fireEvent.click(screen.getByTestId('question-undo'));
    fireEvent.click(screen.getByRole('radio', { name: /Tonight/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    // The replacement gets its own full window, not the remains of the first.
    expect(screen.getByTestId('question-undo').textContent).toBe('Undo (5s)');

    await act(async () => {
      vi.advanceTimersByTime(5_100);
    });
    expect(answerQuestion).toHaveBeenCalledTimes(1);
    expect(answerQuestion.mock.calls[0]?.[2]).toEqual({ q1: { answers: ['Tonight'] } });
  });

  it('still posts when the card unmounts inside the window', async () => {
    const view = render(cardFor(askedState()));
    answerRunNow();
    view.unmount();

    await act(async () => {
      vi.advanceTimersByTime(5_100);
    });
    expect(answerQuestion).toHaveBeenCalledTimes(1);
  });

  it('another user’s answer cancels the scheduled one instead of posting into a dead question', async () => {
    const asked = askedState();
    const { rerender } = render(cardFor(asked));
    answerRunNow();

    // Maya answers first; the question stops being pending for everyone.
    rerender(cardFor(answeredState(asked, maya)));

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(screen.queryByTestId('question-scheduled-answer')).toBeNull();
    expect(screen.getByTestId('question-answered-trace').textContent).toContain('Answered by');
    expect(screen.getByTestId('question-answered-trace').textContent).toContain('Maya');
  });
});

describe('the answered trace', () => {
  it('replaces the question with who answered it and what they picked', () => {
    render(cardFor(answeredState(askedState(), maya)));

    expect(screen.queryByTestId('question-banner')).toBeNull();
    const trace = screen.getByTestId('question-answered-trace').textContent ?? '';
    expect(trace).toContain('Answered by');
    expect(trace).toContain('Maya');
    expect(trace).toContain('Run now');
  });

  it('survives the session going terminal — the record outlives the run', () => {
    let s = answeredState(askedState(), maya);
    s = appReducer(s, {
      type: 'server-event',
      event: wire(104, 'session.completed', { sessionId: 'sess-1', status: 'completed' }),
    });
    render(cardFor(s));
    expect(screen.getByTestId('question-answered-trace').textContent).toContain('Maya');
  });

  it('a cancelled question leaves no answered trace', () => {
    let s = askedState();
    s = appReducer(s, {
      type: 'server-event',
      event: wire(103, 'session.question_resolved', {
        sessionId: 'sess-1',
        questionId: 'q-1',
        reason: 'cancelled',
      }),
    });
    render(cardFor(s));
    expect(screen.queryByTestId('question-answered-trace')).toBeNull();
    expect(screen.queryByTestId('question-banner')).toBeNull();
  });
});
