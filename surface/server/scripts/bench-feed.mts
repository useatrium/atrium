// Benchmark the channel feed's latest-reply preview joins against the query
// with only that preview block removed. This script destroys and reseeds the
// target database, whose name must contain "bench".
//
// Usage (from surface/):
//   DATABASE_URL=postgres://atrium:atrium@localhost:5433/atrium_bench_ss15 \
//     pnpm --filter @atrium/server exec tsx scripts/bench-feed.mts \
//       --channels 5 --roots 5000 --replies-per-root 0..20 --edits 5% --iterations 50
//
// `--roots` is the total root count, distributed evenly across channels. The
// mixed reply distribution keeps most threads quiet, gives some 1-20 replies,
// and gives one in 200 roots 200 replies. The candidate index is temporary: it
// is created after the no-index measurements and dropped before exit.

import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/db.js';
import { createChannel, createWorkspace, listChannelMessages } from '../src/events.js';
import { addWorkspaceMember } from '../src/membership.js';
import { runMigrations } from '../src/migrate.js';
import { truncateAll } from '../test/helpers.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) refuse('DATABASE_URL is required');

let databaseName: string;
try {
  databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
} catch {
  refuse('DATABASE_URL must be a valid PostgreSQL URL');
}
if (!databaseName!.toLowerCase().includes('bench')) {
  refuse(`refusing to wipe non-benchmark database: ${databaseName!}`);
}

const config = parseArgs(process.argv.slice(2));
const pool = createPool(databaseUrl);
let candidateCreated = false;

const ROOT_EVENT_TYPES =
  "('message.posted', 'session.spawned', 'session.replied', 'session.question_requested', 'session.question_answered', 'session.question_resolved')";
const REPLY_EVENT_TYPES =
  "('message.posted', 'session.replied', 'session.question_requested', 'session.question_answered', 'session.question_resolved')";
const CANDIDATE_INDEX = 'bench_feed_reply_types_idx';
const CANDIDATE_INDEX_SQL = `
  CREATE INDEX ${CANDIDATE_INDEX}
    ON events (thread_root_event_id, id)
    WHERE thread_root_event_id IS NOT NULL
      AND type IN ${REPLY_EVENT_TYPES}
`;

interface Config {
  channels: number;
  roots: number;
  replyMin: number;
  replyMax: number;
  editsPercent: number;
  iterations: number;
}

interface SeededChannel {
  id: string;
  label: string;
  roots: number;
  deepBeforeId: number;
}

interface SeedResult {
  channels: SeededChannel[];
  roots: number;
  replies: number;
  edits: number;
  events: number;
}

interface Timing {
  p50: number;
  p95: number;
}

interface PlanSummary {
  executionMs: number;
  nodes: string;
}

interface ResultRow {
  scale: string;
  channel: string;
  variant: string;
  p50: string;
  p95: string;
  plan: string;
}

try {
  console.log(`database: ${databaseName!} (will wipe and reseed)`);
  await runMigrations(pool);
  await pool.query(`DROP INDEX IF EXISTS ${CANDIDATE_INDEX}`);
  await truncateAll(pool);

  const queries = await loadQueries();
  const seed = await seedDatabase(pool, config);
  const scale = `${config.channels}ch/${seed.roots}r/${seed.replies}rp/${seed.edits}ed/${seed.events}ev`;
  console.log(`seeded: ${scale}`);

  const rows: ResultRow[] = [];
  for (const channel of seed.channels) {
    await benchmarkCurrent(rows, scale, channel, queries);
  }

  console.log(`creating ephemeral candidate index: ${CANDIDATE_INDEX}`);
  await pool.query(CANDIDATE_INDEX_SQL);
  candidateCreated = true;
  await pool.query('ANALYZE events');

  for (const channel of seed.channels) {
    await benchmarkCandidate(rows, scale, channel, queries.full);
  }

  printTable(rows);
  console.log(`candidate DDL: ${oneLine(CANDIDATE_INDEX_SQL)}`);
} finally {
  if (candidateCreated) await pool.query(`DROP INDEX IF EXISTS ${CANDIDATE_INDEX}`).catch(() => {});
  await pool.end();
}

