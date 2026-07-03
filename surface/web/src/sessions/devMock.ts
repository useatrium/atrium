// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  DEV MOCK — sessions API stand-in. NOT PRODUCTION CODE.
//
// Serves the exact /api/sessions shapes from the Phase-0 capture fixtures in
// centaur-client/test/fixtures so the Sessions UI can be exercised
// before the real server endpoints exist.
//
// Enabled ONLY when the dev server runs with VITE_SESSIONS_MOCK=1:
//
//   VITE_SESSIONS_MOCK=1 pnpm --filter @atrium/web dev
//
// To use the real endpoints: start without the flag. To remove the mock for
// good: delete this file and the `sessionsMock` / `sessionsMockBus` references
// in ./api.ts and ../Chat.tsx (plus the `mock` field on WireEvent in
// ../state.ts and its one use in ../appState.ts).
//
// Mock behavior:
//   - `@agent <task>`            → replays the B_tooltest fixture (Bash tool call)
//   - `@agent <task with "long">`→ replays C_longstream 3x (~1,240 frames)
//   - pane composer send         → appends a synthetic ack turn
//   - cancel                     → emits a terminal cancelled execution_state
//   - unknown session ids (e.g. /s/whatever) → synthesized completed B session
//
// Seat-flow simulation (Phase 3) — driven by a simulated teammate "Sam":
//   - `@agent <task with "seat">`→ ~4s in, Sam requests the seat (grant banner)
//   - grant to Sam               → Sam drives: steers one synthetic turn and
//                                  "watches" for 8s, during which seat/take
//                                  → 409 seat_held (exercises the fallback);
//                                  after 8s a take succeeds
//   - seat/request while Sam drives → Sam grants the seat back after ~2.5s
// ─────────────────────────────────────────────────────────────────────────────

import type { CentaurEventFrame } from '@atrium/centaur-client';
import { ApiError } from '../api';
import type { UserRef, WireEvent } from '@atrium/surface-client';
import type {
  CreateSessionBody,
  SessionCapabilitiesResponse,
  SessionStreamCallbacks,
  SessionStreamHandle,
} from './api';
import { normalizeExecutionStatus, type SessionStatus, type SessionWire } from './types';
import rawB from '../../../centaur-client/test/fixtures/B_tooltest.json';
import rawC from '../../../centaur-client/test/fixtures/C_longstream.json';

const ENABLED =
  typeof import.meta.env !== 'undefined' &&
  import.meta.env.DEV === true &&
  import.meta.env.VITE_SESSIONS_MOCK === '1';

const B = rawB as unknown as CentaurEventFrame[];
const C = rawC as unknown as CentaurEventFrame[];

// ---- wire-event bus (stands in for the WS session.* fanout) ----------------

type WireListener = (ev: WireEvent) => void;
const busListeners = new Set<WireListener>();
let wireSeq = 9_000_000_000; // far above real event ids; flagged mock anyway

function emitWire(
  type: string,
  channelId: string,
  threadRootEventId: number | null,
  author: UserRef | null,
  payload: Record<string, unknown>,
): void {
  const ev: WireEvent = {
    id: ++wireSeq,
    workspaceId: 'mock-ws',
    channelId,
    threadRootEventId,
    type,
    actorId: author?.id ?? null,
    payload,
    createdAt: new Date().toISOString(),
    author,
    mock: true,
  };
  for (const fn of busListeners) fn(ev);
}

// ---- current user (real /auth/me via the dev proxy; fallback stub) ----------

let cachedMe: UserRef | null = null;
async function mockMe(): Promise<UserRef> {
  if (cachedMe) return cachedMe;
  try {
    const res = await fetch('/auth/me', { credentials: 'same-origin' });
    if (res.ok) {
      const body = (await res.json()) as { user?: UserRef };
      if (body.user) cachedMe = body.user;
    }
  } catch {
    /* server not up — use stub */
  }
  cachedMe ??= { id: 'mock-user', handle: 'mock', displayName: 'Mock User' };
  return cachedMe;
}

// ---- simulated teammate for the seat flow -----------------------------------

