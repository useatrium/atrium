import type { Pool } from 'pg';
import type {
  SessionCapabilityChange,
  SessionCapabilityHarness,
  SessionCapabilityItem,
  SessionCapabilityNamespace,
  SessionCapabilitySnapshot,
} from '@atrium/surface-client/session-capabilities';

export const SESSION_CAPABILITY_PARSER_VERSION = 1;

interface SnapshotInput {
  sessionId: string;
  harness: SessionCapabilityHarness;
  sourceSha256: string;
  bytes: Buffer;
  generatedAt?: string;
}

interface ParserState {
  sessionId: string;
  harness: SessionCapabilityHarness;
  sourceSha256: string;
  generatedAt: string;
  runtime: Record<string, unknown>;
  tools: Map<string, SessionCapabilityItem>;
  namespaces: Map<string, SessionCapabilityNamespace>;
  mcpServers: Map<string, SessionCapabilityItem>;
  agents: Map<string, SessionCapabilityItem>;
  skills: Map<string, SessionCapabilityItem>;
  observedToolCalls: Map<string, SessionCapabilityItem>;
  pendingMcpServers: Set<string>;
  changes: SessionCapabilityChange[];
  warnings: Set<string>;
  redactions: Set<string>;
  runtimeSignatures: Map<string, string>;
}

interface JsonLine {
  line: number;
  record: Record<string, unknown>;
}

const MAX_LISTED_NAMES = 24;
const MAX_DESCRIPTION = 220;
const MAX_CHANGES = 200;

export function deriveSessionCapabilitySnapshot(input: SnapshotInput): SessionCapabilitySnapshot {
  const state: ParserState = {
    sessionId: input.sessionId,
    harness: input.harness,
    sourceSha256: input.sourceSha256,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    runtime: {},
    tools: new Map(),
    namespaces: new Map(),
    mcpServers: new Map(),
    agents: new Map(),
    skills: new Map(),
    observedToolCalls: new Map(),
    pendingMcpServers: new Set(),
    changes: [],
    warnings: new Set(),
    redactions: new Set(),
    runtimeSignatures: new Map(),
  };

  const lines = parseJsonLines(input.bytes, state);
  for (const entry of lines) {
    if (input.harness === 'claude') parseClaudeRecord(state, entry);
    else parseCodexRecord(state, entry);
  }

  if (lines.length === 0) state.warnings.add('No parseable JSONL records found.');

  const tools = sortItems(state.tools);
  const namespaces = buildToolNamespaces(state, tools);
  const snapshot: SessionCapabilitySnapshot = {
    parserVersion: SESSION_CAPABILITY_PARSER_VERSION,
    sessionId: input.sessionId,
    harness: input.harness,
    sourceSha256: input.sourceSha256,
    completeness: input.harness === 'claude' ? 'complete' : 'partial',
    generatedAt: state.generatedAt,
    runtime: state.runtime,
    counts: {
      tools: tools.length,
      toolNamespaces: namespaces.length,
      mcpServers: state.mcpServers.size,
      agents: state.agents.size,
      skills: state.skills.size,
      observedToolCalls: state.observedToolCalls.size,
      changes: state.changes.length,
    },
    tools,
    toolNamespaces: namespaces,
    mcpServers: sortItems(state.mcpServers),
    agents: sortItems(state.agents),
    skills: sortItems(state.skills),
    observedToolCalls: sortItems(state.observedToolCalls),
    pendingMcpServers: [...state.pendingMcpServers].sort(compareNames),
    changes: state.changes.slice(-MAX_CHANGES),
    warnings: [...state.warnings].sort(compareNames),
    redactions: [...state.redactions].sort(compareNames),
  };
  return snapshot;
}

export async function storeSessionCapabilitySnapshot(
  pool: Pool,
  snapshot: SessionCapabilitySnapshot,
): Promise<void> {
  await pool.query(
    `INSERT INTO session_capability_snapshots (
       session_id, harness, source_sha256, parser_version, snapshot_json, updated_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, now())
     ON CONFLICT (session_id, harness)
       DO UPDATE SET source_sha256 = EXCLUDED.source_sha256,
                     parser_version = EXCLUDED.parser_version,
                     snapshot_json = EXCLUDED.snapshot_json,
                     updated_at = now()`,
    [
      snapshot.sessionId,
      snapshot.harness,
      snapshot.sourceSha256,
      snapshot.parserVersion,
      JSON.stringify(snapshot),
    ],
  );
}

