import pg from 'pg';
import { runMigrations } from '../src/migrate.js';
import { createPool } from '../src/db.js';
import { createChannel, createWorkspace } from '../src/events.js';
import { addWorkspaceMember } from '../src/membership.js';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium';
const DB_NAME_RE = /^[a-z0-9_]{1,40}$/;
const PID_RE = /^[1-9]\d{0,9}$/;
const POOL_ID_RE = /^\d{1,3}$/;
const TEST_DB_BASE = DB_NAME_RE.test(process.env.ATRIUM_TEST_DB ?? '')
  ? process.env.ATRIUM_TEST_DB!
  : 'atrium_test';
const TEST_DB_SETUP_LOCK = 727272;

interface TestDatabaseConfig {
  poolId: string | null;
  runId: string | null;
  testDb: string;
  templateDb: string;
}

function currentVitestPoolId(): string | null {
  return POOL_ID_RE.test(process.env.VITEST_POOL_ID ?? '') ? process.env.VITEST_POOL_ID! : null;
}

function currentTestRunId(): string {
  if (PID_RE.test(process.env.ATRIUM_TEST_RUN_ID ?? '')) return process.env.ATRIUM_TEST_RUN_ID!;

  // Vitest's fork workers for one run share the main Vitest process as ppid.
  // globalSetup publishes that pid, but this keeps scratch/manual runs isolated too.
  const parentPid = String(process.ppid);
  if (!PID_RE.test(parentPid)) throw new Error(`Invalid Vitest parent pid for test database: ${parentPid}`);
  return parentPid;
}

function resolveTestDatabaseConfig(): TestDatabaseConfig {
  const poolId = currentVitestPoolId();
  const runId = poolId ? currentTestRunId() : null;
  return {
    poolId,
    runId,
    testDb: testDatabaseName(TEST_DB_BASE, poolId, runId),
    templateDb: templateDatabaseName(TEST_DB_BASE),
  };
}

function testDatabaseName(base: string, poolId: string | null, runId: string | null): string {
  if (!poolId) return base;

  return databaseNameWithSuffix(base, runId ? `_w${poolId}_p${runId}` : `_w${poolId}`);
}

function templateDatabaseName(base: string): string {
  return databaseNameWithSuffix(base, '_wtemplate');
}

function databaseNameWithSuffix(base: string, suffix: string): string {
  if (suffix.length > 40) throw new Error(`Test database suffix is too long: ${suffix}`);

  const name = `${base.slice(0, 40 - suffix.length)}${suffix}`;
  if (!DB_NAME_RE.test(name)) throw new Error(`Invalid test database name: ${name}`);
  return name;
}

/** Create (once) and migrate the dedicated test database. */
export async function createTestPool(): Promise<pg.Pool> {
  const config = resolveTestDatabaseConfig();
  await ensureTestDatabase(config);
  const testUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${config.testDb}`);
  const pool = createPool(testUrl);
  await runMigrations(pool);
  return pool;
}

async function ensureTestDatabase(config: TestDatabaseConfig): Promise<void> {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  try {
    if (!config.poolId) {
      await ensureDatabase(admin, config.testDb);
      return;
    }

    await admin.query('SELECT pg_advisory_lock($1)', [TEST_DB_SETUP_LOCK]);
    try {
      await reapStaleRunDatabases(admin);
      await ensureDatabase(admin, config.templateDb);
      const templateUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${config.templateDb}`);
      const templatePool = createPool(templateUrl);
      try {
        await runMigrations(templatePool);
      } finally {
        await templatePool.end();
      }
      await ensureDatabase(admin, config.testDb, config.templateDb);
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

export async function dropTestDatabasesForRun(runId: string): Promise<void> {
  if (!PID_RE.test(runId)) return;

  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  try {
    const dbNames = await listManagedRunDatabases(admin, runId);
    for (const dbName of dbNames) {
      await dropDatabase(admin, dbName).catch(() => {});
    }
  } finally {
    await admin.end();
  }
}

async function reapStaleRunDatabases(admin: pg.Pool): Promise<void> {
  const dbNames = await listManagedRunDatabases(admin);
  for (const dbName of dbNames) {
    const parsed = parseRunDatabaseName(dbName);
    if (!parsed || isPidAlive(Number.parseInt(parsed.runId, 10))) continue;

    await dropDatabase(admin, dbName).catch(() => {});
  }
}

async function listManagedRunDatabases(admin: pg.Pool, runId?: string): Promise<string[]> {
  const result = await admin.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname LIKE $1 ESCAPE '\\'",
    ['%\\_w%\\_p%'],
  );

  return result.rows.flatMap(({ datname }) => {
    const parsed = parseRunDatabaseName(datname);
    if (!parsed || (runId && parsed.runId !== runId)) return [];
    if (datname !== testDatabaseName(TEST_DB_BASE, parsed.poolId, parsed.runId)) return [];
    return [datname];
  });
}

function parseRunDatabaseName(dbName: string): { poolId: string; runId: string } | null {
  if (!DB_NAME_RE.test(dbName)) return null;

  const match = /_w(\d{1,3})_p([1-9]\d{0,9})$/.exec(dbName);
  if (!match) return null;

  return { poolId: match[1]!, runId: match[2]! };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function dropDatabase(admin: pg.Pool, dbName: string): Promise<void> {
  if (!DB_NAME_RE.test(dbName)) return;
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
}

/**
 * Retry a query on a Postgres deadlock (40P01). Test files now get
 * run+worker-scoped databases, but the reset below is idempotent and this
 * remains a cheap guard for any in-file concurrent setup/teardown.
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