const SAM: UserRef = { id: 'mock-sam', handle: 'sam', displayName: 'Sam' };
const SAM_REQUEST_DELAY_MS = 4_000; // task contains "seat" → Sam asks for it
const SAM_HOLD_MS = 8_000; // after a grant, Sam "watches" → take 409s
const SAM_GRANT_BACK_MS = 2_500; // Sam grants a pending request back
const SAM_SUGGEST_DELAY_MS = 3_000; // task contains "suggest" → Sam proposes one

function emitSeatRequested(run: MockRun, by: UserRef): void {
  const pending = (run.wire.pendingSeatRequests ??= []);
  if (run.wire.driverId === by.id || pending.some((r) => r.userId === by.id)) return;
  pending.push({ userId: by.id, displayName: by.displayName });
  emitWire('session.seat_requested', run.wire.channelId, run.wire.threadRootEventId, by, {
    sessionId: run.wire.id,
    by: by.id,
  });
}

function emitSeatChanged(
  run: MockRun,
  to: UserRef,
  reason: 'granted' | 'taken',
  actor: UserRef,
): void {
  const from = run.wire.driverId;
  run.wire.driverId = to.id;
  run.wire.driver = { userId: to.id, displayName: to.displayName };
  run.wire.pendingSeatRequests = (run.wire.pendingSeatRequests ?? []).filter(
    (r) => r.userId !== to.id,
  );
  emitWire('session.seat_changed', run.wire.channelId, run.wire.threadRootEventId, actor, {
    sessionId: run.wire.id,
    from,
    to: to.id,
    reason,
  });
}

let suggestionSeq = 0;

function emitSuggestionAdded(run: MockRun, author: UserRef, text: string): string {
  const suggestionId = `mock-sug-${++suggestionSeq}`;
  (run.suggestions ??= new Map()).set(suggestionId, text);
  emitWire('session.suggestion_added', run.wire.channelId, run.wire.threadRootEventId, author, {
    sessionId: run.wire.id,
    suggestionId,
    authorId: author.id,
    text,
  });
  return suggestionId;
}

function emitSuggestionResolved(
  run: MockRun,
  actor: UserRef,
  suggestionId: string,
  status: 'sent' | 'dismissed',
  extra: Record<string, unknown> = {},
): void {
  emitWire('session.suggestion_resolved', run.wire.channelId, run.wire.threadRootEventId, actor, {
    sessionId: run.wire.id,
    suggestionId,
    status,
    resolvedBy: actor.id,
    ...extra,
  });
}

let proposalSeq = 0;

function emitAnswerProposed(
  run: MockRun,
  author: UserRef,
  questionId: string,
  answers: Record<string, { answers: string[] }>,
): string {
  const proposalId = `mock-prop-${++proposalSeq}`;
  emitWire('session.answer_proposed', run.wire.channelId, run.wire.threadRootEventId, author, {
    sessionId: run.wire.id,
    proposalId,
    questionId,
    authorId: author.id,
    answers,
  });
  return proposalId;
}

function emitAnswerProposalResolved(
  run: MockRun,
  actor: UserRef,
  proposalId: string,
  status: 'submitted' | 'dismissed',
): void {
  emitWire('session.answer_proposal_resolved', run.wire.channelId, run.wire.threadRootEventId, actor, {
    sessionId: run.wire.id,
    proposalId,
    status,
    resolvedBy: actor.id,
  });
}

// ---- fixture scripts --------------------------------------------------------

/** C_longstream replayed 3x: re-numbered event ids, fresh uuids per replay. */
function longstream3(): CentaurEventFrame[] {
  const out: CentaurEventFrame[] = [];
  for (let k = 0; k < 3; k++) {
    for (const f of C) {
      const clone = JSON.parse(JSON.stringify(f)) as CentaurEventFrame & {
        data: Record<string, unknown> & { message?: { id?: string } };
      };
      clone.event_id = f.event_id + k * 100_000;
      if (k > 0) {
        if (typeof clone.data.uuid === 'string') clone.data.uuid = `${clone.data.uuid}-r${k}`;
        if (clone.data.message?.id) clone.data.message.id = `${clone.data.message.id}-r${k}`;
      }
      out.push(clone);
    }
  }
  return out;
}

