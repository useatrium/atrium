import { randomUUID } from 'node:crypto';
import { questionAnswerTraceText } from '@atrium/surface-client/sessions';
import { CentaurClient, type CentaurEventFrame, type QuestionPrompt } from '@atrium/centaur-client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WsHub } from '../src/hub.js';
import {
  parsePendingQuestion,
  SessionRuns,
  type SessionAnsweredQuestionJson,
  type SessionPendingQuestionJson,
} from '../src/session-runs.js';
import { createTestPool, seedEvent, seedFixture, truncateAll, type Fixture } from './helpers.js';

interface QuestionState {
  pending: (Pick<SessionPendingQuestionJson, 'questionId'> & { questions: QuestionSnapshot[] }) | null;
  answered: Omit<SessionAnsweredQuestionJson, 'at'> | null;
}

interface QuestionSnapshot {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
}

interface QuestionEventRow {
  type: string;
  actor_id: string | null;
  actor_name: string | null;
  payload: Record<string, unknown>;
}

interface SessionQuestionColumns {
  pending_question: unknown;
  answered_question: unknown;
}

type FrameFoldSeam = {
  foldFrame(id: string, frame: CentaurEventFrame): Promise<void>;
};

class AnsweringCentaur extends CentaurClient {
  constructor() {
    super({ baseUrl: 'http://127.0.0.1:1', apiKey: 'test' });
  }

  override async answerQuestion() {
    return { ok: true };
  }
}

const FIRST_QUESTION: QuestionPrompt[] = [
  {
    id: 'choice',
    header: 'Deploy',
    question: 'Which deployment path?',
    options: [
      { label: 'Fast', description: 'Ship the smallest change' },
      { label: 'Careful', description: 'Run the full suite' },
    ],
  },
];

const SECOND_QUESTION: QuestionPrompt[] = [
  {
    id: 'window',
    header: 'Window',
    question: 'When should this run?',
    options: [
      { label: 'Now', description: 'Start immediately' },
      { label: 'Tonight', description: 'Wait for the quiet window' },
    ],
  },
];

let pool: pg.Pool;
let fixture: Fixture;

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  fixture = await seedFixture(pool);
});

function requestedFrame(
  questionId: string,
  turnId: string,
  questions: QuestionPrompt[],
  eventId: number,
): Extract<CentaurEventFrame, { event: 'question_requested' }> {
  return {
    event: 'question_requested',
    event_id: eventId,
    data: { type: 'question_requested', question_id: questionId, turn_id: turnId, questions },
  };
}

function resolvedFrame(
  questionId: string,
  reason: 'answered' | 'cancelled' | 'empty',
  eventId: number,
): Extract<CentaurEventFrame, { event: 'question_resolved' }> {
  return {
    event: 'question_resolved',
    event_id: eventId,
    data: { type: 'question_resolved', question_id: questionId, reason },
  };
}

function snapshotQuestions(value: unknown): QuestionSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.map((question) => {
    const raw = question as Record<string, unknown>;
    return {
      id: String(raw.id),
      header: String(raw.header),
      question: String(raw.question),
      options: Array.isArray(raw.options)
        ? raw.options.map((option) => {
            const item = option as Record<string, unknown>;
            return { label: String(item.label), description: String(item.description) };
          })
        : [],
    };
  });
}

async function eventFold(sessionId: string): Promise<QuestionState> {
  const events = await pool.query<QuestionEventRow>(
    `SELECT e.type, e.actor_id, u.display_name AS actor_name, e.payload
       FROM events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.type IN ('session.question_requested', 'session.question_answered', 'session.question_resolved')
        AND e.payload->>'sessionId' = $1
      ORDER BY e.id`,
    [sessionId],
  );
  const state: QuestionState = { pending: null, answered: null };
  for (const event of events.rows) {
    const questionId = typeof event.payload.questionId === 'string' ? event.payload.questionId : '';
    if (event.type === 'session.question_requested') {
      state.pending = { questionId, questions: snapshotQuestions(event.payload.questions) };
      state.answered = null;
    } else if (event.type === 'session.question_answered') {
      const answers = Array.isArray(event.payload.answers) ? event.payload.answers : [];
      state.pending = null;
      state.answered = {
        questionId,
        answeredById: event.actor_id ?? '',
        answeredByName: event.actor_name ?? event.actor_id ?? '',
        answerText: questionAnswerTraceText(answers),
      };
    } else if (state.pending?.questionId === questionId) {
      state.pending = null;
    }
  }
  return state;
}