export async function loadSessionCapabilitySnapshots(
  pool: Pool,
  sessionId: string,
): Promise<SessionCapabilitySnapshot[]> {
  const rows = await pool.query<{ snapshot_json: SessionCapabilitySnapshot }>(
    `SELECT snapshot_json
       FROM session_capability_snapshots
      WHERE session_id = $1
      ORDER BY harness ASC`,
    [sessionId],
  );
  return rows.rows.map((row) => row.snapshot_json);
}

export async function ensureSessionCapabilitySnapshots(
  pool: Pool,
  storage: { getObjectBytes(key: string): Promise<Buffer> },
  sessionId: string,
): Promise<SessionCapabilitySnapshot[]> {
  const rows = await pool.query<{
    harness: SessionCapabilityHarness;
    s3_key: string;
    sha256: string;
    snapshot_json: SessionCapabilitySnapshot | null;
    snapshot_sha256: string | null;
    parser_version: number | null;
  }>(
    `SELECT ht.harness, ht.s3_key, ht.sha256,
            scs.snapshot_json, scs.source_sha256 AS snapshot_sha256, scs.parser_version
       FROM harness_transcripts ht
       LEFT JOIN session_capability_snapshots scs
         ON scs.session_id = ht.session_id AND scs.harness = ht.harness
      WHERE ht.session_id = $1 AND ht.harness IN ('claude', 'codex')
      ORDER BY ht.harness ASC`,
    [sessionId],
  );

  const snapshots: SessionCapabilitySnapshot[] = [];
  for (const row of rows.rows) {
    if (
      row.snapshot_json &&
      row.snapshot_sha256 === row.sha256 &&
      row.parser_version === SESSION_CAPABILITY_PARSER_VERSION
    ) {
      snapshots.push(row.snapshot_json);
      continue;
    }
    const bytes = await storage.getObjectBytes(row.s3_key);
    const snapshot = deriveSessionCapabilitySnapshot({
      sessionId,
      harness: row.harness,
      sourceSha256: row.sha256,
      bytes,
    });
    await storeSessionCapabilitySnapshot(pool, snapshot);
    snapshots.push(snapshot);
  }
  return snapshots;
}

function parseJsonLines(bytes: Buffer, state: ParserState): JsonLine[] {
  const parsed: JsonLine[] = [];
  const text = bytes.toString('utf8');
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line) as unknown;
      if (isObject(record)) parsed.push({ line: index + 1, record });
    } catch {
      state.warnings.add(`Skipped malformed JSONL at line ${index + 1}.`);
    }
  }
  return parsed;
}

