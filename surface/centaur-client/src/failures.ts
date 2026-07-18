// Failure classification for terminal sessions.
//
// When a run dies, the transcript and Results banner explain *why* — and whose
// fault it was: the *platform* (a timeout, a control-plane restart, a sandbox
// that dropped its pipe) or the *agent* (the harness itself reported failure).
// That platform-vs-agent split is what a driver needs to decide whether a retry
// is worthwhile.
//
// The attribution is NOT re-derived here from prose. api-rs already buckets every
// terminal failure into a stable, low-cardinality `failure_class` (the same label
// it feeds the `centaur_session_failures_total` metric); the reducer folds it onto
// `SessionState.failureClass` and this module just maps that enum to copy. Matching
// the human `error` string is a last resort, used only for *historical* frames that
// predate `failure_class` — those strings are frozen in the event log, so a legacy
// matcher over them can't drift the way one over live upstream prose would.
//
// Pure and dependency-light on purpose: minimal input shape, no import cycle with
// the reducer. Both web and mobile call it at render time.

export type FailureClass = 'platform' | 'agent' | 'unknown';

export interface FailureInfo {
  /** Which side failed. Drives the label and how a viewer reads a retry. */
  class: FailureClass;
  /** Short class label: "Platform error" | "Agent error" | "Run failed". */
  label: string;
  /** One-line, human-readable description of what happened. */
  summary: string;
  /** The raw engine reason, for an expandable detail line. Omitted when nothing
   *  useful was reported. */
  detail?: string;
}

export interface FailureInput {
  /** The reduced `SessionState.status` (or any execution status string). */
  status: string;
  /** Stable low-cardinality class from api-rs (`failure_class`), folded onto
   *  `SessionState.failureClass`. The primary attribution signal. */
  failureClass?: string | null;
  /** Folded from the terminal frame's `terminal_reason` (human string). Shown as
   *  the raw detail, and used to classify historical frames that lack a class. */
  failureReason?: string | null;
  /** Folded from the terminal frame's machine `reason` (e.g.
   *  `startup_turn_not_accepted`). Retained for the legacy fallback. */
  failureCode?: string | null;
}

const PLATFORM_LABEL = 'Platform error';
const AGENT_LABEL = 'Agent error';
const UNKNOWN_LABEL = 'Run failed';

interface Verdict {
  class: FailureClass;
  label: string;
  summary: string;
}

// The api-rs `failure_class` enum → a viewer-facing verdict. This is the whole
// taxonomy; keep it exhaustive as api-rs grows its buckets (a class we don't know
// falls through to the neutral "Run failed" below, still showing the raw detail).
const CLASS_VERDICTS: Record<string, Verdict> = {
  timeout: { class: 'platform', label: PLATFORM_LABEL, summary: 'The run timed out before it finished.' },
  orphaned: { class: 'platform', label: PLATFORM_LABEL, summary: 'A platform restart interrupted this run.' },
  sandbox_io: { class: 'platform', label: PLATFORM_LABEL, summary: 'Lost the connection to the sandbox.' },
  harness: { class: 'agent', label: AGENT_LABEL, summary: 'The agent hit an error and stopped.' },
};

// LEGACY ONLY — for terminal frames logged before `failure_class` existed. Their
// `error`/`reason` strings are immutable history, so matching them can't drift.
// New failures always carry a class and never reach this path.
const LEGACY_PLATFORM_PATTERNS: Array<{ re: RegExp; summary: string }> = [
  {
    re: /reconnect|response ?stream ?disconnected|stream disconnected/i,
    summary: 'The connection to the model dropped mid-run.',
  },
  {
    re: /startup deadline|deadline exceeded|accepted the turn/i,
    summary: 'The run was interrupted before the agent could start.',
  },
  { re: /control.?plane|orphaned/i, summary: 'A platform restart interrupted this run.' },
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
function make(v: Verdict, detail: string | undefined): FailureInfo {
  return { class: v.class, label: v.label, summary: v.summary, ...(detail ? { detail } : {}) };
}

/** Legacy: attribute a class-less historical failure from its frozen reason. */
function legacyVerdict(reason: string): Verdict | null {
  if (!reason) return null;
  if (/harness output reported failure/i.test(reason)) {
    return { class: 'agent', label: AGENT_LABEL, summary: 'The agent hit an error and stopped.' };
  }
  for (const { re, summary } of LEGACY_PLATFORM_PATTERNS) {
    if (re.test(reason)) return { class: 'platform', label: PLATFORM_LABEL, summary };
  }
  return null;
}

/**
 * Classify a terminal failure. Returns `null` for any non-failed status (idle,
 * running, completed, cancelled — cancellation/stop is handled via
 * `SessionState.stoppedByUser`) AND for a failure that carried nothing to surface
 * (no class, no reason). Keeping it null in that case lets the caller retain its
 * generic "Failed" fallback rather than render a contentless card — the feature
 * stays purely additive.
 */
export function classifyFailure(input: FailureInput): FailureInfo | null {
  if (!isFailedStatus(input.status)) return null;

  const cls = (input.failureClass ?? '').trim();
  const reason = (input.failureReason ?? '').trim();
  const detail = cleanDetail(reason);

  // Primary: trust the stable class api-rs stamped on the frame.
  if (cls && CLASS_VERDICTS[cls]) {
    return make(CLASS_VERDICTS[cls], detail);
  }

  // Legacy: pre-`failure_class` frames — attribute from the frozen reason string.
  const legacy = legacyVerdict(reason);
  if (legacy) return make(legacy, detail);

  // Nothing to surface: keep the caller's generic fallback.
  if (!cls && !reason) return null;

  // A failure we can't attribute (reason present, or an unknown future class):
  // neutral label, raw reason behind the detail affordance — never guess blame.
  return make({ class: 'unknown', label: UNKNOWN_LABEL, summary: 'This run ended unexpectedly.' }, detail);
}
