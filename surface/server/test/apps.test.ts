import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { buildAppsOrigin } from '../src/apps-origin.js';
import { AppRegistry } from '../src/app-registry.js';
import { verifyAppLaunchSignature } from '../src/app-signing.js';
import { ArtifactLedger, casBlobKey } from '../src/artifact-ledger.js';
import { config } from '../src/config.js';
import { createTestPool, seedFixture, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;
let ledger: ArtifactLedger;
let sessionId: string;
const bytesByKey = new Map<string, Buffer>();
const secret = 'apps-test-secret';

async function seedSession(channelId = fx.channelId): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1, $2, $3, 'apps-test', 'running', $4) RETURNING id`,
    [fx.workspaceId, channelId, `tk-${randomUUID()}`, fx.userId],
  );
  return r.rows[0]!.id;
}

async function capture(path: string, sha: string, body: string, mime = 'text/html'): Promise<void> {
  await ledger.commitVersion({
    sessionId,
    channelId: fx.channelId,
    path,
    blobSha: sha,
    sizeBytes: Buffer.byteLength(body),
    mime,
    author: `agent:${sessionId}`,
    kind: 'created',
  });
  const key = casBlobKey(sha);
  await ledger.stampBlobS3Key(sha, key);
  bytesByKey.set(key, Buffer.from(body));
}

async function appRegistry(): Promise<AppRegistry> {
  return new AppRegistry(pool, {
    appsOrigin: 'https://apps.local',
    signingSecret: secret,
    launchTtlSeconds: 300,
    storage: {
      getObjectBytes: async (key) => bytesByKey.get(key) ?? Buffer.alloc(0),
    },
  });
}

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  bytesByKey.clear();
  await pool.query('TRUNCATE app_versions, apps, cas_blobs, artifact_pointers, artifact_versions, artifacts CASCADE');
  await truncateAll(pool);
  fx = await seedFixture(pool);
  ledger = new ArtifactLedger(pool);
  sessionId = await seedSession();
});

describe('app registry publish/list/launch', () => {
  it('freezes exact source versions and validates entry-relative assets', async () => {
    const registry = await appRegistry();
    await capture(
      'apps/demo/index.html',
      'a'.repeat(64),
      '<!doctype html><script src="./app.js"></script>',
    );
    await capture('apps/demo/app.js', 'b'.repeat(64), 'globalThis.demo = true;', 'text/javascript');

    const published = await registry.publish({
      sessionId,
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      userId: fx.userId,
      name: 'demo',
      scope: 'channel',
      entry: 'index.html',
    });

    expect(published).toMatchObject({ version: 1, files: 2, entry: 'index.html' });

    await ledger.commitVersion({
      sessionId,
      channelId: fx.channelId,
      path: 'apps/demo/app.js',
      blobSha: 'c'.repeat(64),
      sizeBytes: 9,
      mime: 'text/javascript',
      author: `agent:${sessionId}`,
      kind: 'modified',
    });

    const rows = await pool.query<{ rel_path: string; blob_sha: string; artifact_seq: number }>(
      `SELECT rel_path, blob_sha, artifact_seq
         FROM app_versions
        WHERE app_id = $1 AND version = 1
        ORDER BY rel_path`,
      [published.appId],
    );
    expect(rows.rows).toEqual([
      { rel_path: 'app.js', blob_sha: 'b'.repeat(64), artifact_seq: 1 },
      { rel_path: 'index.html', blob_sha: 'a'.repeat(64), artifact_seq: 1 },
    ]);
  });

  it('rejects missing durable blobs, missing entries, deletes, and dangling assets', async () => {
    const registry = await appRegistry();
    await capture('apps/bad/index.html', 'd'.repeat(64), '<script src="missing.js"></script>');
    await expect(registry.publish({
      sessionId,
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      userId: fx.userId,
      name: 'bad',
      scope: 'channel',
      entry: 'index.html',
    })).rejects.toMatchObject({ code: 'app_asset_missing' });

    await capture('apps/pending/index.html', 'e'.repeat(64), 'pending');
    await pool.query('UPDATE cas_blobs SET s3_key = NULL WHERE sha256 = $1', ['e'.repeat(64)]);
    await expect(registry.publish({
      sessionId,
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      userId: fx.userId,
      name: 'pending',
      scope: 'channel',
      entry: 'index.html',
    })).rejects.toMatchObject({ code: 'blob_unavailable' });

    await capture('apps/deleted/index.html', 'f'.repeat(64), 'deleted');
    await ledger.commitVersion({
      sessionId,
      channelId: fx.channelId,
      path: 'apps/deleted/index.html',
      blobSha: null,
      sizeBytes: 0,
      mime: 'text/html',
      author: `agent:${sessionId}`,
      kind: 'deleted',
    });
    await expect(registry.publish({
      sessionId,
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      userId: fx.userId,
      name: 'deleted',
      scope: 'channel',
      entry: 'index.html',
    })).rejects.toMatchObject({ code: 'app_source_deleted' });

    await capture('apps/noentry/app.js', '1'.repeat(64), 'x', 'text/javascript');
    await expect(registry.publish({
      sessionId,
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      userId: fx.userId,
      name: 'noentry',
      scope: 'channel',
      entry: 'index.html',
    })).rejects.toMatchObject({ code: 'app_entry_missing' });
  });

  it('publishes explicit workspace apps from shared/global/apps', async () => {
    const registry = await appRegistry();
    await capture('shared/global/apps/work/index.html', '2'.repeat(64), 'workspace app');

    const published = await registry.publish({
      sessionId,
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      userId: fx.userId,
      name: 'work',
      scope: 'workspace',
      entry: 'index.html',
    });
    const listed = await registry.listForUser(fx.userId);

    expect(published.files).toBe(1);
    expect(listed).toEqual([
      expect.objectContaining({ id: published.appId, name: 'work', scope: 'workspace', currentVersion: 1 }),
    ]);
  });

  it('publishes workspace apps from shared/apps/<slug>', async () => {
    const registry = await appRegistry();
    await capture('shared/apps/widget/index.html', '5'.repeat(64), 'flat workspace app');

    const published = await registry.publish({
      sessionId,
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      userId: fx.userId,
      name: 'widget',
      scope: 'workspace',
      entry: 'index.html',
    });
    const listed = await registry.listForUser(fx.userId);

    expect(published.files).toBe(1);
    expect(listed).toEqual([
      expect.objectContaining({ id: published.appId, name: 'widget', scope: 'workspace', currentVersion: 1 }),
    ]);
  });

  it('launch requires auth and returns a signed app-origin URL', async () => {
    const registry = await appRegistry();
    await capture('apps/launch/index.html', '3'.repeat(64), 'launch');
    const published = await registry.publish({
      sessionId,
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      userId: fx.userId,
      name: 'launch',
      scope: 'channel',
      entry: 'index.html',
    });
    const app = await buildApp({
      pool,
      sessionSecret: 'session-test-secret',
      sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
    });
    await app.ready();
    try {
      const anon = await app.inject({ method: 'POST', url: `/api/apps/${published.appId}/launch` });
      expect(anon.statusCode).toBe(401);
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { handle: 'alice', displayName: 'Alice' },
      });
      const token = login.json().token as string;
      const launch = await app.inject({
        method: 'POST',
        url: `/api/apps/${published.appId}/launch`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(launch.statusCode).toBe(200);
      const body = launch.json() as { url: string; expires: number; version: number };
      const url = new URL(body.url);
      const parts = url.pathname.split('/');
      expect(parts.slice(-1)[0]).toBe('index.html');
      expect(verifyAppLaunchSignature(
        { appId: published.appId, version: body.version, relPath: '*', expires: body.expires },
        parts[7]!,
        config.appSigningSecret,
      )).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('apps origin', () => {
  it('validates launch signatures and streams CAS/S3 bytes with isolation headers', async () => {
    const registry = await appRegistry();
    await capture('apps/origin/index.html', '4'.repeat(64), '<h1>origin</h1>');
    const published = await registry.publish({
      sessionId,
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      userId: fx.userId,
      name: 'origin',
      scope: 'channel',
      entry: 'index.html',
    });
    const launch = await registry.launch(published.appId, fx.userId);
    const origin = await buildAppsOrigin({
      pool,
      signingSecret: secret,
      storage: {
        getObjectStream: async (key) => Readable.from([bytesByKey.get(key) ?? Buffer.alloc(0)]),
      },
    });
    await origin.ready();
    try {
      const url = new URL(launch.url);
      const res = await origin.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers.location).toBeUndefined();
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.payload).toBe('<h1>origin</h1>');

      const tampered = await origin.inject({ method: 'GET', url: url.pathname.replace('/g/', '/g/1') });
      expect(tampered.statusCode).toBe(401);
    } finally {
      await origin.close();
    }
  });

  it('serves html extensions inline even when captured with generic mime', async () => {
    const registry = await appRegistry();
    await capture('apps/generic-html/index.html', '6'.repeat(64), '<h1>generic</h1>', 'application/octet-stream');
    const published = await registry.publish({
      sessionId,
      workspaceId: fx.workspaceId,
      channelId: fx.channelId,
      userId: fx.userId,
      name: 'generic-html',
      scope: 'channel',
      entry: 'index.html',
    });
    const launch = await registry.launch(published.appId, fx.userId);
    const origin = await buildAppsOrigin({
      pool,
      signingSecret: secret,
      storage: {
        getObjectStream: async (key) => Readable.from([bytesByKey.get(key) ?? Buffer.alloc(0)]),
      },
    });
    await origin.ready();
    try {
      const url = new URL(launch.url);
      const res = await origin.inject({ method: 'GET', url: `${url.pathname}${url.search}` });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.payload).toBe('<h1>generic</h1>');
    } finally {
      await origin.close();
    }
  });
});
