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

describe('GET /api/files/:artifactId/locator', () => {
  async function seedLedgerArtifact(sessionId: string, path: string): Promise<string> {
    const payload = Buffer.from('locator target\n');
    const sha = createHash('sha256').update(payload).digest('hex');
    await seedOffloadedBlob(payload, 'text/markdown');
    await new ArtifactLedger(pool).commitVersion({
      sessionId,
      channelId: fx.channelId,
      path,
      blobSha: sha,
      sizeBytes: payload.byteLength,
      mime: 'text/markdown',
      author: 'agent:test',
      kind: 'created',
    });
    const row = await pool.query<{ id: string }>('SELECT id FROM artifacts WHERE path = $1', [
      `shared/channels/${fx.channelId}/${path}`,
    ]);
    return row.rows[0]!.id;
  }

  it('returns the hub row by id, tombstoned included', async () => {
    const cookie = await loginCookie();
    const sessionId = await insertSession();
    const artifactId = await seedLedgerArtifact(sessionId, 'notes/locate-me.md');

    const live = await app.inject({ method: 'GET', url: `/api/files/${artifactId}/locator`, headers: { cookie } });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({
      artifactId,
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      path: `shared/channels/${fx.channelId}/notes/locate-me.md`,
      name: 'locate-me.md',
      mediaKind: 'text',
      tombstoned: false,
    });

    await pool.query('UPDATE artifacts SET tombstoned_at = now() WHERE id = $1', [artifactId]);
    const gone = await app.inject({ method: 'GET', url: `/api/files/${artifactId}/locator`, headers: { cookie } });
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toMatchObject({ artifactId, tombstoned: true });
  });

  it('legacy /api/files/:id falls through to artifact content for ledger ids', async () => {
    const cookie = await loginCookie();
    const sessionId = await insertSession();
    const artifactId = await seedLedgerArtifact(sessionId, 'notes/legacy-url.md');

    const res = await app.inject({ method: 'GET', url: `/api/files/${artifactId}`, headers: { cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/api/files/artifact/${artifactId}/content`);
  });

  it('hides artifacts in channels the requester cannot access with a 404', async () => {
    await loginCookie();
    const sessionId = await insertSession();
    const artifactId = await seedLedgerArtifact(sessionId, 'notes/private.md');
    // Login auto-joins the default workspace, so gate on channel privacy.
    await pool.query(`UPDATE channels SET kind = 'private' WHERE id = $1`, [fx.channelId]);

    const outsider = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { handle: 'mallory', displayName: 'Mallory' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/files/${artifactId}/locator`,
      headers: { cookie: outsider.headers['set-cookie'] as string },
    });
    expect(res.statusCode).toBe(404);
  });
});
