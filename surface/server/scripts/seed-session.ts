// Seed a workspace/channel/user/session in the live DB and print {sessionId,
// channelId} as JSON — for the distributed daemon e2e.
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db.js';
import { createWorkspace, createChannel } from '../src/events.js';
import { addWorkspaceMember } from '../src/membership.js';

async function main() {
  const pool = createPool(process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium');
  const { workspace } = await createWorkspace(pool, { name: `daemon-e2e-${randomUUID().slice(0, 8)}` });
  const { channel } = await createChannel(pool, { workspaceId: workspace.id, name: 'general' });
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (handle, display_name) VALUES ($1,'Daemon E2E') RETURNING id`,
    [`de2e-${randomUUID().slice(0, 8)}`],
  );
  await addWorkspaceMember(pool, workspace.id, user.rows[0]!.id);
  const session = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, title, status, spawned_by)
     VALUES ($1,$2,$3,'daemon-e2e','running',$4) RETURNING id`,
    [workspace.id, channel.id, `tk-${randomUUID()}`, user.rows[0]!.id],
  );
  console.log(JSON.stringify({ sessionId: session.rows[0]!.id, channelId: channel.id }));
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
