import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { postMessage, listChannelMessages, type AttachmentMeta } from '../events.js';
import { WsHub, type HubSocket } from '../hub.js';
import { registerSttAdapter } from './adapter.js';
import { SttWorker } from './worker.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from '../../test/helpers.js';

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

function fakeSocket(): HubSocket & { received: any[] } {
  const received: any[] = [];
  return {
    readyState: 1,
    received,
    send(data: string) {
      received.push(JSON.parse(data));
    },
  };
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

describe('SttWorker', () => {
  it('claims a pending transcript, stores the result, emits a modifier, and materializes history', async () => {
    const previousProvider = process.env.STT_PROVIDER;
    process.env.STT_PROVIDER = 'worker-test';
    registerSttAdapter({
      name: 'worker-test',
      async transcribe(input) {
        expect(input).toEqual({
          s3Key: 'voice/key.webm',
          contentType: 'audio/webm',
          filename: 'voice.webm',
        });
        return {
          text: 'hello from voice',
          lang: 'en',
          model: 'worker-test-model',
          segments: [{ start: 0, end: 1, text: 'hello' }],
        };
      },
    });

    const audio = await insertAudioFile(fx.userId);
    const posted = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: '',
      attachments: [audio],
      voice: { durationMs: 1200, waveform: [-1, 0.5, 2] },
    });
    expect(posted.payload.voice).toEqual({
      fileId: audio.id,
      durationMs: 1200,
      waveform: [0, 0.5, 1],
    });

    const socket = fakeSocket();
    const hub = new WsHub();
    const client = hub.addClient(socket, { id: fx.userId, handle: 'alice', displayName: 'Alice' });
    hub.subscribe(client, [fx.channelId]);
    socket.received.length = 0;

    const worker = new SttWorker({
      pool,
      hub,
      concurrency: 1,
      pollIntervalMs: 0,
      log: { warn() {}, error() {} },
    });
    try {
      await worker.sweepOnBoot();
      await waitFor(async () => {
        const row = await pool.query<{ status: string; text: string | null; attempts: number }>(
          'SELECT status, text, attempts FROM transcripts WHERE file_id = $1',
          [audio.id],
        );
        return row.rows[0]?.status === 'done' && row.rows[0]?.text === 'hello from voice';
      });
    } finally {
      worker.stop();
      if (previousProvider == null) {
        delete process.env.STT_PROVIDER;
      } else {
        process.env.STT_PROVIDER = previousProvider;
      }
    }

    const transcript = await pool.query<{
      status: string;
      text: string | null;
      lang: string | null;
      model: string | null;
      attempts: number;
    }>('SELECT status, text, lang, model, attempts FROM transcripts WHERE file_id = $1', [audio.id]);
    expect(transcript.rows[0]).toMatchObject({
      status: 'done',
      text: 'hello from voice',
      lang: 'en',
      model: 'worker-test-model',
      attempts: 1,
    });

    const modifier = socket.received.find((msg) => msg.type === 'event')?.event;
    expect(modifier).toMatchObject({
      type: 'voice.transcribed',
      channelId: fx.channelId,
      payload: {
        target: `evt_${posted.id}`,
        transcript: { status: 'done', text: 'hello from voice', lang: 'en' },
      },
    });

    const history = await listChannelMessages(pool, { channelId: fx.channelId });
    const reloaded = history.events.find((event) => event.id === posted.id);
    expect(reloaded?.payload.voice).toEqual({
      fileId: audio.id,
      durationMs: 1200,
      waveform: [0, 0.5, 1],
      transcript: { status: 'done', text: 'hello from voice', lang: 'en' },
    });
  });
});

async function waitFor(fn: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition was not met before timeout');
}
