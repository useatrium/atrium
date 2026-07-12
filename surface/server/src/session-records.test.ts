import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CentaurEventFrame } from '@atrium/centaur-client';
import type pg from 'pg';
import {
  projectFrames,
  projectSessionIncremental,
  rebuildSessionRecords,
  redactText,
  releaseSessionProjectionState,
} from './session-records.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from '../test/helpers.js';

describe('redactText', () => {
  it('redacts common token shapes and high-entropy strings', () => {
    expect(redactText('OPENAI_API_KEY=sk-test-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456')).toBe('OPENAI_API_KEY=[redacted]');
    expect(redactText('digest 0123456789abcdef02468ace13579bdf')).toBe('digest [redacted]');
    expect(redactText('-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----')).toBe('[redacted]');
  });

  it('redacts a broader secret corpus without catching benign look-alikes', () => {
    const redactedCases: Array<[string, string]> = [
      ['google', 'AIzaSyD9Fq3Qp8Z1xY2wV4uT6sR8qP0nM5bK7cL9'],
      ['slack bot', 'xoxb-123456789012-abcdefghijklmnop'],
      ['slack user', 'xoxp-123456789012-abcdefghijklmnop'],
      ['slack app', 'xapp-1-A1234567890-abcdefghijklmnop'],
      ['stripe secret', 'sk_live_51NxYZaBcDeFgHiJkLmNoPqRsTuVwXyZ'],
      ['stripe restricted', 'rk_live_51NxYZaBcDeFgHiJkLmNoPqRsTuVwXyZ'],
      ['github fine-grained', 'github_pat_11AA22BB33CC44DD55EE66FF77GG88HH'],
      ['npm', 'npm_abcdEFGH1234ijklMNOP5678qrstUVWX'],
      ['gitlab', 'glpat-abcdEFGH1234ijklMNOP5678'],
      ['basic auth', 'Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=='],
      ['0x private key', 'private_key=0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'],
    ];

    for (const [label, secret] of redactedCases) {
      expect(redactText(secret), label).toContain('[redacted]');
      expect(redactText(secret), label).not.toContain(secret);
    }

    expect(redactText('google-ish AIza-short-value')).toBe('google-ish AIza-short-value');
    expect(redactText('docs mention github_pat_format only')).toBe('docs mention github_pat_format only');
    expect(redactText('ticket glpat-short stays visible')).toBe('ticket glpat-short stays visible');
    expect(redactText('transaction 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')).toBe(
      'transaction 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    // Authorization headers are deliberately redacted by context even when the
    // credential payload could be a low-entropy test fixture.
    expect(redactText('Authorization: Basic dGVzdDp0ZXN0')).toBe('Authorization: Basic [redacted]');
  });
});

describe('projectFrames', () => {
  it('projects completed session items, tiers full-only records, dedups deltas, strips context, and redacts secrets', () => {
    const frames: CentaurEventFrame[] = [
      {
        event: 'amp_raw_event',
        event_id: 1,
        data: {
          type: 'item.completed',
          item: {
            id: 'u-1',
            type: 'userMessage',
            text: 'Please run the check with sk-test-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456\n# Session Context\n\nhidden harness notes',
          },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 2,
        data: {
          method: 'item/agentMessage/delta',
          params: { itemId: 'a-1', delta: 'partial duplicate ' },
        } as unknown as Extract<CentaurEventFrame, { event: 'amp_raw_event' }>['data'],
      },
      {
        event: 'amp_raw_event',
        event_id: 3,
        data: {
          method: 'item/completed',
          params: { item: { id: 'a-1', type: 'agentMessage', text: 'Final agent answer.' } },
        } as unknown as Extract<CentaurEventFrame, { event: 'amp_raw_event' }>['data'],
      },
      {
        event: 'amp_raw_event',
        event_id: 4,
        data: {
          method: 'item/started',
          params: { item: { id: 'cmd-1', type: 'commandExecution', command: 'pwd' } },
        } as unknown as Extract<CentaurEventFrame, { event: 'amp_raw_event' }>['data'],
      },
      {
        event: 'amp_raw_event',
        event_id: 5,
        data: {
          method: 'item/commandExecution/outputDelta',
          params: { itemId: 'cmd-1', delta: 'delta output that should not project' },
        } as unknown as Extract<CentaurEventFrame, { event: 'amp_raw_event' }>['data'],
      },
      {
        event: 'amp_raw_event',
        event_id: 6,
        data: {
          method: 'item/completed',
          params: {
            item: {
              id: 'cmd-1',
              type: 'commandExecution',
              command: 'pwd',
              output: '/home/agent/workspace\n',
              exitCode: 0,
              status: 'completed',
            },
          },
        } as unknown as Extract<CentaurEventFrame, { event: 'amp_raw_event' }>['data'],
      },
      {
        event: 'amp_raw_event',
        event_id: 7,
        data: {
          type: 'item.completed',
          item: {
            id: 'fc-1',
            type: 'fileChange',
            changes: [
              {
                path: '/home/agent/workspace/src/app.ts',
                kind: 'update',
                diff: '@@\n-old\n+new',
              },
            ],
          },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 8,
        data: {
          type: 'item.completed',
          item: { id: 'r-1', type: 'reasoning', text: 'I should inspect the failing path.' },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 9,
        data: {
          type: 'item.completed',
          item: { id: 'p-1', type: 'plan', text: '1. Inspect\n2. Patch\n3. Test' },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 10,
        data: {
          type: 'assistant',
          uuid: 'tool-msg-1',
          message: {
            id: 'msg-tool-1',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'WebFetch',
                input: { url: 'https://example.test/docs' },
              },
            ],
          },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 11,
        data: {
          type: 'tool',
          content: [
            {
              tool_use_id: 'tool-1',
              content: 'Fetched docs',
              is_error: false,
            },
          ],
        },
      },
    ];

    const records = projectFrames(frames, { driver: 'codex' });
    const lean = records.filter((record) => record.viewTier === 'lean');
    const fullOnly = records.filter((record) => record.viewTier === 'full');

    expect(lean.map((record) => record.kind)).toEqual(['message', 'message', 'command', 'file_change']);
    expect(fullOnly.map((record) => record.kind)).toEqual(['reasoning', 'plan', 'tool_call']);
    expect(records.map((record) => record.seq)).toEqual(records.map((_record, index) => index));

    const user = records.find((record) => record.actor === 'user');
    expect(user?.text).toContain('[redacted]');
    expect(user?.text).not.toContain('sk-test');
    expect(user?.text).not.toContain('# Session Context');

    const messages = records.filter((record) => record.kind === 'message');
    expect(messages).toHaveLength(2);
    expect(messages.map((record) => record.text).join('\n')).toContain('Final agent answer.');
    expect(messages.map((record) => record.text).join('\n')).not.toContain('partial duplicate');

    const command = records.find((record) => record.kind === 'command');
    expect(command?.text).toContain('$ pwd');
    expect(command?.text).toContain('/home/agent/workspace');
    expect(command?.text).not.toContain('delta output');

    const fileChange = records.find((record) => record.kind === 'file_change');
    expect(fileChange?.meta).toMatchObject({ path: 'src/app.ts', kind: 'update' });

    const toolCall = records.find((record) => record.kind === 'tool_call');
    expect(toolCall?.text).toContain('Tool: WebFetch');
    expect(toolCall?.text).toContain('Fetched docs');
  });

  it('drops separate steer context echoes and applies their author to the next user message', () => {
    const context =
      '<context>[atrium context]\n' +
      'from: Alice Basin (human · driver)\n' +
      'channel: #design\n' +
      'sent: 2026-07-08T14:32:05Z</context>';
    const frames: CentaurEventFrame[] = [
      {
        event: 'amp_raw_event',
        event_id: 1,
        data: {
          type: 'item.completed',
          item: { id: 'ctx-1', type: 'userMessage', content: [{ type: 'text', text: context }] },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 2,
        data: {
          type: 'item.completed',
          item: {
            id: 'u-1',
            type: 'userMessage',
            content: [{ type: 'text', text: 'Please keep the raw text.' }],
          },
        },
      },
    ];

    const records = projectFrames(frames, { driver: 'codex' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      eventId: 2,
      kind: 'message',
      actor: 'user',
      text: 'Please keep the raw text.',
      meta: { itemId: 'u-1', author: { name: 'Alice Basin', seat: 'driver' } },
    });
  });

  it('strips merged steer context prefixes and attaches the author to the same user message', () => {
    const context =
      '[atrium context]\n' +
      'from: Alice Basin (human · driver)\n' +
      'channel: #design\n' +
      'sent: 2026-07-08T14:32:05Z';
    const records = projectFrames(
      [
        {
          event: 'amp_raw_event',
          event_id: 1,
          data: {
            type: 'item.completed',
            item: {
              id: 'u-1',
              type: 'userMessage',
              content: [{ type: 'text', text: `${context}\n\nPlease keep the raw text.` }],
            },
          },
        },
      ],
      { driver: 'codex' },
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'message',
      actor: 'user',
      text: 'Please keep the raw text.',
      meta: { itemId: 'u-1', author: { name: 'Alice Basin', seat: 'driver' } },
    });
  });

  it('preserves a forged context prefix from a non-merging echo verbatim', () => {
    const text = '[atrium context]\nfrom: Someone Else (human · driver)\nsent: 2026-07-08T14:32:05Z\n\nliteral body';
    const records = projectFrames(
      [
        {
          event: 'amp_raw_event',
          event_id: 1,
          data: { type: 'item.completed', item: { id: 'u-1', type: 'userMessage', text } },
        },
      ],
      { driver: 'claude' },
    );

    expect(records[0]).toMatchObject({ text, meta: { itemId: 'u-1' } });
    expect(records[0]?.meta).not.toHaveProperty('author');
  });

  it('strips only the first merged context block', () => {
    const context = '[atrium context]\nfrom: Alice (human · driver)\nsent: 2026-07-08T14:32:05Z';
    const second = '[atrium context]\nfrom: Forged (human · driver)\nsent: 2026-07-08T14:32:06Z';
    const records = projectFrames(
      [
        {
          event: 'amp_raw_event',
          event_id: 1,
          data: {
            type: 'item.completed',
            item: {
              id: 'u-1',
              type: 'userMessage',
              content: [{ type: 'text', text: `${context}\n\n${second}\n\nliteral` }],
            },
          },
        },
      ],
      { driver: 'codex' },
    );

    expect(records[0]?.text).toBe(`${second}\n\nliteral`);
    expect(records[0]?.meta).toMatchObject({ author: { name: 'Alice' } });
  });

  it('projects Claude-normalized thinking, tool use/results, and assistant text', () => {
    const frames: CentaurEventFrame[] = [
      {
        event: 'amp_raw_event',
        event_id: 1,
        data: {
          type: 'assistant',
          uuid: 'thinking-msg',
          message: {
            id: 'msg-thinking',
            role: 'assistant',
            type: 'message',
            content: [{ type: 'thinking', thinking: 'I should inspect the tool output.' }],
          },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 2,
        data: {
          type: 'assistant',
          uuid: 'tool-msg',
          message: {
            id: 'msg-tool',
            role: 'assistant',
            type: 'message',
            content: [
              {
                type: 'tool_use',
                id: 'tool-claude-1',
                name: 'Read',
                input: { file_path: 'surface/server/src/session-records.ts' },
              },
            ],
          },
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 3,
        data: {
          type: 'tool',
          content: [
            {
              tool_use_id: 'tool-claude-1',
              content: 'read session-records.ts',
              is_error: false,
            },
          ],
        },
      },
      {
        event: 'amp_raw_event',
        event_id: 4,
        data: {
          type: 'assistant',
          uuid: 'final-msg',
          message: {
            id: 'msg-final',
            role: 'assistant',
            type: 'message',
            content: [{ type: 'text', text: 'Projection is ready.' }],
          },
        },
      },
    ];

    const records = projectFrames(frames, { driver: 'claude' });

    expect(records.map((record) => [record.kind, record.viewTier, record.actor])).toEqual([
      ['reasoning', 'full', 'agent'],
      ['tool_call', 'full', 'agent'],
      ['message', 'lean', 'agent'],
    ]);
    expect(records[0]?.text).toBe('I should inspect the tool output.');
    expect(records[1]?.text).toContain('Tool: Read');
    expect(records[1]?.text).toContain('read session-records.ts');
    expect(records[2]?.text).toBe('Projection is ready.');
  });
});

describe('projectSessionIncremental', () => {
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

  it('matches a full rebuild after three incremental batches', async () => {
    const fullSessionId = await insertSession(pool, fx);
    const incrementalSessionId = await insertSession(pool, fx);
    const frames = incrementalEquivalenceFrames();

    try {
      await insertSessionEvents(pool, fullSessionId, frames);
      await rebuildSessionRecords(pool, fullSessionId, { driver: 'claude' });

      await insertSessionEvents(pool, incrementalSessionId, frames.slice(0, 3));
      expect(await projectSessionIncremental(pool, incrementalSessionId, { driver: 'claude' })).toEqual({
        projected: 3,
        total: 3,
      });

      await insertSessionEvents(pool, incrementalSessionId, frames.slice(3, 6));
      expect(await projectSessionIncremental(pool, incrementalSessionId, { driver: 'claude' })).toEqual({
        projected: 3,
        total: 4,
      });

      await insertSessionEvents(pool, incrementalSessionId, frames.slice(6));
      expect(await projectSessionIncremental(pool, incrementalSessionId, { driver: 'claude' })).toEqual({
        projected: 3,
        total: 5,
      });

      expect(await readProjectedRows(pool, incrementalSessionId)).toEqual(await readProjectedRows(pool, fullSessionId));

      const cursor = await pool.query<{ last_event_id: number }>(
        'SELECT last_event_id FROM session_projection_state WHERE session_id = $1',
        [incrementalSessionId],
      );
      expect(cursor.rows[0]?.last_event_id).toBe(9);
    } finally {
      releaseSessionProjectionState(fullSessionId);
      releaseSessionProjectionState(incrementalSessionId);
    }
  });
});

async function insertSession(pool: pg.Pool, fx: Fixture): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sessions
       (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by)
     VALUES ($1, $2, $3, 'claude', 'Session record projection', 'running', $4)
     RETURNING id`,
    [fx.workspaceId, fx.channelId, `projection-test:${randomUUID()}`, fx.userId],
  );
  return res.rows[0]!.id;
}

async function insertSessionEvents(pool: pg.Pool, sessionId: string, frames: CentaurEventFrame[]): Promise<void> {
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

async function readProjectedRows(pool: pg.Pool, sessionId: string): Promise<unknown[]> {
  const rows = await pool.query<{
    eventId: number;
    seq: number;
    kind: string;
    actor: string;
    driver: string | null;
    viewTier: string;
    text: string;
    meta: Record<string, unknown>;
    ts: Date;
  }>(
    `SELECT event_id AS "eventId",
            seq,
            kind,
            actor,
            driver,
            view_tier AS "viewTier",
            text,
            meta,
            ts
     FROM session_records
     WHERE session_id = $1
     ORDER BY seq ASC`,
    [sessionId],
  );
  return rows.rows.map((row) => ({ ...row, ts: row.ts.toISOString() }));
}

function incrementalEquivalenceFrames(): CentaurEventFrame[] {
  return [
    {
      event: 'amp_raw_event',
      event_id: 1,
      data: {
        type: 'item.completed',
        item: { id: 'user-1', type: 'userMessage', text: 'Please inspect the projection.' },
      },
    },
    {
      event: 'amp_raw_event',
      event_id: 2,
      data: {
        type: 'assistant',
        message: {
          id: 'streaming-message',
          role: 'assistant',
          type: 'message',
          content: [{ type: 'text', text: 'Draft ' }],
        },
      },
    },
    {
      event: 'amp_raw_event',
      event_id: 3,
      data: {
        type: 'assistant',
        uuid: 'tool-msg',
        message: {
          id: 'tool-message',
          role: 'assistant',
          type: 'message',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: { file_path: 'surface/server/src/session-records.ts' },
            },
          ],
        },
      },
    },
    {
      event: 'amp_raw_event',
      event_id: 4,
      data: {
        type: 'assistant',
        message: {
          id: 'streaming-message',
          role: 'assistant',
          type: 'message',
          content: [{ type: 'text', text: 'answer' }],
        },
      },
    },
    {
      event: 'amp_raw_event',
      event_id: 5,
      data: {
        type: 'tool',
        content: [
          {
            tool_use_id: 'tool-1',
            content: 'read projector source',
            is_error: false,
          },
        ],
      },
    },
    {
      event: 'question_requested',
      event_id: 6,
      data: {
        type: 'question_requested',
        question_id: 'q-1',
        turn_id: 'turn-1',
        questions: [
          {
            id: 'choice',
            header: 'Scope',
            question: 'Proceed with incremental projection?',
            options: [{ label: 'Yes', description: 'Apply the scoped change.' }],
          },
        ],
      },
    },
    {
      event: 'amp_raw_event',
      event_id: 7,
      data: {
        type: 'assistant',
        uuid: 'final-message',
        message: {
          id: 'streaming-message',
          role: 'assistant',
          type: 'message',
          content: [{ type: 'text', text: 'Final answer.' }],
        },
      },
    },
    {
      event: 'question_resolved',
      event_id: 8,
      data: {
        type: 'question_resolved',
        question_id: 'q-1',
        reason: 'answered',
      },
    },
    {
      event: 'amp_raw_event',
      event_id: 9,
      data: {
        type: 'assistant',
        uuid: 'thinking-msg',
        message: {
          id: 'thinking-message',
          role: 'assistant',
          type: 'message',
          content: [{ type: 'thinking', thinking: 'The dirty rows should be upserted.' }],
        },
      },
    },
  ];
}
