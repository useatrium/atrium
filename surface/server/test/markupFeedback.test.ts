import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { ArtifactLedger, casBlobKey } from '../src/artifact-ledger.js';
import {
  composeFeedbackSteer,
  deriveFeedbackIntent,
  hasCriticMarkup,
  stripYamlFrontmatter,
} from '../src/markup-feedback.js';
import { createChannel } from '../src/events.js';
import { classifyMedia } from '../src/media-classifier.js';
import { addWorkspaceMember } from '../src/membership.js';
import { parseMarkupSteer } from '../../shared/src/criticmarkup.js';
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

interface CentaurRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;
let ledger: ArtifactLedger;
let centaurRequests: CentaurRequest[];

beforeAll(async () => {
  pool = await createTestPool();
  ledger = new ArtifactLedger(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  centaurRequests = [];
  vi.stubGlobal('fetch', fakeCentaurFetch());
  mockedS3.storage.reset();
  await pool.query(
    'TRUNCATE artifact_changes, artifact_sync_state, cas_blobs, artifact_pointers, artifact_versions, artifacts CASCADE',
  );
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({
    pool,
    sessionRuns: { baseUrl: 'http://centaur.test', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
});

function fakeCentaurFetch(): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const parsed = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    centaurRequests.push({ method: init?.method ?? 'GET', path: parsed.pathname, body });
    if (parsed.pathname.endsWith('/execute')) {
      return Response.json({ execution_id: `exe-${centaurRequests.length}` });
    }
    if (parsed.pathname.endsWith('/messages')) {
      return Response.json({ ok: true });
    }
    if (parsed.pathname.endsWith('/events')) {
      return new Response('', { status: 200 });
    }
    return Response.json({ thread_key: parsed.pathname.split('/').at(-1), assignment_generation: 1 });
  }) as typeof fetch;
}

async function loginCookie(handle = `user-${randomUUID().slice(0, 8)}`): Promise<{ cookie: string; userId: string }> {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { handle, displayName: handle },
  });
  expect(login.statusCode).toBe(200);
  const userId = login.json().user.id;
  await addWorkspaceMember(pool, fx.workspaceId, userId);
  return { cookie: login.headers['set-cookie'] as string, userId };
}

async function seedRunningSession(userId: string, channelId = fx.channelId): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO sessions (
       workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
       driver_id, current_execution_id, assignment_generation
     )
     VALUES ($1, $2, $3, 'claude-code', 'feedback target', 'running', $4, $4, 'exe-old', 1)
     RETURNING id`,
    [fx.workspaceId, channelId, `thread-${randomUUID()}`, userId],
  );
  return inserted.rows[0]!.id;
}

async function seedArtifact(params: {
  userId: string;
  bytes: string;
  filename?: string;
  channelId?: string;
  sourceMessageId?: string;
}): Promise<{ artifactId: string; seq: number; path: string }> {
  const body = Buffer.from(params.bytes, 'utf8');
  const mime = 'text/markdown';
  const channelId = params.channelId ?? fx.channelId;
  const filename = params.filename ?? `feedback-${randomUUID()}.md`;
  const path = `shared/channels/${channelId}/uploads/${filename}`;
  const sha = createHash('sha256').update(body).digest('hex');
  const key = casBlobKey(sha);
  const classification = classifyMedia(body, { declaredMime: mime, filename });
  mockedS3.storage.objects.set(key, { body, contentType: mime });
  await pool.query(
    `INSERT INTO cas_blobs
       (sha256, s3_key, size_bytes, mime, detected_mime, media_kind, is_text, text_encoding, classification_meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
    sourceMessageId: params.sourceMessageId,
  });
  return { artifactId: committed.artifactId, seq: committed.seq, path };
}

async function versionText(artifactId: string, seq: number): Promise<string> {
  const version = await ledger.resolveVersionByArtifactId(artifactId, { seq });
  expect(version?.s3Key).toBeTruthy();
  return (await mockedS3.storage.getObjectBytes(version!.s3Key!)).toString('utf8');
}

function lastSteerText(): string {
  const message = centaurRequests.find((request) => request.path.endsWith('/messages'));
  expect(message).toBeTruthy();
  const messages = message!.body.messages as Array<{ parts: Array<{ type?: string; text: string }> }>;
  return messages[0]!.parts.find((part) => part.type === 'text')!.text;
}

