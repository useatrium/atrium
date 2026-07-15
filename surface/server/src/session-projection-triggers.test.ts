import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { CentaurClient, CentaurEventFrame } from '@atrium/centaur-client';
import { createTestPool, seedEvent, seedFixture, truncateAll, type Fixture } from '../test/helpers.js';
import { getFrameGapStats, resetFrameGapStats } from './frame-gap.js';
import { WsHub } from './hub.js';
import { releaseSessionProjectionState } from './session-records.js';
import { projectIncrementalAndEmit } from './session-record-changefeed.js';
import { isCompletedItemFrame, sessionActivitySummary, SessionRuns } from './session-runs.js';

let pool: pg.Pool;
let fx: Fixture;

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  fx = await seedFixture(pool);
});

afterEach(() => resetFrameGapStats());

describe('session projection triggers', () => {
  it('projects incrementally and emits change-feed rows only for dirty records', async () => {
    const sessionId = await insertSession();
    await insertSessionEvents(sessionId, [
      completedItemFrame(1, 'user-1', 'userMessage', 'Please inspect live projection.'),
    ]);

    await expect(projectIncrementalAndEmit(pool, sessionId)).resolves.toBe(1);
    await expect(readRecordTexts(sessionId)).resolves.toEqual(['Please inspect live projection.']);
    await expect(readChangeCount(sessionId)).resolves.toBe(1);

    await expect(projectIncrementalAndEmit(pool, sessionId)).resolves.toBe(0);
    await expect(readChangeCount(sessionId)).resolves.toBe(1);
    releaseSessionProjectionState(sessionId);
  });

  it('recognizes completed item frames without treating deltas as completed', () => {
    expect(isCompletedItemFrame(completedItemFrame(1, 'typed', 'userMessage', 'typed'))).toBe(true);
    expect(
      isCompletedItemFrame({
        event: 'amp_raw_event',
        event_id: 2,
        data: {
          method: 'item/completed',
          params: { item: { id: 'method', type: 'agentMessage', text: 'method' } },
        } as unknown as Extract<CentaurEventFrame, { event: 'amp_raw_event' }>['data'],
      }),
    ).toBe(true);
    expect(
      isCompletedItemFrame({
        event: 'amp_raw_event',
        event_id: 3,
        data: {
          method: 'item/agentMessage/delta',
          params: { itemId: 'delta', delta: 'partial' },
        } as unknown as Extract<CentaurEventFrame, { event: 'amp_raw_event' }>['data'],
      }),
    ).toBe(false);
    expect(
      isCompletedItemFrame({
        event: 'assistant_text_observed',
        event_id: 4,
        data: {
          type: 'obs.assistant_text',
          engine: 'centaur',
          harness: 'codex',
          thread_key: 'thread',
          execution_id: 'exec',
          text_chars: 7,
          text_block_count: 1,
        },
      }),
    ).toBe(false);
  });

  it('derives compact activity summaries from tool-start frames', () => {
    expect(
      sessionActivitySummary({
        event: 'amp_raw_event',
        event_id: 1,
        data: {
          type: 'item.started',
          item: { type: 'commandExecution', command: 'pnpm test --filter @atrium/server' },
        },
      }),
    ).toBe('running tests: pnpm test --filter @atrium/server');
    expect(
      sessionActivitySummary({
        event: 'amp_raw_event',
        event_id: 2,
        data: {
          type: 'item.started',
          item: { type: 'fileChange', changes: [{ path: 'surface/server/src/routes/sessions.ts' }] },
        },
      }),
    ).toBe('editing surface/server/src/routes/sessions.ts');
    expect(
      sessionActivitySummary({
        event: 'assistant_tool_use_observed',
        event_id: 3,
        data: {
          type: 'obs.assistant_tool_use',
          engine: 'centaur',
          harness: 'codex',
          thread_key: 'thread',
          execution_id: 'exec',
          tool_name: 'Bash',
          tool_use_id: 'tool-1',
          input_keys: ['command'],
          input_size_bytes: 5,
        },
      }),
    ).toBe('running Bash');
  });

  it('persists a completed turn reply under the session conversation root', async () => {
    const sessionId = await insertSession();
    const rootId = await seedEvent(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      type: 'message.posted',
      actorId: fx.userId,
      payload: { text: 'start' },
    });
    await pool.query('UPDATE sessions SET thread_root_event_id = $1 WHERE id = $2', [rootId, sessionId]);
    const runs = new SessionRuns(pool, new WsHub(), {
      autoResume: false,
      centaur: centaurTail([completedExecutionFrame(7)]),
      apiKey: 'test',
    });

    await runPrivateTailer(runs, sessionId);

    const replies = await pool.query<{
      thread_root_event_id: number;
      payload: { session_id: string; text: string; broadcast: boolean };
    }>(
      `SELECT thread_root_event_id, payload
         FROM events
        WHERE type = 'session.replied'
          AND payload->>'session_id' = $1`,
      [sessionId],
    );
    // The reply is rooted in the session conversation AND broadcast, so the
    // answer surfaces in the channel feed as an agent message rather than
    // staying buried in the thread. Both facts are load-bearing.
    expect(replies.rows).toEqual([
      {
        thread_root_event_id: rootId,
        payload: { session_id: sessionId, text: 'done', broadcast: true },
      },
    ]);
  });

  it('debounces live completed-item projection and final-projects the remaining dirty record', async () => {
    const sessionId = await insertSession();
    const runs = new SessionRuns(pool, new WsHub(), {
      autoResume: false,
      centaur: centaurTail([
        completedItemFrame(1, 'user-1', 'userMessage', 'First projected item.'),
        completedItemFrame(2, 'agent-1', 'agentMessage', 'Second projected item.'),
      ]),
      apiKey: 'test',
    });

    await runPrivateTailer(runs, sessionId);

    await expect(readRecordTexts(sessionId)).resolves.toEqual(['First projected item.', 'Second projected item.']);
    await expect(readChangeCount(sessionId)).resolves.toBe(2);
    releaseSessionProjectionState(sessionId);
  });

  it('projects mirrored frames from the failure catch path before marking failed', async () => {
    const sessionId = await insertSession();
    const runs = new SessionRuns(pool, new WsHub(), {
      autoResume: false,
      centaur: centaurTail([usageFrame(1)], new Error('tail failed')),
      apiKey: 'test',
    });

    await runPrivateTailer(runs, sessionId);

    await expect(readRecordTexts(sessionId)).resolves.toEqual(['Usage: gpt-test, cost $0.5, 15 tokens']);
    await expect(readChangeCount(sessionId)).resolves.toBe(1);
    const status = await pool.query<{ status: string }>(`SELECT status FROM sessions WHERE id = $1`, [sessionId]);
    expect(status.rows[0]?.status).toBe('failed');
    releaseSessionProjectionState(sessionId);
  });

  it('treats sparse Centaur event ids as valid global watermarks', async () => {
    const sessionId = await insertSession();
    const runs = new SessionRuns(pool, new WsHub(), {
      autoResume: false,
      centaur: centaurTail([
        completedItemFrame(10, 'user-1', 'userMessage', 'Sparse first item.'),
        completedItemFrame(14, 'agent-1', 'agentMessage', 'Sparse second item.'),
        completedExecutionFrame(22),
      ]),
      apiKey: 'test',
    });

    await runPrivateTailer(runs, sessionId);

    const mirrored = await pool.query<{ centaur_event_id: number }>(
      `SELECT centaur_event_id
         FROM session_events
        WHERE session_id = $1
        ORDER BY centaur_event_id ASC`,
      [sessionId],
    );
    expect(mirrored.rows.map((row) => row.centaur_event_id)).toEqual([10, 14, 22]);
    const row = await pool.query<{ last_event_id: number; status: string }>(
      `SELECT last_event_id, status FROM sessions WHERE id = $1`,
      [sessionId],
    );
    expect(row.rows[0]?.last_event_id).toBe(22);
    expect(row.rows[0]?.status).toBe('completed');
    expect(getFrameGapStats(sessionId)).toBeUndefined();
    releaseSessionProjectionState(sessionId);
  });
});

