import pg from 'pg';
import { runMigrations } from '../src/migrate.js';
import { createPool } from '../src/db.js';
import { createChannel, createWorkspace } from '../src/events.js';
import { addWorkspaceMember } from '../src/membership.js';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium';
// Overridable so parallel checkouts (worktrees/CI shards) don't truncate each
// other's fixtures mid-test. Identifier-safe names only — it's interpolated
// into CREATE DATABASE.
const TEST_DB = /^[a-z0-9_]{1,40}$/.test(process.env.ATRIUM_TEST_DB ?? '')
  ? process.env.ATRIUM_TEST_DB!
  : 'atrium_test';

/** Create (once) and migrate the dedicated test database. */
export async function createTestPool(): Promise<pg.Pool> {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (!exists.rowCount) {
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  }
  await admin.end();
  const testUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${TEST_DB}`);
  const pool = createPool(testUrl);
  await runMigrations(pool);
  return pool;
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(
    'TRUNCATE idempotency_keys, call_participants, calls, user_drafts, workspace_members, events, channels, workspaces, seat_requests, session_views, sessions, auth_sessions, login_codes, oauth_identities, users RESTART IDENTITY CASCADE',
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
