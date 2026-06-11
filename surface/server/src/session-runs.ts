import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  CentaurApiError,
  CentaurClient,
  isTerminalExecutionStatus,
  type CentaurEventFrame,
  type QuestionPrompt,
} from '@atrium/centaur-client';
import { config } from './config.js';
import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';
import {
  appendEvent,
  canAccessChannel,
  DomainError,
  type UserRef,
  type WireEvent,
} from './events.js';
import type { WsHub } from './hub.js';

export type SessionStatus = 'spawning' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SessionJson {
  id: string;
  workspaceId: string;
  channelId: string;
  threadRootEventId: number | null;
  title: string;
  status: SessionStatus;
  harness: string;
  spawnedBy: string;
  driverId: string | null;
  driver: SessionUserJson | null;
  pendingSeatRequests: SessionUserJson[];
  pendingQuestion: SessionPendingQuestionJson | null;
  viewerCount: number;
  costUsd: number;
  resultText: string | null;
  createdAt: string;
  completedAt: string | null;
  lastEventId: number;
  permalink: string;
}

export interface SessionUserJson {
  userId: string;
  displayName: string;
}

export interface SessionPendingQuestionJson {
  questionId: string;
  turnId: string;
  questions: QuestionPrompt[];
  eventId: number;
}

export interface QuestionAnswerBody {
  [questionId: string]: {
    answers: string[];
  };
}

export interface SessionListItem {
  id: string;
  channelId: string;
  channelName: string;
  title: string;
  status: SessionStatus;
  harness: string;
  spawnedBy: string;
  spawnerName: string;
  costUsd: number;
  createdAt: string;
  completedAt: string | null;
}

export interface SessionRunsOptions {
  centaur?: CentaurClient;
  baseUrl?: string;
  apiKey?: string;
  harness?: string;
  autoResume?: boolean;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  thread_root_event_id: number | null;
  centaur_thread_key: string;
  harness: string;
  title: string;
  status: SessionStatus;
  spawned_by: string;
  driver_id: string | null;
  current_execution_id: string | null;
  assignment_generation: number | null;
  centaur_spawn_attempt: number;
  centaur_spawn_id: string | null;
  centaur_execute_attempt: number;
  centaur_execute_id: string | null;
  pending_question: unknown | null;
  last_event_id: number;
  result_text: string | null;
  cost_usd: string | number;
  created_at: Date;
  completed_at: Date | null;
}

interface ChannelRow {
  workspace_id: string;
}

interface SessionUserRow {
  user_id: string;
  display_name: string;
}

type SessionListStatus = 'running' | 'recent' | 'all';

interface SessionListRow extends SessionRow {
  channel_name: string;
  spawner_name: string;
}

const TERMINAL_STATUSES = new Set<SessionStatus>(['completed', 'failed', 'cancelled']);

// Idle window before a terminal session's sandbox assignment is released.
const releaseIdleMs = () => Number(process.env.SESSION_RELEASE_IDLE_MS ?? 60_000);

