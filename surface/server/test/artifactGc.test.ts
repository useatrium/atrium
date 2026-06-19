import { randomUUID } from 'node:crypto';
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