function parseClaudeRecord(state: ParserState, entry: JsonLine): void {
  const record = entry.record;
  const type = stringValue(record.type);
  const timestamp = recordTimestamp(record);

  if (type === 'mode') {
    updateRuntime(state, 'mode', stringValue(record.mode), entry, 'claude.mode');
    return;
  }
  if (type === 'permission-mode') {
    updateRuntime(state, 'permissionMode', stringValue(record.permissionMode), entry, 'claude.permission-mode');
    return;
  }
  if (type === 'user') {
    updateRuntime(state, 'cwd', safePath(stringValue(record.cwd)), entry, 'claude.user');
    updateRuntime(state, 'cliVersion', stringValue(record.version), entry, 'claude.user');
    updateRuntime(state, 'gitBranch', stringValue(record.gitBranch), entry, 'claude.user');
    updateRuntime(state, 'entrypoint', stringValue(record.entrypoint), entry, 'claude.user');
    updateRuntime(state, 'permissionMode', stringValue(record.permissionMode), entry, 'claude.user');
    return;
  }

  const attachment = isObject(record.attachment) ? record.attachment : null;
  if (!attachment) return;
  const attachmentType = stringValue(attachment.type);
  if (attachmentType === 'deferred_tools_delta') {
    const added = stringArray(attachment.addedNames);
    const removed = stringArray(attachment.removedNames);
    const readded = stringArray(attachment.readdedNames);
    for (const name of [...added, ...readded]) addTool(state, name, 'claude.deferred_tools_delta');
    for (const name of removed) state.tools.delete(name);
    const nextPending = new Set(stringArray(attachment.pendingMcpServers));
    clearRemovedPendingMcpServers(state, nextPending);
    state.pendingMcpServers = nextPending;
    for (const name of state.pendingMcpServers) {
      putItem(state.mcpServers, { name, sources: ['claude.pending_mcp_server'], status: 'pending' });
    }
    for (const name of [...added, ...readded]) {
      const mcpName = mcpServerNameFromTool(name);
      if (mcpName) {
        putItem(state.mcpServers, {
          name: mcpName,
          sources: ['claude.deferred_tools_delta'],
          status: 'available',
        });
      }
    }
    addChange(state, entry, {
      timestamp,
      source: 'claude.deferred_tools_delta',
      summary: 'Tool availability delta',
      added,
      removed,
      readded,
      counts: {
        added: added.length,
        removed: removed.length,
        readded: readded.length,
        pendingMcpServers: state.pendingMcpServers.size,
      },
    });
    return;
  }

  if (attachmentType === 'agent_listing_delta') {
    const addedTypes = stringArray(attachment.addedTypes);
    const removedTypes = stringArray(attachment.removedTypes);
    const descriptions = parseDashedDescriptions(stringArray(attachment.addedLines).join('\n'));
    for (const name of addedTypes) {
      putItem(state.agents, {
        name,
        sources: ['claude.agent_listing_delta'],
        description: descriptions.get(name),
      });
    }
    for (const name of removedTypes) state.agents.delete(name);
    addChange(state, entry, {
      timestamp,
      source: 'claude.agent_listing_delta',
      summary: 'Agent listing delta',
      added: addedTypes,
      removed: removedTypes,
      counts: { added: addedTypes.length, removed: removedTypes.length },
    });
    return;
  }

  if (attachmentType === 'mcp_instructions_delta') {
    const added = stringArray(attachment.addedNames);
    const removed = stringArray(attachment.removedNames);
    for (const name of added) {
      putItem(state.mcpServers, {
        name,
        sources: ['claude.mcp_instructions_delta'],
        description: 'Instruction block captured and redacted.',
        status: 'available',
      });
    }
    for (const name of removed) state.mcpServers.delete(name);
    if (stringArray(attachment.addedBlocks).length > 0) {
      state.redactions.add('Claude MCP instruction blocks are captured in raw transcript and redacted here.');
    }
    addChange(state, entry, {
      timestamp,
      source: 'claude.mcp_instructions_delta',
      summary: 'MCP instruction delta',
      added,
      removed,
      counts: { added: added.length, removed: removed.length },
      redacted: true,
    });
    return;
  }

  if (attachmentType === 'skill_listing') {
    const names = stringArray(attachment.names);
    const descriptions = parseDashedDescriptions(stringValue(attachment.content) ?? '');
    for (const name of names) {
      putItem(state.skills, {
        name,
        sources: ['claude.skill_listing'],
        description: descriptions.get(name),
      });
    }
    state.redactions.add('Claude skill listing content is summarized to names and short descriptions.');
    addChange(state, entry, {
      timestamp,
      source: 'claude.skill_listing',
      summary: 'Skill listing captured',
      added: names,
      counts: { skills: names.length },
      redacted: true,
    });
  }
}