/** 250 tool calls + 250 text messages → 500+ rendered items (scroll stress). */
function stressScript(): CentaurEventFrame[] {
  let id = 1000;
  const frames: CentaurEventFrame[] = [];
  frames.push({
    event: 'execution_state',
    event_id: id++,
    data: { type: 'execution.state', status: 'running', thread_key: 'mock-stress', execution_id: 'exe_stress' },
  } as CentaurEventFrame);
  for (let i = 0; i < 250; i++) {
    frames.push({
      event: 'amp_raw_event',
      event_id: id++,
      data: {
        type: 'assistant',
        uuid: `stress-tool-${i}`,
        message: {
          id: `msg_stress_tool_${i}`,
          content: [
            { type: 'tool_use', id: `toolu_stress_${i}`, name: 'Bash', input: { command: `echo step-${i}` } },
          ],
        },
      },
    } as CentaurEventFrame);
    frames.push({
      event: 'amp_raw_event',
      event_id: id++,
      data: {
        type: 'tool',
        content: [{ content: `step-${i}\n`, is_error: i % 50 === 49, tool_use_id: `toolu_stress_${i}` }],
      },
    } as CentaurEventFrame);
    frames.push({
      event: 'amp_raw_event',
      event_id: id++,
      data: {
        type: 'assistant',
        uuid: `stress-text-${i}`,
        message: { id: `msg_stress_text_${i}`, content: [{ type: 'text', text: `step ${i} done — proceeding to ${i + 1}.` }] },
      },
    } as CentaurEventFrame);
  }
  frames.push({
    event: 'execution_state',
    event_id: id++,
    data: {
      type: 'execution.state',
      status: 'completed',
      thread_key: 'mock-stress',
      execution_id: 'exe_stress',
      result_text: 'stress run: 250 tool calls + 250 texts (500+ items).',
    },
  } as CentaurEventFrame);
  return frames;
}

/** A few `artifact.captured` frames so the default mock run shows the Artifacts
 * gallery without the (real) Centaur capture sidecar. No bytes are served in the
 * mock, so image tiles fall back to their type label. */
function mockArtifacts(baseId: number): CentaurEventFrame[] {
  const make = (
    n: number,
    artifact_id: string,
    path: string,
    mime: string,
    size_bytes: number,
    ref: string | null,
  ): CentaurEventFrame =>
    ({
      event: 'artifact.captured',
      event_id: baseId + n,
      data: { type: 'artifact.captured', artifact_id, path, kind: 'created', mime, size_bytes, sha256: artifact_id, ref },
    }) as CentaurEventFrame;
  return [
    make(1, 'art-chart', '/tmp/chart.png', 'image/png', 48_210, 'blob-chart'),
    make(2, 'art-report', '/home/agent/workspace/out/report.csv', 'text/csv', 3_120, 'blob-report'),
    make(3, 'art-big', '/home/agent/outputs/render.pdf', 'application/pdf', 9_400_000, null),
  ];
}

function pickScript(task: string): CentaurEventFrame[] {
  const isDefault = !/stress/i.test(task) && !/long/i.test(task);
  const body: CentaurEventFrame[] = /stress/i.test(task)
    ? stressScript()
    : /long/i.test(task)
      ? longstream3()
      : JSON.parse(JSON.stringify(B));
  if (isDefault) {
    const maxId = body.reduce((m, f) => Math.max(m, f.event_id), 0);
    body.push(...mockArtifacts(maxId + 10));
  }
  // The spawn task is the session's first steer — emit it as a userMessage so
  // the transcript opens with the attributed prompt (matches the real flow).
  const firstId = body[0]?.event_id ?? 1000;
  const steer: CentaurEventFrame = {
    event: 'amp_raw_event',
    event_id: Math.max(1, firstId - 1),
    data: {
      type: 'item.completed',
      item: { id: 'steer-spawn', type: 'userMessage', content: [{ type: 'text', text: task }] },
    },
  } as CentaurEventFrame;
  return [steer, ...body];
}

