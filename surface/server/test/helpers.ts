import pg from 'pg';
import { runMigrations } from '../src/migrate.js';
import { createPool } from '../src/db.js';
import { createChannel, createWorkspace } from '../src/events.js';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium';
const TEST_DB = 'atrium_test';

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
    'TRUNCATE events, channels, workspaces, sessions, auth_sessions, users RESTART IDENTITY CASCADE',
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
  return {
    workspaceId: workspace.id,
    channelId: channel.id,
    otherChannelId: other.id,
    userId: user.rows[0]!.id,
  };
}
