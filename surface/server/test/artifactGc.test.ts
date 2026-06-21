import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { ArtifactLedger } from '../src/artifact-ledger.js';
import { sweepUnreferencedBlobs } from '../src/artifact-ledger-gc.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let ledger: ArtifactLedger;
let sessionId: string;

async function seedSession(channelId = fx.channelId): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1, $2, $3, 'artifact-gc-test', 'running', $4) RETURNING id`,
    [fx.workspaceId, channelId, `tk-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

function capture(
  path: string,
  blobSha: string | null,
  kind: 'created' | 'modified' | 'deleted',
) {
  return ledger.commitVersion({
    sessionId,
    channelId: fx.channelId,
    path,
    blobSha,
    sizeBytes: 10,
    mime: 'text/markdown',
    author: `agent:${sessionId}`,
    kind,
  });
}

async function blobExists(sha256: string): Promise<boolean> {
  const res = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM cas_blobs WHERE sha256 = $1)',
    [sha256],
  );
  return res.rows[0]!.exists;
}

async function artifactIdForPath(path: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    'SELECT id FROM artifacts WHERE session_id = $1 AND path = $2',
    [sessionId, path],
  );
  return res.rows[0]!.id;
}

async function blobRefsForPath(path: string): Promise<Array<{ seq: number; sha: string; role: string }>> {
  const artifactId = await artifactIdForPath(path);
  const res = await pool.query<{ seq: number; sha: string; role: string }>(
    `SELECT seq, sha, role
       FROM artifact_blob_refs
      WHERE artifact_id = $1
      ORDER BY seq ASC, role ASC, sha ASC`,
    [artifactId],
  );
  return res.rows;
}