/** A small synthetic follow-up turn acknowledging a pane-composer message. */
function synthTurn(baseId: number, threadKey: string, text: string): CentaurEventFrame[] {
  const ack = `steer ack: "${text}" — multi-turn execution is mocked; the real tailer arrives with the server half.`;
  const words = ack.split(/(?<= )/); // keep trailing spaces so deltas concat exactly
  let id = baseId;
  const frames: CentaurEventFrame[] = [];
  const state = (status: string, extra: Record<string, unknown> = {}) =>
    frames.push({
      event: 'execution_state',
      event_id: id++,
      data: { type: 'execution.state', status, thread_key: threadKey, execution_id: `exe_mock_${baseId}`, ...extra },
    } as CentaurEventFrame);
  state('running');
  for (const w of words) {
    frames.push({
      event: 'amp_raw_event',
      event_id: id++,
      data: { type: 'assistant', message: { content: [{ type: 'text', text: w }] } },
    } as CentaurEventFrame);
  }
  frames.push({
    event: 'amp_raw_event',
    event_id: id++,
    data: {
      type: 'assistant',
      uuid: `mock-turn-${baseId}`,
      message: { id: `msg_mock_${baseId}`, content: [{ type: 'text', text: ack }] },
    },
  } as CentaurEventFrame);
  frames.push({
    event: 'usage_observed',
    event_id: id++,
    data: {
      type: 'obs.usage',
      engine: 'mock',
      harness: 'codex',
      thread_key: threadKey,
      execution_id: `exe_mock_${baseId}`,
      model: 'claude-mock',
      cost_usd: 0.0042,
    },
  } as CentaurEventFrame);
  state('completed', { result_text: ack });
  return frames;
}

// ---- mock session runs ------------------------------------------------------

interface MockRun {
  wire: SessionWire;
  /** Durable log: everything emitted so far. */
  frames: CentaurEventFrame[];
  /** Remaining frames to emit. */
  script: CentaurEventFrame[];
  framesPerTick: number;
  tickMs: number;
  timer: ReturnType<typeof setInterval> | null;
  /** While in the future, the sim driver "is watching" → seat/take 409s. */
  seatHeldUntil?: number;
  /** Pending suggestion text by id, so a `send` can replay the real words. */
  suggestions?: Map<string, string>;
}

const runs = new Map<string, MockRun>();
let seq = 0;

function maxEventId(run: MockRun): number {
  const last = run.frames[run.frames.length - 1] ?? run.script[run.script.length - 1];
  return last?.event_id ?? 0;
}

function onFrameEmitted(run: MockRun, frame: CentaurEventFrame): void {
  const { wire } = run;
  wire.lastEventId = Math.max(wire.lastEventId, frame.event_id);
  if (frame.event === 'usage_observed' && typeof frame.data.cost_usd === 'number') {
    wire.costUsd = Number(wire.costUsd ?? 0) + frame.data.cost_usd;
  }
  if (frame.event !== 'execution_state') return;
  const status: SessionStatus = normalizeExecutionStatus(frame.data.status);
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  if (status !== wire.status) {
    wire.status = status;
    if (!terminal) {
      emitWire('session.status_changed', wire.channelId, wire.threadRootEventId, null, {
        sessionId: wire.id,
        status,
      });
    }
  }
  if (terminal) {
    if (typeof frame.data.result_text === 'string') wire.resultText = frame.data.result_text;
    wire.completedAt = new Date().toISOString();
    emitWire('session.completed', wire.channelId, wire.threadRootEventId, null, {
      sessionId: wire.id,
      status,
      resultExcerpt: (wire.resultText ?? '').slice(0, 240),
      permalink: `/s/${wire.id}`,
    });
  }
}

function ensureRunning(run: MockRun): void {
  if (run.timer || run.script.length === 0) return;
  run.timer = setInterval(() => {
    for (let i = 0; i < run.framesPerTick; i++) {
      const frame = run.script.shift();
      if (!frame) break;
      run.frames.push(frame);
      onFrameEmitted(run, frame);
    }
    if (run.script.length === 0 && run.timer) {
      clearInterval(run.timer);
      run.timer = null;
    }
  }, run.tickMs);
}

