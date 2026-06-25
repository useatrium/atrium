import type { Db } from './db.js';
import { encodeRecordHandle } from '@atrium/surface-client/handle';
import type {
  SessionRecord,
  SessionRecordActor,
  SessionRecordDriver,
  SessionRecordKind,
  SessionRecordViewTier,
} from './session-records.js';

export type SessionProjectionTier = 'lean' | 'full';

export interface SessionMeta {
  sessionId: string;
  workspaceId: string;
  channelId: string;
  channelName: string;
  threadRootEventId: number | null;
  centaurThreadKey: string;
  harness: string;
  title: string;
  status: string;
  driver: string | null;
  repo: string | null;
  branch: string | null;
  spawnedBy: string;
  spawnerName: string | null;
  driverId: string | null;
  driverName: string | null;
  currentExecutionId: string | null;
  assignmentGeneration: number | null;
  lastEventId: number;
  resultText: string | null;
  costUsd: number;
  usageCostUsd: number;
  createdAt: string;
  completedAt: string | null;
}

interface SessionRecordRow {
  session_id: string;
  event_id: number;
  seq: number;
  entry_uid: string | null;
  kind: SessionRecordKind;
  actor: SessionRecordActor;
  driver: SessionRecordDriver | null;
  view_tier: SessionRecordViewTier;
  text: string;
  meta: unknown;
  ts: Date;
}

interface SessionMetaRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  channel_name: string;
  thread_root_event_id: number | null;
  centaur_thread_key: string;
  harness: string;
  title: string;
  status: string;
  repo: string | null;
  branch: string | null;
  spawned_by: string;
  spawner_name: string | null;
  driver_id: string | null;
  driver_name: string | null;
  current_execution_id: string | null;
  assignment_generation: number | null;
  last_event_id: number;
  result_text: string | null;
  cost_usd: string | number;
  created_at: Date;
  completed_at: Date | null;
  record_driver: string | null;
  usage_cost_usd: string | number;
}

export async function loadSessionRecords(
  pool: Db,
  sessionId: string,
  tier: SessionProjectionTier,
): Promise<SessionRecord[]> {
  const tierWhere = tier === 'lean' ? "AND view_tier = 'lean'" : '';
  const res = await pool.query<SessionRecordRow>(
    `SELECT session_id,
            event_id,
            seq,
            entry_uid,
            kind,
            actor,
            driver,
            view_tier,
            text,
            meta,
            ts
       FROM session_records
      WHERE session_id = $1
        ${tierWhere}
      ORDER BY seq ASC`,
    [sessionId],
  );
  return res.rows.map(toSessionRecord);
}