async function rerunBlobRefsMigration(): Promise<void> {
  const sql = await readFile(new URL('../migrations/036_artifact_blob_refs.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

async function setVersionCreatedAt(path: string, seq: number, createdAt: string): Promise<void> {
  await pool.query(
    `UPDATE artifact_versions v
        SET created_at = $3::timestamptz
       FROM artifacts a
      WHERE a.id = v.artifact_id
        AND a.session_id = $1
        AND a.path = $2
        AND v.seq = $4`,
    [sessionId, path, createdAt, seq],
  );
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
});

describe('artifact ledger GC', () => {
  it('sweeps only old unreferenced blobs and deletes their objects', async () => {
    const referencedSha = 'a'.repeat(64);
    const orphanSha = 'b'.repeat(64);
    await capture('report.md', referencedSha, 'created');
    await pool.query(
      `UPDATE cas_blobs
          SET s3_key = $2, created_at = now() - interval '2 hours'
        WHERE sha256 = $1`,
      [referencedSha, `cas/aa/${referencedSha}`],
    );
    await pool.query(
      `INSERT INTO cas_blobs (sha256, s3_key, size_bytes, mime, created_at)
       VALUES ($1, $2, 10, 'text/plain', now() - interval '2 hours')`,
      [orphanSha, `cas/bb/${orphanSha}`],
    );
    const storage = { deleteObject: vi.fn(async (_key: string) => {}) };

    const result = await sweepUnreferencedBlobs(pool, storage, {
      graceMs: 3_600_000,
      limit: 10,
    });

    expect(result).toEqual({ swept: 1, failed: 0 });
    expect(await blobExists(referencedSha)).toBe(true);
    expect(await blobExists(orphanSha)).toBe(false);
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).toHaveBeenCalledWith(`cas/bb/${orphanSha}`);
  });

  it('keeps blobs referenced only by conflict jsonb sides while sweeping true orphans', async () => {
    const baseSha = 'e'.repeat(64);
    const markerSha = 'f'.repeat(64);
    const incomingSha = '1'.repeat(64);
    const orphanSha = '2'.repeat(64);

    await capture('conflict.md', baseSha, 'created');
    await ledger.commitVersion({
      sessionId,
      channelId: fx.channelId,
      path: 'conflict.md',
      blobSha: markerSha,
      sizeBytes: 10,
      mime: 'text/markdown',
      author: `agent:${sessionId}`,
      kind: 'modified',
      status: 'conflict',
      conflict: {
        base_seq: 1,
        left: { seq: 1, author: `agent:${sessionId}`, sha: baseSha },
        right: { author: `human:${fx.userId}`, sha: incomingSha },
      },
    });
    await pool.query(
      `INSERT INTO cas_blobs (sha256, s3_key, size_bytes, mime, created_at)
       VALUES
         ($1, $2, 10, 'text/plain', now() - interval '2 hours'),
         ($3, $4, 10, 'text/plain', now() - interval '2 hours')`,
      [incomingSha, `cas/11/${incomingSha}`, orphanSha, `cas/22/${orphanSha}`],
    );
    const versionRefs = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM artifact_versions WHERE blob_sha = $1',
      [incomingSha],
    );
    expect(versionRefs.rows[0]!.n).toBe(0);
    const storage = { deleteObject: vi.fn(async (_key: string) => {}) };

    const result = await sweepUnreferencedBlobs(pool, storage, {
      graceMs: 0,
      limit: 10,
    });

    expect(result).toEqual({ swept: 1, failed: 0 });
    expect(await blobExists(incomingSha)).toBe(true);
    expect(await blobExists(orphanSha)).toBe(false);
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).toHaveBeenCalledWith(`cas/22/${orphanSha}`);
  });

  it('records artifact_blob_refs via trigger and backfills existing conflict refs', async () => {
    const baseSha = '3'.repeat(64);
    const markerSha = '4'.repeat(64);
    const incomingSha = '5'.repeat(64);
    const nestedSha = '6'.repeat(64);

    await capture('refs.md', baseSha, 'created');
    await ledger.commitVersion({
      sessionId,
      channelId: fx.channelId,
      path: 'refs.md',
      blobSha: markerSha,
      sizeBytes: 10,
      mime: 'text/markdown',
      author: `agent:${sessionId}`,
      kind: 'modified',
      status: 'conflict',
      conflict: {
        base_seq: 1,
        left: { seq: 1, author: `agent:${sessionId}`, sha: baseSha },
        right: { author: `human:${fx.userId}`, sha: incomingSha },
        nested: { sides: [{ sha: nestedSha }, { sha: incomingSha }, { sha: null }] },
      },
    });

    expect(await blobRefsForPath('refs.md')).toEqual([
      { seq: 1, sha: baseSha, role: 'version' },
      { seq: 2, sha: baseSha, role: 'conflict' },
      { seq: 2, sha: incomingSha, role: 'conflict' },
      { seq: 2, sha: nestedSha, role: 'conflict' },
      { seq: 2, sha: markerSha, role: 'version' },
    ]);

    const artifactId = await artifactIdForPath('refs.md');
    await pool.query('DELETE FROM artifact_blob_refs WHERE artifact_id = $1', [artifactId]);

    await rerunBlobRefsMigration();

    expect(await blobRefsForPath('refs.md')).toEqual([
      { seq: 1, sha: baseSha, role: 'version' },
      { seq: 2, sha: baseSha, role: 'conflict' },
      { seq: 2, sha: incomingSha, role: 'conflict' },
      { seq: 2, sha: nestedSha, role: 'conflict' },
      { seq: 2, sha: markerSha, role: 'version' },
    ]);
  });

  it('keeps sweeping when one row fails', async () => {
    const failSha = 'c'.repeat(64);
    const okSha = 'd'.repeat(64);
    await pool.query(
      `INSERT INTO cas_blobs (sha256, s3_key, size_bytes, mime, created_at)
       VALUES
         ($1, 'cas/cc/fail', 10, 'text/plain', now() - interval '3 hours'),
         ($2, 'cas/dd/ok', 10, 'text/plain', now() - interval '2 hours')`,
      [failSha, okSha],
    );
    const storage = {
      deleteObject: vi.fn(async (key: string) => {
        if (key === 'cas/cc/fail') throw new Error('delete failed');
      }),
    };

    const result = await sweepUnreferencedBlobs(pool, storage, {
      graceMs: 3_600_000,
      limit: 10,
    });

    expect(result).toEqual({ swept: 1, failed: 1 });
    expect(await blobExists(failSha)).toBe(true);
    expect(await blobExists(okSha)).toBe(false);
    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
  });

  it('returns the latest changed version per path since a watermark', async () => {
    await capture('old.md', '0'.repeat(64), 'created');
    await setVersionCreatedAt('old.md', 1, '2026-01-01T00:00:00.000Z');

    await capture('report.md', '1'.repeat(64), 'created');
    await setVersionCreatedAt('report.md', 1, '2026-01-02T00:00:00.000Z');
    await capture('report.md', '2'.repeat(64), 'modified');
    await setVersionCreatedAt('report.md', 2, '2026-01-04T00:00:00.000Z');

    await capture('chart.md', '3'.repeat(64), 'created');
    await setVersionCreatedAt('chart.md', 1, '2026-01-03T00:00:00.000Z');

    const rows = await ledger.changedSince(sessionId, '2026-01-01T12:00:00.000Z');

    expect(rows).toEqual([
      { path: 'chart.md', seq: 1, sha: '3'.repeat(64), kind: 'created' },
      { path: 'report.md', seq: 2, sha: '2'.repeat(64), kind: 'modified' },
    ]);
  });
});