/** Unknown ids (permalinks into sessions from "before") → completed B replay. */
function synthesizeCompletedRun(id: string): MockRun {
  const me = cachedMe ?? { id: 'mock-user', handle: 'mock', displayName: 'Mock User' };
  const body = JSON.parse(JSON.stringify(B)) as CentaurEventFrame[];
  // Open replays with their prompt as the first steer (so the transcript shows
  // the call-and-response + turn rail), matching the real flow.
  const firstId = body[0]?.event_id ?? 1000;
  const frames: CentaurEventFrame[] = [
    {
      event: 'amp_raw_event',
      event_id: Math.max(1, firstId - 1),
      data: {
        type: 'item.completed',
        item: {
          id: 'steer-spawn',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Investigate the toolchain roundtrip and report the result.' }],
        },
      },
    } as CentaurEventFrame,
    ...body,
  ];
  const run: MockRun = {
    wire: {
      id,
      workspaceId: 'mock-ws',
      channelId: '',
      threadRootEventId: null,
      title: 'replayed mock session (B_tooltest)',
      status: 'spawning',
      harness: 'codex',
      spawnedBy: me.id,
      driverId: me.id,
      driver: { userId: me.id, displayName: me.displayName },
      pendingSeatRequests: [],
      costUsd: 0,
      resultText: null,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      completedAt: null,
      lastEventId: 0,
      permalink: `/s/${id}`,
    },
    frames: [],
    script: [],
    framesPerTick: 0,
    tickMs: 0,
    timer: null,
  };
  for (const f of frames) {
    run.frames.push(f);
    // Fold status/cost silently (no bus events for pre-existing history).
    run.wire.lastEventId = Math.max(run.wire.lastEventId, f.event_id);
    if (f.event === 'usage_observed' && typeof f.data.cost_usd === 'number') {
      run.wire.costUsd = Number(run.wire.costUsd ?? 0) + f.data.cost_usd;
    }
    if (f.event === 'execution_state') {
      run.wire.status = normalizeExecutionStatus(f.data.status);
      if (typeof f.data.result_text === 'string') run.wire.resultText = f.data.result_text;
    }
  }
  run.wire.completedAt = new Date(Date.now() - 30_000).toISOString();
  runs.set(id, run);
  return run;
}

function getRun(id: string): MockRun {
  return runs.get(id) ?? synthesizeCompletedRun(id);
}

