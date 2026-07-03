import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { signSession } from '../src/cookie.js';
import { encodeEventHandle } from '../src/entries.js';
import { createChannel, postMessage } from '../src/events.js';
import { addWorkspaceMember } from '../src/membership.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

const mockedS3 = vi.hoisted(() => {
  class FakeStorage {
    readonly objects = new Map<string, { body: Buffer; contentType: string }>();

    reset(): void {
      this.objects.clear();
    }

    uploadObject = async (key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> => {
      this.objects.set(key, { body: Buffer.from(body), contentType });
    };
  }

  return { storage: new FakeStorage() };
});

vi.mock('../src/s3.js', () => ({
  copyObject: async () => {},
  deleteObject: async () => {},
  downloadObject: async () => {},
  ensureBucket: async () => {},
  getObjectBytes: async (key: string) => {
    const object = mockedS3.storage.objects.get(key);
    if (!object) throw new Error(`missing object: ${key}`);
    return Buffer.from(object.body);
  },
  getObjectStream: async (key: string) => {
    const { Readable } = await import('node:stream');
    const object = mockedS3.storage.objects.get(key);
    if (!object) throw new Error(`missing object: ${key}`);
    return {
      stream: Readable.from([object.body]),
      contentType: object.contentType,
      contentLength: object.body.byteLength,
    };
  },
  headObject: async (key: string) => {
    const object = mockedS3.storage.objects.get(key);
    return object ? { contentLength: object.body.byteLength } : null;
  },
  presignGet: async () => 'https://storage.local/get',
  presignPut: async () => 'https://storage.local/put',
  uploadObject: mockedS3.storage.uploadObject,
  uploadObjectStream: async () => {},
}));

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
  mockedS3.storage.reset();
  await pool.query(
    'TRUNCATE artifact_changes, artifact_sync_state, cas_blobs, artifact_pointers, artifact_versions, artifacts CASCADE',
  );
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({
    pool,
    calls: false,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function authCookie(userId: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO auth_sessions (user_id, expires_at)
     VALUES ($1, now() + interval '30 days')
     RETURNING id`,
    [userId],
  );
  return `${config.sessionCookie}=${signSession(res.rows[0]!.id, config.sessionSecret)}`;
}

async function insertUser(handle: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    'INSERT INTO users (handle, display_name) VALUES ($1, $2) RETURNING id',
    [handle, handle],
  );
  return res.rows[0]!.id;
}

describe('POST /api/entries/:handle/extract', () => {
  it('extracts a chat event into a markdown artifact with ledger metadata', async () => {
    const cookie = await authCookie(fx.userId);
    const sourceMessageId = randomUUID();
    const event = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: '# Release Notes\n\nBody text stays verbatim.',
      clientMsgId: sourceMessageId,
    });
    const handle = encodeEventHandle(event.id);

    const res = await app.inject({
      method: 'POST',
      url: `/api/entries/${handle}/extract`,
      headers: { cookie },
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      artifactId: expect.any(String),
      path: `shared/channels/${fx.channelId}/markup/release-notes-${handle}.md`,
      seq: 1,
      workspaceId: fx.workspaceId,
    });

    const ledger = await pool.query<{
      path: string;
      merge_class: string;
      seq: number;
      author: string;
      kind: string;
      source_message_id: string | null;
      mime: string;
      s3_key: string;
    }>(
      `SELECT a.path,
              a.merge_class,
              v.seq,
              v.author,
              v.kind,
              v.source_message_id,
              b.mime,
              b.s3_key
         FROM artifacts a
         JOIN artifact_versions v ON v.artifact_id = a.id
         JOIN cas_blobs b ON b.sha256 = v.blob_sha
        WHERE a.id = $1`,
      [res.json().artifactId],
    );
    expect(ledger.rows[0]).toMatchObject({
      path: `shared/channels/${fx.channelId}/markup/release-notes-${handle}.md`,
      merge_class: 'mergeable-doc',
      seq: 1,
      author: `human:${fx.userId}`,
      kind: 'created',
      source_message_id: sourceMessageId,
      mime: 'text/markdown',
    });
    const stored = mockedS3.storage.objects.get(ledger.rows[0]!.s3_key);
    expect(stored?.contentType).toBe('text/markdown');
    expect(stored?.body.toString('utf8')).toContain(`source_entry: "${handle}"`);
    expect(stored?.body.toString('utf8')).toContain('source_kind: "message.posted"');
    expect(stored?.body.toString('utf8')).toContain('title: "Release Notes"');
    expect(stored?.body.toString('utf8')).toContain(`extracted_by: "${fx.userId}"`);
    expect(stored?.body.toString('utf8')).toMatch(/extracted_at: "\d{4}-\d{2}-\d{2}T/);
    expect(stored?.body.toString('utf8').endsWith('\n# Release Notes\n\nBody text stays verbatim.')).toBe(true);
  });

  it('makes the extracted markdown readable through the artifact content route', async () => {
    const cookie = await authCookie(fx.userId);
    const event = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: '# Readable Extract\n\nRoute body.',
    });
    const handle = encodeEventHandle(event.id);

    const extract = await app.inject({
      method: 'POST',
      url: `/api/entries/${handle}/extract`,
      headers: { cookie },
      payload: {},
    });
    expect(extract.statusCode).toBe(201);

    const content = await app.inject({
      method: 'GET',
      url: `/api/files/artifact/${extract.json().artifactId}/content?at=1`,
      headers: { cookie },
    });

    expect(content.statusCode).toBe(200);
    expect(content.body).toContain(`source_entry: "${handle}"`);
  });

  it('returns an existing extraction without writing another version', async () => {
    const cookie = await authCookie(fx.userId);
    const event = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: 'Repeatable extraction path',
    });
    const handle = encodeEventHandle(event.id);

    const first = await app.inject({
      method: 'POST',
      url: `/api/entries/${handle}/extract`,
      headers: { cookie },
      payload: {},
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/entries/${handle}/extract`,
      headers: { cookie },
      payload: {},
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    const versions = await pool.query<{ count: string }>(
      'SELECT count(*) FROM artifact_versions WHERE artifact_id = $1',
      [first.json().artifactId],
    );
    expect(Number(versions.rows[0]!.count)).toBe(1);
  });

  it('denies extraction when the user cannot access the source channel', async () => {
    const bobId = await insertUser('extract-bob');
    await addWorkspaceMember(pool, fx.workspaceId, bobId);
    const bobCookie = await authCookie(bobId);
    const { channel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: `private-${randomUUID().slice(0, 8)}`,
      actorId: fx.userId,
      private: true,
    });
    const event = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: channel.id,
      actorId: fx.userId,
      text: 'Private text',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/entries/${encodeEventHandle(event.id)}/extract`,
      headers: { cookie: bobCookie },
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'entry_not_found' });
  });

  it('rejects entries with empty text', async () => {
    const cookie = await authCookie(fx.userId);
    const event = await postMessage(pool, {
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      actorId: fx.userId,
      text: '',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/entries/${encodeEventHandle(event.id)}/extract`,
      headers: { cookie },
      payload: {},
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'empty_entry_text' });
  });
});