async function columnState(sessionId: string): Promise<QuestionState> {
  const result = await pool.query<SessionQuestionColumns>(
    'SELECT pending_question, answered_question FROM sessions WHERE id = $1',
    [sessionId],
  );
  const row = result.rows[0]!;
  const pending = parsePendingQuestion(row.pending_question);
  const answered = row.answered_question as SessionAnsweredQuestionJson | null;
  return {
    pending: pending ? { questionId: pending.questionId, questions: snapshotQuestions(pending.questions) } : null,
    answered: answered
      ? {
          questionId: answered.questionId,
          answeredById: answered.answeredById,
          answeredByName: answered.answeredByName,
          answerText: answered.answerText,
        }
      : null,
  };
}

async function insertRunningSession(): Promise<string> {
  const rootId = await seedEvent(pool, {
    workspaceId: fixture.workspaceId,
    channelId: fixture.channelId,
    type: 'session.spawned',
    actorId: fixture.userId,
    payload: {},
  });
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO sessions (
       workspace_id, channel_id, thread_root_event_id, centaur_thread_key, harness,
       title, status, spawned_by, driver_id, current_execution_id, assignment_generation
     )
     VALUES ($1, $2, $3, $4, 'codex', 'question consistency', 'running', $5, $5, 'exe-test', 1)
     RETURNING id`,
    [fixture.workspaceId, fixture.channelId, rootId, `question-consistency:${randomUUID()}`, fixture.userId],
  );
  return inserted.rows[0]!.id;
}

async function foldFrame(runs: SessionRuns, sessionId: string, frame: CentaurEventFrame): Promise<void> {
  await (runs as unknown as FrameFoldSeam).foldFrame(sessionId, frame);
}

describe('session question denorm consistency', () => {
  it('tracks request, answer, superseding request, and resolution exactly on shared event fields', async () => {
    const sessionId = await insertRunningSession();
    const runs = new SessionRuns(pool, new WsHub(), {
      centaur: new AnsweringCentaur(),
      autoResume: false,
      questionRenotifyMinutes: 0,
    });
    const user = { id: fixture.userId, handle: 'alice', displayName: 'Alice' };
    try {
      await foldFrame(runs, sessionId, requestedFrame('q-one', 'turn-one', FIRST_QUESTION, 101));
      expect(await columnState(sessionId)).toEqual(await eventFold(sessionId));

      await runs.answerQuestion(sessionId, user, 'q-one', { choice: { answers: ['Fast'] } });
      expect(await columnState(sessionId)).toEqual(await eventFold(sessionId));

      await foldFrame(runs, sessionId, requestedFrame('q-two', 'turn-two', SECOND_QUESTION, 102));
      expect(await columnState(sessionId)).toEqual(await eventFold(sessionId));

      await foldFrame(runs, sessionId, resolvedFrame('q-two', 'cancelled', 103));
      expect(await columnState(sessionId)).toEqual(await eventFold(sessionId));
    } finally {
      await runs.close();
    }
  });

  it('documents the RPC-driven clear that deliberately has no matching Atrium event', async () => {
    const sessionId = await insertRunningSession();
    const runs = new SessionRuns(pool, new WsHub(), {
      centaur: new AnsweringCentaur(),
      autoResume: false,
      questionRenotifyMinutes: 0,
    });
    try {
      await foldFrame(runs, sessionId, requestedFrame('q-rpc', 'turn-rpc', FIRST_QUESTION, 201));
      expect(await columnState(sessionId)).toEqual(await eventFold(sessionId));

      // A Centaur question_resolved(answered) frame is an authoritative RPC-side
      // signal. If no local answer event exists, SessionRuns still clears the
      // column and intentionally does not manufacture a matching Atrium event.
      await foldFrame(runs, sessionId, resolvedFrame('q-rpc', 'answered', 202));

      const columns = await columnState(sessionId);
      const foldedEvents = await eventFold(sessionId);
      expect(columns.pending).toBeNull();
      expect(foldedEvents.pending?.questionId).toBe('q-rpc');
      const matchingEvents = await pool.query<{ type: string }>(
        `SELECT type FROM events
          WHERE type IN ('session.question_answered', 'session.question_resolved')
            AND payload->>'sessionId' = $1
            AND payload->>'questionId' = 'q-rpc'`,
        [sessionId],
      );
      expect(matchingEvents.rows).toEqual([]);
    } finally {
      await runs.close();
    }
  });
});
