import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { ArtifactLedger, casBlobKey } from '../src/artifact-ledger.js';
import { createChannel } from '../src/events.js';
import { classifyMedia } from '../src/media-classifier.js';
import { addWorkspaceMember } from '../src/membership.js';
import { createTestPool, seedFixture, seedMember, truncateAll, type Fixture } from './helpers.js';

const mockedS3 = vi.hoisted(() => {
  class FakeStorage {
    readonly objects = new Map<string, { body: Buffer; contentType: string }>();

    reset(): void {
      this.objects.clear();
    }

    uploadObject = async (key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> => {
      this.objects.set(key, { body: Buffer.from(body), contentType });
    };

    getObjectBytes = async (key: string): Promise<Buffer> => {
      const object = this.objects.get(key);
      if (!object) throw new Error(`missing object: ${key}`);
      return Buffer.from(object.body);
    };

    getObjectStream = async (key: string) => {
      const object = this.objects.get(key);
      if (!object) throw new Error(`missing object: ${key}`);
      return {
        stream: Readable.from([object.body]),
        contentLength: object.body.byteLength,
        contentRange: null,
        contentType: object.contentType,
      };
    };

    headObject = async (key: string): Promise<{ contentLength: number } | null> => {
      const object = this.objects.get(key);
      return object ? { contentLength: object.body.byteLength } : null;
    };
  }

  return { storage: new FakeStorage() };
});

vi.mock('../src/s3.js', () => ({
  copyObject: async () => {},
  deleteObject: async () => {},
  downloadObject: async () => {},
  ensureBucket: async () => {},
  getObjectBytes: mockedS3.storage.getObjectBytes,
  getObjectStream: mockedS3.storage.getObjectStream,
  headObject: mockedS3.storage.headObject,
  presignGet: async () => 'https://storage.local/get',
  presignPut: async () => 'https://storage.local/put',
  uploadObject: mockedS3.storage.uploadObject,
  uploadObjectStream: async () => {},
}));

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;
let ledger: ArtifactLedger;

beforeAll(async () => {
  pool = await createTestPool();
  ledger = new ArtifactLedger(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  mockedS3.storage.reset();
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

async function loginCookie(handle = 'alice', displayName = 'Alice'): Promise<{ cookie: string; userId: string }> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName },
  });
  expect(login.statusCode).toBe(200);
  const userId = login.json().user.id;
  await addWorkspaceMember(pool, fx.workspaceId, userId);
  return { cookie: login.headers['set-cookie'] as string, userId };
}

async function seedUploadedArtifact(params: {
  userId: string;
  channelId?: string;
  filename?: string;
  bytes: Buffer | string;
  mime?: string;
}): Promise<{ artifactId: string; seq: number; path: string }> {
  const body = Buffer.isBuffer(params.bytes) ? params.bytes : Buffer.from(params.bytes, 'utf8');
  const mime = params.mime ?? 'text/plain';
  const channelId = params.channelId ?? fx.channelId;
  const filename = params.filename ?? `edit-${randomUUID()}.txt`;
  const path = `shared/channels/${channelId}/uploads/${filename}`;
  const sha = createHash('sha256').update(body).digest('hex');
  const key = casBlobKey(sha);
  const classification = classifyMedia(body, { declaredMime: mime, filename });
  mockedS3.storage.objects.set(key, { body, contentType: mime });
  await pool.query(
    `INSERT INTO cas_blobs
       (sha256, s3_key, size_bytes, mime, detected_mime, media_kind, is_text, text_encoding, classification_meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (sha256) DO UPDATE
           SET s3_key = COALESCE(cas_blobs.s3_key, EXCLUDED.s3_key),
               detected_mime = EXCLUDED.detected_mime,
               media_kind = EXCLUDED.media_kind,
               is_text = EXCLUDED.is_text,
               text_encoding = EXCLUDED.text_encoding,
               classification_meta = EXCLUDED.classification_meta`,
    [
      sha,
      key,
      body.byteLength,
      mime,
      classification.detectedMime,
      classification.mediaKind,
      classification.isText,
      classification.textEncoding,
      JSON.stringify(classification.meta),
    ],
  );
  const committed = await ledger.commitUpload({
    workspaceId: fx.workspaceId,
    channelId,
    path,
    blobSha: sha,
    sizeBytes: body.byteLength,
    mime,
    author: `human:${params.userId}`,
  });
  return { artifactId: committed.artifactId, seq: committed.seq, path };
}

async function versionText(artifactId: string, seq: number, cookie: string): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/files/artifact/${artifactId}/content?at=${seq}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.body;
}