function mockCapabilities(id: string): SessionCapabilitiesResponse {
  const generatedAt = new Date().toISOString();
  return {
    sessionId: id,
    snapshots: [
      {
        parserVersion: 1,
        sessionId: id,
        harness: 'codex',
        sourceSha256: 'mock-codex-capabilities',
        completeness: 'partial',
        generatedAt,
        runtime: {
          model: 'gpt-5.5',
          effort: 'high',
          sandboxPolicy: 'workspace-write',
          approvalPolicy: 'never',
          cwd: '.../Code/atrium',
        },
        counts: {
          tools: 5,
          toolNamespaces: 1,
          mcpServers: 0,
          agents: 0,
          skills: 4,
          observedToolCalls: 3,
          changes: 4,
        },
        tools: ['multi_agent_v1.spawn_agent', 'multi_agent_v1.wait_agent', 'multi_agent_v1.send_input', 'multi_agent_v1.close_agent', 'multi_agent_v1.resume_agent'].map((name) => ({
          name,
          namespace: 'multi_agent_v1',
          sources: ['codex.tool_search_output'],
        })),
        toolNamespaces: [
          {
            name: 'multi_agent_v1',
            sources: ['codex.tool_search_output'],
            description: 'Tools for spawning and managing sub-agents.',
            count: 5,
          },
        ],
        mcpServers: [],
        agents: [],
        skills: ['stress-test', 'ui-ux-audit', 'hand-compute', 'workers-best-practices'].map((name) => ({
          name,
          sources: ['codex.developer_skills'],
        })),
        observedToolCalls: [
          { name: 'exec_command', namespace: 'builtin', sources: ['codex.function_call'], status: 'observed', count: 22 },
          { name: 'apply_patch', namespace: 'builtin', sources: ['codex.custom_tool_call'], status: 'observed', count: 5 },
          { name: 'spawn_agent', namespace: 'builtin', sources: ['codex.function_call'], status: 'observed', count: 2 },
        ],
        pendingMcpServers: [],
        changes: [
          {
            seq: 1,
            line: 1,
            source: 'codex.session_meta',
            summary: 'Runtime context captured',
            counts: { runtimeFields: 8 },
          },
          {
            seq: 2,
            line: 4,
            source: 'codex.developer_context',
            summary: 'Developer capability context captured',
            counts: { tools: 0, skills: 4 },
            redacted: true,
          },
          {
            seq: 3,
            line: 11,
            source: 'codex.tool_search_output',
            summary: 'Deferred tool metadata loaded',
            counts: { tools: 5 },
          },
          {
            seq: 4,
            line: 20,
            source: 'codex.function_call',
            summary: 'Tool call observed',
            counts: { observed: 1 },
          },
        ],
        warnings: [],
        redactions: ['Codex developer instructions are summarized to capability names and short descriptions.'],
      },
      {
        parserVersion: 1,
        sessionId: id,
        harness: 'claude',
        sourceSha256: 'mock-claude-capabilities',
        completeness: 'complete',
        generatedAt,
        runtime: {
          mode: 'normal',
          permissionMode: 'bypassPermissions',
          cwd: '.../Code/atrium',
          cliVersion: '2.1.199',
        },
        counts: {
          tools: 14,
          toolNamespaces: 4,
          mcpServers: 3,
          agents: 3,
          skills: 10,
          observedToolCalls: 0,
          changes: 3,
        },
        tools: [
          'Read',
          'WebFetch',
          'WebSearch',
          'TaskCreate',
          'TaskList',
          'TaskOutput',
          'mcp__deepwiki__ask_question',
          'mcp__deepwiki__read_wiki_contents',
          'mcp__deepwiki__read_wiki_structure',
          'mcp__nia__search',
          'mcp__nia__nia_read',
          'mcp__nia__nia_grep',
          'mcp__claude_ai_Figma__get_screenshot',
          'mcp__claude_ai_Figma__get_design_context',
        ].map((name) => ({
          name,
          namespace: name.startsWith('mcp__') ? 'mcp' : 'builtin',
          sources: ['claude.deferred_tools_delta'],
          status: 'available',
        })),
        toolNamespaces: [
          { name: 'builtin', sources: ['claude.deferred_tools_delta'], count: 6 },
          { name: 'mcp:deepwiki', sources: ['claude.deferred_tools_delta'], count: 3 },
          { name: 'mcp:nia', sources: ['claude.deferred_tools_delta'], count: 3 },
          { name: 'mcp:claude.ai Figma', sources: ['claude.deferred_tools_delta'], count: 2 },
        ],
        mcpServers: ['deepwiki', 'nia', 'claude.ai Figma'].map((name) => ({
          name,
          sources: ['claude.mcp_instructions_delta'],
          status: 'available',
        })),
        agents: ['Explore', 'Plan', 'test-engineer-typescript'].map((name) => ({
          name,
          sources: ['claude.agent_listing_delta'],
        })),
        skills: [
          'agent-fanout',
          'stress-test',
          'ui-ux-audit',
          'hand-compute',
          'cloudflare',
          'workers-best-practices',
          'wrangler',
          'dejank',
          'deslop',
          'sj-audit',
        ].map((name) => ({ name, sources: ['claude.skill_listing'] })),
        observedToolCalls: [],
        pendingMcpServers: [],
        changes: [
          {
            seq: 1,
            line: 5,
            source: 'claude.deferred_tools_delta',
            summary: 'Tool availability delta',
            counts: { added: 14, pendingMcpServers: 0 },
          },
          {
            seq: 2,
            line: 6,
            source: 'claude.agent_listing_delta',
            summary: 'Agent listing delta',
            counts: { added: 3 },
          },
          {
            seq: 3,
            line: 8,
            source: 'claude.skill_listing',
            summary: 'Skill listing captured',
            counts: { skills: 10 },
            redacted: true,
          },
        ],
        warnings: [],
        redactions: ['Claude skill listing content is summarized to names and short descriptions.'],
      },
    ],
  };
}

// ---- the mock API -----------------------------------------------------------