describe('composeFeedbackSteer', () => {
  it('includes small marked-up response docs inline and strips frontmatter', () => {
    const text = composeFeedbackSteer({
      markedUpContent: '---\ntitle: Draft\n---\nHello {++there++}\n',
      baseContent: '',
      path: 'message.md',
      seq: 2,
      baseSeq: 1,
      intent: 'response',
      title: 'Draft',
      sourceEntryHandle: 'ent_123',
      note: 'Please keep this terse.',
    });

    expect(text).toContain('I marked up your message ("Draft", entry ent_123)');
    expect(text).toContain('```markdown\nHello {++there++}\n```');
    expect(text).not.toContain('title: Draft');
    expect(text).toContain('Note from me: Please keep this terse.');
  });

  it('extracts large marked-up hunks, preserves multiline spans, merges adjacent hunks, and escalates fences', () => {
    const lines = Array.from({ length: 1200 }, (_, index) => `line ${index}`);
    lines[10] = 'opening {--remove';
    lines[11] = 'still removed';
    lines[12] = 'done--}';
    lines[15] = 'nearby {++add++}';
    lines[350] = 'far {>>why?<<}';
    lines[352] = '```';
    const text = composeFeedbackSteer({
      markedUpContent: lines.join('\n'),
      baseContent: '',
      path: 'shared/report.md',
      seq: 5,
      baseSeq: 4,
      intent: 'revise',
      title: 'report.md',
      status: 'conflict',
    });

    expect(text).toContain('````markdown');
    expect(text).toContain('opening {--remove\nstill removed\ndone--}');
    expect(text).toContain('nearby {++add++}');
    expect(text).toContain('\n⋯\n');
    expect(text).toContain('far {>>why?<<}');
    expect(text).not.toContain('line 200');
    expect(text).toContain('Full document: shared/report.md');
    expect(text).toContain('save recorded a conflict');
  });

  it('derives response intent only from base frontmatter source_entry', () => {
    expect(deriveFeedbackIntent('---\nsource_entry: abc\n---\nBody\n')).toBe('response');
    expect(deriveFeedbackIntent('No frontmatter\nsource_entry: abc\n')).toBe('revise');
    expect(stripYamlFrontmatter('---\na: b\n...\nBody\n')).toBe('Body\n');
    expect(hasCriticMarkup('Clean text')).toBe(false);
    expect(hasCriticMarkup('Please {~~swap~>replace~~} this')).toBe(true);
  });

  it('round-trips composed steers through the shared parser', () => {
    const smallResponse = composeFeedbackSteer({
      markedUpContent: 'Hello {++there++}\n',
      baseContent: '',
      path: 'message.md',
      seq: 2,
      baseSeq: 1,
      intent: 'response',
      title: 'Draft answer',
      sourceEntryHandle: 'rec_abc',
    });
    expect(parseMarkupSteer(smallResponse)).toMatchObject({
      intent: 'response',
      title: 'Draft answer',
      sourceEntryHandle: 'rec_abc',
      path: null,
      doc: 'Hello {++there++}',
      truncated: false,
      note: null,
      conflict: false,
    });

    const longLines = Array.from({ length: 900 }, (_, index) => `line ${index}`);
    longLines[100] = 'replace {~~old~>new~~} here';
    const hunkRevise = composeFeedbackSteer({
      markedUpContent: longLines.join('\n'),
      baseContent: '',
      path: 'shared/report.md',
      seq: 4,
      baseSeq: 3,
      intent: 'revise',
      title: 'report.md',
    });
    const parsedHunk = parseMarkupSteer(hunkRevise);
    expect(parsedHunk).toMatchObject({
      intent: 'revise',
      path: 'shared/report.md',
      truncated: true,
      note: null,
      conflict: false,
    });
    expect(parsedHunk?.doc).toContain('{~~old~>new~~}');
    expect(parsedHunk?.doc).not.toContain('line 400');

    const notedConflict = composeFeedbackSteer({
      markedUpContent: 'Needs {++work++}\n',
      baseContent: '',
      path: 'shared/conflict.md',
      seq: 8,
      baseSeq: 7,
      intent: 'revise',
      title: 'conflict.md',
      note: 'Keep the heading.',
      status: 'conflict',
    });
    expect(parseMarkupSteer(notedConflict)).toMatchObject({
      intent: 'revise',
      path: 'shared/conflict.md',
      doc: 'Needs {++work++}',
      note: 'Keep the heading.',
      conflict: true,
    });

    const withAppendix =
      smallResponse +
      '\n\n---\nReferenced entries:\n- /e/evt_12 (Alice, message): "Context the agent cannot fetch by URL"';
    expect(parseMarkupSteer(withAppendix)).toMatchObject({
      intent: 'response',
      title: 'Draft answer',
      sourceEntryHandle: 'rec_abc',
      doc: 'Hello {++there++}',
    });
  });
});