export class SessionRuns {
  private readonly centaur: CentaurClient;
  private readonly harness: string;
  private readonly autoResume: boolean;
  private readonly tailers = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly pool: Db,
    private readonly hub: WsHub,
    options: SessionRunsOptions = {},
  ) {
    this.centaur =
      options.centaur ??
      new CentaurClient({
        baseUrl: options.baseUrl ?? config.centaurBaseUrl,
        apiKey: options.apiKey ?? config.centaurApiKey,
      });
    this.harness = options.harness ?? config.centaurHarness;
    this.autoResume = options.autoResume ?? true;
  }

  async createSession(args: {
    channelId: string;
    threadRootEventId: number | null;
    task: string;
    harness?: string;
    /** Client's optimistic id, echoed on session.spawned so a spawn whose
     * POST response was lost still reconciles instead of duplicating. */
    clientSpawnId?: string;
    user: UserRef;
  }): Promise<SessionJson> {
    const title = args.task.trim().slice(0, 80);
    const harness = args.harness ?? this.harness;
    const centaurThreadKey = `surface-${randomUUID()}`;
    const result = await withTx(this.pool, async (client) => {
      const channel = await getChannel(client, args.channelId);
      if (!channel) {
        throw new DomainError(404, 'channel_not_found', 'channel not found');
      }
      if (args.threadRootEventId != null) {
        await assertThreadRoot(client, args.channelId, args.threadRootEventId);
      }
      const inserted = await client.query<SessionRow>(
        `INSERT INTO sessions (
           workspace_id, channel_id, thread_root_event_id, centaur_thread_key, harness, title,
           status, spawned_by, driver_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'spawning', $7, $7)
         RETURNING *`,
        [
          channel.workspace_id,
          args.channelId,
          args.threadRootEventId,
          centaurThreadKey,
          harness,
          title,
          args.user.id,
        ],
      );
      let row = inserted.rows[0]!;
      const event = await appendEvent(client, {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        threadRootEventId: args.threadRootEventId,
        type: 'session.spawned',
        actorId: args.user.id,
        payload: {
          sessionId: row.id,
          title: row.title,
          harness: row.harness,
          by: args.user.id,
          ...(args.clientSpawnId ? { client_spawn_id: args.clientSpawnId } : {}),
        },
      });
      if (args.threadRootEventId == null) {
        const updated = await client.query<SessionRow>(
          'UPDATE sessions SET thread_root_event_id = $1 WHERE id = $2 RETURNING *',
          [event.id, row.id],
        );
        row = updated.rows[0]!;
      }
      return { row, event };
    });
    this.hub.publishEvent(result.event);
    queueMicrotask(() => {
      void this.startSession(result.row.id, args.task).catch(() => {});
    });
    return toJson(result.row);
  }

  // TODO(memberships): when multi-workspace membership lands, gate by
  // workspace membership too. Channel access already gates DM-spawned
  // sessions: 404 (not 403) so foreign session ids don't leak existence.
  async getSessionForUser(id: string, userId: string): Promise<SessionJson> {
    const row = await this.getSessionRow(id);
    if (!row || !(await canAccessChannel(this.pool, userId, row.channel_id))) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    return this.toJsonWithSeatInfo(row);
  }

  async listSessionsForUser(args: {
    userId: string;
    status: SessionListStatus;
    limit: number;
  }): Promise<SessionListItem[]> {
    const statusWhere =
      args.status === 'running'
        ? "AND s.status IN ('spawning', 'queued', 'running')"
        : args.status === 'recent'
          ? "AND s.status NOT IN ('spawning', 'queued', 'running')"
          : '';
    const res = await this.pool.query<SessionListRow>(
      `SELECT s.*,
              c.name AS channel_name,
              u.display_name AS spawner_name
       FROM sessions s
       JOIN channels c ON c.id = s.channel_id
       JOIN users u ON u.id = s.spawned_by
       LEFT JOIN channel_members m
         ON m.channel_id = c.id AND m.user_id = $1
       -- Must mirror canAccessChannel: only 'public' is world-visible; every
       -- other kind (dm, gdm, private — and future ones) requires membership.
       WHERE (c.kind = 'public' OR m.user_id IS NOT NULL)
         ${statusWhere}
       ORDER BY CASE s.status
                  WHEN 'spawning' THEN 0
                  WHEN 'queued' THEN 1
                  WHEN 'running' THEN 2
                  ELSE 3
                END,
                s.created_at DESC
       LIMIT $2`,
      [args.userId, args.limit],
    );
    return res.rows.map(toListItem);
  }

  async streamCentaurEvents(
    session: SessionJson,
    userId: string,
    afterEventId: number,
    raw: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    const row = await this.getSessionRow(session.id);
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    const viewId = this.openSessionView(session.id, userId);
    const keepAlive = setInterval(() => {
      raw.write(': keep-alive\n\n');
    }, 15_000);
    keepAlive.unref?.();
    try {
      for await (const frame of this.centaur.tailEvents(row.centaur_thread_key, {
        executionId: row.current_execution_id ?? undefined,
        afterEventId,
        signal,
      })) {
        if (signal.aborted) break;
        raw.write(`event: ${frame.event}\n`);
        raw.write(`data: ${JSON.stringify({ ...frame.data, event_id: frame.event_id })}\n\n`);
      }
    } finally {
      clearInterval(keepAlive);
      void viewId.then((id) => {
        if (id != null) void this.closeSessionView(id);
      });
      raw.end();
    }
  }

  async postUserMessage(id: string, userId: string, text: string): Promise<void> {
    this.cancelScheduledRelease(id);
    const row = await this.requireDriver(id, userId);
    await this.postUserMessageOnce(row, userId, text, true);
    this.startTailer(id);
  }

  async answerQuestion(
    id: string,
    user: UserRef,
    questionId: string,
    answers: QuestionAnswerBody,
  ): Promise<void> {
    const row = await this.requireDriver(id, user.id);
    const pending = parsePendingQuestion(row.pending_question);
    if (!pending || pending.questionId !== questionId) {
      throw new DomainError(409, 'question_not_pending', 'question is not pending');
    }
    if (!row.current_execution_id) {
      throw new DomainError(409, 'execution_not_running', 'session has no running execution');
    }

    await this.centaur.answerQuestion(row.current_execution_id, questionId, answers);

    const event = await withTx(this.pool, async (client) => {
      const before = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
      const locked = before.rows[0];
      const stillPending = locked ? parsePendingQuestion(locked.pending_question) : null;
      if (!locked || !stillPending || stillPending.questionId !== questionId) return null;
      const updated = await client.query<SessionRow>(
        'UPDATE sessions SET pending_question = NULL WHERE id = $1 RETURNING *',
        [id],
      );
      const next = updated.rows[0]!;
      return appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.question_answered',
        actorId: user.id,
        payload: {
          sessionId: id,
          questionId,
          by: user.id,
          answers: summarizeAnswers(stillPending, answers),
        },
      });
    });
    if (event) this.hub.publishEvent(event);
  }

  private async postUserMessageOnce(row: SessionRow, userId: string, text: string, allowStaleRetry: boolean): Promise<void> {
    let generation = row.assignment_generation;
    if (generation == null) {
      const spawned = await this.spawnAssignment(row.id, row.centaur_thread_key, row.harness);
      generation = spawned.assignment_generation;
      row = spawned.row;
    }
    try {
      await this.centaur.postMessage(
        row.centaur_thread_key,
        generation,
        [{ type: 'text', text }],
        { user_id: userId },
        { messageId: `msg-${randomUUID()}` },
      );
    } catch (err) {
      if (allowStaleRetry && isCentaurCode(err, 'ASSIGNMENT_GENERATION_STALE')) {
        const refreshed = await this.clearAssignment(row.id);
        await this.postUserMessageOnce(refreshed, userId, text, false);
        return;
      }
      throw err;
    }
    // A newly posted message needs a fresh execution: a pending execute id
    // left by a crashed earlier steer would make Centaur replay that old
    // execution and strand this message in the queue. Pending-id reuse is
    // only for boot resume (startSession), which posts no message.
    await this.pool.query('UPDATE sessions SET centaur_execute_id = NULL WHERE id = $1', [row.id]);
    const executeId = await this.reserveExecuteId(row.id);
    const exec = await this.centaur.execute(row.centaur_thread_key, generation, row.harness, { executeId });
    await this.pool.query(
      `UPDATE sessions
       SET current_execution_id = $1, status = CASE WHEN status = 'completed' THEN 'queued' ELSE status END,
           completed_at = CASE WHEN status = 'completed' THEN NULL ELSE completed_at END,
           centaur_execute_id = NULL
       WHERE id = $2`,
      [exec.execution_id, row.id],
    );
  }

  async cancelSession(id: string, userId: string): Promise<void> {
    const row = await this.requireSpawnerOrDriver(id, userId);
    await this.centaur.release(row.centaur_thread_key, `rel-${id}`, true);
    await this.updateStatus(id, 'cancelled');
    await this.stopTailer(id);
  }

  async requestSeat(id: string, userId: string): Promise<void> {
    const event = await withTx(this.pool, async (client) => {
      const session = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
      const row = session.rows[0];
      if (!row) {
        throw new DomainError(404, 'session_not_found', 'session not found');
      }
      if (row.driver_id === userId) {
        throw new DomainError(403, 'forbidden', 'driver already holds the seat');
      }
      const inserted = await client.query(
        `INSERT INTO seat_requests (session_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [id, userId],
      );
      if (!inserted.rowCount) return null;
      return appendEvent(client, {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        threadRootEventId: row.thread_root_event_id,
        type: 'session.seat_requested',
        actorId: userId,
        payload: { sessionId: id, by: userId },
      });
    });
    if (event) this.hub.publishEvent(event);
  }

  async grantSeat(id: string, driverId: string, nextDriverId: string): Promise<void> {
    const event = await this.withSeatLock(async (client) => {
      const row = await this.lockSessionForSeatMutation(client, id);
      if (!row) {
        throw new DomainError(404, 'session_not_found', 'session not found');
      }
      if (row.driver_id !== driverId) {
        throw new DomainError(403, 'forbidden', 'only the current driver may grant the seat');
      }
      await this.assertUserExists(client, nextDriverId);
      const updated = await client.query<SessionRow>(
        'UPDATE sessions SET driver_id = $1 WHERE id = $2 RETURNING *',
        [nextDriverId, id],
      );
      await client.query('DELETE FROM seat_requests WHERE session_id = $1 AND user_id = $2', [id, nextDriverId]);
      const next = updated.rows[0]!;
      return appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.seat_changed',
        actorId: driverId,
        payload: { sessionId: id, from: row.driver_id, to: nextDriverId, reason: 'granted' },
      });
    });
    this.hub.publishEvent(event);
  }

  async takeSeat(id: string, userId: string): Promise<void> {
    const event = await this.withSeatLock(async (client) => {
      const row = await this.lockSessionForSeatMutation(client, id);
      if (!row) {
        throw new DomainError(404, 'session_not_found', 'session not found');
      }
      if (row.driver_id === userId) {
        throw new DomainError(409, 'seat_held', 'requester already holds the seat');
      }
      if (row.driver_id && this.hub.isUserPresent(`session:${id}`, row.driver_id)) {
        throw new DomainError(409, 'seat_held', 'current driver is watching');
      }
      await client.query('UPDATE sessions SET driver_id = $1 WHERE id = $2', [userId, id]);
      await client.query('DELETE FROM seat_requests WHERE session_id = $1 AND user_id = $2', [id, userId]);
      return appendEvent(client, {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        threadRootEventId: row.thread_root_event_id,
        type: 'session.seat_changed',
        actorId: userId,
        payload: { sessionId: id, from: row.driver_id, to: userId, reason: 'taken' },
      });
    });
    this.hub.publishEvent(event);
  }

  async resumeActiveSessions(): Promise<void> {
    if (!this.autoResume) return;
    const terminal = await this.pool.query<Pick<SessionRow, 'id'>>(
      `SELECT id FROM sessions
       WHERE status IN ('completed', 'failed', 'cancelled')
         AND assignment_generation IS NOT NULL
       ORDER BY completed_at ASC NULLS LAST, created_at ASC`,
    );
    for (const row of terminal.rows) this.scheduleRelease(row.id);

    const res = await this.pool.query<SessionRow>(
      `SELECT * FROM sessions
       WHERE status NOT IN ('completed', 'failed', 'cancelled')
       ORDER BY created_at ASC`,
    );
    for (const row of res.rows) {
      if (row.current_execution_id) this.startTailer(row.id);
      else {
        queueMicrotask(() => {
          void this.startSession(row.id, null).catch(() => {});
        });
      }
    }
  }

  async close(): Promise<void> {
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    const handles = [...this.tailers.values()];
    for (const handle of handles) handle.controller.abort();
    this.tailers.clear();
    // Await in-flight tailer iterations so no DB write races shutdown
    // (or, in tests, the next suite's TRUNCATE).
    await Promise.allSettled(handles.map((handle) => handle.done));
  }

  private async startSession(id: string, task: string | null): Promise<void> {
    try {
      let row = await this.getSessionRow(id);
      if (!row) return;
      let generation = row.assignment_generation;
      if (generation == null) {
        const spawned = await this.spawnAssignment(row.id, row.centaur_thread_key, row.harness);
        generation = spawned.assignment_generation;
        row = spawned.row;
      }
      if (task != null) {
        await this.centaur.postMessage(
          row.centaur_thread_key,
          generation,
          [{ type: 'text', text: task }],
          { user_id: row.spawned_by },
          { messageId: `msg-${id}-initial` },
        );
      }
      const executeId = await this.reserveExecuteId(id);
      const exec = await this.centaur.execute(row.centaur_thread_key, generation, row.harness, { executeId });
      await this.updateExecution(id, exec.execution_id, generation);
      this.startTailer(id);
    } catch (err) {
      console.error('session start failed', { id, err });
      await this.updateStatus(id, 'failed').catch(() => {});
    }
  }

  private startTailer(id: string): void {
    void this.stopTailer(id);
    const controller = new AbortController();
    const done = this.runTailer(id, controller).finally(() => {
      const current = this.tailers.get(id);
      if (current?.controller === controller) this.tailers.delete(id);
    });
    this.tailers.set(id, { controller, done });
  }

  private stopTailer(id: string): Promise<void> | undefined {
    const existing = this.tailers.get(id);
    if (!existing) return undefined;
    existing.controller.abort();
    this.tailers.delete(id);
    return existing.done.catch(() => {});
  }

  private async runTailer(id: string, controller: AbortController): Promise<void> {
    const row = await this.getSessionRow(id);
    if (!row || !row.current_execution_id || TERMINAL_STATUSES.has(row.status)) return;
    let lastEventId = row.last_event_id;
    let pendingLastEventId = lastEventId;
    let frameCountSinceFlush = 0;
    let lastFlushAt = Date.now();
    try {
      for await (const frame of this.centaur.tailEvents(row.centaur_thread_key, {
        executionId: row.current_execution_id,
        afterEventId: row.last_event_id,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) return;
        lastEventId = Math.max(lastEventId, frame.event_id);
        pendingLastEventId = lastEventId;
        frameCountSinceFlush += 1;
        await this.foldFrame(id, frame);
        if (frameCountSinceFlush >= 25 || Date.now() - lastFlushAt >= 2000) {
          await this.persistLastEventId(id, pendingLastEventId);
          frameCountSinceFlush = 0;
          lastFlushAt = Date.now();
        }
      }
      await this.persistLastEventId(id, pendingLastEventId);
    } catch {
      if (!controller.signal.aborted) {
        await this.updateStatus(id, 'failed').catch(() => {});
      }
    }
  }

  private async foldFrame(id: string, frame: CentaurEventFrame): Promise<void> {
    if (frame.event === 'usage_observed') {
      const cost = typeof frame.data.cost_usd === 'number' ? frame.data.cost_usd : 0;
      if (cost > 0) {
        await this.pool.query('UPDATE sessions SET cost_usd = cost_usd + $1 WHERE id = $2', [cost, id]);
      }
      return;
    }
    if (frame.event === 'question_requested') {
      await this.persistQuestionRequested(id, frame);
      return;
    }
    if (frame.event === 'question_resolved') {
      await this.persistQuestionResolved(id, frame.data.question_id, frame.data.reason);
      return;
    }
    if (frame.event !== 'execution_state') return;
    const status = normalizeStatus(frame.data.status);
    if (isTerminalExecutionStatus(frame.data.status)) {
      const resultText = typeof frame.data.result_text === 'string' ? frame.data.result_text : null;
      await this.completeSession(id, status, resultText, frame.event_id);
    } else {
      await this.updateStatus(id, status);
    }
  }

  private async persistQuestionRequested(
    id: string,
    frame: Extract<CentaurEventFrame, { event: 'question_requested' }>,
  ): Promise<void> {
    const event = await withTx(this.pool, async (client) => {
      const before = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
      const row = before.rows[0];
      if (!row || TERMINAL_STATUSES.has(row.status)) return null;
      const pending: SessionPendingQuestionJson = {
        questionId: frame.data.question_id,
        turnId: frame.data.turn_id,
        questions: frame.data.questions,
        eventId: frame.event_id,
      };
      const updated = await client.query<SessionRow>(
        `UPDATE sessions
         SET pending_question = $1,
             last_event_id = GREATEST(last_event_id, $2)
         WHERE id = $3
         RETURNING *`,
        [JSON.stringify(pending), frame.event_id, id],
      );
      const next = updated.rows[0]!;
      return appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.question_requested',
        actorId: next.spawned_by,
        payload: {
          sessionId: id,
          questionId: pending.questionId,
          questions: summarizeQuestions(pending.questions),
          permalink: `/s/${id}`,
        },
      });
    });
    if (event) this.hub.publishEvent(event);
  }

  private async persistQuestionResolved(
    id: string,
    questionId: string,
    reason: 'answered' | 'cancelled' | 'empty',
  ): Promise<void> {
    const event = await withTx(this.pool, async (client) => {
      const before = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
      const row = before.rows[0];
      const pending = row ? parsePendingQuestion(row.pending_question) : null;
      if (!row || !pending || pending.questionId !== questionId) return null;
      const updated = await client.query<SessionRow>(
        'UPDATE sessions SET pending_question = NULL WHERE id = $1 RETURNING *',
        [id],
      );
      if (reason === 'answered') return null;
      const next = updated.rows[0]!;
      return appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.question_resolved',
        actorId: next.spawned_by,
        payload: { sessionId: id, questionId, reason },
      });
    });
    if (event) this.hub.publishEvent(event);
  }

  private async updateStatus(id: string, status: SessionStatus): Promise<void> {
    const event = await withTx(this.pool, async (client) => {
      const before = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
      const row = before.rows[0];
      if (!row || row.status === status || TERMINAL_STATUSES.has(row.status)) return null;
      const updated = await client.query<SessionRow>(
        'UPDATE sessions SET status = $1 WHERE id = $2 RETURNING *',
        [status, id],
      );
      return appendEvent(client, {
        workspaceId: updated.rows[0]!.workspace_id,
        channelId: updated.rows[0]!.channel_id,
        threadRootEventId: updated.rows[0]!.thread_root_event_id,
        type: 'session.status_changed',
        actorId: updated.rows[0]!.spawned_by,
        payload: { sessionId: id, status },
      });
    });
    if (event) this.hub.publishEvent(event);
  }

  private async completeSession(
    id: string,
    status: SessionStatus,
    resultText: string | null,
    lastEventId: number,
  ): Promise<void> {
    const event = await withTx(this.pool, async (client) => {
      const before = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
      const row = before.rows[0];
      if (!row || TERMINAL_STATUSES.has(row.status)) return null;
      const completed = await client.query<SessionRow>(
        `UPDATE sessions
         SET status = $1, result_text = $2, completed_at = now(), pending_question = NULL,
             last_event_id = GREATEST(last_event_id, $3)
         WHERE id = $4
         RETURNING *`,
        [status, resultText, lastEventId, id],
      );
      const next = completed.rows[0]!;
      return appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.completed',
        actorId: next.spawned_by,
        payload: {
          sessionId: id,
          status,
          resultExcerpt: (resultText ?? '').slice(0, 200),
          permalink: `/s/${id}`,
        },
      });
    });
    if (event) this.hub.publishEvent(event);
    if (event) this.scheduleRelease(id);
  }

  // Free the sandbox after an idle window: terminal sessions must not pin a
  // warm runtime forever (pods accumulate and exhaust the node — found by live
  // e2e). The delay + cancel-on-steer avoids racing a follow-up turn that
  // arrives right after completion; the re-check makes a late fire harmless.
  private scheduleRelease(id: string): void {
    this.cancelScheduledRelease(id);
    const timer = setTimeout(() => {
      this.releaseTimers.delete(id);
      void this.releaseAssignment(id);
    }, releaseIdleMs());
    timer.unref?.();
    this.releaseTimers.set(id, timer);
  }

  private cancelScheduledRelease(id: string): void {
    const existing = this.releaseTimers.get(id);
    if (existing) {
      clearTimeout(existing);
      this.releaseTimers.delete(id);
    }
  }

  private async releaseAssignment(id: string): Promise<void> {
    try {
      const row = await this.getSessionRow(id);
      if (!row || !TERMINAL_STATUSES.has(row.status)) return;
      if (row.assignment_generation == null) return;
      await this.centaur.release(row.centaur_thread_key, `rel-${id}-${Date.now()}`, false);
      await this.pool.query('UPDATE sessions SET assignment_generation = NULL WHERE id = $1', [id]);
    } catch (err) {
      console.warn('session release failed', { id, err });
    }
  }

  private async persistLastEventId(id: string, lastEventId: number): Promise<void> {
    await this.pool.query('UPDATE sessions SET last_event_id = GREATEST(last_event_id, $1) WHERE id = $2', [
      lastEventId,
      id,
    ]);
  }

  private async updateExecution(
    id: string,
    executionId: string | null,
    generation: number,
  ): Promise<SessionRow> {
    const res = await this.pool.query<SessionRow>(
      `UPDATE sessions
       SET current_execution_id = COALESCE($1, current_execution_id),
           assignment_generation = $2,
           centaur_execute_id = CASE WHEN $1::text IS NULL THEN centaur_execute_id ELSE NULL END
       WHERE id = $3
       RETURNING *`,
      [executionId, generation, id],
    );
    return res.rows[0]!;
  }

  private async spawnAssignment(
    id: string,
    threadKey: string,
    harness: string,
  ): Promise<{ row: SessionRow; assignment_generation: number }> {
    const spawnId = await this.reserveSpawnId(id);
    const spawned = await this.centaur.spawn(threadKey, harness, { spawnId });
    const generation = spawned.assignment_generation;
    if (generation == null) throw new Error('centaur spawn missing assignment_generation');
    const row = await this.persistSpawnedAssignment(id, generation);
    return { row, assignment_generation: generation };
  }

  private async reserveSpawnId(id: string): Promise<string> {
    const res = await this.pool.query<{ centaur_spawn_id: string }>(
      `UPDATE sessions
       SET centaur_spawn_attempt = CASE
             WHEN centaur_spawn_id IS NULL THEN centaur_spawn_attempt + 1
             ELSE centaur_spawn_attempt
           END,
           centaur_spawn_id = COALESCE(
             centaur_spawn_id,
             'spawn-' || id::text || '-a' || (centaur_spawn_attempt + 1)::text
           )
       WHERE id = $1
       RETURNING centaur_spawn_id`,
      [id],
    );
    return res.rows[0]!.centaur_spawn_id;
  }

  private async persistSpawnedAssignment(id: string, generation: number): Promise<SessionRow> {
    const res = await this.pool.query<SessionRow>(
      `UPDATE sessions
       SET assignment_generation = $1,
           centaur_spawn_id = NULL
       WHERE id = $2
       RETURNING *`,
      [generation, id],
    );
    return res.rows[0]!;
  }

  private async reserveExecuteId(id: string): Promise<string> {
    const res = await this.pool.query<{ centaur_execute_id: string }>(
      `UPDATE sessions
       SET centaur_execute_attempt = CASE
             WHEN centaur_execute_id IS NULL THEN centaur_execute_attempt + 1
             ELSE centaur_execute_attempt
           END,
           centaur_execute_id = COALESCE(
             centaur_execute_id,
             'exec-' || id::text || '-a' || (centaur_execute_attempt + 1)::text
           )
       WHERE id = $1
       RETURNING centaur_execute_id`,
      [id],
    );
    return res.rows[0]!.centaur_execute_id;
  }

  private async clearAssignment(id: string): Promise<SessionRow> {
    const res = await this.pool.query<SessionRow>(
      `UPDATE sessions
       SET assignment_generation = NULL,
           centaur_spawn_id = NULL
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    return res.rows[0]!;
  }

  private async getSessionRow(id: string): Promise<SessionRow | null> {
    // Non-UUID ids (hand-mangled permalinks) are "not found", not a Postgres
    // cast error surfacing as a 500.
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const res = await this.pool.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
    return res.rows[0] ?? null;
  }

  private async requireDriver(id: string, userId: string): Promise<SessionRow> {
    const row = await this.getSessionRow(id);
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    if (row.driver_id !== userId) {
      throw new DomainError(403, 'forbidden', 'only the current driver may steer this session');
    }
    return row;
  }

  private async requireSpawnerOrDriver(id: string, userId: string): Promise<SessionRow> {
    const row = await this.getSessionRow(id);
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    if (row.spawned_by !== userId && row.driver_id !== userId) {
      throw new DomainError(403, 'forbidden', 'only the spawner or current driver may cancel this session');
    }
    return row;
  }

  private async withSeatLock<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    try {
      return await withTx(this.pool, fn);
    } catch (err) {
      if ((err as { code?: string }).code === '55P03') {
        throw new DomainError(409, 'seat_held', 'seat mutation already in progress');
      }
      throw err;
    }
  }

  private async lockSessionForSeatMutation(client: DbClient, id: string): Promise<SessionRow | null> {
    const res = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE NOWAIT', [id]);
    return res.rows[0] ?? null;
  }

  private async assertUserExists(client: DbClient, userId: string): Promise<void> {
    const res = await client.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (!res.rowCount) {
      throw new DomainError(404, 'user_not_found', 'user not found');
    }
  }

  private async toJsonWithSeatInfo(row: SessionRow): Promise<SessionJson> {
    const [driver, requests, viewers] = await Promise.all([
      row.driver_id
        ? this.pool.query<SessionUserRow>(
            'SELECT id AS user_id, display_name FROM users WHERE id = $1',
            [row.driver_id],
          )
        : Promise.resolve({ rows: [] as SessionUserRow[] }),
      this.pool.query<SessionUserRow>(
        `SELECT u.id AS user_id, u.display_name
         FROM seat_requests sr
         JOIN users u ON u.id = sr.user_id
         WHERE sr.session_id = $1
         ORDER BY sr.created_at ASC, u.display_name ASC`,
        [row.id],
      ),
      this.pool.query<{ viewer_count: number }>(
        `SELECT count(DISTINCT user_id) AS viewer_count
         FROM session_views
         WHERE session_id = $1 AND user_id <> $2`,
        [row.id, row.spawned_by],
      ),
    ]);
    return toJson(row, {
      driver: driver.rows[0] ? toSessionUserJson(driver.rows[0]) : null,
      pendingSeatRequests: requests.rows.map(toSessionUserJson),
      // node-pg returns count() as a string; coerce so JSON carries a number.
      viewerCount: Number(viewers.rows[0]?.viewer_count ?? 0),
    });
  }

  private async openSessionView(sessionId: string, userId: string): Promise<number | null> {
    try {
      const res = await this.pool.query<{ id: number }>(
        'INSERT INTO session_views (session_id, user_id) VALUES ($1, $2) RETURNING id',
        [sessionId, userId],
      );
      return res.rows[0]?.id ?? null;
    } catch (err) {
      console.warn('session view open failed', err);
      return null;
    }
  }

  private async closeSessionView(id: number): Promise<void> {
    try {
      await this.pool.query('UPDATE session_views SET closed_at = now() WHERE id = $1', [id]);
    } catch (err) {
      console.warn('session view close failed', err);
    }
  }
}

async function getChannel(client: DbClient, channelId: string): Promise<ChannelRow | null> {
  const res = await client.query<ChannelRow>('SELECT workspace_id FROM channels WHERE id = $1', [channelId]);
  return res.rows[0] ?? null;
}

async function assertThreadRoot(
  client: DbClient,
  channelId: string,
  threadRootEventId: number,
): Promise<void> {
  const root = await client.query<{
    channel_id: string | null;
    thread_root_event_id: number | null;
    type: string;
  }>('SELECT channel_id, thread_root_event_id, type FROM events WHERE id = $1', [threadRootEventId]);
  const r = root.rows[0];
  if (!r || (r.type !== 'message.posted' && r.type !== 'session.spawned')) {
    throw new DomainError(404, 'thread_root_not_found', 'thread root not found');
  }
  if (r.channel_id !== channelId) {
    throw new DomainError(400, 'thread_channel_mismatch', 'thread root belongs to another channel');
  }
  if (r.thread_root_event_id != null) {
    throw new DomainError(400, 'nested_thread', 'cannot spawn from a nested thread event');
  }
}

function normalizeStatus(status: string): SessionStatus {
  if (status === 'completed' || status === 'cancelled') return status;
  if (status === 'queued' || status === 'running') return status;
  if (status === 'failed' || status === 'failed_permanent') return 'failed';
  return 'running';
}

function isCentaurCode(err: unknown, code: string): boolean {
  return err instanceof CentaurApiError && err.code === code;
}

function toJson(
  row: SessionRow,
  seatInfo: {
    driver?: SessionUserJson | null;
    pendingSeatRequests?: SessionUserJson[];
    viewerCount?: number;
  } = {},
): SessionJson {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    threadRootEventId: row.thread_root_event_id,
    title: row.title,
    status: row.status,
    harness: row.harness,
    spawnedBy: row.spawned_by,
    driverId: row.driver_id,
    driver: seatInfo.driver ?? null,
    pendingSeatRequests: seatInfo.pendingSeatRequests ?? [],
    pendingQuestion: parsePendingQuestion(row.pending_question),
    viewerCount: seatInfo.viewerCount ?? 0,
    costUsd: Number(row.cost_usd),
    resultText: row.result_text,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    lastEventId: row.last_event_id,
    permalink: `/s/${row.id}`,
  };
}