function parseCodexRecord(state: ParserState, entry: JsonLine): void {
  const record = entry.record;
  const type = stringValue(record.type);
  const timestamp = recordTimestamp(record);

  if (type === 'session_meta' && isObject(record.payload)) {
    const payload = record.payload;
    const git = isObject(payload.git) ? payload.git : {};
    updateRuntimeGroup(
      state,
      'codex.session_meta',
      {
        cwd: safePath(stringValue(payload.cwd)),
        originator: stringValue(payload.originator),
        cliVersion: stringValue(payload.cli_version),
        source: stringValue(payload.source),
        threadSource: stringValue(payload.thread_source),
        modelProvider: stringValue(payload.model_provider),
        gitBranch: stringValue(git.branch),
        gitCommit: stringValue(git.commit_hash),
      },
      entry,
      timestamp,
    );
    if (payload.base_instructions) {
      state.redactions.add('Codex base instructions are captured in raw transcript and redacted here.');
    }
    return;
  }

  if (type === 'turn_context' && isObject(record.payload)) {
    const payload = record.payload;
    const sandbox = isObject(payload.sandbox_policy) ? payload.sandbox_policy : {};
    const collaboration = isObject(payload.collaboration_mode) ? payload.collaboration_mode : {};
    updateRuntimeGroup(
      state,
      'codex.turn_context',
      {
        cwd: safePath(stringValue(payload.cwd)),
        workspaceRoots: stringArray(payload.workspace_roots).map(safePath).filter(Boolean),
        currentDate: stringValue(payload.current_date),
        timezone: stringValue(payload.timezone),
        approvalPolicy: stringValue(payload.approval_policy),
        sandboxPolicy: stringValue(sandbox.type),
        model: stringValue(payload.model),
        effort: stringValue(payload.effort),
        personality: stringValue(payload.personality),
        collaborationMode: stringValue(collaboration.mode),
        multiAgentVersion: stringValue(payload.multi_agent_version),
      },
      entry,
      timestamp,
    );
    return;
  }

  const payload = isObject(record.payload) ? record.payload : null;
  if (!payload) return;
  const payloadType = stringValue(payload.type);

  if (payloadType === 'message' && stringValue(payload.role) === 'developer') {
    for (const text of messageTextParts(payload.content)) parseCodexDeveloperText(state, text, entry, timestamp);
    state.redactions.add('Codex developer instructions are summarized to capability names and short descriptions.');
    return;
  }

  if (payloadType === 'tool_search_output') {
    parseCodexToolSearchOutput(state, payload, entry, timestamp);
    return;
  }

  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    const name = stringValue(payload.name);
    if (name) {
      incrementObservedTool(state, name, payloadType === 'custom_tool_call' ? 'codex.custom_tool_call' : 'codex.function_call');
      addChange(state, entry, {
        timestamp,
        source: payloadType === 'custom_tool_call' ? 'codex.custom_tool_call' : 'codex.function_call',
        summary: 'Tool call observed',
        added: [name],
        counts: { observed: 1 },
      });
    }
  }
}