describe('Files Hub artifactId text editing', () => {
  it('cleanly saves text content and exposes the new head in versions', async () => {
    const { cookie, userId } = await loginCookie();
    const file = await seedUploadedArtifact({ userId, filename: 'clean.txt', bytes: 'first\n' });

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/files/${file.artifactId}/content`,
      headers: { cookie, 'content-type': 'text/plain', 'x-artifact-base-seq': String(file.seq) },
      payload: 'second\n',
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ seq: 2, status: 'normal' });

    const versions = await app.inject({
      method: 'GET',
      url: `/api/files/${file.artifactId}/versions`,
      headers: { cookie },
    });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().versions[0]).toMatchObject({ seq: 2, status: 'normal', isLatest: true });
    expect(await versionText(file.artifactId, 2, cookie)).toBe('second\n');
  });

  it('auto-merges stale non-overlapping edits from the same base', async () => {
    const { cookie, userId } = await loginCookie();
    const file = await seedUploadedArtifact({
      userId,
      filename: 'merge.txt',
      bytes: 'one\nleft\nmiddle\nright\nend\n',
    });

    const first = await app.inject({
      method: 'PUT',
      url: `/api/files/${file.artifactId}/content`,
      headers: { cookie, 'content-type': 'text/plain', 'x-artifact-base-seq': '1' },
      payload: 'one\nleft latest\nmiddle\nright\nend\n',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ seq: 2, status: 'normal' });

    const second = await app.inject({
      method: 'PUT',
      url: `/api/files/${file.artifactId}/content`,
      headers: { cookie, 'content-type': 'text/plain', 'x-artifact-base-seq': '1' },
      payload: 'one\nleft\nmiddle\nright incoming\nend\n',
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ seq: 3, status: 'normal' });
    expect(await versionText(file.artifactId, 3, cookie)).toBe('one\nleft latest\nmiddle\nright incoming\nend\n');
  });

  it('records a true conflict and resolves it by artifact id', async () => {
    const { cookie, userId } = await loginCookie();
    const file = await seedUploadedArtifact({ userId, filename: 'conflict.txt', bytes: 'title\nsame\nend\n' });

    const first = await app.inject({
      method: 'PUT',
      url: `/api/files/${file.artifactId}/content`,
      headers: { cookie, 'content-type': 'text/plain', 'x-artifact-base-seq': '1' },
      payload: 'title\nleft edit\nend\n',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ seq: 2, status: 'normal' });

    const second = await app.inject({
      method: 'PUT',
      url: `/api/files/${file.artifactId}/content`,
      headers: { cookie, 'content-type': 'text/plain', 'x-artifact-base-seq': '1' },
      payload: 'title\nright edit\nend\n',
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ seq: 3, status: 'conflict' });

    const conflict = await app.inject({
      method: 'GET',
      url: `/api/files/${file.artifactId}/conflict`,
      headers: { cookie },
    });
    expect(conflict.statusCode).toBe(200);
    expect(conflict.json()).toMatchObject({
      artifactId: file.artifactId,
      path: file.path,
      kind: 'diff3',
      conflictSeq: 3,
      baseSeq: 1,
      base: { text: 'title\nsame\nend\n' },
      left: { text: 'title\nleft edit\nend\n' },
      right: { text: 'title\nright edit\nend\n' },
    });
    expect(conflict.json().markers).toContain('<<<<<<< latest:2');
    expect(conflict.json().markers).toContain('>>>>>>> incoming');

    const chosen = 'title\nresolved\nend\n';
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/files/${file.artifactId}/resolve`,
      headers: { cookie, 'content-type': 'text/plain', 'x-artifact-base-seq': '3' },
      payload: chosen,
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual({ seq: 4, status: 'normal' });
    expect(await versionText(file.artifactId, 4, cookie)).toBe(chosen);
  });

  it('rejects editing binary artifacts', async () => {
    const { cookie, userId } = await loginCookie();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const file = await seedUploadedArtifact({ userId, filename: 'image.png', bytes: png, mime: 'image/png' });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/files/${file.artifactId}/content`,
      headers: { cookie, 'content-type': 'text/plain', 'x-artifact-base-seq': '1' },
      payload: 'not a png\n',
    });

    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: 'binary_not_editable', mediaKind: 'image' });
  });

  it('enforces manage/read ACLs for edit and conflict detail', async () => {
    const { userId: ownerId } = await loginCookie();
    const { cookie: otherCookie } = await loginCookie(`reader-${randomUUID().slice(0, 8)}`, 'Reader');
    const publicFile = await seedUploadedArtifact({ userId: ownerId, filename: 'owned.txt', bytes: 'owned\n' });

    const deniedEdit = await app.inject({
      method: 'PUT',
      url: `/api/files/${publicFile.artifactId}/content`,
      headers: { cookie: otherCookie, 'content-type': 'text/plain', 'x-artifact-base-seq': '1' },
      payload: 'reader edit\n',
    });
    expect(deniedEdit.statusCode).toBe(403);
    expect(deniedEdit.json()).toEqual({ error: 'forbidden' });

    const bobId = await seedMember(pool, fx.workspaceId, `bob-${randomUUID().slice(0, 8)}`, 'Bob');
    const { channel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: `private-${randomUUID().slice(0, 8)}`,
      actorId: bobId,
      private: true,
    });
    const privateFile = await seedUploadedArtifact({
      userId: bobId,
      channelId: channel.id,
      filename: 'secret.txt',
      bytes: 'secret\n',
    });

    const hiddenConflict = await app.inject({
      method: 'GET',
      url: `/api/files/${privateFile.artifactId}/conflict`,
      headers: { cookie: otherCookie },
    });
    expect([403, 404]).toContain(hiddenConflict.statusCode);
  });

  it('rejects editing tombstoned artifacts', async () => {
    const { cookie, userId } = await loginCookie();
    const file = await seedUploadedArtifact({ userId, filename: 'deleted.txt', bytes: 'live\n' });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/files/${file.artifactId}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(200);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/files/${file.artifactId}/content`,
      headers: { cookie, 'content-type': 'text/plain', 'x-artifact-base-seq': '1' },
      payload: 'after delete\n',
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: 'gone' });
  });
});
