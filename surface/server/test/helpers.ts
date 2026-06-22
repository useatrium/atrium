import pg from 'pg';
import { runMigrations } from '../src/migrate.js';
import { createPool } from '../src/db.js';
import { createChannel, createWorkspace } from '../src/events.js';
import { addWorkspaceMember } from '../src/membership.js';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium';
const DB_NAME_RE = /^[a-z0-9_]{1,40}$/;
const TEST_DB_BASE = DB_NAME_RE.test(process.env.ATRIUM_TEST_DB ?? '')
  ? process.env.ATRIUM_TEST_DB!
  : 'atrium_test';
const VITEST_POOL_ID = /^\d{1,3}$/.test(process.env.VITEST_POOL_ID ?? '') ? process.env.VITEST_POOL_ID! : null;
const TEST_DB = testDatabaseName(TEST_DB_BASE, VITEST_POOL_ID);
const TEMPLATE_DB = testDatabaseName(TEST_DB_BASE, 'template');
const TEST_DB_SETUP_LOCK = 727272;

function testDatabaseName(base: string, poolId: string | null): string {
  if (!poolId) return base;

  const suffix = `_w${poolId}`;
  return `${base.slice(0, 40 - suffix.length)}${suffix}`;
}

/** Create (once) and migrate the dedicated test database. */
export async function createTestPool(): Promise<pg.Pool> {
  await ensureTestDatabase();
  const testUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);
  const pool = createPool(testUrl);
  await runMigrations(pool);
  return pool;
}

async function ensureTestDatabase(): Promise<void> {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  try {
    if (!VITEST_POOL_ID) {
      await ensureDatabase(admin, TEST_DB);
      return;
    }

    await admin.query('SELECT pg_advisory_lock($1)', [TEST_DB_SETUP_LOCK]);
    try {
      await ensureDatabase(admin, TEMPLATE_DB);
      const templateUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${TEMPLATE_DB}`);
      const templatePool = createPool(templateUrl);
      try {
        await runMigrations(templatePool);
      } finally {
        await templatePool.end();
      }
      await ensureDatabase(admin, TEST_DB, TEMPLATE_DB);
    } finally {
      await admin.query('SELECT pg_advisory_unlock($1)', [TEST_DB_SETUP_LOCK]).catch(() => {});
    }
  } finally {
    await admin.end();
  }
}

async function ensureDatabase(admin: pg.Pool, dbName: string, templateDb?: string): Promise<void> {
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount) return;

  try {
    await admin.query(templateDb ? `CREATE DATABASE ${dbName} TEMPLATE ${templateDb}` : `CREATE DATABASE ${dbName}`);
  } catch (err) {
    if ((err as { code?: string })?.code !== '42P04') throw err;
  }
}

/**
 * Retry a query on a Postgres deadlock (40P01). Test files now get
 * worker-scoped databases, but the reset below is idempotent and this remains
 * a cheap guard for any in-file concurrent setup/teardown.
 */
export async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if ((err as { code?: string })?.code === '40P01' && attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
        continue;
      }
      throw err;
    }
  }
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await withDeadlockRetry(() =>
    pool.query(
      'TRUNCATE idempotency_keys, call_participants, calls, user_drafts, workspace_members, events, channels, workspaces, seat_requests, session_views, sessions, auth_sessions, login_codes, oauth_identities, users RESTART IDENTITY CASCADE',
    ),
  );
}

export interface Fixture {
  workspaceId: string;
  channelId: string;
  otherChannelId: string;
  userId: string;
}

export async function seedFixture(pool: pg.Pool): Promise<Fixture> {
  const { workspace } = await createWorkspace(pool, { name: 'testws' });
  const { channel } = await createChannel(pool, { workspaceId: workspace.id, name: 'general' });
  const { channel: other } = await createChannel(pool, {
    workspaceId: workspace.id,
    name: 'random',
  });
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (handle, display_name) VALUES ('alice', 'Alice') RETURNING id`,
  );
  await addWorkspaceMember(pool, workspace.id, user.rows[0]!.id);
  return {
    workspaceId: workspace.id,
    channelId: channel.id,
    otherChannelId: other.id,
    userId: user.rows[0]!.id,
  };
}

/** Create a user and join them to the workspace — the post-tenancy default. */
export async function seedMember(
  pool: pg.Pool,
  workspaceId: string,
  handle: string,
  displayName = handle,
): Promise<string> {
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (handle, display_name) VALUES ($1, $2) RETURNING id`,
    [handle, displayName],
  );
  await addWorkspaceMember(pool, workspaceId, user.rows[0]!.id);
  return user.rows[0]!.id;
}
