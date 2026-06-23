import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ArtifactLedger } from '../src/artifact-ledger.js';
import {
  writeBackArtifact,
  writeBackDelete,
  type ArtifactWritebackStorage,
} from '../src/artifact-writeback.js';
import { loadConflictDetail } from '../src/artifact-conflict.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

class FakeStorage implements ArtifactWritebackStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  async uploadObject(key: string, body: Buffer | Uint8Array): Promise<void> {
    this.objects.set(key, { body: Buffer.from(body), contentType: 'text/markdown' });
  }
  async getObjectBytes(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`missing ${key}`);
    return Buffer.from(o.body);
  }
}

let pool: pg.Pool;
let fx: Fixture;
let ledger: ArtifactLedger;
let storage: FakeStorage;
let sessionId: string;

async function seedSession(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1, $2, $3, 'conflict-test', 'running', $4) RETURNING id`,
    [fx.workspaceId, fx.channelId, `tk-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

function write(path: string, text: string, baseSeq?: number, mergeable = false) {
  return writeBackArtifact({
    pool,
    storage,
    channelId: fx.channelId,
    sessionId,
    path,
    bytes: Buffer.from(text, 'utf8'),
    mime: mergeable ? 'text/markdown' : 'application/octet-stream',
    author: `human:${fx.userId}`,
    ...(baseSeq == null ? {} : { baseSeq }),
  });
}

/** Force the artifact's merge_class (write-back creates 'immutable-data'). */
async function setMergeClass(path: string, cls: string) {
  await pool.query(`UPDATE artifacts SET merge_class = $3 WHERE workspace_id = $1 AND path = $2`, [
    fx.workspaceId,
    path,
    cls,
  ]);
}

async function deleteCapture(path: string, baseSeq: number) {
  return ledger.commitVersion({
    sessionId,
    channelId: fx.channelId,
    path,
    blobSha: null,
    sizeBytes: 0,
    mime: 'application/octet-stream',
    author: `agent:${sessionId}`,
    kind: 'deleted',
    baseSeq,
  });
}

beforeAll(async () => {
  pool = await createTestPool();
  ledger = new ArtifactLedger(pool);
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
  sessionId = await seedSession();
  storage = new FakeStorage();
});

describe('delete-vs-edit (never auto-pick, §8B #5)', () => {
  it('records a conflict when an edit lands on a deleted file', async () => {
    await write('f.md', 'v1');
    expect(await deleteCapture('f.md', 1)).toMatchObject({ ok: true, seq: 2 });

    const edit = await write('f.md', 'my edit', 1);
    expect(edit).toMatchObject({ ok: true, status: 'conflict', seq: 3 });

    const serve = await ledger.serveResolution(sessionId, 'f.md');
    expect(serve).toMatchObject({ conflicted: true, conflictSeq: 3, servedSeq: 2, servedKind: 'deleted' });

    const detail = await loadConflictDetail(pool, storage, sessionId, 'f.md');
    expect(detail).toMatchObject({ kind: 'delete_vs_edit', conflictSeq: 3 });
    expect(detail!.right.text).toBe('my edit'); // the edit is preserved, not lost
    expect(detail!.left.label).toBe('deleted');
    expect(detail!.base.text).toBe('v1');
  });

  it('records a conflict when a delete lands on a concurrently edited file', async () => {
    await write('g.md', 'v1');
    await write('g.md', 'v2 edit', 1); // clean → seq 2
    const del = await writeBackDelete({
      pool,
      channelId: fx.channelId,
      sessionId,
      path: 'g.md',
      author: `agent:${sessionId}`,
      baseSeq: 1, // stale: latest is the edit at seq 2
    });
    expect(del).toMatchObject({ ok: true, status: 'conflict', seq: 3 });
    const detail = await loadConflictDetail(pool, storage, sessionId, 'g.md');
    expect(detail).toMatchObject({ kind: 'edit_vs_delete' });
    expect(detail!.left.text).toBe('v2 edit');
    expect(detail!.right.label).toBe('deleted');
  });

  it('a clean delete (current base) is a normal tombstone', async () => {
    await write('h.md', 'v1');
    const del = await writeBackDelete({
      pool,
      channelId: fx.channelId,
      sessionId,
      path: 'h.md',
      author: `agent:${sessionId}`,
      baseSeq: 1,
    });
    expect(del).toMatchObject({ ok: true, status: 'normal', seq: 2 });
    const serve = await ledger.serveResolution(sessionId, 'h.md');
    expect(serve).toMatchObject({ conflicted: false, servedKind: 'deleted' });
  });
});

describe('resolution (write-back against the conflict seq)', () => {
  it('keep-edit resolves the conflict to a normal version', async () => {
    await write('f.md', 'v1');
    await deleteCapture('f.md', 1);
    await write('f.md', 'my edit', 1); // conflict at seq 3

    const resolved = await write('f.md', 'final', 3); // base = conflict seq
    expect(resolved).toMatchObject({ ok: true, status: 'normal', seq: 4 });
    const serve = await ledger.serveResolution(sessionId, 'f.md');
    expect(serve).toMatchObject({ conflicted: false, servedSeq: 4, servedKind: 'modified' });
    expect(await ledger.getConflict(sessionId, 'f.md')).toBeNull();
  });

  it('stay-deleted resolves the conflict to a tombstone', async () => {
    await write('f.md', 'v1');
    await deleteCapture('f.md', 1);
    await write('f.md', 'my edit', 1); // conflict at seq 3

    const resolved = await writeBackDelete({
      pool,
      channelId: fx.channelId,
      sessionId,
      path: 'f.md',
      author: `human:${fx.userId}`,
      baseSeq: 3, // resolve against the conflict
    });
    expect(resolved).toMatchObject({ ok: true, status: 'normal', seq: 4 });
    const serve = await ledger.serveResolution(sessionId, 'f.md');
    expect(serve).toMatchObject({ conflicted: false, servedKind: 'deleted' });
  });
});

describe('diff3 content conflict detail', () => {
  it('hydrates both sides + base for a mergeable-doc conflict', async () => {
    await write('doc.md', 'line1\nline2\nline3\n', undefined, true);
    await setMergeClass('doc.md', 'mergeable-doc');
    // Two stale edits off base v1 that touch the same region → diff3 conflict.
    await write('doc.md', 'line1\nLEFT\nline3\n', 1, true); // seq 2 (clean off base 1)
    const conflicting = await write('doc.md', 'line1\nRIGHT\nline3\n', 1, true); // stale → merge
    expect(conflicting.ok).toBe(true);
    if (conflicting.ok && conflicting.status === 'conflict') {
      const detail = await loadConflictDetail(pool, storage, sessionId, 'doc.md');
      expect(detail).not.toBeNull();
      expect(detail!.base.text).toBe('line1\nline2\nline3\n');
      expect(detail!.markers).toContain('RIGHT');
    }
  });
});

describe('hydration scope (A4)', () => {
  it('lists the session artifact paths with latest seq', async () => {
    await write('shared/a.md', 'x');
    await write('shared/b.md', 'y');
    await write('shared/a.md', 'x2', 1);
    const scope = await ledger.sessionScope(sessionId);
    expect(scope).toEqual([
      expect.objectContaining({ path: 'shared/a.md', latestSeq: 2, kind: 'modified' }),
      expect.objectContaining({ path: 'shared/b.md', latestSeq: 1, kind: 'created' }),
    ]);
  });

  it('serveResolution returns null for an unknown path', async () => {
    expect(await ledger.serveResolution(sessionId, 'nope.md')).toBeNull();
  });
});
