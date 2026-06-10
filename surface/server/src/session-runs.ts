import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { CentaurClient, isTerminalExecutionStatus, type CentaurEventFrame } from '@atrium/centaur-client';
import { config } from './config.js';
import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';
import { appendEvent, DomainError, type UserRef, type WireEvent } from './events.js';
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
  costUsd: number;
  resultText: string | null;
  createdAt: string;
  completedAt: string | null;
  lastEventId: number;
  permalink: string;
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
  last_event_id: number;
  result_text: string | null;
  cost_usd: string | number;
  created_at: Date;
  completed_at: Date | null;
}

interface ChannelRow {
  workspace_id: string;
}

const TERMINAL_STATUSES = new Set<SessionStatus>(['completed', 'failed', 'cancelled']);

export class SessionRuns {
  private readonly centaur: CentaurClient;
  private readonly harness: string;
  private readonly autoResume: boolean;
  private readonly tailers = new Map<string, { controller: AbortController; done: Promise<void> }>();

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
        payload: { sessionId: row.id, title: row.title, harness: row.harness, by: args.user.id },
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
  // workspace membership here. Today there is exactly one workspace and every
  // authenticated user belongs to it, so cookie auth at the route suffices.
  async getSessionForUser(id: string, _userId: string): Promise<SessionJson> {
    const row = await this.getSessionRow(id);
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    return toJson(row);
  }

  async streamCentaurEvents(
    session: SessionJson,
    afterEventId: number,
    raw: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    const row = await this.getSessionRow(session.id);
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
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
      raw.end();
    }
  }

  async postUserMessage(id: string, userId: string, text: string): Promise<void> {
    const row = await this.requireSpawner(id, userId);
    let generation = row.assignment_generation;
    if (generation == null) {
      const spawned = await this.centaur.spawn(row.centaur_thread_key, row.harness);
      generation = spawned.assignment_generation;
      await this.pool.query('UPDATE sessions SET assignment_generation = $1 WHERE id = $2', [generation, id]);
    }
    await this.centaur.postMessage(row.centaur_thread_key, generation, [{ type: 'text', text }], {
      user_id: userId,
    });
    const exec = await this.centaur.execute(row.centaur_thread_key, generation, row.harness);
    await this.pool.query(
      `UPDATE sessions
       SET current_execution_id = $1, status = CASE WHEN status = 'completed' THEN 'queued' ELSE status END,
           completed_at = CASE WHEN status = 'completed' THEN NULL ELSE completed_at END
       WHERE id = $2`,
      [exec.execution_id, id],
    );
    this.startTailer(id);
  }

  async cancelSession(id: string, userId: string): Promise<void> {
    const row = await this.requireSpawner(id, userId);
    await this.centaur.release(row.centaur_thread_key, `rel-${id}`, true);
    await this.updateStatus(id, 'cancelled');
    await this.stopTailer(id);
  }

  async resumeActiveSessions(): Promise<void> {
    if (!this.autoResume) return;
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
        const spawned = await this.centaur.spawn(row.centaur_thread_key, row.harness);
        generation = spawned.assignment_generation;
        row = await this.updateExecution(id, null, generation);
      }
      if (task != null) {
        await this.centaur.postMessage(row.centaur_thread_key, generation, [{ type: 'text', text: task }], {
          user_id: row.spawned_by,
        });
      }
      const exec = await this.centaur.execute(row.centaur_thread_key, generation, row.harness);
      await this.updateExecution(id, exec.execution_id, generation);
      this.startTailer(id);
    } catch {
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
    if (frame.event !== 'execution_state') return;
    const status = normalizeStatus(frame.data.status);
    if (isTerminalExecutionStatus(frame.data.status)) {
      const resultText = typeof frame.data.result_text === 'string' ? frame.data.result_text : null;
      await this.completeSession(id, status, resultText, frame.event_id);
    } else {
      await this.updateStatus(id, status);
    }
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
         SET status = $1, result_text = $2, completed_at = now(), last_event_id = GREATEST(last_event_id, $3)
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
           assignment_generation = $2
       WHERE id = $3
       RETURNING *`,
      [executionId, generation, id],
    );
    return res.rows[0]!;
  }

  private async getSessionRow(id: string): Promise<SessionRow | null> {
    const res = await this.pool.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
    return res.rows[0] ?? null;
  }

  private async requireSpawner(id: string, userId: string): Promise<SessionRow> {
    const row = await this.getSessionRow(id);
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    if (row.spawned_by !== userId) {
      throw new DomainError(403, 'forbidden', 'only the spawner may steer this session');
    }
    return row;
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

function toJson(row: SessionRow): SessionJson {
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
    costUsd: Number(row.cost_usd),
    resultText: row.result_text,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    lastEventId: row.last_event_id,
    permalink: `/s/${row.id}`,
  };
}
