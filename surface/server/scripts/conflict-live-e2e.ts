// Live integration: drive the full conflict → detail → resolve loop against the
// REAL Postgres (:5433) and REAL MinIO (:9000) — the storage round-trip the unit
// tests fake out. Proves writeBackArtifact's diff3 + conflict-state, the
// loadConflictDetail both-sides hydration from S3, and the resolution write-back
// all work end-to-end on real infra. Run: pnpm tsx scripts/conflict-live-e2e.ts
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { ensureBucket, uploadObject, getObjectBytes } from '../src/s3.js';
import { writeBackArtifact } from '../src/artifact-writeback.js';
import { loadConflictDetail } from '../src/artifact-conflict.js';
import { ArtifactLedger } from '../src/artifact-ledger.js';
import { createWorkspace, createChannel } from '../src/events.js';
import { addWorkspaceMember } from '../src/membership.js';

const storage = { uploadObject, getObjectBytes };
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const pool = createPool('postgres://atrium:atrium@localhost:5433/atrium');
  await runMigrations(pool);
  await ensureBucket();

  const { workspace } = await createWorkspace(pool, { name: `live-${randomUUID().slice(0, 8)}` });
  const { channel } = await createChannel(pool, { workspaceId: workspace.id, name: 'general' });
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (handle, display_name) VALUES ($1,'Live') RETURNING id`,
    [`live-${randomUUID().slice(0, 8)}`],
  );
  await addWorkspaceMember(pool, workspace.id, user.rows[0]!.id);
  const session = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1,$2,$3,'live-e2e','running',$4) RETURNING id`,
    [workspace.id, channel.id, `tk-${randomUUID()}`, user.rows[0]!.id],
  );
  const sessionId = session.rows[0]!.id;
  const ledger = new ArtifactLedger(pool);

  const write = (path: string, text: string, baseSeq?: number) =>
    writeBackArtifact({
      pool,
      storage,
      channelId: channel.id,
      sessionId,
      path,
      bytes: Buffer.from(text, 'utf8'),
      mime: 'text/markdown',
      author: `human:${user.rows[0]!.id}`,
      ...(baseSeq == null ? {} : { baseSeq }),
    });

  console.log('\n[1] create v1 + mark mergeable-doc');
  const v1 = await write('plan.md', 'intro\nstep two\nconclusion\n');
  ok(v1.ok && v1.seq === 1, 'v1 created (seq 1)');
  await pool.query(`UPDATE artifacts SET merge_class='mergeable-doc' WHERE session_id=$1 AND path='plan.md'`, [
    sessionId,
  ]);

  console.log('[2] writer A edits off base 1 (clean → v2)');
  const a = await write('plan.md', 'intro\nstep two — ALICE\nconclusion\n', 1);
  ok(a.ok && a.status === 'normal' && a.seq === 2, 'A committed v2 normal');

  console.log('[3] writer B edits the SAME region off the stale base 1 → conflict');
  const b = await write('plan.md', 'intro\nstep two — BOB\nconclusion\n', 1);
  ok(b.ok && b.status === 'conflict', `B produced a conflict version (seq ${b.ok ? b.seq : '?'})`);

  console.log('[4] serve resolution hides markers + flags the conflict');
  const serve = await ledger.serveResolution(sessionId, 'plan.md');
  ok(serve!.conflicted === true && serve!.servedSeq === 2, 'serves last-normal v2 + conflicted flag');

  console.log('[5] load both-sides detail from REAL MinIO');
  const detail = await loadConflictDetail(pool, storage, sessionId, 'plan.md');
  ok(!!detail, 'conflict detail loaded');
  ok(detail!.left.text.includes('ALICE'), 'left side carries Alice’s edit (fetched from S3)');
  ok(detail!.right.text.includes('BOB'), 'right side carries Bob’s edit (fetched from S3)');
  ok(detail!.base.text.includes('step two\n'), 'base is the common ancestor (fetched from S3)');
  ok(detail!.markers.includes('<<<<<<<') && detail!.markers.includes('BOB'), 'diff3 markers present');

  console.log('[6] resolve against the conflict seq → normal latest');
  const conflictSeq = (await ledger.getConflict(sessionId, 'plan.md'))!.conflictSeq;
  const resolved = await write('plan.md', 'intro\nstep two — MERGED\nconclusion\n', conflictSeq);
  ok(resolved.ok && resolved.status === 'normal', 'resolution committed a normal version');
  const after = await ledger.serveResolution(sessionId, 'plan.md');
  ok(after!.conflicted === false, 'conflict cleared');
  ok((await ledger.getConflict(sessionId, 'plan.md')) === null, 'no unresolved conflict remains');

  // verify the resolved bytes actually round-trip from MinIO via the serve path
  const finalVer = await ledger.resolveVersion(sessionId, 'plan.md', { pointer: 'latest' });
  const finalBytes = await getObjectBytes(finalVer!.s3Key!);
  ok(finalBytes.toString('utf8').includes('MERGED'), 'final resolved bytes fetch from MinIO');

  console.log('\n✅ LIVE conflict→detail→resolve loop PASSED against real PG + MinIO\n');
  await pool.end();
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
