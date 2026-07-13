import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { loadConflictDetail } from '../src/artifact-conflict.js';
import { ArtifactLedger, casBlobKey } from '../src/artifact-ledger.js';
import { writeBackArtifact, type ArtifactWritebackStorage } from '../src/artifact-writeback.js';
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

class FakeStorage implements ArtifactWritebackStorage {
  readonly objects = new Map<string, Buffer>();

  async uploadObject(key: string, body: Buffer | Uint8Array): Promise<void> {
    this.objects.set(key, Buffer.from(body));
  }

  async getObjectBytes(key: string): Promise<Buffer> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error(`missing object ${key}`);
    return Buffer.from(bytes);
  }
}

/** Low-level ledger commit. Existing versions must name a base; null is used
 * only by tests that deliberately exercise the legacy single-writer append. */
function capture(
  path: string,
  blobSha: string | null,
  kind: 'created' | 'modified' | 'deleted',
  opts: { mime?: string; size?: number; baseSeq?: number | null } = {},
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
    ...(opts.baseSeq === undefined ? {} : { baseSeq: opts.baseSeq }),
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
    expect(latest).toMatchObject({
      seq: 1,
      blobSha: 'a'.repeat(64),
      kind: 'created',
      mime: 'text/markdown',
      s3Key: null,
    });
  });

  it('chains v2 and retains history', async () => {
    await capture('report.md', 'a'.repeat(64), 'created');
    const v2 = await capture('report.md', 'b'.repeat(64), 'modified', { baseSeq: 1 });
    expect(v2).toMatchObject({ ok: true, seq: 2 });

    const latest = await ledger.resolveVersion(sessionId, 'report.md', { pointer: 'latest' });
    expect(latest?.seq).toBe(2);
    expect(latest?.blobSha).toBe('b'.repeat(64));

    const old = await ledger.resolveVersion(sessionId, 'report.md', { seq: 1 });
    expect(old?.blobSha).toBe('a'.repeat(64));
  });

  it('content-dedups an identical re-capture (idempotent, no new version)', async () => {
    await capture('report.md', 'a'.repeat(64), 'created');
    const again = await capture('report.md', 'a'.repeat(64), 'modified', { baseSeq: 1 });
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
    await capture('report.md', 'b'.repeat(64), 'modified', { baseSeq: 1 }); // seq 2

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
    const del = await capture('report.md', null, 'deleted', { baseSeq: 1 });
    expect(del).toMatchObject({ ok: true, seq: 2 });

    const latest = await ledger.resolveVersion(sessionId, 'report.md', { pointer: 'latest' });
    expect(latest).toMatchObject({ seq: 2, kind: 'deleted', blobSha: null, mime: null });
  });

  it('serializes concurrent commits and rejects the writer whose named base became stale', async () => {
    await capture('report.md', 'a'.repeat(64), 'created'); // seq 1
    const [r1, r2] = await Promise.all([
      capture('report.md', 'e'.repeat(64), 'modified', { baseSeq: 1 }),
      capture('report.md', 'f'.repeat(64), 'modified', { baseSeq: 1 }),
    ]);
    expect([r1, r2].filter((result) => result.ok)).toHaveLength(1);
    expect([r1, r2].find((result) => !result.ok)).toMatchObject({ reason: 'stale_base', latestSeq: 2, baseSeq: 1 });
    expect(await versionCount()).toBe(2);
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
      baseSeq: 1,
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

describe('ArtifactLedger — concurrent shared editing', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = new FakeStorage();
  });

  function captureText(text: string, author: string, baseSeq?: number | null) {
    return writeBackArtifact({
      pool,
      storage,
      channelId: fx.channelId,
      sessionId,
      path: 'design.md',
      bytes: Buffer.from(text),
      mime: 'text/markdown',
      author,
      ...(baseSeq === undefined ? {} : { baseSeq }),
    });
  }

  it('records a conflict when two writers fork the same base and preserves the first writer', async () => {
    const base = 'title\noriginal\nend\n';
    const aEdit = 'title\nagent A\nend\n';
    const bEdit = 'title\nagent B\nend\n';

    await captureText(base, 'node:seed'); // v1: both agents hydrate this
    expect(await captureText(aEdit, 'node:agent-a', 1)).toMatchObject({ ok: true, seq: 2, status: 'normal' });
    expect(await captureText(bEdit, 'node:agent-b', 1)).toMatchObject({ ok: true, seq: 3, status: 'conflict' });

    const resolution = await ledger.serveResolution(sessionId, 'design.md');
    expect(resolution).toMatchObject({ servedSeq: 2, conflicted: true, conflictSeq: 3 });

    const detail = await loadConflictDetail(pool, storage, sessionId, 'design.md');
    expect(detail).toMatchObject({ kind: 'diff3', conflictSeq: 3, baseSeq: 1 });
    expect(detail?.left.text).toBe(aEdit);
    expect(detail?.right.text).toBe(bEdit);
    expect(detail?.markers).toContain('agent A');
    expect(detail?.markers).toContain('agent B');
  });

  it('linearizes sequential edits whose base is latest without a false conflict', async () => {
    await captureText('v1\n', 'node:agent-a');
    expect(await captureText('v2\n', 'node:agent-a', 1)).toMatchObject({ ok: true, seq: 2, status: 'normal' });
    expect(await captureText('v3\n', 'node:agent-a', 2)).toMatchObject({ ok: true, seq: 3, status: 'normal' });
    expect(await ledger.getConflict(sessionId, 'design.md')).toBeNull();
  });

  it('allows a base-less first write and records an unknown-base append as a conflict', async () => {
    expect(await captureText('v1\n', 'node:agent-a')).toMatchObject({ ok: true, seq: 1 });
    expect(await captureText('blind append\n', 'node:agent-b')).toMatchObject({
      ok: true,
      seq: 2,
      status: 'conflict',
    });
    expect(await versionCount()).toBe(2);
    expect(await ledger.serveResolution(sessionId, 'design.md')).toMatchObject({
      servedSeq: 1,
      conflicted: true,
      conflictSeq: 2,
    });

    const detail = await loadConflictDetail(pool, storage, sessionId, 'design.md');
    expect(detail).toMatchObject({ kind: 'unmergeable', conflictSeq: 2, baseSeq: null });
    expect(detail?.left.text).toBe('v1\n');
    expect(detail?.right.text).toBe('blind append\n');
  });

  it('keeps explicit null as the legacy single-writer implicit append assertion', async () => {
    expect(await captureText('v1\n', 'node:agent-a')).toMatchObject({ ok: true, seq: 1 });
    expect(await captureText('v2\n', 'node:legacy', null)).toMatchObject({
      ok: true,
      seq: 2,
      status: 'normal',
    });
    expect(await ledger.getConflict(sessionId, 'design.md')).toBeNull();
  });
});
