import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ArtifactLedger, casBlobKey } from '../src/artifact-ledger.js';
import type { DomainError } from '../src/events.js';
import { WsHub } from '../src/hub.js';
import { SessionRuns, type ArtifactStorage } from '../src/session-runs.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let ledger: ArtifactLedger;
let sessionRuns: SessionRuns;
let sessionId: string;

const presignCalls: { key: string; filename: string; inline: boolean }[] = [];
const artifactStorage: ArtifactStorage = {
  uploadObject: async () => undefined,
  presignGet: async (key: string, filename: string, inline: boolean) => {
    presignCalls.push({ key, filename, inline });
    return `https://storage.local/get/${encodeURIComponent(key)}?inline=${inline ? 1 : 0}`;
  },
};

async function seedSession(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1, $2, $3, 'artifact-serve-test', 'running', $4) RETURNING id`,
    [fx.workspaceId, fx.channelId, `tk-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

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
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE cas_blobs, artifact_pointers, artifact_versions, artifacts CASCADE');
  await truncateAll(pool);
  fx = await seedFixture(pool);
  sessionId = await seedSession();
  ledger = new ArtifactLedger(pool);
  sessionRuns = new SessionRuns(pool, new WsHub(), {
    artifactStorage,
    autoResume: false,
  });
  presignCalls.length = 0;
});

describe('getLedgerServePlan', () => {
  it('returns a redirect for an offloaded latest version', async () => {
    const sha = 'a'.repeat(64);
    const s3Key = casBlobKey(sha);
    await capture('out/chart.png', sha, 'created', { mime: 'image/png', size: 6 });
    await ledger.stampBlobS3Key(sha, s3Key);

    const plan = await sessionRuns.getLedgerServePlan(sessionId, 'out/chart.png', { pointer: 'latest' });

    expect(plan).toEqual({
      kind: 'redirect',
      s3Key,
      url: `https://storage.local/get/${encodeURIComponent(s3Key)}?inline=1`,
    });
    expect(presignCalls).toEqual([{ key: s3Key, filename: 'chart.png', inline: true }]);
  });

  it('throws 410 for a deleted tombstone', async () => {
    await capture('out/report.md', 'b'.repeat(64), 'created');
    await capture('out/report.md', null, 'deleted');

    await expect(
      sessionRuns.getLedgerServePlan(sessionId, 'out/report.md', { pointer: 'latest' }),
    ).rejects.toMatchObject({
      statusCode: 410,
      code: 'artifact_deleted',
    } satisfies Partial<DomainError>);
  });

  it('throws 404 for an unknown path', async () => {
    await expect(
      sessionRuns.getLedgerServePlan(sessionId, 'out/missing.png', { pointer: 'latest' }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'artifact_not_found',
    } satisfies Partial<DomainError>);
  });
});
