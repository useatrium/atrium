// Spawns the live "hero" demo session (scripted via demo-scripts.json) as maya
// into #eng-platform and dresses it to read as a real claude-code run.
// Prints JSON {sessionId, channelId} on the last line.
//
// Requires: seed-demo-workspace.mts already ran; server running with
// ATRIUM_DEMO_SCRIPT_PATH=server/scripts/demo-scripts.json.

import pg from 'pg';

const API = process.env.ATRIUM_API ?? 'http://localhost:3210';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_demo';
const pool = new pg.Pool({ connectionString: DATABASE_URL });

const loginRes = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ handle: 'maya', displayName: 'Maya Chen' }),
});
if (!loginRes.ok) throw new Error(`login: ${loginRes.status}`);
const cookie = loginRes.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');

const chRes = await fetch(`${API}/api/channels`, { headers: { cookie } });
const { channels } = (await chRes.json()) as { channels: Array<{ id: string; name: string }> };
const channel = channels.find((c) => c.name === 'eng-platform');
if (!channel) throw new Error('eng-platform channel not found — run seed-demo-workspace.mts first');

const spawnRes = await fetch(`${API}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({
    channelId: channel.id,
    task: "Fix the retry backoff in the ingestion worker — batches stall in pending_ocr whenever the OCR pool cold-starts. While you're in there, add a queue-depth log line on every retry.",
    harness: 'demo',
  }),
});
if (!spawnRes.ok) throw new Error(`spawn: ${spawnRes.status} ${await spawnRes.text()}`);
const spawned = (await spawnRes.json()) as { session?: { id: string }; id?: string };
const sessionId = spawned.session?.id ?? spawned.id;
if (!sessionId) throw new Error(`no session id in ${JSON.stringify(spawned)}`);

await pool.query(`UPDATE sessions SET title=$2, harness=$3, repo=$4, branch=$5 WHERE id=$1`, [
  sessionId,
  'Fix retry backoff in ingestion worker',
  'claude-code',
  'meridian/atlas',
  'fix/ingest-backoff',
]);
await pool.query(
  `UPDATE events SET payload = payload || jsonb_build_object('title', $2::text)
   WHERE type='session.spawned' AND payload->>'sessionId' = $1`,
  [sessionId, 'Fix retry backoff in ingestion worker'],
);
await pool.end();
console.log(JSON.stringify({ sessionId, channelId: channel.id }));
