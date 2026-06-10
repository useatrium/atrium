import pg from 'pg';

// events.id is bigserial (int8). Values stay far below 2^53 for this
// prototype, so parse as JS number instead of string.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
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
