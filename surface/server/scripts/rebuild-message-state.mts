import { createPool } from '../src/db.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) refuse('DATABASE_URL is required');

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== '--yes') {
  refuse('refusing to rebuild message_state without the explicit --yes flag');
}

const pool = createPool(databaseUrl);
const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query('TRUNCATE message_state');
  await client.query('SELECT project_message_event(id) FROM events ORDER BY id');
  const count = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM message_state');
  await client.query('COMMIT');
  console.log(`message_state rebuilt: ${count.rows[0]?.count ?? 0} rows`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  client.release();
  await pool.end();
}

function refuse(message: string): never {
  console.error(message);
  console.error('usage: DATABASE_URL=postgres://... tsx scripts/rebuild-message-state.mts --yes');
  process.exit(1);
}
