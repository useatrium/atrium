import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { CentaurEventFrame } from '@atrium/centaur-client';
import { ArtifactLedger, casBlobKey } from '../src/artifact-ledger.js';
import { SessionRuns, type ArtifactStorage } from '../src/session-runs.js';
import { WsHub } from '../src/hub.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let ledger: ArtifactLedger;
let runs: SessionRuns;
let sessionId: string;

type ArtifactFrame = Extract<CentaurEventFrame, { event: 'artifact.captured' }>;

async function seedSession(channelId = fx.channelId): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1, $2, $3, 'bridge-test', 'running', $4) RETURNING id`,
    [fx.workspaceId, channelId, `tk-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

function artifactCapturedFrame(
  eventId: number,
  overrides: Partial<ArtifactFrame['data']> = {},
): ArtifactFrame {
  const sha = overrides.sha256 ?? 'a'.repeat(64);
  return {
    event: 'artifact.captured',
    event_id: eventId,
    data: {
      type: 'artifact.captured',
      artifact_id: overrides.artifact_id ?? `artifact-${sha.slice(0, 12)}`,
      execution_id: overrides.execution_id ?? 'exe-bridge',
      path: overrides.path ?? 'reports/summary.md',
      kind: overrides.kind ?? 'created',
      mime: overrides.mime ?? 'text/markdown',
      size_bytes: overrides.size_bytes ?? 128,
      sha256: sha,
      ref: overrides.ref ?? 'staged-ref',
    },
  };
}

async function mirror(frame: ArtifactFrame): Promise<void> {
  await (runs as unknown as {
    mirrorFrame(id: string, frame: CentaurEventFrame): Promise<void>;
  }).mirrorFrame(sessionId, frame);
}

async function versionCount(): Promise<number> {
  const r = await pool.query<{ n: string }>('SELECT count(*)::int AS n FROM artifact_versions');
  return Number(r.rows[0]!.n);
}

async function insertSessionArtifactRow(args: {
  artifactId: string;
  sha256: string;
  centaurRef: string;
  path?: string;
  mime?: string;
  sizeBytes?: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO session_artifacts
       (id, session_id, execution_id, centaur_ref, path, mime, size_bytes, sha256)
     VALUES ($1, $2, 'exe-bridge', $3, $4, $5, $6, $7)`,
    [
      args.artifactId,
      sessionId,
      args.centaurRef,
      args.path ?? 'reports/summary.md',
      args.mime ?? 'text/markdown',
      args.sizeBytes ?? 128,
      args.sha256,
    ],
  );
}

function byteStream(body: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
}

function fakeArtifactStorage() {
  const uploads: { key: string; body: Buffer; contentType: string }[] = [];
  const storage: ArtifactStorage = {
    uploadObject: async (key, body, contentType) => {
      uploads.push({ key, body: Buffer.from(body), contentType });
    },
    presignGet: async (key) => `https://storage.local/${encodeURIComponent(key)}`,
  };
  return { uploads, storage };
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
  runs = new SessionRuns(pool, new WsHub(), {
    centaur: {} as never,
    autoResume: false,
  });
});

describe('artifact capture bridge', () => {
  it('mirrors captured artifacts into the CAS ledger, idempotently replays content, and records tombstones', async () => {
    const sha = 'b'.repeat(64);
    await mirror(artifactCapturedFrame(1, { sha256: sha }));

    const latest = await ledger.resolveVersion(sessionId, 'reports/summary.md', { pointer: 'latest' });
    expect(latest).toMatchObject({
      seq: 1,
      blobSha: sha,
      kind: 'created',
      mime: 'text/markdown',
      sizeBytes: 128,
    });
    const artifact = await pool.query<{ merge_class: string }>(
      'SELECT merge_class FROM artifacts WHERE workspace_id = $1 AND path = $2',
      [fx.workspaceId, 'reports/summary.md'],
    );
    expect(artifact.rows[0]?.merge_class).toBe('mergeable-doc');

    await mirror(artifactCapturedFrame(2, {
      artifact_id: 'artifact-replay',
      sha256: sha,
      kind: 'modified',
    }));
    const replayed = await ledger.resolveVersion(sessionId, 'reports/summary.md', { pointer: 'latest' });
    expect(replayed?.seq).toBe(1);
    expect(await versionCount()).toBe(1);

    await mirror(artifactCapturedFrame(3, {
      artifact_id: 'artifact-delete',
      kind: 'deleted',
      sha256: 'c'.repeat(64),
      ref: null,
      size_bytes: 0,
    }));
    const tombstone = await ledger.resolveVersion(sessionId, 'reports/summary.md', { pointer: 'latest' });
    expect(tombstone).toMatchObject({
      seq: 2,
      blobSha: null,
      kind: 'deleted',
      mime: null,
      sizeBytes: null,
    });
  });

  it('offloads captured bytes to the CAS key and globally dedups later rows', async () => {
    const sha = 'd'.repeat(64);
    const body = new Uint8Array([1, 2, 3, 4]);
    await ledger.commitVersion({
      sessionId,
      channelId: fx.channelId,
      path: 'reports/summary.md',
      blobSha: sha,
      sizeBytes: body.byteLength,
      mime: 'text/markdown',
      author: `agent:${sessionId}`,
      kind: 'created',
      mergeClass: 'mergeable-doc',
    });
    await insertSessionArtifactRow({
      artifactId: 'artifact-first',
      sha256: sha,
      centaurRef: 'blob-first',
      sizeBytes: body.byteLength,
    });

    const requests: string[] = [];
    const s3 = fakeArtifactStorage();
    const offloader = new SessionRuns(pool, new WsHub(), {
      centaur: {
        getArtifactBytes: async (_executionId: string, ref: string) => {
          requests.push(ref);
          return {
            body: byteStream(body),
            contentType: 'text/markdown',
            contentLength: body.byteLength,
          };
        },
      } as never,
      artifactStorage: s3.storage,
      autoResume: false,
    });

    const first = await offloader.offloadArtifactBatch();
    const casKey = casBlobKey(sha);
    expect(first).toEqual({ offloaded: 1, evicted: 0, failed: 0 });
    expect(requests).toEqual(['blob-first']);
    expect(s3.uploads).toEqual([{ key: casKey, body: Buffer.from(body), contentType: 'text/markdown' }]);
    const firstRow = await pool.query<{ s3_key: string | null }>(
      'SELECT s3_key FROM session_artifacts WHERE session_id = $1 AND id = $2',
      [sessionId, 'artifact-first'],
    );
    expect(firstRow.rows[0]?.s3_key).toBe(casKey);
    const firstVersion = await ledger.resolveVersion(sessionId, 'reports/summary.md', { pointer: 'latest' });
    expect(firstVersion?.s3Key).toBe(casKey);

    await insertSessionArtifactRow({
      artifactId: 'artifact-duplicate',
      sha256: sha,
      centaurRef: 'blob-duplicate',
      sizeBytes: body.byteLength,
    });
    requests.length = 0;
    s3.uploads.length = 0;

    const duplicate = await offloader.offloadArtifactBatch();
    expect(duplicate).toEqual({ offloaded: 1, evicted: 0, failed: 0 });
    expect(requests).toEqual([]);
    expect(s3.uploads).toEqual([]);
    const duplicateRow = await pool.query<{ s3_key: string | null }>(
      'SELECT s3_key FROM session_artifacts WHERE session_id = $1 AND id = $2',
      [sessionId, 'artifact-duplicate'],
    );
    expect(duplicateRow.rows[0]?.s3_key).toBe(casKey);
  });
});
