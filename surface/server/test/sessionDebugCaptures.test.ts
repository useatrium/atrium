import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createTestPool, seedFixture, truncateAll } from './helpers.js';
import { recordSessionDebugCapture, listSessionDebugCaptures } from '../src/session-debug-captures.js';

let pool: pg.Pool;

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
});

describe('session debug captures', () => {
  it('stores verbose content in the durable session plane and returns telemetry-safe refs', async () => {
    const fixture = await seedFixture(pool);
    const session = await pool.query<{ id: string }>(
      `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by)
       VALUES ($1, $2, 'debug-thread', 'codex', 'debug', 'running', $3)
       RETURNING id`,
      [fixture.workspaceId, fixture.channelId, fixture.userId],
    );

    const richPayload = {
      prompt: 'sensitive dogfood prompt',
      toolArgs: { command: 'cat secret.txt' },
      stdout: 'secret output',
    };
    const { capture, telemetry } = await recordSessionDebugCapture(pool, {
      sessionId: session.rows[0]!.id,
      executionId: 'exe_123',
      entryUid: 'entry_456',
      captureMode: 'admin_verbose',
      eventKind: 'debug.verbose_capture',
      payload: richPayload,
      actorId: fixture.userId,
      expiresAt: '2026-07-28T00:00:00.000Z',
    });

    expect(capture.payload).toEqual(richPayload);
    const listed = await listSessionDebugCaptures(pool, session.rows[0]!.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.payload).toEqual(richPayload);

    expect(telemetry).toMatchObject({
      event: 'session_debug_capture_recorded',
      session_id: session.rows[0]!.id,
      execution_id: 'exe_123',
      entry_uid: 'entry_456',
      capture_mode: 'admin_verbose',
      event_kind: 'debug.verbose_capture',
      debug_capture_id: capture.id,
    });
    expect(JSON.stringify(telemetry)).not.toContain('sensitive dogfood prompt');
    expect(JSON.stringify(telemetry)).not.toContain('secret output');
    expect(JSON.stringify(telemetry)).not.toContain('cat secret.txt');
  });
});
