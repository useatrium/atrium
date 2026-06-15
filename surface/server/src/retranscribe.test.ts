import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from './app.js';
import { createChannel, postMessage, type AttachmentMeta } from './events.js';
import { WsHub } from './hub.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from '../test/helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let app: FastifyInstance | null = null;
let enqueueCount = 0;

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  fx = await seedFixture(pool);
  enqueueCount = 0;
});

afterEach(async () => {
  await app?.close();
  app = null;
});

async function startApp() {
  app = await buildApp({
    pool,
    hub: new WsHub(),
    stt: { enqueue: () => enqueueCount++ },
    calls: false,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
  return app;
}

async function login(handle: string, displayName = handle): Promise<string> {
  const res = await app!.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  expect(res.statusCode).toBe(200);
  return res.headers['set-cookie'] as string;
}

async function insertAudioFile(uploaderId: string): Promise<AttachmentMeta> {
  const res = await pool.query<{
    id: string;
    filename: string;
    content_type: string;
    size_bytes: string;
  }>(
    `INSERT INTO files (workspace_id, uploader_id, filename, content_type, size_bytes, s3_key)
     VALUES ($1, $2, 'voice.webm', 'audio/webm', 42, 'voice/key.webm')
     RETURNING id, filename, content_type, size_bytes`,
    [fx.workspaceId, uploaderId],
  );
  const row = res.rows[0]!;
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    size: Number(row.size_bytes),
  };
}

async function postVoiceMessage(channelId = fx.channelId): Promise<{ eventId: number; fileId: string }> {
  const audio = await insertAudioFile(fx.userId);
  const event = await postMessage(pool, {
    workspaceId: fx.workspaceId,
    channelId,
    actorId: fx.userId,
    text: '',
    attachments: [audio],
    voice: { durationMs: 1200, waveform: [0, 0.5, 1] },
  });
  return { eventId: event.id, fileId: audio.id };
}

describe('POST /api/voice/:fileId/retranscribe', () => {
  it('resets a failed transcript to pending, appends a pending modifier, and nudges STT', async () => {
    const current = await startApp();
    const cookie = await login('alice', 'Alice');
    const { eventId, fileId } = await postVoiceMessage();
    await pool.query(
      `UPDATE transcripts
       SET status = 'failed', attempts = 3, error = 'model crashed'
       WHERE file_id = $1`,
      [fileId],
    );

    const res = await current.inject({
      method: 'POST',
      url: `/api/voice/${fileId}/retranscribe`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(202);
    expect(enqueueCount).toBe(1);
    const transcript = await pool.query<{ status: string; attempts: number; error: string | null }>(
      'SELECT status, attempts, error FROM transcripts WHERE file_id = $1',
      [fileId],
    );
    expect(transcript.rows[0]).toEqual({ status: 'pending', attempts: 0, error: null });

    const event = await pool.query<{ type: string; payload: any }>(
      `SELECT type, payload
       FROM events
       WHERE type = 'voice.transcribed' AND payload->>'target_event_id' = $1
       ORDER BY id DESC
       LIMIT 1`,
      [String(eventId)],
    );
    expect(event.rows[0]).toMatchObject({
      type: 'voice.transcribed',
      payload: {
        target_event_id: eventId,
        transcript: { status: 'pending' },
      },
    });
  });

  it('returns 404 for a user without channel access', async () => {
    const current = await startApp();
    const bobCookie = await login('bob', 'Bob');
    const { channel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: 'secret',
      actorId: fx.userId,
      private: true,
    });
    const { fileId } = await postVoiceMessage(channel.id);
    await pool.query("UPDATE transcripts SET status = 'failed' WHERE file_id = $1", [fileId]);

    const res = await current.inject({
      method: 'POST',
      url: `/api/voice/${fileId}/retranscribe`,
      headers: { cookie: bobCookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  it('returns 409 for a transcript that is not failed', async () => {
    const current = await startApp();
    const cookie = await login('alice', 'Alice');
    const { fileId } = await postVoiceMessage();
    await pool.query("UPDATE transcripts SET status = 'done', text = 'already done' WHERE file_id = $1", [
      fileId,
    ]);

    const res = await current.inject({
      method: 'POST',
      url: `/api/voice/${fileId}/retranscribe`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not_retryable' });
  });

  it('returns 404 for an unknown file id', async () => {
    const current = await startApp();
    const cookie = await login('alice', 'Alice');

    const res = await current.inject({
      method: 'POST',
      url: `/api/voice/${randomUUID()}/retranscribe`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });
});
