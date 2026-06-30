import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
export const defaultMigrationsDir = join(here, '..', 'migrations');

export async function runMigrations(
  pool: pg.Pool,
  dir: string = defaultMigrationsDir,
): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    // Serialize concurrent migrators (e.g. two dev servers booting).
    await client.query('SELECT pg_advisory_lock(727271)');
    for (const file of files) {
      const seen = await client.query(
        'SELECT 1 FROM schema_migrations WHERE name = $1',
        [file],
      );
      if (seen.rowCount) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727271)').catch(() => {});
    client.release();
  }
  return applied;
}

// CLI entry: `pnpm migrate`.
// NOTE: in the production server this module is bundled into dist/index.js by
// esbuild, so import.meta.url === pathToFileURL(argv[1]) would be true even when
// started as the server — firing a SECOND runMigrations on its own pool that
// races main()'s on `CREATE TABLE IF NOT EXISTS schema_migrations`
// ("duplicate key ... pg_type_typname_nsp_index"). Require the entry file to
// actually be this migrate module so the CLI path only runs under `pnpm migrate`.
const invokedDirectly =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /(^|[\\/])migrate\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  runMigrations(pool)
    .then((applied) => {
      if (applied.length === 0) console.log('migrations: up to date');
      else console.log(`migrations applied: ${applied.join(', ')}`);
      return pool.end();
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
