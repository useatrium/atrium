// Seed for the /atrium daemon e2e: a viewer session + a target session with
// projected records (so /atrium has content the daemon can materialize).
// Prints {viewer, target} as JSON on the last line.
import pg from 'pg';
import { projectAndEmitChange } from '../src/session-record-changefeed.js';

const DB = process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium';
const pool = new pg.Pool({ connectionString: DB });

// A real user + workspace + public channel (reuse the first public channel, or
// bootstrap one). The default-workspace bootstrap runs on server start.
const ws = await pool.query<{ id: string }>(`SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1`);
const workspaceId = ws.rows[0]!.id;
const ch = await pool.query<{ id: string }>(
  `SELECT id FROM channels WHERE workspace_id=$1 AND kind='public' ORDER BY created_at ASC LIMIT 1`,
  [workspaceId],
);
const channelId = ch.rows[0]!.id;
const usr = await pool.query<{ id: string }>(
  `INSERT INTO users (handle, display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id`,
  [`atrium-e2e-${Date.now()}`, 'Atrium E2E'],
);
const userId =
  usr.rows[0]?.id ??
  (await pool.query<{ id: string }>(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`)).rows[0]!.id;
// ensure workspace membership so public-channel sessions are visible
await pool.query(
  `INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
  [workspaceId, userId],
);

async function mk(title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, channel_id, centaur_thread_key, harness, title, status, spawned_by)
     VALUES ($1,$2,$3,'codex',$4,'completed',$5) RETURNING id`,
    [workspaceId, channelId, `atrium-e2e:${Date.now()}:${Math.round(performance.now())}`, title, userId],
  );
  return r.rows[0]!.id;
}
const viewer = await mk('Atrium e2e viewer');
const target = await mk('Snorkelwacker indexing bug');

const item = (id: string, t: string, x: Record<string, unknown>) => ({ type: 'item.completed', item: { id, type: t, ...x } });
const frames = [
  item('u1', 'userMessage', { text: 'Why does the snorkelwacker index skip every third row?' }),
  item('a1', 'agentMessage', { text: 'The snorkelwacker cursor advances twice on a tie.' }),
  item('r1', 'reasoning', { text: 'FULL-TIER-SECRET-REASONING: the tiebreak compares by xid only.' }),
];
let e = 1;
for (const data of frames)
  await pool.query(
    `INSERT INTO session_events (session_id, centaur_event_id, event_kind, frame) VALUES ($1,$2,'amp_raw_event',$3) ON CONFLICT DO NOTHING`,
    [target, e++, JSON.stringify({ event: 'amp_raw_event', event_id: e, data })],
  );
await projectAndEmitChange(pool, target);
console.log(JSON.stringify({ viewer, target, userId }));
await pool.end();