export interface SessionsMockApi {
  createSession(body: CreateSessionBody): Promise<{ session: SessionWire }>;
  getSession(id: string): Promise<{ session: SessionWire }>;
  getCapabilities(id: string): Promise<SessionCapabilitiesResponse>;
  sendMessage(id: string, text: string): Promise<void>;
  answerQuestion(id: string, questionId: string, answers: Record<string, { answers: string[] }>): Promise<void>;
  cancel(id: string): Promise<void>;
  requestSeat(id: string): Promise<void>;
  grantSeat(id: string, userId: string): Promise<void>;
  takeSeat(id: string): Promise<void>;
  createSuggestion(id: string, text: string): Promise<void>;
  resolveSuggestion(
    id: string,
    suggestionId: string,
    action: 'send' | 'dismiss',
    opts: { text?: string; note?: string },
  ): Promise<void>;
  proposeAnswer(
    id: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
  ): Promise<void>;
  resolveAnswerProposal(
    id: string,
    proposalId: string,
    action: 'submit' | 'dismiss',
    opts: { note?: string },
  ): Promise<void>;
  openStream(
    sessionId: string,
    afterEventId: number,
    cb: SessionStreamCallbacks,
  ): SessionStreamHandle;
}

export const sessionsMock: SessionsMockApi | null = ENABLED
  ? {
      async createSession(body) {
        const me = await mockMe();
        const id = `mock-${++seq}`;
        const script = pickScript(body.task);
        const longRun = script.length > 100; // big captures stream fast
        const run: MockRun = {
          wire: {
            id,
            workspaceId: 'mock-ws',
            channelId: body.channelId,
            threadRootEventId: body.threadRootEventId ?? null,
            title: body.task.slice(0, 80),
            status: 'spawning',
            harness: body.harness ?? 'codex',
            spawnedBy: me.id,
            driverId: me.id,
            driver: { userId: me.id, displayName: me.displayName },
            pendingSeatRequests: [],
            costUsd: 0,
            resultText: null,
            createdAt: new Date().toISOString(),
            completedAt: null,
            lastEventId: 0,
            permalink: `/s/${id}`,
          },
          frames: [],
          script,
          framesPerTick: longRun ? 8 : 1,
          tickMs: longRun ? 15 : 110,
          timer: null,
        };
        runs.set(id, run);
        setTimeout(() => {
          emitWire('session.spawned', body.channelId, body.threadRootEventId ?? null, me, {
            sessionId: id,
            title: run.wire.title,
            harness: run.wire.harness,
            by: me.id,
          });
          ensureRunning(run);
        }, 300);
        // Seat sim: a "seat" task gets Sam asking for the driver seat shortly in.
        if (/seat/i.test(body.task)) {
          setTimeout(() => emitSeatRequested(run, SAM), SAM_REQUEST_DELAY_MS);
        }
        // Suggestion sim: a "suggest" task gets Sam proposing a steer the local
        // driver can Send / Edit / Dismiss from the strip.
        if (/suggest/i.test(body.task)) {
          setTimeout(
            () => emitSuggestionAdded(run, SAM, 'Try running the tests before editing more.'),
            SAM_SUGGEST_DELAY_MS,
          );
        }
        return { session: { ...run.wire } };
      },

      async getSession(id) {
        await mockMe(); // synthesized sessions get attributed to the real user
        return { session: { ...getRun(id).wire } };
      },

      async getCapabilities(id) {
        return mockCapabilities(id);
      },

      async sendMessage(id, text) {
        const run = getRun(id);
        run.script.push(...synthTurn(maxEventId(run) + 1, `mock-${id}`, text));
        if (run.framesPerTick === 0) {
          run.framesPerTick = 2;
          run.tickMs = 80;
        }
        ensureRunning(run);
      },

      async answerQuestion(id) {
        const run = getRun(id);
        run.wire.pendingQuestion = null;
      },

      async cancel(id) {
        const run = getRun(id);
        const terminal =
          run.wire.status === 'completed' ||
          run.wire.status === 'failed' ||
          run.wire.status === 'cancelled';
        if (terminal) return;
        run.script.length = 0; // drop whatever was still streaming
        run.script.push({
          event: 'execution_state',
          event_id: maxEventId(run) + 1,
          data: {
            type: 'execution.state',
            status: 'cancelled',
            thread_key: `mock-${id}`,
            execution_id: 'exe_mock_cancel',
          },
        } as CentaurEventFrame);
        ensureRunning(run);
      },

      async requestSeat(id) {
        const me = await mockMe();
        const run = getRun(id);
        emitSeatRequested(run, me);
        // Sam is a friendly driver: grants a pending request back shortly.
        if (run.wire.driverId === SAM.id) {
          setTimeout(() => {
            if (run.wire.driverId === SAM.id) emitSeatChanged(run, me, 'granted', SAM);
          }, SAM_GRANT_BACK_MS);
        }
      },

      async grantSeat(id, userId) {
        const me = await mockMe();
        const run = getRun(id);
        if (run.wire.driverId !== me.id) {
          throw new ApiError(403, 'forbidden', 'only the current driver may grant the seat');
        }
        const grantee: UserRef =
          userId === SAM.id
            ? SAM
            : userId === me.id
              ? me
              : {
                  id: userId,
                  handle: userId,
                  displayName:
                    (run.wire.pendingSeatRequests ?? []).find((r) => r.userId === userId)
                      ?.displayName ?? userId,
                };
        emitSeatChanged(run, grantee, 'granted', me);
        if (grantee.id === SAM.id) {
          // Sam "watches" for a while (take → 409) and drives one steer turn.
          run.seatHeldUntil = Date.now() + SAM_HOLD_MS;
          setTimeout(() => {
            if (run.wire.driverId !== SAM.id) return;
            run.script.push(
              ...synthTurn(maxEventId(run) + 1, `mock-${id}`, '(Sam) taking a look from the seat'),
            );
            if (run.framesPerTick === 0) {
              run.framesPerTick = 2;
              run.tickMs = 80;
            }
            ensureRunning(run);
          }, 1_500);
        }
      },

      async takeSeat(id) {
        const me = await mockMe();
        const run = getRun(id);
        if (run.wire.driverId === me.id) {
          throw new ApiError(409, 'seat_held', 'you already hold the seat');
        }
        if ((run.seatHeldUntil ?? 0) > Date.now()) {
          throw new ApiError(409, 'seat_held', 'current driver is watching');
        }
        emitSeatChanged(run, me, 'taken', me);
      },

      async createSuggestion(id, text) {
        const me = await mockMe();
        emitSuggestionAdded(getRun(id), me, text);
      },

      async resolveSuggestion(id, suggestionId, action, opts) {
        const me = await mockMe();
        const run = getRun(id);
        if (action === 'dismiss') {
          emitSuggestionResolved(run, me, suggestionId, 'dismissed', opts.note ? { note: opts.note } : {});
          run.suggestions?.delete(suggestionId);
          return;
        }
        const edited = (opts.text ?? '').trim();
        const sent = edited || run.suggestions?.get(suggestionId) || '(suggested message)';
        emitSuggestionResolved(run, me, suggestionId, 'sent', edited ? { sentText: edited } : {});
        run.suggestions?.delete(suggestionId);
        // The accepted suggestion lands in the transcript as the driver's steer.
        run.script.push(...synthTurn(maxEventId(run) + 1, `mock-${id}`, sent));
        if (run.framesPerTick === 0) {
          run.framesPerTick = 2;
          run.tickMs = 80;
        }
        ensureRunning(run);
      },

      async proposeAnswer(id, questionId, answers) {
        const me = await mockMe();
        emitAnswerProposed(getRun(id), me, questionId, answers);
      },

      async resolveAnswerProposal(id, proposalId, action) {
        const me = await mockMe();
        const run = getRun(id);
        emitAnswerProposalResolved(run, me, proposalId, action === 'submit' ? 'submitted' : 'dismissed');
        // Submitting answers the question; clear the pending prompt.
        if (action === 'submit') run.wire.pendingQuestion = null;
      },

      openStream(sessionId, afterEventId, cb) {
        const run = getRun(sessionId);
        let cursor = 0;
        let closed = false;
        setTimeout(() => !closed && cb.onOpen?.(), 0);
        const pump = setInterval(() => {
          let delivered = 0;
          while (cursor < run.frames.length && delivered < 50) {
            const frame = run.frames[cursor++];
            if (frame && frame.event_id > afterEventId) {
              cb.onFrame(frame);
              delivered++;
            }
          }
        }, 20);
        return {
          close: () => {
            closed = true;
            clearInterval(pump);
          },
        };
      },
    }
  : null;

/**
 * DEV MOCK bus: synthetic `session.*` WireEvents that the real server would
 * fan out over the channel WS. Chat.tsx subscribes when non-null.
 */
export const sessionsMockBus = ENABLED
  ? {
      subscribe(fn: WireListener): () => void {
        busListeners.add(fn);
        return () => busListeners.delete(fn);
      },
    }
  : null;
