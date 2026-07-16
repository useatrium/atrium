// Wire-contract enforcement for the node-sync daemon's internal API.
//
// The fixtures under runtime/node-sync/contract/fixtures/ are the minimum
// response shapes the daemon's parsers rely on (each fixture is parsed by the
// daemon's own tests — runtime/node-sync/tests/contract.rs). This suite
// asserts the LIVE routes still produce at least those shapes, so a
// surface-only change that breaks the daemon goes red here, in surface CI,
// without waiting for the kind e2e. See runtime/node-sync/CONTRACT.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { emitSessionRecordChange } from '../src/session-record-changefeed.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

const mockedS3 = vi.hoisted(() => {
  class FakeStorage {
    readonly objects = new Map<string, { body: Buffer; contentType: string }>();

    reset(): void {
      this.objects.clear();
    }

    uploadObject = async (key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> => {
      this.objects.set(key, { body: Buffer.from(body), contentType });
    };

    uploadObjectStream = async (key: string, stream: NodeJS.ReadableStream, contentType: string): Promise<void> => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      this.objects.set(key, { body: Buffer.concat(chunks), contentType });
    };

    copyObject = async (srcKey: string, destKey: string): Promise<void> => {
      const object = this.objects.get(srcKey);
      if (!object) throw new Error(`missing object: ${srcKey}`);
      this.objects.set(destKey, { body: Buffer.from(object.body), contentType: object.contentType });
    };

    deleteObject = async (key: string): Promise<void> => {
      this.objects.delete(key);
    };

    getObjectBytes = async (key: string): Promise<Buffer> => {
      const object = this.objects.get(key);
      if (!object) throw new Error(`missing object: ${key}`);
      return Buffer.from(object.body);
    };

    headObject = async (key: string): Promise<{ contentLength: number } | null> => {
      const object = this.objects.get(key);
      return object ? { contentLength: object.body.byteLength } : null;
    };
  }

  return { storage: new FakeStorage() };
});

vi.mock('../src/s3.js', () => ({
  copyObject: mockedS3.storage.copyObject,
  deleteObject: mockedS3.storage.deleteObject,
  downloadObject: async () => {},
  ensureBucket: async () => {},
  getObjectBytes: mockedS3.storage.getObjectBytes,
  headObject: mockedS3.storage.headObject,
  presignGet: async () => 'https://storage.local/get',
  presignPut: async () => 'https://storage.local/put',
  uploadObject: mockedS3.storage.uploadObject,
  uploadObjectStream: mockedS3.storage.uploadObjectStream,
}));

