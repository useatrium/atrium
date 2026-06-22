import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  buildSessionMeta,
  loadSessionRecords,
  renderArtifactsMarkdown,
  renderChangesMarkdown,
  renderEventsJsonl,
  renderFullMarkdown,
  renderSummaryMarkdown,
  renderToolsMarkdown,
  renderTranscriptMarkdown,
} from './atrium-session-projection.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from '../test/helpers.js';

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

async function insertSession(): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sessions
       (workspace_id, channel_id, centaur_thread_key, harness, repo, branch, title, status, spawned_by)
     VALUES ($1, $2, $3, 'codex', 'atrium', 'issue-72', 'Render session records', 'completed', $4)
     RETURNING id`,
    [fx.workspaceId, fx.channelId, `test:${randomUUID()}`, fx.userId],
  );
  return res.rows[0]!.id;
}

async function insertRecord(args: {
  sessionId: string;
  seq: number;
  kind: string;
  actor?: string;
  driver?: string | null;
  viewTier: 'lean' | 'full';
  text: string;
  meta?: Record<string, unknown>;
  ts?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO session_records
       (session_id, event_id, seq, kind, actor, driver, view_tier, text, meta, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      args.sessionId,
      args.seq + 10,
      args.seq,
      args.kind,
      args.actor ?? 'agent',
      args.driver ?? 'codex',
      args.viewTier,
      args.text,
      JSON.stringify(args.meta ?? {}),
      args.ts ?? `2026-01-01T00:00:0${args.seq}.000Z`,
    ],
  );
}

async function seedProjectedSession(): Promise<string> {
  const sessionId = await insertSession();
  await insertRecord({
    sessionId,
    seq: 0,
    kind: 'message',
    actor: 'user',
    viewTier: 'lean',
    text: 'Please repair the widget renderer.',
  });
  await insertRecord({
    sessionId,
    seq: 1,
    kind: 'message',
    actor: 'agent',
    viewTier: 'lean',
    text: 'I will inspect the projection code.',
  });
  await insertRecord({
    sessionId,
    seq: 2,
    kind: 'reasoning',
    viewTier: 'full',
    text: 'Hidden reasoning that belongs only in the full transcript.',
  });
  await insertRecord({
    sessionId,
    seq: 3,
    kind: 'command',
    viewTier: 'lean',
    text: '$ pnpm test\nall green',
    meta: { command: 'pnpm test', outputExcerpt: 'all green' },
  });
  await insertRecord({
    sessionId,
    seq: 4,
    kind: 'file_change',
    viewTier: 'lean',
    text: 'File update: surface/server/src/example.ts',
    meta: { path: 'surface/server/src/example.ts', kind: 'update' },
  });
  await insertRecord({
    sessionId,
    seq: 5,
    kind: 'tool_call',
    viewTier: 'full',
    text: 'Tool: inspect\nArguments: {"path":"example"}',
    meta: { toolName: 'inspect', argsExcerpt: '{"path":"example"}' },
  });
  await insertRecord({
    sessionId,
    seq: 6,
    kind: 'artifact',
    viewTier: 'lean',
    text: 'Artifact text: docs/report.md (text/markdown, 20 bytes)',
    meta: { path: 'docs/report.md', kind: 'text', mime: 'text/markdown' },
  });
  return sessionId;
}

describe('atrium session projection renderers', () => {
  it('renders lean transcript, full transcript, summary, artifacts, tools, changes, events, and metadata', async () => {
    const sessionId = await seedProjectedSession();

    const lean = await loadSessionRecords(pool, sessionId, 'lean');
    expect(lean.map((record) => record.kind)).toEqual([
      'message',
      'message',
      'command',
      'file_change',
      'artifact',
    ]);

    const transcript = renderTranscriptMarkdown(lean);
    expect(transcript).toContain('**User**: Please repair the widget renderer.');
    expect(transcript).toContain('$ pnpm test');
    expect(transcript).not.toContain('Hidden reasoning');
    expect(transcript).not.toContain('Tool: inspect');

    const full = await loadSessionRecords(pool, sessionId, 'full');
    const fullMarkdown = renderFullMarkdown(full);
    expect(full.map((record) => record.kind)).toEqual([
      'message',
      'message',
      'reasoning',
      'command',
      'file_change',
      'tool_call',
      'artifact',
    ]);
    expect(fullMarkdown).toContain('Hidden reasoning that belongs only in the full transcript.');
    expect(fullMarkdown).toContain('Tool: inspect');

    const meta = await buildSessionMeta(pool, sessionId);
    expect(meta).toMatchObject({
      sessionId,
      title: 'Render session records',
      status: 'completed',
      driver: 'codex',
      channelName: 'general',
      repo: 'atrium',
      branch: 'issue-72',
    });

    const summary = renderSummaryMarkdown(full, meta);
    expect(summary).toContain('# Render session records');
    expect(summary).toContain('Status: completed');
    expect(summary).toContain('Messages: 2');
    expect(summary).toContain('Commands: 1');
    expect(summary).toContain('Files changed: 1');
    expect(summary).toContain('Artifacts: 1');

    expect(renderChangesMarkdown(full)).toContain('- update: surface/server/src/example.ts');
    expect(renderToolsMarkdown(full)).toContain('## Command 3');
    expect(renderToolsMarkdown(full)).toContain('## Tool Call 5: inspect');
    expect(renderArtifactsMarkdown(full)).toContain('- docs/report.md (text, text/markdown)');

    const jsonl = renderEventsJsonl(full);
    const lines = jsonl.trimEnd().split('\n');
    expect(lines).toHaveLength(full.length);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      sessionId,
      seq: 0,
      kind: 'message',
      viewTier: 'lean',
      text: 'Please repair the widget renderer.',
    });
  });
});
