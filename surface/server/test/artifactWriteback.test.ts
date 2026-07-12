import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ArtifactLedger } from '../src/artifact-ledger.js';
import { writeBackArtifact, type ArtifactWritebackStorage } from '../src/artifact-writeback.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

class FakeStorage implements ArtifactWritebackStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async uploadObject(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body: Buffer.from(body), contentType });
  }

  async getObjectBytes(key: string): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`missing object ${key}`);
    return Buffer.from(object.body);
  }
}

let pool: pg.Pool;
let fx: Fixture;
let ledger: ArtifactLedger;
let storage: FakeStorage;
let sessionId: string;

async function seedSession(channelId = fx.channelId): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1, $2, $3, 'writeback-test', 'running', $4) RETURNING id`,
    [fx.workspaceId, channelId, `tk-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

function write(path: string, text: string, baseSeq?: number) {
  return writeBackArtifact({
    pool,
    storage,
    channelId: fx.channelId,
    sessionId,
    path,
    bytes: Buffer.from(text, 'utf8'),
    mime: 'text/markdown',
    author: `human:${fx.userId}`,
    ...(baseSeq == null ? {} : { baseSeq }),
  });
}

function activePath(path: string): string {
  return `shared/channels/${fx.channelId}/${path}`;
}

async function markMergeable(path: string): Promise<void> {
  await pool.query(`UPDATE artifacts SET merge_class = 'mergeable-doc' WHERE workspace_id = $1 AND path = $2`, [
    fx.workspaceId,
    activePath(path),
  ]);
}

async function latestText(path: string): Promise<string> {
  const latest = await ledger.resolveVersion(sessionId, path, { pointer: 'latest' });
  expect(latest?.s3Key).toBeTruthy();
  return (await storage.getObjectBytes(latest!.s3Key!)).toString('utf8');
}

beforeAll(async () => {
  pool = await createTestPool();
  ledger = new ArtifactLedger(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE cas_blobs, artifact_pointers, artifact_versions, artifacts CASCADE');
  await truncateAll(pool);
  fx = await seedFixture(pool);
  sessionId = await seedSession();
  storage = new FakeStorage();
});

describe('writeBackArtifact', () => {
  it('creates the first version without a base seq', async () => {
    const res = await write('report.md', 'hello\n');
    expect(res).toMatchObject({ ok: true, seq: 1, status: 'normal', idempotent: false });
    expect(await latestText('report.md')).toBe('hello\n');
  });

  it('writes v2 against base seq 1', async () => {
    await write('report.md', 'hello\n');
    const res = await write('report.md', 'hello v2\n', 1);
    expect(res).toMatchObject({ ok: true, seq: 2, status: 'normal', idempotent: false });
    expect(await latestText('report.md')).toBe('hello v2\n');
  });

  it('auto-merges a stale write with non-overlapping edits on mergeable docs', async () => {
    await write('report.md', 'one\nleft\nmiddle\nright\nend\n');
    await markMergeable('report.md');
    await write('report.md', 'one\nleft latest\nmiddle\nright\nend\n', 1);

    const res = await write('report.md', 'one\nleft\nmiddle\nright incoming\nend\n', 1);
    expect(res).toMatchObject({ ok: true, seq: 3, status: 'normal', idempotent: false });
    expect(await latestText('report.md')).toBe('one\nleft latest\nmiddle\nright incoming\nend\n');
  });

  it('records a conflict version with diff3 markers and conflict json for same-line edits', async () => {
    await write('report.md', 'title\nsame\nend\n');
    await markMergeable('report.md');
    await write('report.md', 'title\nleft edit\nend\n', 1);

    const res = await write('report.md', 'title\nright edit\nend\n', 1);
    expect(res).toMatchObject({ ok: true, seq: 3, status: 'conflict', idempotent: false });

    const markerText = await latestText('report.md');
    expect(markerText).toContain('<<<<<<< latest:2');
    expect(markerText).toContain('||||||| base:1');
    expect(markerText).toContain('=======');
    expect(markerText).toContain('>>>>>>> incoming');

    const conflict = await pool.query<{ status: string; conflict: Record<string, unknown> }>(
      `SELECT status, conflict
        FROM artifact_versions v
        JOIN artifacts a ON a.id = v.artifact_id
       WHERE a.workspace_id = $1 AND a.path = $2 AND v.seq = 3`,
      [fx.workspaceId, activePath('report.md')],
    );
    expect(conflict.rows[0]!.status).toBe('conflict');
    expect(conflict.rows[0]!.conflict).toMatchObject({
      base_seq: 1,
      left: { seq: 2 },
      right: { author: `human:${fx.userId}` },
    });
  });
});
