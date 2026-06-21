import net from 'node:net';
import pg from 'pg';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_e2e';
const adminUrl = databaseUrl.replace(/\/[^/]*$/, '/atrium');
const dbName = databaseUrl.match(/\/([^/?]+)(?:[?].*)?$/)?.[1] ?? 'atrium_e2e';
const serverPort = Number(process.env.E2E_SERVER_PORT ?? process.env.PORT ?? 3101);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5273);

async function assertPortFree(port, label) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => {
      reject(
        new Error(
          `${label} port ${port} is already in use. Stop the dev stack before running e2e, or set E2E_SERVER_PORT/E2E_WEB_PORT to free ports.`,
        ),
      );
    });
    server.once('listening', () => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function createDatabase() {
  if (!/^[a-z0-9_]{1,40}$/.test(dbName)) {
    throw new Error(`Unsafe e2e database name: ${dbName}`);
  }
  const admin = new pg.Pool({ connectionString: adminUrl });
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
}

async function truncateDatabase() {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`
      TRUNCATE
        channel_read_cursors,
        push_tokens,
        channel_members,
        files,
        session_views,
        seat_requests,
        events,
        channels,
        workspaces,
        sessions,
        auth_sessions,
        users,
        -- cas_blobs is content-addressed (no session FK), so the sessions
        -- CASCADE never reaches it. Without this, a reused local DB keeps
        -- cas_blobs rows with s3_key stamped; blobIsOffloaded then skips the
        -- re-upload, and a write-back read 500s if the bytes aren't in the
        -- current object store.
        cas_blobs
      RESTART IDENTITY CASCADE
    `);
  } catch (err) {
    if (err?.code !== '42P01') throw err;
  } finally {
    await pool.end();
  }
}

await Promise.all([
  assertPortFree(serverPort, 'API server'),
  assertPortFree(webPort, 'web client'),
]);
await createDatabase();
await truncateDatabase();
