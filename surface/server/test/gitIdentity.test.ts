import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { Connections } from '../src/connections.js';
import { resolveGitIdentity } from '../src/git-identity.js';
import { createTestPool, seedFixture, seedMember, truncateAll, type Fixture } from './helpers.js';

let pool: pg.Pool;
let fx: Fixture;

beforeAll(async () => {
  pool = await createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await truncateAll(pool);
  fx = await seedFixture(pool);
});

async function setUser(userId: string, displayName: string, email: string | null): Promise<void> {
  await pool.query('UPDATE users SET display_name = $2, email = $3 WHERE id = $1', [userId, displayName, email]);
}

async function addGitHubIdentity(userId: string, accountLogin: string, accountId: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO user_connection_identities
       (workspace_id, user_id, provider, identity_id, status, token_kind, account_login, account_id, active)
     VALUES ($1, $2, 'github', 'github:pat', 'connected', 'pat', $3, $4, true)`,
    [fx.workspaceId, userId, accountLogin, accountId],
  );
}

async function addSession(args: {
  spawnedBy: string;
  credentialOwner?: string | null;
  harness?: string;
}): Promise<{ id: string; threadKey: string }> {
  const threadKey = `git-identity-${randomUUID()}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO sessions
       (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by,
        provider_credential_user_id)
     VALUES ($1, $2, $3, $4, 'git identity', 'running', $5, $6)
     RETURNING id`,
    [fx.workspaceId, fx.channelId, threadKey, args.harness ?? 'codex', args.spawnedBy, args.credentialOwner ?? null],
  );
  return { id: result.rows[0]!.id, threadKey };
}

describe('resolveGitIdentity', () => {
  it('uses the active GitHub login and id for an ID-prefixed noreply address', async () => {
    await setUser(fx.userId, 'Allan Niemerg', 'allan@example.com');
    await addGitHubIdentity(fx.userId, 'aniemerg', '123');
    const session = await addSession({ spawnedBy: fx.userId });

    await expect(resolveGitIdentity(pool, session.id)).resolves.toEqual({
      authorName: 'Allan Niemerg',
      authorEmail: '123+aniemerg@users.noreply.github.com',
      source: 'github_noreply',
      sessionId: session.id,
      harness: 'codex',
    });
  });

  it('falls back to the Atrium email when an existing GitHub identity has no account id', async () => {
    await setUser(fx.userId, 'Allan Niemerg', 'allan@example.com');
    await addGitHubIdentity(fx.userId, 'aniemerg', null);
    const session = await addSession({ spawnedBy: fx.userId });

    await expect(resolveGitIdentity(pool, session.id)).resolves.toMatchObject({
      authorEmail: 'allan@example.com',
      source: 'atrium_account',
    });
  });

  it('uses the Atrium email when no GitHub connection exists', async () => {
    await setUser(fx.userId, 'Allan Niemerg', 'allan@example.com');
    const session = await addSession({ spawnedBy: fx.userId });

    await expect(resolveGitIdentity(pool, session.id)).resolves.toMatchObject({
      authorName: 'Allan Niemerg',
      authorEmail: 'allan@example.com',
      source: 'atrium_account',
    });
  });

  it('returns no identity when neither GitHub nor Atrium supplies an email', async () => {
    await setUser(fx.userId, '', null);
    const session = await addSession({ spawnedBy: fx.userId });

    await expect(resolveGitIdentity(pool, session.id)).resolves.toBeNull();
  });

  it('uses provider_credential_user_id ahead of spawned_by', async () => {
    await setUser(fx.userId, 'Spawner', 'spawner@example.com');
    await addGitHubIdentity(fx.userId, 'spawner', '111');
    const credentialOwnerId = await seedMember(pool, fx.workspaceId, 'owner', 'Credential Owner');
    await pool.query('UPDATE users SET email = $2 WHERE id = $1', [credentialOwnerId, 'owner@example.com']);
    await addGitHubIdentity(credentialOwnerId, 'credential-owner', '456');
    const session = await addSession({ spawnedBy: fx.userId, credentialOwner: credentialOwnerId, harness: 'claude' });

    await expect(resolveGitIdentity(pool, session.id)).resolves.toEqual({
      authorName: 'Credential Owner',
      authorEmail: '456+credential-owner@users.noreply.github.com',
      source: 'github_noreply',
      sessionId: session.id,
      harness: 'claude',
    });
  });

  it('backfills account_id on both live connection tables during the next validation upsert', async () => {
    await setUser(fx.userId, 'Allan Niemerg', 'allan@example.com');
    await addGitHubIdentity(fx.userId, 'aniemerg', null);
    await new Connections(pool).upsertGitHubMetadata({
      workspaceId: fx.workspaceId,
      userId: fx.userId,
      status: 'connected',
      tokenKind: 'pat',
      accountLogin: 'aniemerg',
      accountId: '123',
    });

    const stored = await pool.query<{ table_name: string; account_id: string | null }>(
      `SELECT 'user_connections' AS table_name, account_id
         FROM user_connections
        WHERE workspace_id = $1 AND user_id = $2 AND provider = 'github'
       UNION ALL
       SELECT 'user_connection_identities' AS table_name, account_id
         FROM user_connection_identities
        WHERE workspace_id = $1 AND user_id = $2 AND provider = 'github' AND active
       ORDER BY table_name`,
      [fx.workspaceId, fx.userId],
    );
    expect(stored.rows).toEqual([
      { table_name: 'user_connection_identities', account_id: '123' },
      { table_name: 'user_connections', account_id: '123' },
    ]);
  });
});

describe('GET /api/internal/sessions/:id/git-identity', () => {
  it('returns 204 with no body when identity resolution is unavailable', async () => {
    await setUser(fx.userId, '', null);
    const session = await addSession({ spawnedBy: fx.userId });
    const app = await buildApp({
      pool,
      artifactCaptureApiKey: 'git-identity-test-key',
      sessionRuns: { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', autoResume: false },
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/internal/sessions/${session.threadKey}/git-identity`,
        headers: { 'x-api-key': 'git-identity-test-key' },
      });
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
    } finally {
      await app.close();
    }
  });
});
