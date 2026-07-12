// The turn-status derivation: one pure function from stream state + client
// clocks to the pinned status line's phase/liveness/clocks, shared by the web
// SessionPane and the mobile session screen so both platforms compute
// IDENTICAL states. Every output is a claim backed by the stream: clocks are
// anchored to server-stamped frame times (correct when opening a pane
// mid-turn, identical for every viewer), and "quiet" is phase-aware — every
// harness is legitimately silent while a tool runs (start → result, nothing
// between), but streams token deltas continuously while thinking, so only
// thinking-phase silence is meaningful. Harness-agnostic.

import type { SessionItem, SessionState, ToolCallItem } from './reducer.js';
import { toolDisplay } from './toolDisplay.js';

export type TurnPhase = 'thinking' | 'tool' | 'waiting' | 'done';

/** How alive the turn actually is, judged from the stream (not assumed):
 *  - live: frames are arriving (or silence is expected, e.g. a tool is running)
 *  - quiet: thinking-phase silence past ~30s — suspicious but not alarming
 *  - stuck: thinking-phase silence past ~5m — offer the exit
 *  - reconnecting: the client's SSE to the server is down
 *  - reattaching: the server lost the sandbox stdout pipe and is re-attaching
 */
export type TurnLiveness = 'live' | 'quiet' | 'stuck' | 'reconnecting' | 'reattaching';

// Thinking-phase silence thresholds (tool runs are exempt). Quiet is
// informational; stuck offers the exit.
export const QUIET_AFTER_MS = 30_000;
export const STUCK_AFTER_QUIET_MS = 5 * 60_000;
// Don't flash "Reconnecting…" during the moment a stream (re)opens.
export const RECONNECT_GRACE_MS = 3_000;

export interface TurnStatusInputs {
  stream: SessionState;
  /** Local wall clock (a ~1s ticker). */
  now: number;
  /** Whether the client's stream connection is currently open. */
  connected: boolean;
  /** Local receipt time of the newest folded frame (null before the first). */
  lastFrameAt: number | null;
  /** `localNow - serverNow` from the latest ping; null before the first. */
  clockSkewMs: number | null;
  /** When this view mounted — the silence anchor when no frame ever arrived. */
  mountedAt: number;
  /** When `connected` last flipped false (or mount) — the reconnect-grace anchor. */
  disconnectedAt: number;
  /** Session-level: turn in flight (non-terminal, not stalled). */
  activeTurn: boolean;
  /** Session-level: still spawning/queued — no frames can exist yet. */
  starting: boolean;
  /** Session-level: displayed status is completed (drives the done phase). */
  completed: boolean;
  /** Pending HITL question id, if any (drives the waiting phase). */
  pendingQuestionId: string | null;
  /** A banner (provider auth) owns the state — suppress the line entirely. */
  suppressed: boolean;
}

export interface TurnTokens {
  count: number;
  /** True when derived from streamed chars ÷ 4 (render with ≈). */
  estimated: boolean;
}

export interface TurnStatusSnapshot {
  /** Null = render no status line (suppressed, or nothing to say). */
  phase: TurnPhase | null;
  liveness: TurnLiveness;
  /** Current turn's elapsed, from stream anchors only — 0 = show no clock. */
  elapsedMs: number;
  /** Frame silence on the server clock (feeds quiet/stuck copy). */
  quietMs: number;
  /** Time blocked on a human (waiting phase), anchored to the question frame. */
  waitingMs: number;
  /** The tool_call currently running, scoped to the current turn. */
  openTool: ToolCallItem | null;
  /** Tail line of the reasoning streaming right now (fresh narration only). */
  headline: string | null;
  /** Output tokens so far — the ticking liveness instrument. */
  tokens: TurnTokens | null;
}

