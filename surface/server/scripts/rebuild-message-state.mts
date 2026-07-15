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
  // Chunked rather than one transaction: each projection takes a
  // pg_advisory_xact_lock held until its transaction ends, so a single-tx
  // rebuild would exhaust the shared lock table on a large events table.
  // The projection is derived state, so a rebuild interrupted mid-way is
  // harmless — rerun it. The watermark upsert also makes it safe to run
  // against a live writer.
  await client.query('TRUNCATE message_state');
  const idRange = await client.query<{ min_id: string; max_id: string }>(
    'SELECT min(id)::text AS min_id, max(id)::text AS max_id FROM events',
  );
  const minId = Number(idRange.rows[0]?.min_id ?? 0);
  const maxId = Number(idRange.rows[0]?.max_id ?? -1);
  const CHUNK = 5000;
  for (let lo = minId; lo <= maxId; lo += CHUNK) {
    await client.query('SELECT project_message_event(id) FROM events WHERE id >= $1 AND id < $2 ORDER BY id', [
      lo,
      lo + CHUNK,
    ]);
  }
  const count = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM message_state');
  console.log(`message_state rebuilt: ${count.rows[0]?.count ?? 0} rows`);
} finally {
  client.release();
  await pool.end();
}

function refuse(message: string): never {
  console.error(message);
  console.error('usage: DATABASE_URL=postgres://... tsx scripts/rebuild-message-state.mts --yes');
  process.exit(1);
}