function parseCodexDeveloperText(
  state: ParserState,
  text: string,
  entry: JsonLine,
  timestamp?: string,
): void {
  const toolAdded: string[] = [];
  const namespaceMatches = [...text.matchAll(/^## Namespace: ([A-Za-z0-9_.:-]+)/gm)];
  for (let i = 0; i < namespaceMatches.length; i++) {
    const match = namespaceMatches[i]!;
    const namespace = match[1]!;
    const start = match.index ?? 0;
    const end = namespaceMatches[i + 1]?.index ?? text.length;
    const section = text.slice(start, end);
    const toolNames = [...section.matchAll(/^type ([A-Za-z_][A-Za-z0-9_]*) = /gm)].map((m) => m[1]!);
    if (toolNames.length > 0) {
      putNamespace(state, namespace, 'codex.developer_tools', toolNames.length);
      for (const toolName of toolNames) {
        const fullName = `${namespace}.${toolName}`;
        if (!state.tools.has(fullName)) toolAdded.push(fullName);
        addTool(state, fullName, 'codex.developer_tools', namespace);
      }
    }
  }

  const skillSection = sectionBetween(text, '### Available skills', '### How to use skills');
  const skillDescriptions = parseDashedDescriptions(skillSection);
  const skillAdded: string[] = [];
  for (const [name, description] of skillDescriptions) {
    if (!state.skills.has(name)) skillAdded.push(name);
    putItem(state.skills, { name, sources: ['codex.developer_skills'], description });
  }

  if (toolAdded.length > 0 || skillAdded.length > 0) {
    addChange(state, entry, {
      timestamp,
      source: 'codex.developer_context',
      summary: 'Developer capability context captured',
      added: [...toolAdded, ...skillAdded],
      counts: { tools: toolAdded.length, skills: skillAdded.length },
      redacted: true,
    });
  }
}

function parseCodexToolSearchOutput(
  state: ParserState,
  payload: Record<string, unknown>,
  entry: JsonLine,
  timestamp?: string,
): void {
  const added: string[] = [];
  const tools = Array.isArray(payload.tools) ? payload.tools.filter(isObject) : [];
  for (const namespaceRecord of tools) {
    if (stringValue(namespaceRecord.type) !== 'namespace') continue;
    const namespace = stringValue(namespaceRecord.name);
    if (!namespace) continue;
    const nested = Array.isArray(namespaceRecord.tools) ? namespaceRecord.tools.filter(isObject) : [];
    putNamespace(state, namespace, 'codex.tool_search_output', nested.length, stringValue(namespaceRecord.description));
    for (const tool of nested) {
      const toolName = stringValue(tool.name);
      if (!toolName) continue;
      const fullName = `${namespace}.${toolName}`;
      if (!state.tools.has(fullName)) added.push(fullName);
      addTool(state, fullName, 'codex.tool_search_output', namespace, stringValue(tool.description));
    }
  }
  if (added.length > 0) {
    addChange(state, entry, {
      timestamp,
      source: 'codex.tool_search_output',
      summary: 'Deferred tool metadata loaded',
      added,
      counts: { tools: added.length },
    });
  }
}

function updateRuntime(
  state: ParserState,
  key: string,
  value: unknown,
  entry: JsonLine,
  source: string,
): void {
  if (value == null || value === '') return;
  if (state.runtime[key] === value) return;
  state.runtime[key] = value;
  addChange(state, entry, {
    timestamp: recordTimestamp(entry.record),
    source,
    summary: `Runtime ${key} captured`,
    counts: { runtimeFields: 1 },
  });
}

function updateRuntimeGroup(
  state: ParserState,
  source: string,
  values: Record<string, unknown>,
  entry: JsonLine,
  timestamp?: string,
): void {
  const clean = Object.fromEntries(Object.entries(values).filter(([, value]) => value != null && value !== ''));
  const signature = JSON.stringify(clean);
  if (state.runtimeSignatures.get(source) === signature) return;
  state.runtimeSignatures.set(source, signature);
  Object.assign(state.runtime, clean);
  addChange(state, entry, {
    timestamp,
    source,
    summary: 'Runtime context captured',
    counts: { runtimeFields: Object.keys(clean).length },
  });
}

function addTool(
  state: ParserState,
  name: string,
  source: string,
  namespace = toolNamespace(name),
  description?: string,
): void {
  putItem(state.tools, {
    name,
    namespace,
    sources: [source],
    description: trimDescription(description),
    status: source.includes('observed') ? 'observed' : 'available',
  });
}

function incrementObservedTool(state: ParserState, name: string, source: string): void {
  const existing = state.observedToolCalls.get(name);
  putItem(state.observedToolCalls, {
    name,
    namespace: toolNamespace(name),
    sources: [source],
    status: 'observed',
    count: (existing?.count ?? 0) + 1,
  });
}

function putNamespace(
  state: ParserState,
  name: string,
  source: string,
  count: number,
  description?: string,
): void {
  const existing = state.namespaces.get(name);
  state.namespaces.set(name, {
    name,
    sources: mergeSources(existing?.sources ?? [], [source]),
    description: trimDescription(existing?.description ?? description),
    count: Math.max(existing?.count ?? 0, count),
  });
}

function putItem<T extends SessionCapabilityItem>(map: Map<string, T>, item: T): void {
  const existing = map.get(item.name);
  if (!existing) {
    map.set(item.name, { ...item, description: trimDescription(item.description) });
    return;
  }
  map.set(item.name, {
    ...existing,
    ...item,
    sources: mergeSources(existing.sources, item.sources),
    description: trimDescription(existing.description ?? item.description),
    count: item.count ?? existing.count,
    status: item.status ?? existing.status,
  });
}

function clearRemovedPendingMcpServers(state: ParserState, nextPending: Set<string>): void {
  for (const [name, item] of state.mcpServers) {
    if (!item.sources.includes('claude.pending_mcp_server') || nextPending.has(name)) continue;
    const sources = item.sources.filter((source) => source !== 'claude.pending_mcp_server');
    if (sources.length === 0) {
      state.mcpServers.delete(name);
    } else {
      state.mcpServers.set(name, { ...item, sources, status: 'available' });
    }
  }
}

function addChange(
  state: ParserState,
  entry: JsonLine,
  change: Omit<SessionCapabilityChange, 'seq' | 'line'>,
): void {
  const useful =
    (change.added?.length ?? 0) > 0 ||
    (change.removed?.length ?? 0) > 0 ||
    (change.readded?.length ?? 0) > 0 ||
    Object.values(change.counts ?? {}).some((count) => count > 0);
  if (!useful) return;
  state.changes.push({
    seq: state.changes.length + 1,
    line: entry.line,
    ...change,
    added: limitNames(change.added),
    removed: limitNames(change.removed),
    readded: limitNames(change.readded),
  });
}

function buildToolNamespaces(
  state: ParserState,
  tools: SessionCapabilityItem[],
): SessionCapabilityNamespace[] {
  for (const tool of tools) {
    const namespace = tool.namespace ?? toolNamespace(tool.name);
    const existing = state.namespaces.get(namespace);
    state.namespaces.set(namespace, {
      name: namespace,
      sources: mergeSources(existing?.sources ?? [], tool.sources),
      description: existing?.description,
      count:
        (existing?.count ?? 0) +
        (existing ? 0 : tools.filter((candidate) => (candidate.namespace ?? toolNamespace(candidate.name)) === namespace).length),
    });
  }
  return [...state.namespaces.values()].sort((a, b) => compareNames(a.name, b.name));
}

function sortItems(map: Map<string, SessionCapabilityItem>): SessionCapabilityItem[] {
  return [...map.values()].sort((a, b) => compareNames(a.name, b.name));
}

function parseDashedDescriptions(text: string): Map<string, string> {
  const descriptions = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('- ')) continue;
    const separator = line.indexOf(': ');
    if (separator < 0) continue;
    const name = line.slice(2, separator).trim();
    const description = trimDescription(line.slice(separator + 2).replace(/\s*\(file:\s+[^)]*\)\s*$/, ''));
    if (name && description) descriptions.set(name, description);
  }
  return descriptions;
}

