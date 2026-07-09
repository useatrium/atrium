import pg from 'pg';

// events.id is bigserial (int8). Values stay far below 2^53 for this
// prototype, so parse as JS number instead of string.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // Without an 'error' listener, an idle client dying (e.g. Postgres shutting
  // down under the server) is an unhandled 'error' event that kills the process.
  pool.on('error', (err) => {
    console.error('pg pool: idle client error', err);
  });
  return pool;
}

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

/** Run fn inside a transaction. */
export async function withTx<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
