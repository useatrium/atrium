// Seed for the /atrium ACL-isolation e2e: a PRIVATE target session that viewer A
// can see (channel member) but viewer B cannot (non-member). Prints
// {viewerA, viewerB, target} JSON.
import pg from 'pg';
import { projectAndEmitChange } from '../src/session-record-changefeed.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium',
});
const ws = (await pool.query<{ id: string }>(`SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1`)).rows[0]!.id;
const pubCh = (
  await pool.query<{ id: string }>(
    `SELECT id FROM channels WHERE workspace_id=$1 AND kind='public' ORDER BY created_at ASC LIMIT 1`,
    [ws],
  )
).rows[0]!.id;

async function user(handle: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (handle, display_name) VALUES ($1,$2) ON CONFLICT (handle) DO UPDATE SET handle=EXCLUDED.handle RETURNING id`,
    [`${handle}-${Date.now()}`, handle],
  );
  await pool.query(`INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [
    ws,
    r.rows[0]!.id,
  ]);
  return r.rows[0]!.id;
}
const alice = await user('iso-alice');
const bob = await user('iso-bob');

// a PRIVATE channel; only Alice is a member
const priv = (
  await pool.query<{ id: string }>(
    `INSERT INTO channels (workspace_id, name, kind) VALUES ($1,$2,'private') RETURNING id`,
    [ws, `iso-secret-${Date.now()}`],
  )
).rows[0]!.id;
await pool.query(`INSERT INTO channel_members (channel_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [
  priv,
  alice,
]);

async function session(channelId: string, spawnedBy: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by)
     VALUES ($1,$2,$3,'codex',$4,'completed',$5) RETURNING id`,
    [ws, channelId, `iso:${Date.now()}:${Math.round(performance.now())}`, title, spawnedBy],
  );
  return r.rows[0]!.id;
}
// the private target (in the private channel, spawned by Alice) + records
const target = await session(priv, alice, 'Classified zibblefarb audit');
const item = (id: string, t: string, x: Record<string, unknown>) => ({
  type: 'item.completed',
  item: { id, type: t, ...x },
});
const frames = [
  item('u1', 'userMessage', { text: 'Audit the classified zibblefarb pipeline' }),
  item('a1', 'agentMessage', { text: 'The zibblefarb token rotates on each call.' }),
];
let e = 1;
for (const data of frames)
  await pool.query(
    `INSERT INTO session_events (session_id, centaur_event_id, event_kind, frame) VALUES ($1,$2,'amp_raw_event',$3) ON CONFLICT DO NOTHING`,
    [target, e++, JSON.stringify({ event: 'amp_raw_event', event_id: e, data })],
  );
await projectAndEmitChange(pool, target);

// viewer sessions (in the public channel) for each user
const viewerA = await session(pubCh, alice, 'Alice viewer');
const viewerB = await session(pubCh, bob, 'Bob viewer');
console.log(JSON.stringify({ viewerA, viewerB, target }));
await pool.end();