export async function buildSessionMeta(pool: Db, sessionId: string): Promise<SessionMeta> {
  const res = await pool.query<SessionMetaRow>(
    `SELECT s.id,
            s.workspace_id,
            s.channel_id,
            c.name AS channel_name,
            s.thread_root_event_id,
            s.centaur_thread_key,
            s.harness,
            s.title,
            s.status,
            s.repo,
            s.branch,
            s.spawned_by,
            spawner.display_name AS spawner_name,
            s.driver_id,
            driver.display_name AS driver_name,
            s.current_execution_id,
            s.assignment_generation,
            s.last_event_id,
            s.result_text,
            s.cost_usd,
            s.created_at,
            s.completed_at,
            first_record.driver AS record_driver,
            COALESCE(usage_cost.total, 0) AS usage_cost_usd
       FROM sessions s
       JOIN channels c ON c.id = s.channel_id
       LEFT JOIN users spawner ON spawner.id = s.spawned_by
       LEFT JOIN users driver ON driver.id = s.driver_id
       LEFT JOIN LATERAL (
         SELECT sr.driver
           FROM session_records sr
          WHERE sr.session_id = s.id
            AND sr.driver IS NOT NULL
          ORDER BY sr.seq ASC
          LIMIT 1
       ) first_record ON true
       LEFT JOIN LATERAL (
         SELECT SUM(
                  CASE
                    WHEN sr.meta ? 'costUsd'
                     AND (sr.meta->>'costUsd') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                    THEN (sr.meta->>'costUsd')::numeric
                    ELSE 0
                  END
                ) AS total
           FROM session_records sr
          WHERE sr.session_id = s.id
            AND sr.kind = 'usage'
       ) usage_cost ON true
      WHERE s.id = $1`,
    [sessionId],
  );
  const row = res.rows[0];
  if (!row) throw new Error('session not found');
  const sessionCost = Number(row.cost_usd);
  const usageCost = Number(row.usage_cost_usd);
  return {
    sessionId: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    threadRootEventId: row.thread_root_event_id,
    centaurThreadKey: row.centaur_thread_key,
    harness: row.harness,
    title: row.title,
    status: row.status,
    driver: row.record_driver ?? driverFromHarness(row.harness),
    repo: row.repo,
    branch: row.branch,
    spawnedBy: row.spawned_by,
    spawnerName: row.spawner_name,
    driverId: row.driver_id,
    driverName: row.driver_name,
    currentExecutionId: row.current_execution_id,
    assignmentGeneration: row.assignment_generation,
    lastEventId: row.last_event_id,
    resultText: row.result_text,
    costUsd: sessionCost > 0 || usageCost === 0 ? sessionCost : usageCost,
    usageCostUsd: usageCost,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

export function renderTranscriptMarkdown(records: SessionRecord[]): string {
  const lines = ['# Transcript', ''];
  const leanRecords = records.filter((record) => record.viewTier === 'lean');
  if (leanRecords.length === 0) return `${lines.join('\n')}No transcript records.\n`;

  for (const record of leanRecords) {
    renderLeanRecord(lines, record);
  }
  return finalize(lines);
}

export function renderFullMarkdown(records: SessionRecord[]): string {
  const lines = ['# Full Transcript', ''];
  if (records.length === 0) return `${lines.join('\n')}No session records.\n`;

  for (const record of records) {
    lines.push(`## ${record.seq}. ${titleCase(record.kind)} - ${labelActor(record.actor)}`);
    lines.push(`Event: ${record.eventId}`);
    if (record.driver) lines.push(`Driver: ${record.driver}`);
    lines.push(`Tier: ${record.viewTier}`);
    lines.push(`Time: ${record.ts.toISOString()}`);
    lines.push('');
    lines.push(record.text || '[empty]');
    lines.push('');
  }
  return finalize(lines);
}

export function renderSummaryMarkdown(records: SessionRecord[], meta: SessionMeta | Record<string, unknown>): string {
  const title = stringFrom(meta, 'title') ?? 'Session';
  const status = stringFrom(meta, 'status') ?? 'unknown';
  const driver = stringFrom(meta, 'driver') ?? 'unknown';
  const counts = countRecords(records);
  const actions = keyActions(records);
  const lines = [
    `# ${title}`,
    '',
    `Status: ${status}`,
    `Driver: ${driver}`,
    '',
    '## Counts',
    '',
    `Messages: ${counts.messages}`,
    `Commands: ${counts.commands}`,
    `Files changed: ${counts.filesChanged}`,
    `Artifacts: ${counts.artifacts}`,
    '',
    '## Key Actions',
    '',
  ];

  if (actions.length === 0) {
    lines.push('None.');
  } else {
    for (const action of actions) lines.push(`- ${action}`);
  }
  return finalize(lines);
}

export function renderChangesMarkdown(records: SessionRecord[]): string {
  const changes = records.filter((record) => record.kind === 'file_change');
  const lines = ['# Files Changed', ''];
  if (changes.length === 0) {
    lines.push('None.');
    return finalize(lines);
  }

  for (const record of changes) {
    const path = stringFrom(record.meta, 'path') ?? firstLine(record.text).replace(/^File [^:]+:\s*/, '');
    const kind = stringFrom(record.meta, 'kind') ?? 'update';
    lines.push(`- ${kind}: ${path}`);
  }
  return finalize(lines);
}

export function renderToolsMarkdown(records: SessionRecord[]): string {
  const tools = records.filter((record) => record.kind === 'command' || record.kind === 'tool_call');
  const lines = ['# Tools', ''];
  if (tools.length === 0) {
    lines.push('None.');
    return finalize(lines);
  }

  for (const record of tools) {
    if (record.kind === 'command') {
      const command = stringFrom(record.meta, 'command') ?? commandFromText(record.text) ?? 'command';
      lines.push(`## Command ${record.seq}`);
      lines.push('');
      lines.push('```console');
      lines.push(`$ ${command}`);
      const output = outputFromText(record.text);
      if (output) lines.push(output);
      lines.push('```');
      lines.push('');
      continue;
    }
    const toolName = stringFrom(record.meta, 'toolName') ?? 'tool';
    lines.push(`## Tool Call ${record.seq}: ${toolName}`);
    lines.push('');
    lines.push(record.text || '[empty]');
    lines.push('');
  }
  return finalize(lines);
}

export function renderArtifactsMarkdown(records: SessionRecord[]): string {
  const artifacts = records.filter((record) => record.kind === 'artifact');
  const lines = ['# Artifacts', ''];
  if (artifacts.length === 0) {
    lines.push('None.');
    return finalize(lines);
  }

  for (const record of artifacts) {
    const path = stringFrom(record.meta, 'path') ?? firstLine(record.text);
    const kind = stringFrom(record.meta, 'kind');
    const mime = stringFrom(record.meta, 'mime');
    const detail = [kind, mime].filter((part): part is string => Boolean(part)).join(', ');
    lines.push(`- ${path}${detail ? ` (${detail})` : ''}`);
  }
  return finalize(lines);
}

export function renderEventsJsonl(records: SessionRecord[]): string {
  if (records.length === 0) return '';
  return `${records.map((record) => JSON.stringify(recordToJson(record))).join('\n')}\n`;
}

function toSessionRecord(row: SessionRecordRow): SessionRecord {
  return {
    sessionId: row.session_id,
    eventId: Number(row.event_id),
    seq: row.seq,
    // Markdown rendering doesn't use entryUid; '' bridges any transient null
    // (pre-projection / pre-backfill rows) until the column is NOT NULL.
    entryUid: row.entry_uid ?? '',
    kind: row.kind,
    actor: row.actor,
    driver: row.driver,
    viewTier: row.view_tier,
    text: row.text,
    meta: objectFrom(row.meta) as SessionRecord['meta'],
    ts: row.ts,
  };
}

function renderLeanRecord(lines: string[], record: SessionRecord): void {
  switch (record.kind) {
    case 'message':
      lines.push(`**${labelActor(record.actor)}**: ${record.text}`);
      lines.push('');
      return;
    case 'command':
      lines.push('**Agent command**');
      lines.push('');
      lines.push('```console');
      lines.push(record.text);
      lines.push('```');
      lines.push('');
      return;
    case 'file_change':
      lines.push(`**File change**: ${firstLine(record.text)}`);
      appendRemainingLines(lines, record.text);
      lines.push('');
      return;
    case 'artifact':
      lines.push(`**Artifact**: ${record.text}`);
      lines.push('');
      return;
    case 'question':
      lines.push(`**Question**: ${record.text}`);
      lines.push('');
      return;
    case 'usage':
    case 'status':
      lines.push(`**${titleCase(record.kind)}**: ${record.text}`);
      lines.push('');
      return;
    case 'reasoning':
    case 'plan':
    case 'tool_call':
      return;
  }
}

function appendRemainingLines(lines: string[], text: string): void {
  const rest = text.split('\n').slice(1).join('\n').trim();
  if (!rest) return;
  lines.push('');
  lines.push(rest);
}

function countRecords(records: SessionRecord[]): {
  messages: number;
  commands: number;
  filesChanged: number;
  artifacts: number;
} {
  return {
    messages: records.filter((record) => record.kind === 'message').length,
    commands: records.filter((record) => record.kind === 'command').length,
    filesChanged: uniquePaths(records.filter((record) => record.kind === 'file_change')).size,
    artifacts: records.filter((record) => record.kind === 'artifact').length,
  };
}

function keyActions(records: SessionRecord[]): string[] {
  const actions: string[] = [];
  for (const record of records) {
    if (actions.length >= 8) break;
    if (record.kind === 'command') {
      actions.push(`Ran ${commandFromText(record.text) ?? 'command'}`);
    } else if (record.kind === 'file_change') {
      const path = stringFrom(record.meta, 'path') ?? firstLine(record.text);
      const kind = stringFrom(record.meta, 'kind') ?? 'updated';
      actions.push(`${kind} ${path}`);
    } else if (record.kind === 'artifact') {
      actions.push(`Captured ${stringFrom(record.meta, 'path') ?? firstLine(record.text)}`);
    } else if (record.kind === 'message' && record.actor === 'user') {
      actions.push(`User asked: ${excerpt(record.text, 140)}`);
    } else if (record.kind === 'status' && record.text) {
      actions.push(excerpt(firstLine(record.text), 140));
    }
  }
  return actions;
}

function uniquePaths(records: SessionRecord[]): Set<string> {
  const paths = new Set<string>();
  for (const record of records) {
    paths.add(stringFrom(record.meta, 'path') ?? firstLine(record.text));
  }
  return paths;
}

function recordToJson(record: SessionRecord): Record<string, unknown> {
  return {
    sessionId: record.sessionId,
    eventId: record.eventId,
    seq: record.seq,
    kind: record.kind,
    actor: record.actor,
    driver: record.driver,
    viewTier: record.viewTier,
    text: record.text,
    meta: record.meta,
    handle: record.entryUid ? encodeRecordHandle(record.entryUid) : null,
    ts: record.ts.toISOString(),
  };
}

function objectFrom(value: unknown): Record<string, unknown> {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringFrom(value: unknown, key: string): string | null {
  const record = objectFrom(value);
  const field = record[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

function labelActor(actor: SessionRecordActor): string {
  if (actor === 'user') return 'User';
  if (actor === 'agent') return 'Agent';
  return 'System';
}

function titleCase(input: SessionRecordKind | string): string {
  return input
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

function commandFromText(text: string): string | null {
  const line = firstLine(text);
  if (!line.startsWith('$ ')) return null;
  return line.slice(2);
}

function outputFromText(text: string): string {
  const lines = text.split('\n');
  if (lines[0]?.startsWith('$ ')) lines.shift();
  return lines.join('\n').trim();
}

function excerpt(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 3).trimEnd()}...`;
}

function driverFromHarness(harness: string): string | null {
  const normalized = harness.toLowerCase();
  if (normalized.includes('codex')) return 'codex';
  if (normalized.includes('claude')) return 'claude';
  return null;
}

function finalize(lines: string[]): string {
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}