async function benchmarkCurrent(
  rows: ResultRow[],
  scale: string,
  channel: SeededChannel,
  queries: { full: string; baseline: string },
): Promise<void> {
  for (const page of ['first', 'deep'] as const) {
    const beforeId = page === 'deep' ? channel.deepBeforeId : undefined;
    const fullSql = feedSql(queries.full, beforeId !== undefined);
    const baselineSql = feedSql(queries.baseline, beforeId !== undefined);
    const params = beforeId === undefined ? [channel.id, 51] : [channel.id, 51, beforeId];

    const fullPlan = await explain(pool, fullSql, params);
    const baselinePlan = await explain(pool, baselineSql, params);
    const e2e = await measure(() => listChannelMessages(pool, { channelId: channel.id, beforeId, limit: 50 }));
    const sqlFull = await measure(() => pool.query(fullSql, params));
    const sqlBaseline = await measure(() => pool.query(baselineSql, params));

    rows.push(row(scale, channel.label, `e2e/full/${page}`, e2e, fullPlan));
    rows.push(row(scale, channel.label, `sql/full/${page}`, sqlFull, fullPlan));
    rows.push(row(scale, channel.label, `sql/no-preview/${page}`, sqlBaseline, baselinePlan));
  }
}

async function benchmarkCandidate(
  rows: ResultRow[],
  scale: string,
  channel: SeededChannel,
  messageSelect: string,
): Promise<void> {
  for (const page of ['first', 'deep'] as const) {
    const beforeId = page === 'deep' ? channel.deepBeforeId : undefined;
    const sql = feedSql(messageSelect, beforeId !== undefined);
    const params = beforeId === undefined ? [channel.id, 51] : [channel.id, 51, beforeId];
    const plan = await explain(pool, sql, params);
    const e2e = await measure(() => listChannelMessages(pool, { channelId: channel.id, beforeId, limit: 50 }));
    const raw = await measure(() => pool.query(sql, params));
    rows.push(row(scale, channel.label, `e2e/candidate/${page}`, e2e, plan));
    rows.push(row(scale, channel.label, `sql/candidate/${page}`, raw, plan));
  }
}

async function loadQueries(): Promise<{ full: string; baseline: string }> {
  const source = await readFile(new URL('../src/events.ts', import.meta.url), 'utf8');
  const match = /const MESSAGE_SELECT = `([\s\S]*?)`;/.exec(source);
  if (!match?.[1]) throw new Error('could not extract MESSAGE_SELECT from server/src/events.ts');

  const full = match[1];
  const selectStart = full.indexOf('         lr.id AS last_reply_preview_id,');
  const selectEndMarker = '         lr.type AS last_reply_event_type,\n';
  const selectEnd = full.indexOf(selectEndMarker, selectStart);
  const joinStart = full.indexOf('  LEFT JOIN events lr ON lr.id = r.last_reply_id\n');
  const joinEndMarker = '  ) lr_edit ON true\n';
  const joinEnd = full.indexOf(joinEndMarker, joinStart);
  if (selectStart < 0 || selectEnd < 0 || joinStart < 0 || joinEnd < 0) {
    throw new Error('MESSAGE_SELECT latest-reply block changed; update the benchmark string surgery');
  }

  // Baseline: preserve the pre-existing reply count/max lateral join, but
  // remove the preview columns plus events/users/edited-text joins added for
  // lastReply. This deliberately leaves all other feed folding work intact.
  const withoutSelect = full.slice(0, selectStart) + full.slice(selectEnd + selectEndMarker.length);
  const adjustedJoinStart = withoutSelect.indexOf('  LEFT JOIN events lr ON lr.id = r.last_reply_id\n');
  const adjustedJoinEnd = withoutSelect.indexOf(joinEndMarker, adjustedJoinStart);
  const baseline =
    withoutSelect.slice(0, adjustedJoinStart) + withoutSelect.slice(adjustedJoinEnd + joinEndMarker.length);
  return { full, baseline };
}

function feedSql(messageSelect: string, deep: boolean): string {
  return `${messageSelect}
    WHERE e.channel_id = $1
      AND e.type IN ${ROOT_EVENT_TYPES}
      AND (e.thread_root_event_id IS NULL OR (e.payload->>'broadcast')::boolean IS TRUE)
      ${deep ? 'AND e.id < $3' : ''}
    ORDER BY e.id DESC
    LIMIT $2`;
}