function parseTs(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/** The newest tool_call still awaiting its result, scoped to the CURRENT
 * turn: a tool orphaned by a cancelled earlier turn (stamped before this
 * turn's start) must not pin the 'tool' phase and suppress the quiet/stuck
 * escalation. Only a later text item clears an open candidate (the agent
 * moved on; its result frame was lost) — a steer's echoed user_message must
 * NOT clear it, since mid-turn steers land while a tool is genuinely running. */
function openToolCall(items: SessionItem[], turnStartMs: number | null): ToolCallItem | null {
  let candidate: ToolCallItem | null = null;
  for (const item of items) {
    if (item.type === 'tool_call') {
      if (item.result !== undefined) continue;
      const startedMs = parseTs(item.ts);
      if (startedMs !== null && turnStartMs !== null && startedMs < turnStartMs) continue;
      candidate = item;
    } else if (item.type === 'text' && candidate !== null) {
      candidate = null;
    }
  }
  return candidate;
}

/** While frames flow, narrate with the model's own words: the tail line of
 * the reasoning it is streaming right now (i.e. the transcript's last item). */
function reasoningHeadline(items: SessionItem[]): string | null {
  const last = items[items.length - 1];
  if (!last || last.type !== 'reasoning') return null;
  const source = last.summary?.trim() ? last.summary : last.text;
  const lines = (source ?? '')
    .split('\n')
    .map((line) => line.replace(/\*\*/g, '').trim())
    .filter(Boolean);
  const tail = lines[lines.length - 1];
  if (!tail) return null;
  return tail.length > 80 ? `${tail.slice(0, 79)}…` : tail;
}

/** Compact token display: raw under 1k, then one decimal ("2.4k", "1.2M") —
 * calm ticks without pretending to precision the chars÷4 estimate lacks.
 * 999,950+ promotes to the M tier at the DISPLAY boundary (toFixed rounds). */
export function formatTokens(count: number): string {
  if (count >= 999_950) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

/** The fixed status-line vocabulary, shared verbatim by web and mobile. The
 * seat-aware waiting copy is the one platform-supplied string (it needs the
 * viewer's seat + the driver's name). */
export function turnStatusLabel(args: {
  phase: TurnPhase | null;
  starting: boolean;
  headline: string | null;
  openTool: ToolCallItem | null;
  waitingLabel: string;
}): string {
  const { phase, starting, headline, openTool, waitingLabel } = args;
  if (phase === 'tool' && openTool) return `Working: ${toolDisplay(openTool).title}`;
  if (phase === 'waiting') return waitingLabel;
  if (phase === 'done') return 'Turn complete';
  if (starting) return 'Starting';
  return headline ?? 'Thinking';
}

/** Item-derived pieces cached on the items array's identity — the reducer
 * replaces the array on every fold, so identity is a correct fold-version key.
 * deriveTurnStatus runs on a 1s ticker; without this every tick would rescan
 * the full transcript (and re-split the reasoning tail) for nothing. */
interface ItemDerived {
  turnStartMs: number | null;
  openTool: ToolCallItem | null;
  headline: string | null;
  questionTs: Map<string, number | null>;
}
const itemDerivedCache = new WeakMap<SessionItem[], ItemDerived>();

function itemDerived(items: SessionItem[], turnStartMs: number | null): ItemDerived {
  const cached = itemDerivedCache.get(items);
  if (cached && cached.turnStartMs === turnStartMs) return cached;
  const entry: ItemDerived = {
    turnStartMs,
    openTool: openToolCall(items, turnStartMs),
    headline: reasoningHeadline(items),
    questionTs: new Map(),
  };
  itemDerivedCache.set(items, entry);
  return entry;
}

function questionAskedTs(derived: ItemDerived, items: SessionItem[], questionId: string): number | null {
  if (derived.questionTs.has(questionId)) return derived.questionTs.get(questionId) ?? null;
  const question = items.find((item) => item.type === 'question' && item.questionId === questionId);
  const ts = parseTs(question?.ts);
  derived.questionTs.set(questionId, ts);
  return ts;
}

export function deriveTurnStatus(inputs: TurnStatusInputs): TurnStatusSnapshot {
  const {
    stream,
    now,
    connected,
    lastFrameAt,
    clockSkewMs,
    mountedAt,
    disconnectedAt,
    activeTurn,
    starting,
    completed,
    pendingQuestionId,
    suppressed,
  } = inputs;

  const lastFrameTsMs = parseTs(stream.lastFrameTs);
  // Estimated server "now": ping skew when we have it, else project the last
  // frame's stamp forward from its local receipt. Local clock as a last resort.
  const serverNowMs =
    clockSkewMs !== null
      ? now - clockSkewMs
      : lastFrameTsMs !== null && lastFrameAt !== null
        ? lastFrameTsMs + (now - lastFrameAt)
        : now;

  // Clock only from stream-derived anchors — no createdAt/local fallbacks. A
  // pane opened before the replay folds (or a steer observed before the new
  // execution's frames arrive — turnEndTs still closed) shows no clock rather
  // than a days-since-creation or stale-turn number.
  const turnStartMs = parseTs(stream.turnStartTs);
  const turnEndMs = parseTs(stream.turnEndTs);
  const elapsedMs =
    turnStartMs === null
      ? 0
      : activeTurn
        ? turnEndMs === null
          ? Math.max(0, serverNowMs - turnStartMs)
          : 0
        : turnEndMs !== null
          ? Math.max(0, turnEndMs - turnStartMs)
          : 0;

  // How long the stream has been silent, on the server's clock — so a reload
  // mid-silence resumes the true count instead of restarting at zero. With no
  // frames at all (e.g. the stream never came up), silence counts from mount.
  const quietMs =
    lastFrameTsMs !== null ? Math.max(0, serverNowMs - lastFrameTsMs) : Math.max(0, now - (lastFrameAt ?? mountedAt));

  // The waiting clock anchors to the question's own frame stamp — quietMs
  // would reset on unrelated frames (artifact captures, usage) and undercount
  // how long the agent has been blocked on a human. Fallback to frame-silence
  // when the question frame carries no stamp (old mirrors) — an undercount
  // beats claiming the wait just started.
  const derived = itemDerived(stream.items, turnStartMs);

  let waitingMs = quietMs;
  if (pendingQuestionId !== null) {
    const sinceMs = questionAskedTs(derived, stream.items, pendingQuestionId);
    if (sinceMs !== null) waitingMs = Math.max(0, serverNowMs - sinceMs);
  }

  const openTool = derived.openTool;

  // Drive the single pinned status line: thinking → tool (a command/tool is
  // mid-run) → waiting (pending question) while active, then done on
  // completion. Suppressed entirely when a banner owns the state.
  const phase: TurnPhase | null = suppressed
    ? null
    : activeTurn && pendingQuestionId !== null
      ? 'waiting'
      : activeTurn && openTool
        ? 'tool'
        : activeTurn
          ? 'thinking'
          : completed
            ? 'done'
            : null;

  // Judge aliveness from evidence. Spawning/queued sessions can't have frames
  // yet, and tool runs are expected silence — both are exempt from quiet/stuck.
  // Reconnect display waits out a short grace from the actual disconnect
  // moment (NOT quietMs — the agent may have been legitimately quiet for
  // longer than the grace when a 1s transport blip happens).
  const disconnectedMs = connected ? 0 : Math.max(0, now - disconnectedAt);
  const silenceMatters = phase === 'thinking' && !starting;
  const liveness: TurnLiveness = !activeTurn
    ? 'live'
    : !connected && disconnectedMs >= RECONNECT_GRACE_MS
      ? 'reconnecting'
      : stream.transport === 'reattaching'
        ? 'reattaching'
        : silenceMatters && quietMs >= STUCK_AFTER_QUIET_MS
          ? 'stuck'
          : silenceMatters && quietMs >= QUIET_AFTER_MS
            ? 'quiet'
            : 'live';

  // Output tokens so far: real when the stream reports usage (codex
  // snapshots, usage_observed), else streamed-chars ÷ 4 marked estimated. A
  // count that stops climbing mid-thinking is the "something's off" tell.
  const tokens: TurnTokens | null =
    stream.tokensUsed !== undefined
      ? { count: stream.tokensUsed, estimated: false }
      : stream.deltaChars > 0
        ? { count: Math.round(stream.deltaChars / 4), estimated: true }
        : null;

  return {
    phase,
    liveness,
    elapsedMs,
    quietMs,
    waitingMs,
    openTool,
    headline: phase === 'thinking' && liveness === 'live' ? derived.headline : null,
    tokens,
  };
}
