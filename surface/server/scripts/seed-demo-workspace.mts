// Seed a demo workspace with realistic activity for screenshots and demos.
//
// Wipes the target database (all rows, not the schema), then builds a small
// fictional team — Meridian Labs, mixed engineering + research — with channels,
// conversations, threads, mentions, reactions, uploads, unread state, a missed
// call, and scripted agent sessions (completed with artifacts + a published
// app, one failed, one parked on a pending question).
//
// Usage:
//   DATABASE_URL=postgres://atrium:atrium@localhost:5433/atrium_demo \
//   ATRIUM_API=http://localhost:3210 \
//   S3_BUCKET=atrium-demo \
//   pnpm --filter @atrium/server exec tsx scripts/seed-demo-workspace.mts [--assets <dir>]
//
// The server must be running against the same database AND with
// ATRIUM_DEMO_SCRIPT_PATH=server/scripts/demo-scripts.json (the scripted
// transcripts). Screenshot pipeline: run this, then e2e/capture-demo-shots.mjs.
// Never point this at a real deployment: the wipe is unconditional.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { writeBackArtifact } from '../src/artifact-writeback.js';
import { uploadObject, getObjectBytes, headObject } from '../src/s3.js';
import { projectAndEmitChange } from '../src/session-record-changefeed.js';

const API = process.env.ATRIUM_API ?? 'http://localhost:3210';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5433/atrium_demo';
const ASSETS_DIR = argValue('--assets') ?? new URL('./demo-assets', import.meta.url).pathname;

if (!/demo/.test(DATABASE_URL)) {
  console.error(`refusing to wipe non-demo database: ${DATABASE_URL}`);
  console.error('(the database name must contain "demo")');
  process.exit(1);
}

const WORKSPACE_NAME = 'Meridian Labs';

// ---------------------------------------------------------------------------
// Small HTTP client with per-user cookies
// ---------------------------------------------------------------------------

type Actor = { handle: string; displayName: string; cookie: string; id: string };