async function seedDatabase(db: Pool, args: Config): Promise<SeedResult> {
  const { workspace } = await createWorkspace(db, { name: 'Feed benchmark' });
  const userRows = await db.query<{ id: string }>(
    `INSERT INTO users (handle, display_name)
     SELECT 'bench_user_' || n, 'Bench User ' || n
     FROM generate_series(1, 8) n
     RETURNING id`,
  );
  const userIds = userRows.rows.map((user) => user.id);
  for (const userId of userIds) await addWorkspaceMember(db, workspace.id, userId);

  const channels: Array<{ id: string; label: string; roots: number }> = [];
  for (let i = 0; i < args.channels; i += 1) {
    const created = await createChannel(db, {
      workspaceId: workspace.id,
      name: `bench-${i + 1}`,
      actorId: userIds[0],
    });
    channels.push({
      id: created.channel.id,
      label: `ch${i + 1}`,
      roots: Math.floor(args.roots / args.channels) + (i < args.roots % args.channels ? 1 : 0),
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE bench_roots (
        channel_id uuid NOT NULL,
        root_id bigint PRIMARY KEY,
        ordinal integer NOT NULL
      ) ON COMMIT DROP
    `);
    for (const channel of channels) {
      await insertRoots(client, workspace.id, channel, userIds);
    }
    await insertReplies(client, workspace.id, userIds, args);
    await client.query(
      `UPDATE events
       SET payload = payload - '_benchOrdinal'
       WHERE workspace_id = $1 AND payload ? '_benchOrdinal'`,
      [workspace.id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const editThreshold = Math.round(args.editsPercent * 100);
  if (editThreshold > 0) {
    await db.query(
      `WITH targets AS MATERIALIZED (
         SELECT id, channel_id, thread_root_event_id, actor_id
         FROM events
         WHERE workspace_id = $1
           AND type = 'message.posted'
           AND mod(id * 48271, 10000) < $2
       )
       INSERT INTO events (workspace_id, channel_id, thread_root_event_id, type, actor_id, payload)
       SELECT $1, channel_id, thread_root_event_id, 'message.edited', actor_id,
              jsonb_build_object('target', 'evt_' || id::text, 'text', 'edited benchmark message ' || id)
       FROM targets`,
      [workspace.id, editThreshold],
    );
  }

  // Chunked: each projection takes a pg_advisory_xact_lock held until its
  // transaction ends, so one statement over the whole seed would exhaust the
  // shared lock table at benchmark scale.
  const idRange = await db.query<{ min_id: string; max_id: string }>(
    'SELECT min(id)::text AS min_id, max(id)::text AS max_id FROM events WHERE workspace_id = $1',
    [workspace.id],
  );
  const minId = Number(idRange.rows[0]?.min_id ?? 0);
  const maxId = Number(idRange.rows[0]?.max_id ?? -1);
  const PROJECT_CHUNK = 5000;
  for (let lo = minId; lo <= maxId; lo += PROJECT_CHUNK) {
    await db.query(
      'SELECT project_message_event(id) FROM events WHERE workspace_id = $1 AND id >= $2 AND id < $3 ORDER BY id',
      [workspace.id, lo, lo + PROJECT_CHUNK],
    );
  }

  await db.query('VACUUM (ANALYZE) events');

  const counts = await db.query<{ roots: number; replies: number; edits: number; events: number }>(
    `SELECT
       count(*) FILTER (WHERE type = 'message.posted' AND thread_root_event_id IS NULL)::int AS roots,
       count(*) FILTER (WHERE type IN ${REPLY_EVENT_TYPES} AND thread_root_event_id IS NOT NULL)::int AS replies,
       count(*) FILTER (WHERE type = 'message.edited')::int AS edits,
       count(*)::int AS events
     FROM events
     WHERE workspace_id = $1`,
    [workspace.id],
  );

  const seededChannels: SeededChannel[] = [];
  for (const channel of channels) {
    const offset = Math.min(Math.max(50, Math.floor(channel.roots * 0.8)), Math.max(0, channel.roots - 51));
    const cursor = await db.query<{ id: number }>(
      `SELECT id
       FROM events
       WHERE channel_id = $1 AND type = 'message.posted' AND thread_root_event_id IS NULL
       ORDER BY id DESC OFFSET $2 LIMIT 1`,
      [channel.id, offset],
    );
    if (!cursor.rows[0]) throw new Error(`channel ${channel.label} has no deep-page cursor`);
    seededChannels.push({ ...channel, deepBeforeId: Number(cursor.rows[0].id) });
  }

  return { channels: seededChannels, ...counts.rows[0]! };
}

async function insertRoots(
  client: PoolClient,
  workspaceId: string,
  channel: { id: string; roots: number },
  userIds: string[],
): Promise<void> {
  await client.query(
    `WITH inserted AS (
       INSERT INTO events (workspace_id, channel_id, thread_root_event_id, type, actor_id, payload)
       SELECT $1, $2, NULL, 'message.posted',
              ($3::uuid[])[1 + mod(n - 1, cardinality($3::uuid[]))],
              jsonb_build_object('text', 'benchmark root ' || n, '_benchOrdinal', n)
       FROM generate_series(1, $4::int) n
       RETURNING id, channel_id, (payload->>'_benchOrdinal')::int AS ordinal
     )
     INSERT INTO bench_roots (channel_id, root_id, ordinal)
     SELECT channel_id, id, ordinal FROM inserted`,
    [workspaceId, channel.id, userIds, channel.roots],
  );
}

async function insertReplies(client: PoolClient, workspaceId: string, userIds: string[], args: Config): Promise<void> {
  const replyCount = replyCountSql(args.replyMin, args.replyMax);
  await client.query(
    `INSERT INTO events (workspace_id, channel_id, thread_root_event_id, type, actor_id, payload)
     SELECT $1, roots.channel_id, roots.root_id,
            CASE WHEN mod(roots.ordinal + reply_no, 10) = 0 THEN 'session.replied' ELSE 'message.posted' END,
            CASE WHEN mod(roots.ordinal + reply_no, 10) = 0 THEN NULL
                 ELSE ($2::uuid[])[1 + mod(roots.ordinal + reply_no, cardinality($2::uuid[]))] END,
            CASE WHEN mod(roots.ordinal + reply_no, 10) = 0
                 THEN jsonb_build_object(
                   'sessionId', 'bench-session-' || roots.root_id,
                   'text', 'agent reply ' || reply_no || ' on root ' || roots.root_id
                 )
                 ELSE jsonb_build_object('text', 'reply ' || reply_no || ' on root ' || roots.root_id)
            END
     FROM bench_roots roots
     CROSS JOIN LATERAL generate_series(1, ${replyCount}) reply_no`,
    [workspaceId, userIds],
  );
}

function replyCountSql(min: number, max: number): string {
  const quiet = min;
  const smallMin = Math.max(min, 1);
  const smallMax = Math.max(smallMin, Math.min(max, 2));
  const activeMin = Math.max(min, 3);
  const activeMax = Math.max(activeMin, max);
  const hot = Math.max(200, max);
  return `(CASE
    WHEN mod(roots.ordinal, 200) = 0 THEN ${hot}
    WHEN mod(roots.ordinal, 100) < 65 THEN ${quiet}
    WHEN mod(roots.ordinal, 100) < 90
      THEN ${smallMin} + mod(roots.ordinal, ${smallMax - smallMin + 1})
    ELSE ${activeMin} + mod(roots.ordinal, ${activeMax - activeMin + 1})
  END)`;
}

async function measure(work: () => Promise<unknown>): Promise<Timing> {
  for (let i = 0; i < 5; i += 1) await work();
  const samples: number[] = [];
  for (let i = 0; i < config.iterations; i += 1) {
    const started = performance.now();
    await work();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
}

async function explain(db: Pool, sql: string, params: unknown[]): Promise<PlanSummary> {
  const result = await db.query<Record<string, unknown>>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const raw = result.rows[0]?.['QUERY PLAN'];
  const document = (typeof raw === 'string' ? JSON.parse(raw) : raw) as ExplainDocument[];
  const root = document?.[0];
  if (!root?.Plan) throw new Error('unexpected EXPLAIN JSON shape');

  const nodes: Array<{ label: string; selfMs: number }> = [];
  collectPlanNodes(root.Plan, nodes);
  nodes.sort((a, b) => b.selfMs - a.selfMs);
  return {
    executionMs: root['Execution Time'] ?? 0,
    nodes: nodes
      .slice(0, 3)
      .map((node) => `${node.label} ${node.selfMs.toFixed(2)}ms`)
      .join('; '),
  };
}

interface ExplainDocument {
  Plan: ExplainNode;
  'Execution Time'?: number;
}

interface ExplainNode {
  'Node Type': string;
  Alias?: string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Actual Total Time'?: number;
  'Actual Loops'?: number;
  Plans?: ExplainNode[];
}

function collectPlanNodes(node: ExplainNode, output: Array<{ label: string; selfMs: number }>): number {
  const childrenMs = (node.Plans ?? []).reduce((total, child) => total + collectPlanNodes(child, output), 0);
  const totalMs = (node['Actual Total Time'] ?? 0) * (node['Actual Loops'] ?? 1);
  const detail = node['Index Name'] ?? node.Alias ?? node['Relation Name'];
  output.push({
    label: detail ? `${node['Node Type']}[${detail}]` : node['Node Type'],
    selfMs: Math.max(0, totalMs - childrenMs),
  });
  return totalMs;
}

function row(scale: string, channel: string, variant: string, timing: Timing, plan: PlanSummary): ResultRow {
  return {
    scale,
    channel,
    variant,
    p50: timing.p50.toFixed(2),
    p95: timing.p95.toFixed(2),
    plan: `${plan.executionMs.toFixed(2)}ms: ${plan.nodes}`,
  };
}

function printTable(rows: ResultRow[]): void {
  const headers: Array<keyof ResultRow> = ['scale', 'channel', 'variant', 'p50', 'p95', 'plan'];
  const widths = Object.fromEntries(
    headers.map((header) => [header, Math.max(header.length, ...rows.map((item) => item[header].length))]),
  ) as Record<keyof ResultRow, number>;
  const render = (item: ResultRow | Record<keyof ResultRow, string>) =>
    headers.map((header) => item[header].padEnd(widths[header])).join(' | ');
  console.log(render(Object.fromEntries(headers.map((header) => [header, header])) as Record<keyof ResultRow, string>));
  console.log(headers.map((header) => '-'.repeat(widths[header])).join('-+-'));
  for (const item of rows) console.log(render(item));
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
}

function parseArgs(argv: string[]): Config {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`expected --flag value, got: ${argv.slice(i).join(' ')}`);
    }
    values.set(flag, value);
  }

  const allowed = new Set(['--channels', '--roots', '--replies-per-root', '--edits', '--iterations']);
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`unknown flag: ${flag}`);

  const channels = positiveInteger(values.get('--channels') ?? '5', '--channels');
  const roots = positiveInteger(values.get('--roots') ?? '5000', '--roots');
  const iterations = positiveInteger(values.get('--iterations') ?? '50', '--iterations');
  const replyMatch = /^(\d+)(?:\.\.(\d+))?$/.exec(values.get('--replies-per-root') ?? '0..20');
  if (!replyMatch) throw new Error('--replies-per-root must be N or MIN..MAX');
  const replyMin = Number(replyMatch[1]);
  const replyMax = Number(replyMatch[2] ?? replyMatch[1]);
  if (replyMax < replyMin || replyMax > 10_000) throw new Error('invalid --replies-per-root range');
  const editRaw = values.get('--edits') ?? '5%';
  const editMatch = /^(\d+(?:\.\d+)?)%?$/.exec(editRaw);
  if (!editMatch) throw new Error('--edits must be a percentage such as 5%');
  const editsPercent = Number(editMatch[1]);
  if (editsPercent < 0 || editsPercent > 100) throw new Error('--edits must be between 0% and 100%');
  if (roots < channels * 52) throw new Error('--roots must provide at least 52 roots per channel for a deep page');
  return { channels, roots, replyMin, replyMax, editsPercent, iterations };
}

function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function refuse(message: string): never {
  console.error(message);
  console.error('(the database name must contain "bench"; this script wipes all rows)');
  process.exit(1);
}
