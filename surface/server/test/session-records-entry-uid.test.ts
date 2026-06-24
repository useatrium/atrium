import { createHash, randomUUID } from 'node:crypto';
import type { CentaurEventFrame } from '@atrium/centaur-client';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rebuildSessionRecords, releaseSessionProjectionState } from '../src/session-records.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

type EntryUidSource = 'tu' | 'msg' | 'item' | 'q' | 'fb';

interface ProjectedRow {
  seq: number;
  eventId: number;
  kind: string;
  text: string;
  meta: Record<string, unknown>;
  entryUid: string;
}

describe('session record entry_uid derivation', () => {
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

  it('keeps entry_uid stable when an earlier projected record shifts seq', async () => {
    const sessionId = await insertSession(pool, fx);
    const frames = initialFrames();

    try {
      await insertSessionEvents(pool, sessionId, frames);
      await rebuildSessionRecords(pool, sessionId, { driver: 'codex' });

      const before = await readProjectedRows(pool, sessionId);
      expect(before.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);

      expect(messageRow(before).entryUid).toBe(expectedUid('msg', 'msg-source'));
      expect(toolRow(before).entryUid).toBe(expectedUid('tu', 'tool-use-source'));
      expect(codexItemRow(before).entryUid).toBe(expectedUid('item', 'codex-item-source'));
      expect(questionRow(before).entryUid).toBe(expectedUid('q', 'question-source'));
      expect(fallbackUsageRow(before, 70).entryUid).toBe(expectedUid('fb', '70|usage|0'));

      const fileRows = codexFileChangeRows(before);
      expect(fileRows).toHaveLength(2);
      expect(fileRows[0]!.entryUid).toBe(expectedUid('item', 'change|codex-file-source|0'));
      expect(fileRows[1]!.entryUid).toBe(expectedUid('item', 'change|codex-file-source|1'));
      expect(fileRows[0]!.entryUid).not.toBe(fileRows[1]!.entryUid);

      for (const row of before) {
        expect(row.entryUid).toMatch(/^[A-Za-z0-9_-]+$/);
      }
      expect(new Set(before.map((row) => row.entryUid)).size).toBe(before.length);

      const stableByLogicalEntry = new Map(
        before.map((row) => [
          logicalEntryKey(row),
          { entryUid: row.entryUid, seq: row.seq },
        ]),
      );

      await insertSessionEvents(pool, sessionId, [earlierFrame()]);
      await rebuildSessionRecords(pool, sessionId, { driver: 'codex' });

      const after = await readProjectedRows(pool, sessionId);
      expect(after.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

      for (const [key, original] of stableByLogicalEntry) {
        const row = after.find((candidate) => logicalEntryKey(candidate) === key);
        expect(row, key).toBeDefined();
        expect(row!.entryUid, key).toBe(original.entryUid);
        expect(row!.seq, key).not.toBe(original.seq);
      }
    } finally {
      releaseSessionProjectionState(sessionId);
    }
  });
});

async function insertSession(pool: pg.Pool, fx: Fixture): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sessions
       (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by)
     VALUES ($1, $2, $3, 'codex', 'Entry uid projection', 'running', $4)
     RETURNING id`,
    [fx.workspaceId, fx.channelId, `entry-uid-test:${randomUUID()}`, fx.userId],
  );
  return res.rows[0]!.id;
}

async function insertSessionEvents(
  pool: pg.Pool,
  sessionId: string,
  frames: CentaurEventFrame[],
): Promise<void> {
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
        new Date(Date.UTC(2026, 0, 1, 0, 0, frame.event_id)).toISOString(),
      ],
    );
  }
}

async function readProjectedRows(pool: pg.Pool, sessionId: string): Promise<ProjectedRow[]> {
  const rows = await pool.query<ProjectedRow>(
    `SELECT event_id AS "eventId",
            seq,
            kind,
            text,
            meta,
            entry_uid AS "entryUid"
     FROM session_records
     WHERE session_id = $1
     ORDER BY seq ASC`,
    [sessionId],
  );
  return rows.rows;
}

function initialFrames(): CentaurEventFrame[] {
  return [
    {
      event: 'amp_raw_event',
      event_id: 10,
      data: {
        type: 'assistant',
        uuid: 'uuid-source',
        message: {
          id: 'msg-source',
          role: 'assistant',
          type: 'message',
          content: [{ type: 'text', text: 'Message anchored by message id.' }],
        },
      },
    },
    {
      event: 'amp_raw_event',
      event_id: 20,
      data: {
        type: 'assistant',
        uuid: 'uuid-tool-source',
        message: {
          id: 'msg-tool-source',
          role: 'assistant',
          type: 'message',
          content: [
            {
              type: 'tool_use',
              id: 'tool-use-source',
              name: 'Read',
              input: { file_path: 'surface/server/src/session-records.ts' },
            },
          ],
        },
      },
    },
    {
      event: 'amp_raw_event',
      event_id: 30,
      data: {
        type: 'tool',
        content: [
          {
            tool_use_id: 'tool-use-source',
            content: 'read projector source',
            is_error: false,
          },
        ],
      },
    },
    {
      event: 'amp_raw_event',
      event_id: 40,
      data: {
        type: 'item.completed',
        item: { id: 'codex-item-source', type: 'userMessage', text: 'Codex user entry.' },
      },
    },
    {
      event: 'amp_raw_event',
      event_id: 50,
      data: {
        type: 'item.completed',
        item: {
          id: 'codex-file-source',
          type: 'fileChange',
          changes: [
            { path: '/repo/a.ts', kind: 'update', diff: '@@\n-old\n+new' },
            { path: '/repo/b.ts', kind: 'delete', diff: '@@\n-old' },
          ],
        },
      },
    },
    {
      event: 'question_requested',
      event_id: 60,
      data: {
        type: 'question_requested',
        question_id: 'question-source',
        turn_id: 'turn-source',
        questions: [
          {
            id: 'choice',
            header: 'Scope',
            question: 'Proceed?',
            options: [{ label: 'Yes', description: 'Continue.' }],
          },
        ],
      },
    },
    usageFrame(70, 0.5),
  ];
}

function earlierFrame(): CentaurEventFrame {
  return usageFrame(5, 0.25);
}

function usageFrame(eventId: number, costUsd: number): CentaurEventFrame {
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
      cost_usd: costUsd,
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      authoritative: true,
    },
  };
}

function expectedUid(source: EntryUidSource, rawKeyString: string): string {
  return `${source}_${createHash('sha256')
    .update(`${source}|${rawKeyString}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function messageRow(rows: ProjectedRow[]): ProjectedRow {
  return expectRow(rows.find((row) => row.meta.messageId === 'msg-source'));
}

function toolRow(rows: ProjectedRow[]): ProjectedRow {
  return expectRow(rows.find((row) => row.meta.toolUseId === 'tool-use-source'));
}

function codexItemRow(rows: ProjectedRow[]): ProjectedRow {
  return expectRow(rows.find((row) => row.meta.itemId === 'codex-item-source'));
}

function questionRow(rows: ProjectedRow[]): ProjectedRow {
  return expectRow(rows.find((row) => row.meta.questionId === 'question-source'));
}

function fallbackUsageRow(rows: ProjectedRow[], eventId: number): ProjectedRow {
  return expectRow(
    rows.find((row) => row.kind === 'usage' && firstSourceEventId(row.meta) === eventId),
  );
}

function codexFileChangeRows(rows: ProjectedRow[]): ProjectedRow[] {
  return rows
    .filter((row) => row.meta.itemId === 'codex-file-source')
    .sort((a, b) => Number(a.meta.changeIndex) - Number(b.meta.changeIndex));
}

function logicalEntryKey(row: ProjectedRow): string {
  if (typeof row.meta.toolUseId === 'string') return `tool:${row.meta.toolUseId}`;
  if (typeof row.meta.messageId === 'string') return `${row.kind}:msg:${row.meta.messageId}`;
  if (typeof row.meta.itemId === 'string') {
    const changeIndex = row.meta.changeIndex;
    if (typeof changeIndex === 'number' || typeof changeIndex === 'string') {
      return `item:${row.meta.itemId}:change:${changeIndex}`;
    }
    return `item:${row.meta.itemId}`;
  }
  if (typeof row.meta.questionId === 'string') return `question:${row.meta.questionId}`;
  return `fallback:${row.kind}:${firstSourceEventId(row.meta)}`;
}

function firstSourceEventId(meta: Record<string, unknown>): number | string | null {
  if (!Array.isArray(meta.sourceEventIds)) return null;
  const first = meta.sourceEventIds[0];
  if (typeof first !== 'number' && typeof first !== 'string') return null;
  return first;
}

function expectRow(row: ProjectedRow | undefined): ProjectedRow {
  expect(row).toBeDefined();
  return row!;
}