async function login(handle: string, displayName: string): Promise<Actor> {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, displayName }),
  });
  if (!res.ok) throw new Error(`login ${handle}: ${res.status} ${await res.text()}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  if (!cookie) throw new Error(`login ${handle}: no session cookie`);
  const me = (await api({ handle, displayName, cookie, id: '' }, 'GET', '/auth/me')) as {
    user: { id: string };
  };
  return { handle, displayName, cookie, id: me.user.id };
}

async function api(actor: Actor, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: actor.cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} as ${actor.handle}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let msgCounter = 0;
function clientMsgId(): string {
  msgCounter += 1;
  return `seed-${Date.now().toString(36)}-${msgCounter}`;
}

// ---------------------------------------------------------------------------
// Seeding primitives
// ---------------------------------------------------------------------------

const backdates: Array<{ id: number; at: Date }> = [];

async function post(
  actor: Actor,
  channelId: string,
  text: string,
  at: Date,
  opts: { thread?: number; attachments?: string[] } = {},
): Promise<number> {
  const body: Record<string, unknown> = { channelId, text, clientMsgId: clientMsgId() };
  if (opts.thread != null) body.threadRootEventId = opts.thread;
  if (opts.attachments) body.attachments = opts.attachments;
  const res = (await api(actor, 'POST', '/api/messages', body)) as { event: { id: number } };
  backdates.push({ id: res.event.id, at });
  return res.event.id;
}

async function react(actor: Actor, eventId: number, emoji: string): Promise<void> {
  await api(actor, 'POST', `/api/messages/${eventId}/reactions`, { emoji, action: 'add' });
}

async function markRead(actor: Actor, channelId: string, lastReadEventId: number): Promise<void> {
  await api(actor, 'POST', `/api/channels/${channelId}/read`, { lastReadEventId });
}

async function upload(actor: Actor, filename: string, contentType: string, bytes: Buffer): Promise<string> {
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const created = (await api(actor, 'POST', '/api/uploads', {
    filename,
    contentType,
    size: bytes.byteLength,
    contentHash,
  })) as { fileId: string; uploadUrl: string };
  const put = await fetch(created.uploadUrl.startsWith('http') ? created.uploadUrl : `${API}${created.uploadUrl}`, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: bytes,
  });
  if (!put.ok) throw new Error(`upload PUT ${filename}: ${put.status}`);
  return created.fileId;
}

async function tryReadAsset(name: string): Promise<Buffer | null> {
  try {
    return await readFile(join(ASSETS_DIR, name));
  } catch {
    return null;
  }
}

// --- scripted agent sessions (server must run with ATRIUM_DEMO_SCRIPT_PATH) --

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

async function spawnScripted(
  actor: Actor,
  channelId: string,
  task: string,
  wait: 'terminal' | { frames: number },
): Promise<string> {
  const res = (await api(actor, 'POST', '/api/sessions', { channelId, task, harness: 'demo' })) as {
    session?: { id: string };
    id?: string;
  };
  const sessionId = res.session?.id ?? res.id;
  if (!sessionId) throw new Error(`spawn returned no session id: ${JSON.stringify(res)}`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`session ${sessionId} (${task.slice(0, 40)}…) did not settle`);
    if (wait === 'terminal') {
      const s = (await api(actor, 'GET', `/api/sessions/${sessionId}`)) as {
        session?: { status?: string };
        status?: string;
      };
      const status = s.session?.status ?? s.status;
      if (status && TERMINAL.has(status)) break;
    } else {
      const { rows } = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM session_events WHERE session_id = $1',
        [sessionId],
      );
      if (Number(rows[0]?.n ?? 0) >= wait.frames) break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return sessionId;
}

// Rewrites the staging fields on a scripted session so it reads as a real run.
async function dressSession(
  sessionId: string,
  opts: { title: string; harness: string; createdAt: Date; completedAt?: Date; repo?: string; branch?: string },
): Promise<void> {
  await pool.query(
    `UPDATE sessions SET title=$2, harness=$3, created_at=$4, completed_at=$5, repo=$6, branch=$7 WHERE id=$1`,
    [
      sessionId,
      opts.title,
      opts.harness,
      opts.createdAt,
      opts.completedAt ?? null,
      opts.repo ?? null,
      opts.branch ?? null,
    ],
  );
  await pool.query(
    `UPDATE events SET created_at=$2, payload = payload || jsonb_build_object('title', $3::text)
     WHERE type='session.spawned' AND payload->>'sessionId' = $1`,
    [sessionId, opts.createdAt, opts.title],
  );
  await pool.query(
    `UPDATE events SET created_at=$2 WHERE type LIKE 'session.%' AND type <> 'session.spawned' AND payload->>'sessionId' = $1`,
    [sessionId, opts.completedAt ?? opts.createdAt],
  );
  await pool
    .query('UPDATE session_records SET ts=$2 WHERE session_id=$1', [sessionId, opts.completedAt ?? opts.createdAt])
    .catch(() => {});
}

const storage = { uploadObject, getObjectBytes, headObject };

async function addArtifact(
  sessionId: string,
  channelId: string,
  path: string,
  bytes: Buffer,
  mime: string,
  at: Date,
): Promise<void> {
  const result = await writeBackArtifact({
    pool,
    storage,
    channelId,
    sessionId,
    path,
    bytes,
    mime,
    author: 'agent:demo',
  });
  if (!result.ok) throw new Error(`writeBackArtifact ${path}: ${JSON.stringify(result)}`);
  const fullPath = path.startsWith('shared/') ? path : `shared/channels/${channelId}/${path}`;
  const sha = createHash('sha256').update(bytes).digest('hex');
  const { rows } = await pool.query<{ max: string }>(
    'SELECT COALESCE(MAX(centaur_event_id), 0)::text AS max FROM session_events WHERE session_id = $1',
    [sessionId],
  );
  const eventId = Number(rows[0]?.max ?? 0) + 1;
  const frame = {
    event: 'artifact.captured',
    event_id: eventId,
    data: {
      type: 'artifact.captured',
      artifact_id: sha,
      execution_id: `exec-demo-${sessionId.slice(0, 8)}`,
      path: fullPath,
      kind: 'created',
      mime,
      size_bytes: bytes.byteLength,
      sha256: sha,
      ref: null,
    },
  };
  await pool.query(
    `INSERT INTO session_events (session_id, centaur_event_id, event_kind, frame) VALUES ($1, $2, $3, $4)`,
    [sessionId, eventId, frame.event, JSON.stringify(frame)],
  );
  // Best-effort backdating of the ledger timestamps the UI displays.
  await pool.query('UPDATE artifacts SET created_at=$2 WHERE session_id=$1', [sessionId, at]).catch(() => {});
  await pool
    .query(
      `UPDATE artifact_versions av SET created_at=$2 FROM artifacts a WHERE av.artifact_id=a.id AND a.session_id=$1`,
      [sessionId, at],
    )
    .catch(() => {});
}

// Times: anchor "now" and express message times as offsets so the seeded
// history always sits just behind the capture moment.
const NOW = Date.now();
const min = (n: number) => new Date(NOW - n * 60_000);
const hours = (n: number) => new Date(NOW - n * 3_600_000);
const days = (n: number, hh = 10, mm = 0) => {
  const d = new Date(NOW - n * 86_400_000);
  d.setHours(hh, mm, 0, 0);
  return d;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function wipe(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}

async function main(): Promise<void> {
  console.log(`wiping ${DATABASE_URL} ...`);
  await wipe();

  console.log('creating users ...');
  // Hero first: first login creates the default workspace + #general.
  const maya = await login('maya', 'Maya Chen');
  const jonas = await login('jonas', 'Jonas Weber');
  const priya = await login('priya', 'Priya Nair');
  const sam = await login('sam', 'Sam Okafor');
  const elena = await login('elena', 'Elena Sato');
  const rafa = await login('rafa', 'Rafael Ortiz');
  const team = [maya, jonas, priya, sam, elena, rafa];

  await pool.query('UPDATE workspaces SET name = $1', [WORKSPACE_NAME]);
  // Screenshots are shot in light mode; pin it for every seeded user.
  await pool.query(`UPDATE users SET prefs = prefs || '{"theme":"light"}'::jsonb`);

  console.log('creating channels ...');
  const mkChannel = async (name: string, isPrivate = false): Promise<string> => {
    const res = (await api(maya, 'POST', '/api/channels', { name, ...(isPrivate ? { private: true } : {}) })) as {
      channel: { id: string };
    };
    return res.channel.id;
  };
  const channelsRes = (await api(maya, 'GET', '/api/channels')) as { channels: Array<{ id: string; name: string }> };
  const general = channelsRes.channels.find((c) => c.name === 'general')?.id;
  if (!general) throw new Error('default #general not found');
  const engPlatform = await mkChannel('eng-platform');
  const research = await mkChannel('research');
  const dataPipeline = await mkChannel('data-pipeline');
  const releases = await mkChannel('releases');
  const incidents = await mkChannel('incidents', true);

  // Memberships via SQL: the members endpoint would post "added X" system
  // events into the timelines we are about to stage.
  const publicChannels = [general, engPlatform, research, dataPipeline, releases];
  for (const ch of publicChannels) {
    for (const u of team) {
      await pool.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        ch,
        u.id,
      ]);
    }
  }
  for (const u of [maya, jonas, rafa]) {
    await pool.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      incidents,
      u.id,
    ]);
  }

  console.log('posting conversations ...');
  const mention = (u: Actor) => `<@${u.id}>`;

  // NOTE on ordering: the timeline and the Attention feed sort by event id,
  // not created_at — so everything below is posted in one global chronological
  // sequence, and the backdated times must stay monotonic for any item that
  // lands in Maya's attention feed (mentions, DM posts, reactions to her
  // messages, calls, session events).

  // --- two days ago → yesterday morning ---------------------------------------
  await post(
    elena,
    general,
    'reading group is Thursday 4pm — this week is "Latent Consistency Distillation". Priya has the annotated copy',
    days(2, 9, 40),
  );
  const g2 = await post(
    rafa,
    general,
    'espresso machine on 4 is fixed. it was the pump, not your technique',
    days(1, 8, 55),
  );
  await react(sam, g2, '🎉');
  await react(priya, g2, '🎉');

  // #data-pipeline — yesterday's backfill incident (messages only; the
  // embeddings session comes later, in chronological position)
  const chartBytes = await tryReadAsset('queue-depth.png');
  let dp1: number;
  if (chartBytes) {
    const chartFile = await upload(rafa, 'queue-depth-backfill.png', 'image/png', chartBytes);
    dp1 = await post(
      rafa,
      dataPipeline,
      'queue depth during last night backfill — the sawtooth is the retry storm',
      days(1, 9, 12),
      { attachments: [chartFile] },
    );
  } else {
    dp1 = await post(
      rafa,
      dataPipeline,
      'queue depth during last night backfill — the sawtooth is the retry storm (chart in the run folder)',
      days(1, 9, 12),
    );
  }
  void dp1;
  const dp2 = await post(
    jonas,
    dataPipeline,
    'each tooth lines up with an OCR pool cold start. same root cause as the retry-ceiling thing in #eng-platform',
    days(1, 9, 30),
  );
  await react(rafa, dp2, '💯');

  // group DM (yesterday, read)
  const gdmRes = (await api(maya, 'POST', '/api/dms', { userIds: [priya.id, elena.id] })) as {
    channel: { id: string };
  };
  const gdm = gdmRes.channel.id;
  await post(maya, gdm, 'eval review Thursday — can one of you own the scanned-docs section?', days(1, 11, 20));
  const gdm2 = await post(elena, gdm, 'mine. I want to show the rotation-angle drill-down anyway', days(1, 11, 34));
  await react(priya, gdm2, '💪');

  // --- #research — yesterday afternoon: the eval regression arc ---------------
  const r1 = await post(
    priya,
    research,
    [
      'v0.13 eval run is done. headline numbers:',
      '',
      '| split | v0.12 F1 | v0.13 F1 | Δ |',
      '|---|---|---|---|',
      '| forms | 91.4 | 92.6 | **+1.2** |',
      '| tables | 88.2 | 89.0 | **+0.8** |',
      '| scanned-docs | 84.7 | 81.6 | **−3.1** |',
    ].join('\n'),
    days(1, 14, 5),
  );
  await react(maya, r1, '👀');
  await react(elena, r1, '👀');
  const r2 = await post(
    elena,
    research,
    'scanned-docs −3.1 is not noise. I would bet on the new deskew step — it crops aggressively on rotated pages',
    days(1, 14, 22),
  );
  await react(maya, r2, '👍');
  // Thread under the eval table
  await post(maya, research, 'do we have the per-page error breakdown?', days(1, 14, 30), { thread: r1 });
  const csvBytes =
    (await tryReadAsset('evals-v0.13.csv')) ??
    Buffer.from(
      'page_id,split,rotation_deg,v012_f1,v013_f1\n' +
        Array.from({ length: 40 }, (_, i) => {
          const rot = (i * 7) % 23;
          const v12 = (82 + (i % 9) + rot / 30).toFixed(1);
          const v13 = (Number(v12) - (rot > 5 ? 3.4 : -0.6)).toFixed(1);
          return `p${1000 + i},scanned-docs,${rot},${v12},${v13}`;
        }).join('\n'),
      'utf8',
    );
  const csvFile = await upload(priya, 'evals-v0.13-scanned.csv', 'text/csv', csvBytes);
  await post(priya, research, 'raw per-page run for the scanned split:', days(1, 14, 41), {
    thread: r1,
    attachments: [csvFile],
  });
  const r5 = await post(
    elena,
    research,
    'errors are concentrated in pages rotated >5°. it is the deskew.',
    days(1, 15, 10),
    { thread: r1 },
  );
  await react(priya, r5, '🎯');
  const deskewSample = await tryReadAsset('deskew-sample.png');
  if (deskewSample) {
    const sampleFile = await upload(priya, 'deskew-sample-p1042.png', 'image/png', deskewSample);
    await post(
      priya,
      research,
      'this is what the over-crop looks like on p1042 — the red box is the deskew output:',
      days(1, 15, 14),
      {
        thread: r1,
        attachments: [sampleFile],
      },
    );
  }

  // Elena puts an agent on the regression analysis (yesterday, completed, with
  // artifacts: report, chart, and a published drill-down app).
  console.log('spawning eval-analysis session ...');
  const evalSession = await spawnScripted(
    elena,
    research,
    'Analyze the scanned-docs eval regression between v0.12 and v0.13 — isolate the cause and publish a drill-down the team can use.',
    'terminal',
  );
  await dressSession(evalSession, {
    title: 'Analyze eval regression v0.12 → v0.13',
    harness: 'codex',
    createdAt: days(1, 15, 26),
    completedAt: days(1, 15, 33),
    repo: 'meridian/atlas',
  });
  const reportBytes = await tryReadAsset('eval-regression-report.md');
  const chartPng = await tryReadAsset('f1-by-rotation.png');
  const appHtml = await tryReadAsset('app-eval-dashboard.html');
  if (reportBytes) await addArtifact(evalSession, research, 'report.md', reportBytes, 'text/markdown', days(1, 15, 31));
  if (chartPng) await addArtifact(evalSession, research, 'f1-by-rotation.png', chartPng, 'image/png', days(1, 15, 31));
  if (appHtml) {
    await addArtifact(
      evalSession,
      research,
      'shared/apps/eval-dashboard/index.html',
      appHtml,
      'text/html',
      days(1, 15, 32),
    );
    await addArtifact(
      evalSession,
      research,
      'shared/apps/eval-dashboard/atrium.app.json',
      Buffer.from(
        JSON.stringify({ title: 'Eval dashboard — v0.12 → v0.13', entry: 'index.html', renderer: 'html-app' }, null, 2),
        'utf8',
      ),
      'application/json',
      days(1, 15, 32),
    );
  }
  await projectAndEmitChange(pool, evalSession).catch(() => {});

  // --- #releases — yesterday late afternoon ------------------------------------
  const rel1 = await post(
    maya,
    releases,
    [
      '**v0.13.2 cut — Thursday**',
      '',
      '- [x] evals triaged (regression isolated to deskew)',
      '- [x] changelog drafted',
      '- [ ] deskew: rollback vs. threshold fix — decision Wed',
      '- [ ] 24h staging soak',
    ].join('\n'),
    days(1, 16, 30),
  );
  await react(jonas, rel1, '✅');
  await react(priya, rel1, '✅');
  {
    const relNotes = await tryReadAsset('release-notes-v0.13.2.md');
    const attachments = relNotes
      ? [await upload(sam, 'release-notes-v0.13.2.md', 'text/markdown', relNotes)]
      : undefined;
    await post(
      sam,
      releases,
      'changelog draft is up — added before/after screenshots for the new gallery view',
      days(1, 17, 5),
      attachments ? { attachments } : {},
    );
  }

  // --- today ---------------------------------------------------------------
  const g3 = await post(
    maya,
    general,
    `<!channel> the eval dashboard from yesterday's regression analysis is live — poke at it before Thursday's review`,
    hours(3),
  );
  await react(elena, g3, '👀');
  const g4 = await post(sam, general, 'the drill-down by rotation angle is really slick 🔥', min(160));
  await react(maya, g4, '🙏');

  // #incidents (private): last night's cert rotation + Maya's failed migration
  await post(
    rafa,
    incidents,
    'rotated object-store TLS certs 02:10–02:25 UTC. preview service saw ~40 502s, self-recovered. runbook updated.',
    hours(9),
  );
  console.log('spawning thumbnail-migration session ...');
  const thumbsSession = await spawnScripted(
    maya,
    incidents,
    'Migrate thumbnail derivatives to the new object-store bucket (atlas-derivatives).',
    'terminal',
  );
  await dressSession(thumbsSession, {
    title: 'Migrate thumbnails to atlas-derivatives',
    harness: 'claude-code',
    createdAt: hours(2.4),
    completedAt: hours(2.3),
    repo: 'meridian/atlas-infra',
  });

  // DM jonas ↔ maya around the retry incident, with a missed call
  const dmRes = (await api(jonas, 'POST', '/api/dms', { userIds: [maya.id] })) as { channel: { id: string } };
  const dmJonasMaya = dmRes.channel.id;
  await post(maya, dmJonasMaya, 'the retry ceiling thing — can you own the repro test?', min(120));

  // Missed = the call ended and Maya neither joined nor declined.
  const callId = randomUUID();
  await pool.query(
    `INSERT INTO calls (id, workspace_id, channel_id, initiator_id, room, status, started_at, ended_at)
     SELECT $1, workspace_id, $2, $3, $4, 'ended', $5, $6 FROM channels WHERE id = $2`,
    [callId, dmJonasMaya, jonas.id, `demo-call-${callId.slice(0, 8)}`, min(115), min(113)],
  );
  await pool.query(`INSERT INTO call_participants (call_id, user_id, joined_at, left_at) VALUES ($1, $2, $3, $4)`, [
    callId,
    jonas.id,
    min(115),
    min(113),
  ]);
  // The attention feed keys off the call.ended event, not the calls row.
  await pool.query(
    `INSERT INTO events (workspace_id, channel_id, type, actor_id, payload, created_at)
     SELECT workspace_id, $1, 'call.ended', $2::uuid,
            jsonb_build_object('callId', $3::text, 'initiatorId', $6::text, 'startedAt', $4::text, 'answered', false),
            $5::timestamptz
     FROM channels WHERE id = $1`,
    [dmJonasMaya, jonas.id, callId, min(115).toISOString(), min(113), jonas.id],
  );

  await post(
    jonas,
    dmJonasMaya,
    'tried calling — anyway: easy repro, kill the OCR pool mid-batch. writing the test now',
    min(110),
  );
  const dmLast = await post(
    jonas,
    dmJonasMaya,
    'test is green on the branch. cold-start window reproduces in ~9s with the pool pinned to zero',
    min(104),
  );

  // #data-pipeline — this morning: quota news, then Maya's backfill agent
  await post(rafa, dataPipeline, 'GPU quota bump is approved btw — 8 → 12 A10s starting Monday', min(75));
  await post(elena, dataPipeline, 'nice, that unblocks the full-corpus embedding backfill', min(56));
  {
    const latency = await tryReadAsset('latency-weekly.png');
    if (latency) {
      const latencyFile = await upload(jonas, 'latency-p95-weekly.png', 'image/png', latency);
      await post(jonas, dataPipeline, 'p95 latency trend for context — W24 is the backfill week', min(53), {
        attachments: [latencyFile],
      });
    }
  }

  // Maya kicks off the backfill; the agent sizes it and needs a human decision
  // (write lock), so it parks with a pending question ("Needs you").
  console.log('spawning embeddings-backfill session ...');
  const backfillSession = await spawnScripted(
    maya,
    dataPipeline,
    'Backfill embeddings for the Q2 document corpus onto the new pool.',
    { frames: 8 },
  );
  await dressSession(backfillSession, {
    title: 'Backfill Q2 corpus embeddings',
    harness: 'codex',
    createdAt: min(48),
    repo: 'meridian/atlas',
  });
  // Shaped exactly like persistQuestionRequested's event: attributed to the
  // spawner, threaded under the session card, questionId in the payload —
  // so the client renders the same persona'd, answerable question card the
  // live path produces (no "Unknown", no dead top-level message).
  const questionEvent = await pool.query<{ id: string }>(
    `INSERT INTO events (workspace_id, channel_id, thread_root_event_id, type, actor_id, payload, created_at)
     SELECT s.workspace_id, s.channel_id, s.thread_root_event_id, 'session.question_requested', s.spawned_by,
            jsonb_build_object(
              'sessionId', s.id::text,
              'questionId', 'q-backfill-lock',
              'questions', jsonb_build_array(
                jsonb_build_object(
                  'id', 'q1',
                  'header', 'Write lock',
                  'question', 'The reindex holds a write lock for ~40 minutes. Run it now or schedule for tonight?',
                  'options', jsonb_build_array(
                    jsonb_build_object('label', 'Run now', 'description', 'blocks ingestion writes until ~finished'),
                    jsonb_build_object('label', 'Tonight 02:00', 'description', 'schedule for the quiet window')
                  )
                )
              ),
              'permalink', '/s/' || s.id::text
            ), $2::timestamptz
     FROM sessions s WHERE s.id = $1 RETURNING id`,
    [backfillSession, min(46)],
  );
  await pool.query(`UPDATE sessions SET status='running', pending_question=$2 WHERE id=$1`, [
    backfillSession,
    JSON.stringify({
      questionId: 'q-backfill-lock',
      turnId: 't1',
      eventId: Number(questionEvent.rows[0]!.id),
      // ~49 minutes ago, matching the question event's place in the timeline —
      // drives the "Needs you · 49m" waiting clock.
      askedAt: new Date(Date.now() - 49 * 60_000).toISOString(),
      questions: [
        {
          id: 'q1',
          header: 'Write lock',
          question: 'The reindex holds a write lock for ~40 minutes. Run it now or schedule for tonight?',
          options: [
            { label: 'Run now', description: 'blocks ingestion writes until ~finished' },
            { label: 'Tonight 02:00', description: 'schedule for the quiet window' },
          ],
        },
      ],
    }),
  ]);

  // #research — Priya's ask lands after the backfill question (unread + mention)
  await post(
    priya,
    research,
    `${mention(maya)} can we grab 30 min tomorrow on the deskew rollback? want a decision before the v0.13.2 cut`,
    min(38),
  );

  // --- #eng-platform — this morning's retry-ceiling arc (hero channel) ----
  const e1 = await post(
    jonas,
    engPlatform,
    'ingestion hit the retry ceiling again overnight. 3 batches stuck in `pending_ocr`, bumped them by hand',
    min(126),
  );
  void e1;
  const e2 = await post(
    jonas,
    engPlatform,
    'backoff caps at 30s, which is way too tight while the OCR pool is cold-starting',
    min(124),
  );
  await react(sam, e2, '👀');
  await post(
    maya,
    engPlatform,
    `yeah, that cap predates the pool autoscaler. ${mention(jonas)} can you get the cold-start repro into a test?`,
    min(118),
  );
  await post(jonas, engPlatform, 'on it — kill the pool mid-batch, reproduces every time', min(116));
  await post(
    sam,
    engPlatform,
    'possibly related? preview service threw a handful of 502s during last night thumbnail regen',
    min(97),
  );
  const e6 = await post(
    rafa,
    engPlatform,
    'not related — that was me rotating the object-store certs 😅 posted a note in #incidents',
    min(94),
  );
  await react(sam, e6, '😂');
  const e7 = await post(
    maya,
    engPlatform,
    'putting an agent on the backoff fix so we do not lose the morning to it',
    min(6),
  );
  await react(jonas, e7, '🔥');
  const e8 = await post(
    priya,
    engPlatform,
    'while it is in there — a queue-depth log line on every retry would help the latency analysis a lot',
    min(4),
  );
  await react(maya, e8, '➕');
  // --- read state -------------------------------------------------------------
  console.log('setting read cursors ...');
  const latest = async (ch: string): Promise<number> => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM events WHERE channel_id = $1 ORDER BY id DESC LIMIT 1`,
      [ch],
    );
    return rows.length ? Number(rows[0].id) : 0;
  };
  // Everyone but Maya has read everything they can see.
  for (const u of [jonas, priya, sam, elena, rafa]) {
    for (const ch of [...publicChannels, ...(u === jonas || u === rafa ? [incidents] : [])]) {
      const id = await latest(ch);
      if (id > 0) await markRead(u, ch, id);
    }
  }
  await markRead(jonas, dmJonasMaya, await latest(dmJonasMaya));
  for (const u of [maya, priya, elena]) await markRead(u, gdm, await latest(gdm));
  // Maya: caught up everywhere except #research (1 unread w/ mention),
  // #data-pipeline (2 unread), and the Jonas DM (2 unread).
  for (const ch of [general, engPlatform, releases, incidents]) {
    const id = await latest(ch);
    if (id > 0) await markRead(maya, ch, id);
  }
  {
    // research: everything read except the last (mention) message
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM events WHERE channel_id = $1 AND type = 'message.posted' ORDER BY id DESC OFFSET 1 LIMIT 1`,
      [research],
    );
    if (rows.length) await markRead(maya, research, Number(rows[0].id));
  }
  {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM events WHERE channel_id = $1 AND type = 'message.posted' ORDER BY id DESC OFFSET 2 LIMIT 1`,
      [dataPipeline],
    );
    if (rows.length) await markRead(maya, dataPipeline, Number(rows[0].id));
  }
  {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM events WHERE channel_id = $1 AND type = 'message.posted' ORDER BY id DESC OFFSET 2 LIMIT 1`,
      [dmJonasMaya],
    );
    if (rows.length) await markRead(maya, dmJonasMaya, Number(rows[0].id));
  }

  // --- backdate ---------------------------------------------------------------
  console.log(`backdating ${backdates.length} events ...`);
  for (const { id, at } of backdates) {
    await pool.query('UPDATE events SET created_at = $2 WHERE id = $1', [id, at]);
  }
  // Mentions carry their own created_at used for ordering in the activity feed.
  await pool
    .query(`UPDATE mentions m SET created_at = e.created_at FROM events e WHERE m.event_id = e.id`)
    .catch(() => {});
  // Reactions were posted "now"; pin each to shortly after its target message
  // so the activity feed reads coherently.
  await pool.query(
    `UPDATE events e SET created_at = t.created_at + interval '3 minutes'
     FROM events t
     WHERE e.type = 'reaction.added' AND e.payload->>'target' = 'evt_' || t.id::text`,
  );
  await pool.query(
    `UPDATE files f SET created_at = e.created_at
     FROM events e, jsonb_array_elements(e.payload->'attachments') att
     WHERE e.type = 'message.posted' AND (att->>'id')::uuid = f.id`,
  );
  // Uploads are mirrored into the artifact ledger (shared/channels/.../uploads/…);
  // the gallery shows the ledger timestamps.
  await pool.query(
    `UPDATE artifacts a SET created_at = e.created_at
     FROM events e, jsonb_array_elements(e.payload->'attachments') att
     WHERE e.type = 'message.posted' AND a.path LIKE '%/uploads/%'
       AND a.path LIKE '%/' || (att->>'filename')`,
  );
  await pool.query(
    `UPDATE artifact_versions av SET created_at = a.created_at
     FROM artifacts a WHERE av.artifact_id = a.id AND a.path LIKE '%/uploads/%'`,
  );

  console.log('done. summary:');
  const counts = await pool.query<{ relname: string; n: string }>(
    `SELECT 'events' AS relname, count(*)::text AS n FROM events
     UNION ALL SELECT 'users', count(*)::text FROM users
     UNION ALL SELECT 'channels', count(*)::text FROM channels
     UNION ALL SELECT 'files', count(*)::text FROM files
     UNION ALL SELECT 'mentions', count(*)::text FROM mentions`,
  );
  for (const row of counts.rows) console.log(`  ${row.relname}: ${row.n}`);
  console.log(
    JSON.stringify(
      {
        users: Object.fromEntries(team.map((u) => [u.handle, u.id])),
        channels: { general, engPlatform, research, dataPipeline, releases, incidents, dmJonasMaya, gdm },
        dmLastEvent: dmLast,
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