function toListItem(row: SessionListRow): SessionListItem {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    title: row.title,
    status: row.status,
    harness: row.harness,
    spawnedBy: row.spawned_by,
    spawnerName: row.spawner_name,
    costUsd: Number(row.cost_usd),
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

function toSessionUserJson(row: SessionUserRow): SessionUserJson {
  return { userId: row.user_id, displayName: row.display_name };
}

function parsePendingQuestion(value: unknown): SessionPendingQuestionJson | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.questionId !== 'string' || typeof raw.turnId !== 'string') return null;
  if (!Array.isArray(raw.questions)) return null;
  const questions = raw.questions.filter(isQuestionPrompt);
  if (questions.length !== raw.questions.length) return null;
  const eventId = Number(raw.eventId);
  if (!Number.isFinite(eventId)) return null;
  return {
    questionId: raw.questionId,
    turnId: raw.turnId,
    questions,
    eventId,
  };
}

function isQuestionPrompt(value: unknown): value is QuestionPrompt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.header !== 'string' || typeof raw.question !== 'string') {
    return false;
  }
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options)) return false;
    for (const option of raw.options) {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return false;
      const o = option as Record<string, unknown>;
      if (typeof o.label !== 'string' || typeof o.description !== 'string') return false;
    }
  }
  return true;
}

function summarizeQuestions(questions: QuestionPrompt[]): Record<string, unknown>[] {
  return questions.map((q) => ({
    id: q.id,
    header: q.header,
    question: q.question,
    optionCount: q.options?.length ?? 0,
    isOther: q.isOther === true,
    isSecret: q.isSecret === true,
  }));
}

function summarizeAnswers(
  pending: SessionPendingQuestionJson,
  answers: QuestionAnswerBody,
): Record<string, unknown>[] {
  return Object.entries(answers).map(([id, value]) => {
    const prompt = pending.questions.find((q) => q.id === id);
    const answerValues = Array.isArray(value.answers) ? value.answers : [];
    return {
      id,
      header: prompt?.header ?? id,
      answers: prompt?.isSecret ? answerValues.map(() => 'redacted') : answerValues,
      count: answerValues.length,
    };
  });
}