const KEY = 'internal-contract-test-key';
const FIXTURES = join(import.meta.dirname, '../../../runtime/node-sync/contract/fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

// The fixture is a minimum-shape template: every key it has must exist in the
// live response with a matching type. Extra keys in the response are fine —
// the daemon's parsers are tolerant readers. A non-empty template array
// requires a non-empty response array whose first element matches the
// template element.
function expectShape(actual: unknown, template: unknown, path = '$'): void {
  if (Array.isArray(template)) {
    expect(Array.isArray(actual), `${path} must be an array`).toBe(true);
    if (template.length > 0) {
      expect((actual as unknown[]).length, `${path} must not be empty`).toBeGreaterThan(0);
      expectShape((actual as unknown[])[0], template[0], `${path}[0]`);
    }
    return;
  }
  if (typeof template === 'object') {
    expect(typeof actual, `${path} must be an object`).toBe('object');
    expect(actual, `${path} must not be null`).not.toBeNull();
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) {
      expectShape((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
    return;
  }
  expect(typeof actual, `${path} must be a ${typeof template}`).toBe(typeof template);
}

let pool: pg.Pool;
let fx: Fixture;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  pool = await createTestPool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  mockedS3.storage.reset();
  await pool.query(
    'TRUNCATE artifact_changes, artifact_sync_state, cas_blobs, artifact_pointers, artifact_versions, artifacts CASCADE',
  );
  await truncateAll(pool);
  fx = await seedFixture(pool);
  app = await buildApp({
    pool,
    artifactCaptureApiKey: KEY,
    sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

async function session(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1,$2,$3,'contract','running',$4) RETURNING id`,
    [fx.workspaceId, fx.channelId, `tk-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

async function capture(sid: string, path: string): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/internal/sessions/${sid}/artifacts/capture?path=${encodeURIComponent(path)}`,
    headers: { 'x-api-key': KEY, 'content-type': 'text/markdown' },
    payload: 'contract fixture bytes',
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('node-sync wire contract (fixtures)', () => {
  it('capture response carries the contract shape', async () => {
    const sid = await session();
    const body = await capture(sid, `shared/channels/${fx.channelId}/report.md`);
    expectShape(body, loadFixture('capture-response.json'));
  });

  it('artifacts changes feed carries the contract shape', async () => {
    const sid = await session();
    await capture(sid, `shared/channels/${fx.channelId}/report.md`);
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/artifacts/changes`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(200);
    expectShape(res.json(), loadFixture('artifacts-changes.json'));
  });

  it('hydration-scope carries the contract shape', async () => {
    const sid = await session();
    await capture(sid, `shared/channels/${fx.channelId}/report.md`);
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/hydration-scope`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(200);
    expectShape(res.json(), loadFixture('hydration-scope.json'));
  });

  it('warmcache manifest round-trip carries the contract shape', async () => {
    const sid = await session();
    const put = await app.inject({
      method: 'PUT',
      url: `/api/internal/sessions/${sid}/cache/manifest`,
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: {
        lockfile_hash: 'abc123',
        kind: 'pnpm-store',
        entries: [
          {
            path: 'v3/files/00/aabbcc',
            sha256: 'cc33dd44cc33dd44cc33dd44cc33dd44cc33dd44cc33dd44cc33dd44cc33dd44',
            size_bytes: 1024,
          },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/cache/hydration?lockfile_hash=abc123&kind=pnpm-store`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(200);
    expectShape(res.json(), loadFixture('warmcache-hydration.json'));
  });

  it('atrium changes feed carries the contract shape', async () => {
    const viewer = await session();
    const target = await session();
    await emitSessionRecordChange(pool, target, 3);
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewer}/atrium/changes`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(200);
    expectShape(res.json(), loadFixture('atrium-changes.json'));
  });

  it('atrium channels and context-doc delta headers carry the contract shape', async () => {
    const viewer = await session();
    const target = await session();
    const channels = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewer}/atrium/channels`,
      headers: { 'x-api-key': KEY },
    });
    expect(channels.statusCode).toBe(200);
    expectShape(channels.json(), loadFixture('atrium-channels.json'));
    // Exact key match, not just shape: node-sync maps `lastEventId` and
    // `last_event_id` to the same struct field, so an extra alias spelling in
    // one row is a duplicate field that poisons the entire channels parse
    // (this halted context materialization for every session on 2026-07-14).
    const [fixtureRow] = loadFixture('atrium-channels.json') as Record<string, unknown>[];
    const fixtureKeys = Object.keys(fixtureRow ?? {}).sort();
    for (const row of channels.json() as Record<string, unknown>[]) {
      expect(Object.keys(row).sort()).toEqual(fixtureKeys);
    }

    const sessionDoc = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewer}/atrium/sessions/${target}/transcript`,
      headers: { 'x-api-key': KEY },
    });
    expect(sessionDoc.statusCode).toBe(200);
    expect(sessionDoc.headers).toMatchObject({
      'x-atrium-delta': 'full',
      'x-atrium-next-seq': expect.any(String),
      'x-atrium-epoch': expect.any(String),
    });

    const chatDoc = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${viewer}/atrium/channels/${fx.channelId}/chat`,
      headers: { 'x-api-key': KEY },
    });
    expect(chatDoc.statusCode).toBe(200);
    expect(chatDoc.headers).toMatchObject({
      'x-atrium-delta': 'full',
      'x-atrium-next-event-id': expect.any(String),
      'x-atrium-epoch': expect.any(String),
    });
  });

  // The bundles ELEMENT shape is pinned daemon-side (the fixture parses via
  // parse_profile_bundles); seeding a real bundle here would drag in the whole
  // profile-writeback pipeline, so the live check pins the envelope only.
  it('profile-bundles carries the contract envelope', async () => {
    const sid = await session();
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/profile-bundles?harness=codex`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json<{ bundles: unknown[] }>().bundles)).toBe(true);
  });

  it('git identity carries the contract shape', async () => {
    await pool.query(`UPDATE users SET display_name = 'Allan Niemerg', email = 'allan@example.com' WHERE id = $1`, [
      fx.userId,
    ]);
    await pool.query(
      `INSERT INTO user_connection_identities
         (workspace_id, user_id, provider, identity_id, status, token_kind, account_login, account_id, active)
       VALUES ($1, $2, 'github', 'github:pat', 'connected', 'pat', 'aniemerg', '123', true)`,
      [fx.workspaceId, fx.userId],
    );
    const sid = await session();
    const res = await app.inject({
      method: 'GET',
      url: `/api/internal/sessions/${sid}/git-identity`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(200);
    const { _comment, ...template } = loadFixture('git-identity.json') as Record<string, unknown>;
    expect(typeof _comment).toBe('string');
    expectShape(res.json(), template);
    expect(res.json()).toMatchObject({
      authorName: 'Allan Niemerg',
      authorEmail: '123+aniemerg@users.noreply.github.com',
      source: 'github_noreply',
      sessionId: sid,
    });
  });
});
