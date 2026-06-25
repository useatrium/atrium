import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ArtifactLedger, casBlobKey } from '../src/artifact-ledger.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let ledger: ArtifactLedger;
let sessionId: string;

/** Minimal session row to hang artifacts off (artifacts.session_id FK). */
async function seedSession(channelId = fx.channelId): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1, $2, $3, 'ledger-test', 'running', $4) RETURNING id`,
    [fx.workspaceId, channelId, `tk-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

/** A capture-shaped commit (the Lane 1 bridge path: agent author, implicit base). */
function capture(
  path: string,
  blobSha: string | null,
  kind: 'created' | 'modified' | 'deleted',
  opts: { mime?: string; size?: number } = {},
) {
  return ledger.commitVersion({
    sessionId,
    channelId: fx.channelId,
    path,
    blobSha,
    sizeBytes: opts.size ?? 10,
    mime: opts.mime ?? 'text/markdown',
    author: `agent:${sessionId}`,
    kind,
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
  await pool.query('TRUNCATE cas_blobs, artifact_pointers, artifact_versions, artifacts CASCADE');
  await truncateAll(pool);
  fx = await seedFixture(pool);
  sessionId = await seedSession();
});

async function versionCount(): Promise<number> {
  const r = await pool.query<{ n: string }>('SELECT count(*)::int AS n FROM artifact_versions');
  return Number(r.rows[0]!.n);
}

describe('ArtifactLedger foundation', () => {
  it('commits v1 and resolves latest', async () => {
    const res = await capture('report.md', 'a'.repeat(64), 'created');
    expect(res).toMatchObject({ ok: true, seq: 1, idempotent: false });

    const latest = await ledger.resolveVersion(sessionId, 'report.md', { pointer: 'latest' });
    expect(latest).toMatchObject({ seq: 1, blobSha: 'a'.repeat(64), kind: 'created', mime: 'text/markdown', s3Key: null });
  });

  it('chains v2 and retains history', async () => {
    await capture('report.md', 'a'.repeat(64), 'created');
    const v2 = await capture('report.md', 'b'.repeat(64), 'modified');
    expect(v2).toMatchObject({ ok: true, seq: 2 });

    const latest = await ledger.resolveVersion(sessionId, 'report.md', { pointer: 'latest' });
    expect(latest?.seq).toBe(2);
    expect(latest?.blobSha).toBe('b'.repeat(64));

    const old = await ledger.resolveVersion(sessionId, 'report.md', { seq: 1 });
    expect(old?.blobSha).toBe('a'.repeat(64));
  });

  it('content-dedups an identical re-capture (idempotent, no new version)', async () => {
    await capture('report.md', 'a'.repeat(64), 'created');
    const again = await capture('report.md', 'a'.repeat(64), 'modified');
    expect(again).toMatchObject({ ok: true, seq: 1, idempotent: true });
    expect(await versionCount()).toBe(1);
  });

  it('dedups the blob globally across artifacts', async () => {
    const sha = 'c'.repeat(64);
    await capture('one.md', sha, 'created');
    await capture('two.md', sha, 'created'); // different artifact, same bytes
    const blobs = await pool.query<{ n: string }>('SELECT count(*)::int AS n FROM cas_blobs WHERE sha256 = $1', [sha]);
    expect(Number(blobs.rows[0]!.n)).toBe(1);
  });

  it('rejects a stale base (OCC)', async () => {
    await capture('report.md', 'a'.repeat(64), 'created'); // seq 1
    await capture('report.md', 'b'.repeat(64), 'modified'); // seq 2

    const stale = await ledger.commitVersion({
      sessionId,
      channelId: fx.channelId,
      path: 'report.md',
      blobSha: 'd'.repeat(64),
      sizeBytes: 10,
      mime: 'text/markdown',
      author: `human:${fx.userId}`,
      kind: 'modified',
      baseSeq: 1, // edited against v1 while latest is v2
    });
    expect(stale).toMatchObject({ ok: false, reason: 'stale_base', latestSeq: 2, baseSeq: 1 });
    expect(await versionCount()).toBe(2); // nothing appended
  });

  it('records a delete tombstone', async () => {
    await capture('report.md', 'a'.repeat(64), 'created');
    const del = await capture('report.md', null, 'deleted');
    expect(del).toMatchObject({ ok: true, seq: 2 });

    const latest = await ledger.resolveVersion(sessionId, 'report.md', { pointer: 'latest' });
    expect(latest).toMatchObject({ seq: 2, kind: 'deleted', blobSha: null, mime: null });
  });

  it('serializes concurrent commits to the same artifact (monotonic seq)', async () => {
    await capture('report.md', 'a'.repeat(64), 'created'); // seq 1
    const [r1, r2] = await Promise.all([
      capture('report.md', 'e'.repeat(64), 'modified'),
      capture('report.md', 'f'.repeat(64), 'modified'),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    const seqs = [(r1 as { seq: number }).seq, (r2 as { seq: number }).seq].sort();
    expect(seqs).toEqual([2, 3]); // no gap, no dup
    expect(await versionCount()).toBe(3);
  });

  it('tracks blob durability state + key', async () => {
    const sha = 'a'.repeat(64);
    await capture('report.md', sha, 'created');
    expect(await ledger.blobIsDurable(sha)).toBe(false);

    await ledger.stampBlobS3Key(sha, casBlobKey(sha));
    expect(await ledger.blobIsDurable(sha)).toBe(true);

    const latest = await ledger.resolveVersion(sessionId, 'report.md', { pointer: 'latest' });
    expect(latest?.s3Key).toBe(casBlobKey(sha));
  });

  it('returns null for unknown artifact / pointer', async () => {
    expect(await ledger.resolveVersion(sessionId, 'nope.md', { pointer: 'latest' })).toBeNull();
    await capture('report.md', 'a'.repeat(64), 'created');
    expect(await ledger.resolveVersion(sessionId, 'report.md', { pointer: 'official' })).toBeNull();
  });

  it('shares workspace identity across sessions at the same path', async () => {
    const otherSession = await seedSession();
    const first = await capture('shared/global/report.md', 'a'.repeat(64), 'created');
    expect(first).toMatchObject({ ok: true, seq: 1 });
    if (!first.ok) throw new Error('expected first commit to succeed');
    const other = await ledger.commitVersion({
      sessionId: otherSession,
      channelId: fx.channelId,
      path: 'shared/global/report.md',
      blobSha: 'b'.repeat(64),
      sizeBytes: 10,
      mime: 'text/markdown',
      author: `agent:${otherSession}`,
      kind: 'created',
    });
    expect(other).toMatchObject({ ok: true, seq: 2, artifactId: first.artifactId });
    const a = await ledger.resolveVersion(sessionId, 'shared/global/report.md', { pointer: 'latest' });
    const b = await ledger.resolveVersion(otherSession, 'shared/global/report.md', { pointer: 'latest' });
    expect(a?.blobSha).toBe('b'.repeat(64));
    expect(b?.blobSha).toBe('b'.repeat(64));
  });

  it('casBlobKey shards by sha prefix', () => {
    const sha = '0123456789abcdef'.repeat(4);
    expect(casBlobKey(sha)).toBe(`cas/01/${sha}`);
  });
});

// CHARACTERIZATION (green in CI on purpose): documents a KNOWN gap, not a desired
// behavior — the blind-append clobber from notes/cas-ledger-build-plan.md §9
// finding 1. capture() passes no baseSeq, so commitVersion linearizes every writer
// onto `latest` regardless of the base it actually edited. Two agents that both
// fork v1 → the second silently buries the first, with NO conflict recorded.
//
// WHEN shared-doc capture is made base-aware (the §9 fix), FLIP this test: agent
// B's capture should carry base_seq=1 → trip stale_base → node-diff3 → a
// status='conflict' version, not overwrite A. Rewrite the assertions then and
// delete this comment.
describe('ArtifactLedger — concurrent shared editing (characterization, §9)', () => {
  it('blind-append capture buries the prior edit with no conflict', async () => {
    const HELLO = 'a'.repeat(64);
    const A_EDIT = 'b'.repeat(64); // agent A's edit off v1
    const B_EDIT = 'c'.repeat(64); // agent B's edit off v1 — does NOT contain A's change

    await capture('design.md', HELLO, 'created'); // v1: both agents hydrate this

    const a = await capture('design.md', A_EDIT, 'modified'); // implicit base = latest(1) → seq 2
    expect(a).toMatchObject({ ok: true, seq: 2 });

    const b = await capture('design.md', B_EDIT, 'modified'); // B also forked v1, but no base →
    expect(b).toMatchObject({ ok: true, seq: 3 }); // implicit base = latest(2): appended over A

    // The clobber: latest is B's bytes; nothing flagged that A's edit was lost.
    const latest = await ledger.resolveVersion(sessionId, 'design.md', { pointer: 'latest' });
    expect(latest).toMatchObject({ seq: 3, blobSha: B_EDIT, status: 'normal' });

    // The lost update is SILENT — no conflict version was ever recorded.
    const conflicts = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM artifact_versions WHERE status = 'conflict'`,
    );
    expect(conflicts.rows[0]!.n).toBe(0);

    // A's edit still exists in history (seq 2) but is unreachable via latest — it
    // never merged forward into B's version.
    const aStill = await ledger.resolveVersion(sessionId, 'design.md', { seq: 2 });
    expect(aStill?.blobSha).toBe(A_EDIT);
  });
});