describe('POST /api/files/:artifactId/feedback', () => {
  it('commits the marked-up version and steers the session', async () => {
    const { cookie, userId } = await loginCookie();
    const sessionId = await seedRunningSession(userId);
    const file = await seedArtifact({ userId, bytes: '# Draft\n\nOriginal\n' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/files/${file.artifactId}/feedback`,
      headers: { cookie },
      payload: {
        content: '# Draft\n\n{~~Original~>Revised~~}\n',
        baseSeq: file.seq,
        sessionId,
        intent: 'revise',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ seq: 2, status: 'normal', steered: true });
    expect(await versionText(file.artifactId, 2)).toBe('# Draft\n\n{~~Original~>Revised~~}\n');
    expect(lastSteerText()).toContain('I marked up `shared/channels/');
    expect(lastSteerText()).toContain('{~~Original~>Revised~~}');
    expect(centaurRequests.some((request) => request.path.endsWith('/execute'))).toBe(true);
  });

  it('apply mode steers from the latest marked-up version without committing', async () => {
    const { cookie, userId } = await loginCookie();
    const sessionId = await seedRunningSession(userId);
    const file = await seedArtifact({
      userId,
      bytes: '# Draft\n\nPlease {~~Original~>Revised~~} this.\n',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/files/${file.artifactId}/feedback`,
      headers: { cookie },
      payload: {
        mode: 'apply',
        sessionId,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ seq: 1, status: 'normal', steered: true, applied: true });
    expect(await versionText(file.artifactId, 1)).toBe('# Draft\n\nPlease {~~Original~>Revised~~} this.\n');
    expect(await ledger.resolveVersionByArtifactId(file.artifactId, { seq: 2 })).toBeNull();
    expect(lastSteerText()).toContain('I marked up `shared/channels/');
    expect(lastSteerText()).toContain('The file in your workspace already has my markup');
    expect(lastSteerText()).toContain('{~~Original~>Revised~~}');
    expect(centaurRequests.some((request) => request.path.endsWith('/execute'))).toBe(true);
  });

  it('apply mode rejects clean latest content without steering', async () => {
    const { cookie, userId } = await loginCookie();
    const sessionId = await seedRunningSession(userId);
    const file = await seedArtifact({ userId, bytes: '# Draft\n\nNothing to apply.\n' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/files/${file.artifactId}/feedback`,
      headers: { cookie },
      payload: {
        mode: 'apply',
        sessionId,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('no_markup');
    expect(await ledger.resolveVersionByArtifactId(file.artifactId, { seq: 2 })).toBeNull();
    expect(centaurRequests.some((request) => request.path.endsWith('/messages'))).toBe(false);
  });

  it('returns 409 on hard stale_base and does not steer', async () => {
    const { cookie, userId } = await loginCookie();
    const sessionId = await seedRunningSession(userId);
    const file = await seedArtifact({ userId, bytes: 'base\n' });
    await pool.query("UPDATE artifacts SET merge_class = 'immutable-data' WHERE id = $1", [file.artifactId]);
    const first = await app.inject({
      method: 'PUT',
      url: `/api/files/${file.artifactId}/content`,
      headers: { cookie, 'content-type': 'text/markdown', 'x-artifact-base-seq': '1' },
      payload: 'newer\n',
    });
    expect(first.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: `/api/files/${file.artifactId}/feedback`,
      headers: { cookie },
      payload: { content: 'stale {++markup++}\n', baseSeq: 1, sessionId, intent: 'revise' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('stale_base');
    expect(centaurRequests.some((request) => request.path.endsWith('/messages'))).toBe(false);
  });

  it('derives response intent from base frontmatter', async () => {
    const { cookie, userId } = await loginCookie();
    const sessionId = await seedRunningSession(userId);
    const file = await seedArtifact({
      userId,
      bytes: '---\ntitle: Agent reply\nsource_entry: rec_456\n---\nOriginal answer\n',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/files/${file.artifactId}/feedback`,
      headers: { cookie },
      payload: { content: 'Original {>>question<<}\n', baseSeq: file.seq, sessionId },
    });

    expect(res.statusCode).toBe(200);
    expect(lastSteerText()).toContain('I marked up your message ("Agent reply", entry rec_456)');
    expect(lastSteerText()).toContain('not a request to edit a file');
  });

  it('denies users without artifact access', async () => {
    const { cookie, userId } = await loginCookie();
    const sessionId = await seedRunningSession(userId);
    const ownerId = await seedMember(pool, fx.workspaceId, `owner-${randomUUID().slice(0, 8)}`, 'Owner');
    const { channel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: `private-${randomUUID().slice(0, 8)}`,
      actorId: ownerId,
      private: true,
    });
    const file = await seedArtifact({ userId: ownerId, channelId: channel.id, bytes: 'secret\n' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/files/${file.artifactId}/feedback`,
      headers: { cookie },
      payload: { content: 'secret {++x++}\n', baseSeq: file.seq, sessionId, intent: 'revise' },
    });

    expect(res.statusCode).toBe(404);
    expect(centaurRequests.some((request) => request.path.endsWith('/messages'))).toBe(false);
  });

  it('denies users without session access', async () => {
    const { cookie, userId } = await loginCookie();
    const ownerId = await seedMember(pool, fx.workspaceId, `owner-${randomUUID().slice(0, 8)}`, 'Owner');
    const { channel } = await createChannel(pool, {
      workspaceId: fx.workspaceId,
      name: `session-private-${randomUUID().slice(0, 8)}`,
      actorId: ownerId,
      private: true,
    });
    const sessionId = await seedRunningSession(ownerId, channel.id);
    const file = await seedArtifact({ userId, bytes: 'visible\n' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/files/${file.artifactId}/feedback`,
      headers: { cookie },
      payload: { content: 'visible {++x++}\n', baseSeq: file.seq, sessionId, intent: 'revise' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('session_not_found');
    expect(centaurRequests.some((request) => request.path.endsWith('/messages'))).toBe(false);
  });
});
