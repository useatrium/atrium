// #9 — upload↔commit atomicity: a version must never reference a blob that
// isn't verified-durable in S3. writeBackArtifact HEAD-verifies the PUT before
// stamping s3_key (the "servable" signal); a failed verify aborts the write.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { writeBackArtifact, type ArtifactWritebackStorage } from '../src/artifact-writeback.js';
import { ArtifactLedger } from '../src/artifact-ledger.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

class FakeStorage implements ArtifactWritebackStorage {
  readonly objects = new Map<string, Buffer>();
  headLands = true; // flip to simulate a PUT that didn't actually land durably
  async uploadObject(key: string, body: Buffer | Uint8Array): Promise<void> {
    this.objects.set(key, Buffer.from(body));
  }
  async getObjectBytes(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`missing ${key}`);
    return Buffer.from(o);
  }
  async headObject(key: string): Promise<{ contentLength: number } | null> {
    if (!this.headLands) return null;
    const o = this.objects.get(key);
    return o ? { contentLength: o.length } : null;
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
     VALUES ($1,$2,$3,'dur','running',$4) RETURNING id`,
    [fx.workspaceId, fx.channelId, `tk-${randomUUID()}`, fx.userId],
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
  storage = new FakeStorage();
});

function write(text: string) {
  return writeBackArtifact({
    pool,
    storage,
    channelId: fx.channelId,
    sessionId,
    path: 'd.md',
    bytes: Buffer.from(text, 'utf8'),
    mime: 'text/markdown',
    author: `human:${fx.userId}`,
  });
}

describe('blob durability (#9)', () => {
  it('commits when the upload is verified durable', async () => {
    const res = await write('durable bytes');
    expect(res).toMatchObject({ ok: true, seq: 1 });
    // the version's blob is stamped (servable)
    const v = await ledger.resolveVersion(sessionId, 'd.md', { pointer: 'latest' });
    expect(v?.s3Key).toBeTruthy();
  });

  it('aborts the write (no version) when the PUT did not land', async () => {
    storage.headLands = false; // HEAD returns null → durability check fails
    await expect(write('lost bytes')).rejects.toThrow(/durability check failed/);
    // nothing was committed
    const v = await ledger.resolveVersion(sessionId, 'd.md', { pointer: 'latest' });
    expect(v).toBeNull();
  });
});
