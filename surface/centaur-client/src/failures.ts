// Failure classification for terminal sessions.
//
// A terminal `execution_state` frame carries *why* a run died (`terminal_reason`
// + machine `reason`), but the reducer only folds those raw strings onto
// `SessionState`. This module turns them into a small, human-facing verdict the
// transcript and Results banner render: is this the *platform's* fault (a
// reconnect, a control-plane restart, a sandbox that never came up) or the
// *agent's* (the turn itself errored)? The distinction is what a driver needs to
// decide whether a retry is worthwhile.
//
// Pure and dependency-light on purpose: it takes a minimal input shape (not the
// whole SessionState) so it stays trivially testable and can't form an import
// cycle with the reducer. Both web and mobile call it at render time.

export type FailureClass = 'platform' | 'agent' | 'unknown';

export interface FailureInfo {
  /** Which side failed. Drives the label and how a viewer reads a retry. */
  class: FailureClass;
  /** Short class label: "Platform error" | "Agent error" | "Run failed". */
  label: string;
  /** One-line, human-readable description of what happened. */
  summary: string;
  /** The raw engine reason, for an expandable detail line. Omitted when it would
   *  merely repeat the summary or when nothing useful was reported. */
  detail?: string;
}

export interface FailureInput {
  /** The reduced `SessionState.status` (or any execution status string). */
  status: string;
  /** Folded from the terminal frame's `terminal_reason` (human string). */
  failureReason?: string | null;
  /** Folded from the terminal frame's machine `reason` (e.g.
   *  `startup_turn_not_accepted`). */
  failureCode?: string | null;
}

const PLATFORM_LABEL = 'Platform error';
const AGENT_LABEL = 'Agent error';
const UNKNOWN_LABEL = 'Run failed';

// Machine `reason` codes that are unambiguously infrastructure, mapped to their
// friendly summary. These come from api-rs, not the harness.
const PLATFORM_CODES: Record<string, string> = {
  startup_turn_not_accepted: 'The run was interrupted before the agent could start.',
  control_plane_shutdown: 'A platform update interrupted this run.',
  sandbox_startup_failed: 'The sandbox failed to start.',
  stdout_owner_lost: 'Lost the connection to the sandbox.',
};

// Machine `reason` codes that mean the agent/turn itself errored.
const AGENT_CODES = new Set(['turn_failed', 'agent_error', 'harness_error', 'model_error']);

// Ordered pattern match against the human `terminal_reason` string, used when the
// machine code is absent or unrecognized. First hit wins.
const PLATFORM_PATTERNS: Array<{ re: RegExp; summary: string }> = [
  {
    re: /reconnect|response ?stream ?disconnected|stream disconnected/i,
    summary: 'The connection to the model dropped mid-run.',
  },
  {
    re: /startup deadline|deadline exceeded|not accepted the turn|accepted the turn/i,
    summary: 'The run was interrupted before the agent could start.',
  },
  { re: /control.?plane/i, summary: 'A platform update interrupted this run.' },
  { re: /sandbox/i, summary: 'The sandbox failed to start.' },
  { re: /stdout|pump|owner lease/i, summary: 'Lost the connection to the sandbox.' },
];

function isFailedStatus(status: string): boolean {
  return status === 'failed' || status === 'failed_permanent';
}

/** Trim a raw reason for use as detail; empty → undefined. */
function cleanDetail(reason: string | null | undefined): string | undefined {
  const trimmed = (reason ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Build a FailureInfo, omitting `detail` entirely when absent (the exact
 *  optional property the render layer expects). */
function make(cls: FailureClass, label: string, summary: string, detail: string | undefined): FailureInfo {
  return { class: cls, label, summary, ...(detail ? { detail } : {}) };
}

/**
 * Classify a terminal failure. Returns `null` for any non-failed status (idle,
 * running, completed, cancelled) — cancellation/stop is handled separately via
 * `SessionState.stoppedByUser`, not here — AND for a failure that carried no
 * reason at all. The whole point is to surface *why* a run died, so with nothing
 * to surface we return null and let the caller keep its generic "Failed" fallback
 * rather than render a contentless card. This keeps the feature purely additive.
 */
export function classifyFailure(input: FailureInput): FailureInfo | null {
  if (!isFailedStatus(input.status)) return null;

  const code = (input.failureCode ?? '').trim();
  const reason = (input.failureReason ?? '').trim();
  if (!code && !reason) return null;

  const detail = cleanDetail(reason);

  // 1. Trust an explicit machine code first — it's the least ambiguous signal.
  if (code && PLATFORM_CODES[code]) {
    return make('platform', PLATFORM_LABEL, PLATFORM_CODES[code], detail);
  }
  if (code && AGENT_CODES.has(code)) {
    return make('agent', AGENT_LABEL, 'The agent hit an error and stopped.', detail);
  }

  // 2. Fall back to the human reason string.
  for (const { re, summary } of PLATFORM_PATTERNS) {
    if (re.test(reason)) {
      return make('platform', PLATFORM_LABEL, summary, detail);
    }
  }

  // 3. We have a reason but can't attribute it. Don't guess whose fault it was:
  //    a neutral label, with the raw reason behind the detail affordance.
  return make('unknown', UNKNOWN_LABEL, 'This run ended unexpectedly.', detail);
}