function messageTextParts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  const parts: string[] = [];
  for (const part of value) {
    if (!isObject(part)) continue;
    const text = stringValue(part.text);
    if (text) parts.push(text);
  }
  return parts;
}

function sectionBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  if (start < 0) return '';
  const end = text.indexOf(endMarker, start + startMarker.length);
  return text.slice(start + startMarker.length, end < 0 ? text.length : end);
}

function toolNamespace(name: string): string {
  const mcp = mcpServerNameFromTool(name);
  if (mcp) return `mcp:${mcp}`;
  const dot = name.indexOf('.');
  if (dot > 0) return name.slice(0, dot);
  return 'builtin';
}

function mcpServerNameFromTool(name: string): string | null {
  if (!name.startsWith('mcp__')) return null;
  const [, server] = name.split('__');
  if (!server) return 'unknown';
  if (server.startsWith('claude_ai_')) return `claude.ai ${server.slice('claude_ai_'.length).replaceAll('_', ' ')}`;
  return server.replaceAll('_', ' ');
}

function recordTimestamp(record: Record<string, unknown>): string | undefined {
  const direct = stringValue(record.timestamp);
  if (direct) return direct;
  const payload = isObject(record.payload) ? record.payload : null;
  return stringValue(payload?.timestamp);
}

function safePath(value?: string): string | undefined {
  if (!value) return undefined;
  const parts = value.replaceAll('\\', '/').split('/').filter(Boolean);
  if (parts.length <= 2) return value;
  return `.../${parts.slice(-2).join('/')}`;
}

function trimDescription(value?: string | null): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length > MAX_DESCRIPTION ? `${compact.slice(0, MAX_DESCRIPTION - 3)}...` : compact;
}

function limitNames(names?: string[]): string[] | undefined {
  if (!names || names.length === 0) return undefined;
  const sorted = [...names].sort(compareNames);
  if (sorted.length <= MAX_LISTED_NAMES) return sorted;
  return [...sorted.slice(0, MAX_LISTED_NAMES), `+${sorted.length - MAX_LISTED_NAMES} more`];
}

function mergeSources(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort(compareNames);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}
