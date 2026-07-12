import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { ArtifactLedger, casBlobKey } from '../src/artifact-ledger.js';
import { classifyMedia } from '../src/media-classifier.js';
import { addWorkspaceMember } from '../src/membership.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    'TRUNCATE artifact_changes, artifact_sync_state, cas_blobs, artifact_pointers, artifact_versions, artifacts CASCADE',
  );
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({
    pool,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function loginCookie(): Promise<string> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle: 'alice', displayName: 'Alice' },
  });
  await addWorkspaceMember(pool, fx.workspaceId, login.json().user.id);
  return login.headers['set-cookie'] as string;
}

async function insertSession(): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by, driver_id)
     VALUES ($1, $2, $3, 'claude-code', 'files-route', 'running', $4, $4) RETURNING id`,
    [fx.workspaceId, fx.channelId, `thread-${randomUUID()}`, fx.userId],
  );
  return res.rows[0]!.id;
}

async function seedOffloadedBlob(bytes: Buffer, mime: string): Promise<void> {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const classification = classifyMedia(bytes, { declaredMime: mime });
  await pool.query(
    `INSERT INTO cas_blobs
       (sha256, size_bytes, mime, s3_key, detected_mime, media_kind, is_text, text_encoding, classification_meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (sha256) DO UPDATE
       SET s3_key = EXCLUDED.s3_key,
           detected_mime = EXCLUDED.detected_mime,
           media_kind = EXCLUDED.media_kind,
           is_text = EXCLUDED.is_text,
           text_encoding = EXCLUDED.text_encoding`,
    [
      sha,
      bytes.byteLength,
      mime,
      casBlobKey(sha),
      classification.detectedMime,
      classification.mediaKind,
      classification.isText,
      classification.textEncoding,
      JSON.stringify(classification.meta),
    ],
  );
}

describe('PUT /api/sessions/:id/files', () => {
  it('rejects git-backed repo files as read-only', async () => {
    const cookie = await loginCookie();
    const sessionId = await insertSession();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${sessionId}/files?path=repo/src/app.ts`,
      headers: { cookie, 'content-type': 'text/plain' },
      payload: 'change',
    });

    expect(res.statusCode).toBe(405);
    expect(res.json()).toEqual({
      error: 'repo_read_only',
      message: 'repo files are read-only in-app; steer the agent to change code',
    });
  });

  it('keeps ledger file write-back working', async () => {
    const cookie = await loginCookie();
    const sessionId = await insertSession();
    const payload = Buffer.from('ledger change\n');
    await seedOffloadedBlob(payload, 'text/markdown');

    const res = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${sessionId}/files?path=notes/plan.md`,
      headers: { cookie, 'content-type': 'text/markdown' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ backing: 'ledger', seq: 1 });
    const blob = await pool.query<{
      detected_mime: string;
      media_kind: string;
      is_text: boolean;
      text_encoding: string | null;
    }>('SELECT detected_mime, media_kind, is_text, text_encoding FROM cas_blobs ORDER BY created_at DESC LIMIT 1');
    expect(blob.rows[0]).toMatchObject({
      detected_mime: 'text/markdown',
      media_kind: 'text',
      is_text: true,
      text_encoding: 'ascii',
    });
  });

  it('rejects binary bytes on text edit route', async () => {
    const cookie = await loginCookie();
    const sessionId = await insertSession();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${sessionId}/files?path=images/chart.png`,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: png,
    });

    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({
      error: 'binary_not_editable',
      mediaKind: 'image',
    });
  });

  it('exposes media metadata on artifact by-path responses', async () => {
    const cookie = await loginCookie();
    const sessionId = await insertSession();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const sha = createHash('sha256').update(png).digest('hex');
    await seedOffloadedBlob(png, 'application/octet-stream');
    await new ArtifactLedger(pool).commitVersion({
      sessionId,
      channelId: fx.channelId,
      path: 'images/chart.png',
      blobSha: sha,
      sizeBytes: png.byteLength,
      mime: 'application/octet-stream',
      author: 'agent:test',
      kind: 'created',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/artifacts/by-path?path=${encodeURIComponent('images/chart.png')}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers['x-media-kind']).toBe('image');
    expect(res.headers['x-is-text']).toBe('false');
    expect(res.headers['x-detected-mime']).toBe('image/png');
    expect(res.headers['x-size-bytes']).toBe(String(png.byteLength));
    expect(res.headers['x-artifact-canonical-path']).toBe(`shared/channels/${fx.channelId}/images/chart.png`);
  });
});