async function insertSession(): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sessions
       (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
        current_execution_id)
     VALUES ($1, $2, $3, 'codex', 'Projection trigger test', 'running', $4, 'exec-test')
     RETURNING id`,
    [fx.workspaceId, fx.channelId, `projection-trigger:${randomUUID()}`, fx.userId],
  );
  return res.rows[0]!.id;
}

async function insertSessionEvents(sessionId: string, frames: CentaurEventFrame[]): Promise<void> {
  for (const frame of frames) {
    await pool.query(
      `INSERT INTO session_events
         (session_id, centaur_event_id, event_kind, frame, created_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)`,
      [
        sessionId,
        frame.event_id,
        frame.event,
        JSON.stringify(frame),
        `2026-01-01T00:00:${String(frame.event_id).padStart(2, '0')}.000Z`,
      ],
    );
  }
}

function completedItemFrame(
  eventId: number,
  id: string,
  type: 'userMessage' | 'agentMessage',
  text: string,
): CentaurEventFrame {
  return {
    event: 'amp_raw_event',
    event_id: eventId,
    data: {
      type: 'item.completed',
      item: { id, type, text },
    },
  };
}

function usageFrame(eventId: number): CentaurEventFrame {
  return {
    event: 'usage_observed',
    event_id: eventId,
    data: {
      type: 'obs.usage',
      engine: 'centaur',
      harness: 'codex',
      thread_key: 'thread',
      execution_id: 'exec-test',
      model: 'gpt-test',
      cost_usd: 0.5,
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    },
  };
}

function completedExecutionFrame(eventId: number): CentaurEventFrame {
  return {
    event: 'execution_state',
    event_id: eventId,
    data: {
      type: 'execution.state',
      status: 'completed',
      thread_key: 'thread',
      execution_id: 'exec-test',
      result_text: 'done',
    },
  };
}

function centaurTail(frames: CentaurEventFrame[], error?: Error): CentaurClient {
  return {
    async *tailEvents() {
      for (const frame of frames) yield frame;
      if (error) throw error;
    },
  } as unknown as CentaurClient;
}

async function runPrivateTailer(runs: SessionRuns, sessionId: string): Promise<void> {
  await (
    runs as unknown as {
      runTailer(id: string, controller: AbortController): Promise<void>;
    }
  ).runTailer(sessionId, new AbortController());
}

async function readRecordTexts(sessionId: string): Promise<string[]> {
  const res = await pool.query<{ text: string }>(
    `SELECT text FROM session_records WHERE session_id = $1 ORDER BY seq ASC`,
    [sessionId],
  );
  return res.rows.map((row) => row.text);
}

async function readChangeCount(sessionId: string): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM session_record_changes WHERE session_id = $1`,
    [sessionId],
  );
  return Number(res.rows[0]?.count ?? 0);
}
