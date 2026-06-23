import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ArtifactLedger, type CommitVersionGroupFile } from '../src/artifact-ledger.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let ledger: ArtifactLedger;
let sessionId: string;

async function seedSession(channelId = fx.channelId): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1, $2, $3, 'commit-group-test', 'running', $4) RETURNING id`,
    [fx.workspaceId, channelId, `tk-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

function group(files: CommitVersionGroupFile[], groupId = `group-${randomUUID()}`) {
  return ledger.commitVersionGroup({
    sessionId,
    channelId: fx.channelId,
    groupId,
    author: `node:${sessionId}`,
    files,
  });
}

function file(
  path: string,
  sha: string | null,
  kind: 'created' | 'modified' | 'deleted' = sha == null ? 'deleted' : 'modified',
  baseSeq: number | null = null,
): CommitVersionGroupFile {
  return {
    path,
    blobSha: sha,
    sizeBytes: sha == null ? 0 : 10,
    mime: 'text/markdown',
    baseSeq,
    kind,
  };
}

async function versionCount(): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM artifact_versions v
       JOIN artifacts a ON a.id = v.artifact_id
      WHERE a.workspace_id = $1`,
    [fx.workspaceId],
  );
  return r.rows[0]!.n;
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
    'TRUNCATE artifact_commit_groups, artifact_changes, artifact_sync_state, cas_blobs, artifact_pointers, artifact_versions, artifacts CASCADE',
  );
  await truncateAll(pool);
  fx = await seedFixture(pool);
  sessionId = await seedSession();
});

describe('ArtifactLedger commitVersionGroup', () => {
  it('commits an N-file manifest as one version set', async () => {
    const result = await group([
      file('a.md', 'a'.repeat(64), 'created'),
      file('b.md', 'b'.repeat(64), 'created'),
    ], 'happy-group');

    expect(result).toEqual({
      ok: true,
      group_id: 'happy-group',
      results: [
        { path: 'a.md', seq: 1 },
        { path: 'b.md', seq: 1 },
      ],
    });
    await expect(ledger.resolveVersion(sessionId, 'a.md', { pointer: 'latest' })).resolves.toMatchObject({
      seq: 1,
      blobSha: 'a'.repeat(64),
    });
    await expect(ledger.resolveVersion(sessionId, 'b.md', { pointer: 'latest' })).resolves.toMatchObject({
      seq: 1,
      blobSha: 'b'.repeat(64),
    });
    expect(await versionCount()).toBe(2);
  });

  it('aborts the whole group when one file has a stale base', async () => {
    await group([
      file('a.md', 'a'.repeat(64), 'created'),
      file('b.md', 'b'.repeat(64), 'created'),
    ], 'seed-group');
    await ledger.commitVersion({
      sessionId,
      channelId: fx.channelId,
      path: 'a.md',
      blobSha: 'c'.repeat(64),
      sizeBytes: 10,
      mime: 'text/markdown',
      author: `agent:${sessionId}`,
      kind: 'modified',
      baseSeq: 1,
    });
    const before = await versionCount();

    const stale = await group([
      file('a.md', 'd'.repeat(64), 'modified', 1),
      file('b.md', 'e'.repeat(64), 'modified', 1),
      file('c.md', 'f'.repeat(64), 'created'),
    ], 'stale-group');

    expect(stale).toEqual({
      ok: false,
      reason: 'stale_base',
      stale: [{ path: 'a.md', latest_seq: 2, base_seq: 1 }],
    });
    expect(await versionCount()).toBe(before);
    await expect(ledger.resolveVersion(sessionId, 'b.md', { pointer: 'latest' })).resolves.toMatchObject({
      seq: 1,
      blobSha: 'b'.repeat(64),
    });
    await expect(ledger.resolveVersion(sessionId, 'c.md', { pointer: 'latest' })).resolves.toBeNull();
    const groups = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM artifact_commit_groups WHERE group_id = 'stale-group'`,
    );
    expect(groups.rows[0]!.n).toBe(0);
  });

  it('replays an already committed group_id without double-applying', async () => {
    const files = [
      file('a.md', 'a'.repeat(64), 'created'),
      file('b.md', 'b'.repeat(64), 'created'),
    ];
    const first = await group(files, 'replay-group');
    const before = await versionCount();

    const replay = await group([
      file('a.md', 'c'.repeat(64), 'modified'),
      file('b.md', 'd'.repeat(64), 'modified'),
    ], 'replay-group');

    expect(replay).toEqual(first);
    expect(await versionCount()).toBe(before);
    const changes = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM artifact_changes WHERE group_id = 'replay-group'`,
    );
    expect(changes.rows[0]!.n).toBe(2);
  });

  it('dedups per-file content inside a group', async () => {
    await group([file('a.md', 'a'.repeat(64), 'created')], 'dedup-seed');
    const before = await versionCount();

    const result = await group([
      file('a.md', 'a'.repeat(64), 'modified', 1),
      file('b.md', 'b'.repeat(64), 'created'),
    ], 'dedup-group');

    expect(result).toEqual({
      ok: true,
      group_id: 'dedup-group',
      results: [
        { path: 'a.md', seq: 1 },
        { path: 'b.md', seq: 1 },
      ],
    });
    expect(await versionCount()).toBe(before + 1);
    const dedupChanges = await pool.query<{ path: string }>(
      `SELECT path FROM artifact_changes WHERE group_id = 'dedup-group' ORDER BY path`,
    );
    expect(dedupChanges.rows.map((r) => r.path)).toEqual(['b.md']);
  });

  it('emits gap-free change rows carrying the group_id', async () => {
    await group([
      file('a.md', 'a'.repeat(64), 'created'),
      file('b.md', 'b'.repeat(64), 'created'),
      file('c.md', 'c'.repeat(64), 'created'),
    ], 'feed-group');

    const rows = await pool.query<{ id: number; xid: string; path: string; group_id: string | null }>(
      `SELECT id, xid::text AS xid, path, group_id
         FROM artifact_changes
        WHERE session_id = $1
        ORDER BY xid, id`,
      [sessionId],
    );
    expect(rows.rows.map((r) => r.path)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(rows.rows.map((r) => r.group_id)).toEqual(['feed-group', 'feed-group', 'feed-group']);
    const firstId = rows.rows[0]!.id;
    expect(rows.rows.map((r) => r.id)).toEqual([firstId, firstId + 1, firstId + 2]);
    expect(new Set(rows.rows.map((r) => r.xid)).size).toBe(1);
  });
});
