import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ArtifactLedger, CHANGE_CURSOR_ZERO } from '../src/artifact-ledger.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let ledger: ArtifactLedger;
let sessionId: string;

async function seedSession(channelId = fx.channelId): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1, $2, $3, 'changefeed-test', 'running', $4) RETURNING id`,
    [fx.workspaceId, channelId, `tk-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

function capture(path: string, sha: string, kind: 'created' | 'modified' | 'deleted') {
  return ledger.commitVersion({
    sessionId,
    channelId: fx.channelId,
    path,
    blobSha: kind === 'deleted' ? null : sha,
    sizeBytes: 10,
    mime: 'text/markdown',
    author: `agent:${sessionId}`,
    kind,
  });
}

async function artifactIdFor(path: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM artifacts WHERE workspace_id = $1 AND path = $2`,
    [fx.workspaceId, path],
  );
  return r.rows[0]!.id;
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
});

describe('artifact change-feed', () => {
  it('emits one row per commit, in order, with the right fields', async () => {
    await capture('shared/a.md', 'a'.repeat(64), 'created');
    await capture('shared/a.md', 'b'.repeat(64), 'modified');
    await capture('shared/b.md', 'c'.repeat(64), 'created');

    const page = await ledger.changesSince(sessionId);
    expect(page.rows.map((r) => [r.path, r.seq, r.kind])).toEqual([
      ['shared/a.md', 1, 'created'],
      ['shared/a.md', 2, 'modified'],
      ['shared/b.md', 1, 'created'],
    ]);
    expect(page.rows[0]).toMatchObject({
      sha: 'a'.repeat(64),
      status: 'normal',
      author: `agent:${sessionId}`,
      origin: 'agent',
      baseSeq: null,
    });
    expect(page.rows[1]).toMatchObject({ baseSeq: 1 });
  });

  it('resumes from a cursor without re-delivering', async () => {
    await capture('shared/a.md', 'a'.repeat(64), 'created');
    const first = await ledger.changesSince(sessionId);
    expect(first.rows).toHaveLength(1);

    await capture('shared/a.md', 'b'.repeat(64), 'modified');
    const second = await ledger.changesSince(sessionId, first.nextCursor);
    expect(second.rows.map((r) => r.seq)).toEqual([2]);

    // Empty poll keeps the cursor stable.
    const third = await ledger.changesSince(sessionId, second.nextCursor);
    expect(third.rows).toHaveLength(0);
    expect(third.nextCursor).toEqual(second.nextCursor);
  });

  it('is gap-free under concurrent overlapping commits (§8B #7)', async () => {
    // Seed one committed row so we have an artifact + a starting cursor.
    await capture('shared/race.md', 'a'.repeat(64), 'created');
    const artifactId = await artifactIdFor('shared/race.md');
    const start = (await ledger.changesSince(sessionId)).nextCursor;

    // Two overlapping txns: B inserts a LATER id but commits FIRST; A commits last.
    // A naive max(id) cursor would consume B (id=high), then skip A (id=low) forever.
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await a.query(
        `INSERT INTO artifact_changes (artifact_id, workspace_id, session_id, path, seq, base_seq, sha, status, kind, author)
         VALUES ($1,$2,$3,'shared/race.md',2,1,$4,'normal','modified',$5)`,
        [artifactId, fx.workspaceId, sessionId, 'a2'.repeat(32), `agent:${sessionId}`],
      );
      await b.query('BEGIN');
      await b.query(
        `INSERT INTO artifact_changes (artifact_id, workspace_id, session_id, path, seq, base_seq, sha, status, kind, author)
         VALUES ($1,$2,$3,'shared/race.md',3,2,$4,'normal','modified',$5)`,
        [artifactId, fx.workspaceId, sessionId, 'a3'.repeat(32), `agent:${sessionId}`],
      );
      await b.query('COMMIT'); // B (higher id) durable; A still open.

      // While A is in flight, the feed must withhold BOTH (B's id is past the
      // xmin horizon) — never consume B prematurely.
      const mid = await ledger.changesSince(sessionId, start);
      expect(mid.rows).toHaveLength(0);

      await a.query('COMMIT');
    } finally {
      a.release();
      b.release();
    }

    // Now both drain, in commit order (A's txn id < B's), nothing skipped.
    const after = await ledger.changesSince(sessionId, start);
    expect(after.rows.map((r) => r.seq)).toEqual([2, 3]);
  });

  it('tags origin so node-merge writes are echo-suppressible (§8B #2)', async () => {
    // The node-side merge lane sets a txn-local GUC; capture defaults to 'agent'.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL atrium.change_origin = 'node-merge'");
      const artifactId = randomUUID();
      await client.query(
        `INSERT INTO artifacts (id, workspace_id, session_id, channel_id, path, merge_class)
         VALUES ($1,$2,$3,$4,'shared/echo.md','mergeable-doc')`,
        [artifactId, fx.workspaceId, sessionId, fx.channelId],
      );
      await client.query(
        `INSERT INTO cas_blobs (sha256, size_bytes, mime) VALUES ($1, 3, 'text/markdown')
         ON CONFLICT DO NOTHING`,
        ['e'.repeat(64)],
      );
      await client.query(
        `INSERT INTO artifact_versions (artifact_id, seq, blob_sha, base_seq, author, kind, status)
         VALUES ($1, 1, $2, NULL, 'node-merge', 'created', 'normal')`,
        [artifactId, 'e'.repeat(64)],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const page = await ledger.changesSince(sessionId);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ path: 'shared/echo.md', origin: 'node-merge' });
  });

  it('surfaces conflict-status versions in the feed (§8B #5)', async () => {
    await capture('shared/doc.md', 'a'.repeat(64), 'created');
    const artifactId = await artifactIdFor('shared/doc.md');
    await pool.query(
      `INSERT INTO cas_blobs (sha256, size_bytes, mime) VALUES ($1, 3, 'text/markdown')
       ON CONFLICT DO NOTHING`,
      ['f'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO artifact_versions (artifact_id, seq, blob_sha, base_seq, author, kind, status, conflict)
       VALUES ($1, 2, $2, 1, 'human:x', 'modified', 'conflict', $3)`,
      [artifactId, 'f'.repeat(64), JSON.stringify({ base_seq: 1 })],
    );
    const page = await ledger.changesSince(sessionId);
    const conflict = page.rows.find((r) => r.status === 'conflict');
    expect(conflict).toMatchObject({ path: 'shared/doc.md', seq: 2, status: 'conflict' });
  });
});

describe('artifact sync-state', () => {
  it('upserts and advances the per-path state record', async () => {
    expect(await ledger.getSyncState(sessionId, 'plan.md')).toBeNull();

    await ledger.upsertSyncState(sessionId, 'plan.md', {
      baseSeq: 5,
      baseSha: 'b'.repeat(64),
      upperSha: null,
      appliedRemoteSeq: null,
    });
    expect(await ledger.getSyncState(sessionId, 'plan.md')).toEqual({
      baseSeq: 5,
      baseSha: 'b'.repeat(64),
      upperSha: null,
      appliedRemoteSeq: null,
    });

    // Agent edits → upper_sha set; node adopts remote v6 → base advances + applied.
    await ledger.upsertSyncState(sessionId, 'plan.md', {
      baseSeq: 6,
      baseSha: 'c'.repeat(64),
      upperSha: 'd'.repeat(64),
      appliedRemoteSeq: 6,
    });
    expect(await ledger.getSyncState(sessionId, 'plan.md')).toMatchObject({
      baseSeq: 6,
      appliedRemoteSeq: 6,
      upperSha: 'd'.repeat(64),
    });
  });
});
