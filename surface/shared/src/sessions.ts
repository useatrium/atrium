// Session entities + pure fold helpers. No React imports — unit tested directly.

import { Schema } from 'effect';

const NullableStringSchema = Schema.Union(Schema.String, Schema.Null);
const NullableNumberSchema = Schema.Union(Schema.Number, Schema.Null);

export type SessionStatus = 'spawning' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export const SessionStatusSchema = Schema.Literal('spawning', 'queued', 'running', 'completed', 'failed', 'cancelled');

/** Seat-related user reference as serialized by the server. */
export interface SessionSeatUser {
  userId: string;
  displayName: string;
}

export type SeatChangeReason = 'granted' | 'taken';

/** One audit entry folded from a `session.seat_changed` wire event. */
export interface SeatAuditEntry {
  /** Workspace event id — dedupe key across WS fanout + catch-up overlap. */
  id: number;
  from: string | null;
  to: string;
  reason: SeatChangeReason;
  /** Display names resolved at fold time when the event carried them. */
  fromName?: string;
  toName?: string;
  at: string;
}

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
  previewFormat?: 'markdown' | 'html';
}

export interface QuestionPrompt {
  id: string;
  header: string;
  question: string;
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
  options?: QuestionOption[];
}

export interface SessionPendingQuestion {
  questionId: string;
  turnId?: string;
  questions: QuestionPrompt[];
  eventId?: number;
}

export interface SessionProviderAuthRequired {
  provider: 'claude-code' | 'codex' | 'github';
  userId: string;
  reason: 'missing_token' | 'invalid_token' | 'auth_error';
  message: string;
  at: string;
}

export type QuestionResolutionReason = 'answered' | 'cancelled' | 'empty';

export interface SessionQuestionAnswerSummary {
  id: string;
  header: string;
  answers: string[];
  count: number;
}

export interface SessionQuestionPayloadPrompt {
  question: string;
}

export function questionPayloadPrompts(payload: Record<string, unknown>): SessionQuestionPayloadPrompt[] {
  if (!Array.isArray(payload.questions)) return [];
  return payload.questions
    .map((item): SessionQuestionPayloadPrompt | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const question = (item as Record<string, unknown>).question;
      return typeof question === 'string' && question.trim() ? { question } : null;
    })
    .filter((item): item is SessionQuestionPayloadPrompt => item !== null);
}

export function questionPayloadAnswers(payload: Record<string, unknown>): SessionQuestionAnswerSummary[] {
  if (!Array.isArray(payload.answers)) return [];
  return payload.answers
    .map((item): SessionQuestionAnswerSummary | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const raw = item as Record<string, unknown>;
      if (typeof raw.id !== 'string') return null;
      const answers = Array.isArray(raw.answers)
        ? raw.answers.filter((answer): answer is string => typeof answer === 'string')
        : [];
      return {
        id: raw.id,
        header: typeof raw.header === 'string' ? raw.header : raw.id,
        answers,
        count: typeof raw.count === 'number' && Number.isFinite(raw.count) ? raw.count : answers.length,
      };
    })
    .filter((item): item is SessionQuestionAnswerSummary => item !== null);
}

export function questionAnswerSummaryText(summary: SessionQuestionAnswerSummary): string {
  if (summary.answers.length > 0) return summary.answers.join('\n');
  return summary.count === 1 ? '1 answer recorded' : `${summary.count} answers recorded`;
}

export function sessionQuestionEventLabel(
  type: 'question_requested' | 'question_answered' | 'question_resolved' | 'replied' | undefined,
  reason: unknown,
): string {
  if (type === 'replied') return 'Agent replied';
  if (type === 'question_requested') return 'Question asked';
  if (type === 'question_answered') return 'Question answered';
  if (reason === 'empty') return 'Question expired without an answer';
  if (reason === 'cancelled') return 'Question cancelled';
  return 'Question resolved';
}

export interface SessionQuestionEvent {
  /** Workspace event id. Dedupe key across WS fanout + catch-up overlap. */
  id: number;
  questionId: string;
  kind: 'requested' | 'answered' | 'resolved';
  at: string;
  actorId?: string;
  actorName?: string;
  turnId?: string;
  questions?: QuestionPrompt[];
  answers?: SessionQuestionAnswerSummary[];
  reason?: QuestionResolutionReason;
}

export type SuggestionStatus = 'pending' | 'sent' | 'dismissed';

/**
 * A spectator-proposed steer (Phase 2 collaboration). The driver sends it,
 * edits-then-sends it, or dismisses it; resolved rows persist for retro value.
 */
export interface SessionSuggestion {
  /** Suggestion row id (uuid) — stable dedupe key across WS + catch-up. */
  id: string;
  /** The spectator who proposed it. */
  authorId: string;
  authorName?: string;
  text: string;
  status: SuggestionStatus;
  /** Driver who resolved it (null/absent until sent/dismissed). */
  resolvedBy?: string | null;
  resolvedByName?: string | null;
  /** The actually-sent text when edited-then-sent (differs from `text`). */
  sentText?: string | null;
  /** Optional "why" on dismiss — never required. */
  note?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
}

// === jul6steer-prov additions ===
export interface SteerProvenance {
  proposerName: string;
  resolvedByName: string;
  edited: boolean;
  resolvedAt: string | number;
}

export interface SteerProvenanceUserMessage {
  id: string;
  text: string;
  ts?: string | number | null;
}

export function normalizeSteerProvenanceText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function steerProvenanceKey(provenance: SteerProvenance): string {
  return [
    String(provenance.resolvedAt),
    provenance.proposerName,
    provenance.resolvedByName,
    provenance.edited ? 'edited' : 'sent',
  ].join('\u0000');
}

function steerProvenanceTime(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function matchSteerProvenance(
  userMessages: readonly SteerProvenanceUserMessage[],
  suggestions: readonly SessionSuggestion[],
): Map<string, SteerProvenance> {
  const consumed = new Set<string>();
  const matched = new Map<string, SteerProvenance>();
  const sentSuggestions = suggestions
    .filter((suggestion) => suggestion.status === 'sent')
    .map((suggestion) => ({
      suggestion,
      createdMs: steerProvenanceTime(suggestion.createdAt),
      resolvedAt: suggestion.resolvedAt ?? suggestion.createdAt,
      resolvedMs: steerProvenanceTime(suggestion.resolvedAt ?? suggestion.createdAt),
      text: normalizeSteerProvenanceText(suggestion.sentText ?? suggestion.text),
    }))
    .filter(
      (
        item,
      ): item is {
        suggestion: SessionSuggestion;
        createdMs: number;
        resolvedAt: string;
        resolvedMs: number;
        text: string;
      } => item.createdMs != null && item.resolvedMs != null,
    )
    .sort((a, b) => a.resolvedMs - b.resolvedMs);

  for (const { suggestion, createdMs, resolvedAt, resolvedMs, text } of sentSuggestions) {
    let best: { message: SteerProvenanceUserMessage; distance: number } | null = null;

    for (const message of userMessages) {
      if (consumed.has(message.id)) continue;
      if (normalizeSteerProvenanceText(message.text) !== text) continue;
      const messageMs = steerProvenanceTime(message.ts);
      if (messageMs == null || messageMs < createdMs) continue;

      const distance = Math.abs(messageMs - resolvedMs);
      if (!best || distance < best.distance) best = { message, distance };
    }

    if (!best) continue;
    consumed.add(best.message.id);
    matched.set(best.message.id, {
      proposerName: suggestion.authorName ?? suggestion.authorId,
      resolvedByName: suggestion.resolvedByName ?? suggestion.resolvedBy ?? 'someone',
      edited: suggestion.sentText != null,
      resolvedAt,
    });
  }

  return matched;
}

export type AnswerProposalStatus = 'pending' | 'submitted' | 'dismissed';

/**
 * A spectator-proposed answer to a pending HITL question (Phase 2). The driver
 * one-click submits it (driver-attributed) or dismisses it; rows persist.
 */
export interface SessionAnswerProposal {
  /** Proposal row id (uuid) — stable dedupe key across WS + catch-up. */
  id: string;
  /** The pending question this answers (`QuestionPrompt`-set id). */
  questionId: string;
  /** The spectator who proposed it. */
  authorId: string;
  authorName?: string;
  /** Same shape the answer route takes: { [questionId]: { answers } }. */
  answers: SessionQuestionAnswers;
  status: AnswerProposalStatus;
  /** Driver who resolved it (null/absent until submitted/dismissed). */
  resolvedBy?: string | null;
  resolvedByName?: string | null;
  /** Optional "why" on dismiss — never required. */
  note?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
}

/** Session JSON as served by POST/GET /api/sessions. */
export interface SessionWire {
  id: string;
  workspaceId: string;
  channelId: string;
  threadRootEventId: number | null;
  title: string;
  status: SessionStatus;
  harness: string;
  /** Spawn-dialog git metadata (optional; absent on older payloads). */
  repo?: string | null;
  branch?: string | null;
  repos?: SessionRepoSpec[] | null;
  spawnedBy: string;
  driverId: string | null;
  /** Driver display info (Phase 3 server; may be absent on older payloads). */
  driver?: SessionSeatUser | null;
  pendingSeatRequests?: SessionSeatUser[];
  /** Suggestion queue, oldest-first (Phase 2; absent on older payloads). */
  suggestions?: SessionSuggestion[];
  /** Pending HITL answer proposals (Phase 2; absent on older payloads). */
  answerProposals?: SessionAnswerProposal[];
  pendingQuestion?: SessionPendingQuestion | null;
  providerAuthRequired?: SessionProviderAuthRequired | null;
  githubIdentityMode?: string | null;
  providerConnectionId?: string | null;
  agentProfileVersionId?: string | null;
  modelEffort?: string | null;
  viewerCount?: number;
  costUsd: number | string | null;
  resultText: string | null;
  createdAt: string;
  completedAt: string | null;
  archivedAt: string | null;
  pinned: boolean;
  lastEventId: number;
  permalink: string;
}

export interface SessionListItem {
  id: string;
  channelId: string;
  channelName: string;
  title: string;
  status: SessionStatus;
  harness: string;
  spawnedBy: string;
  spawnerName: string;
  costUsd: number;
  createdAt: string;
  completedAt: string | null;
  archivedAt: string | null;
  pinned: boolean;
}

/** Client-side session entity (wire shape + display-only extras). */
export interface Session {
  id: string;
  workspaceId: string;
  channelId: string;
  threadRootEventId: number | null;
  title: string;
  status: SessionStatus;
  harness: string;
  /** Spawn-dialog git metadata, captured at spawn time (optional). */
  repo?: string | null;
  branch?: string | null;
  repos?: SessionRepoSpec[] | null;
  spawnedBy: string;
  /** Display name of the spawner when known (from WS author / me). */
  spawnerName?: string;
  driverId: string | null;
  /** Display name of the current driver when known. */
  driverName?: string;
  /** Open seat requests, oldest-first (deduped by userId). */
  pendingSeatRequests: SessionSeatUser[];
  /** Suggestion queue folded from session.suggestion_* events, oldest-first. */
  suggestions: SessionSuggestion[];
  /** HITL answer proposals folded from session.answer_proposal_* events. */
  answerProposals: SessionAnswerProposal[];
  pendingQuestion?: SessionPendingQuestion | null;
  providerAuthRequired?: SessionProviderAuthRequired | null;
  githubIdentityMode?: string | null;
  providerConnectionId?: string | null;
  agentProfileVersionId?: string | null;
  /** Current reasoning effort — seeded from the spawning profile, updated by
   * per-turn steer overrides (codex only). Null/absent = harness default. */
  modelEffort?: string | null;
  /** Live-only client audit log folded from session.question_* events. */
  questionEvents?: SessionQuestionEvent[];
  /** Seat handoff audit log folded from session.seat_changed, oldest-first. */
  seatEvents: SeatAuditEntry[];
  costUsd: number;
  resultText: string | null;
  /** Latest ephemeral tool/activity ticker received over the workspace socket. */
  latestActivity?: SessionActivity;
  createdAt: string;
  completedAt: string | null;
  archivedAt: string | null;
  pinned: boolean;
  lastEventId: number;
  permalink: string;
}

/** Ephemeral per-session activity. It is intentionally not returned by REST or
 * persisted in the events table. */
export interface SessionActivity {
  summary: string;
  at: string;
}

export interface SessionRepoSpec {
  repo: string;
  ref?: string;
  subdir?: string;
  private?: boolean;
}

export interface SessionFoldEvent {
  id: number;
  workspaceId: string;
  channelId: string | null;
  threadRootEventId: number | null;
  type: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  author: {
    id: string;
    displayName: string;
  } | null;
}

export interface SessionQuestionAnswers {
  [questionId: string]: {
    answers: string[];
  };
}

export const SessionRepoSpecSchema = Schema.mutable(
  Schema.Struct({
    repo: Schema.String,
    ref: Schema.optionalWith(Schema.String, { exact: true }),
    subdir: Schema.optionalWith(Schema.String, { exact: true }),
    private: Schema.optionalWith(Schema.Boolean, { exact: true }),
  }),
);

export const SessionSeatUserSchema = Schema.mutable(
  Schema.Struct({
    userId: Schema.String,
    displayName: Schema.String,
  }),
);

export const QuestionOptionSchema = Schema.mutable(
  Schema.Struct({
    label: Schema.String,
    description: Schema.String,
    preview: Schema.optionalWith(Schema.String, { exact: true }),
    previewFormat: Schema.optionalWith(Schema.Literal('markdown', 'html'), { exact: true }),
  }),
);

export const QuestionPromptSchema = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    header: Schema.String,
    question: Schema.String,
    multiSelect: Schema.optionalWith(Schema.Boolean, { exact: true }),
    isOther: Schema.optionalWith(Schema.Boolean, { exact: true }),
    isSecret: Schema.optionalWith(Schema.Boolean, { exact: true }),
    options: Schema.optionalWith(Schema.mutable(Schema.Array(QuestionOptionSchema)), { exact: true }),
  }),
);

export const SessionPendingQuestionSchema = Schema.mutable(
  Schema.Struct({
    questionId: Schema.String,
    turnId: Schema.optionalWith(Schema.String, { exact: true }),
    questions: Schema.mutable(Schema.Array(QuestionPromptSchema)),
    eventId: Schema.optionalWith(Schema.Number, { exact: true }),
  }),
);

export const SessionProviderAuthRequiredSchema = Schema.mutable(
  Schema.Struct({
    provider: Schema.Literal('claude-code', 'codex', 'github'),
    userId: Schema.String,
    reason: Schema.Literal('missing_token', 'invalid_token', 'auth_error'),
    message: Schema.String,
    at: Schema.String,
  }),
);

export const SessionQuestionAnswersSchema = Schema.mutable(
  Schema.Record({
    key: Schema.String,
    value: Schema.mutable(
      Schema.Struct({
        answers: Schema.mutable(Schema.Array(Schema.String)),
      }),
    ),
  }),
);

export const SessionSuggestionSchema = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    authorId: Schema.String,
    authorName: Schema.optionalWith(Schema.String, { exact: true }),
    text: Schema.String,
    status: Schema.Literal('pending', 'sent', 'dismissed'),
    resolvedBy: Schema.optionalWith(NullableStringSchema, { exact: true }),
    resolvedByName: Schema.optionalWith(NullableStringSchema, { exact: true }),
    sentText: Schema.optionalWith(NullableStringSchema, { exact: true }),
    note: Schema.optionalWith(NullableStringSchema, { exact: true }),
    createdAt: Schema.String,
    resolvedAt: Schema.optionalWith(NullableStringSchema, { exact: true }),
  }),
);

export const SessionAnswerProposalSchema = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    questionId: Schema.String,
    authorId: Schema.String,
    authorName: Schema.optionalWith(Schema.String, { exact: true }),
    answers: SessionQuestionAnswersSchema,
    status: Schema.Literal('pending', 'submitted', 'dismissed'),
    resolvedBy: Schema.optionalWith(NullableStringSchema, { exact: true }),
    resolvedByName: Schema.optionalWith(NullableStringSchema, { exact: true }),
    note: Schema.optionalWith(NullableStringSchema, { exact: true }),
    createdAt: Schema.String,
    resolvedAt: Schema.optionalWith(NullableStringSchema, { exact: true }),
  }),
);

export const SessionWireSchema = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    workspaceId: Schema.String,
    channelId: Schema.String,
    threadRootEventId: NullableNumberSchema,
    title: Schema.String,
    status: SessionStatusSchema,
    harness: Schema.String,
    repo: Schema.optionalWith(NullableStringSchema, { exact: true }),
    branch: Schema.optionalWith(NullableStringSchema, { exact: true }),
    repos: Schema.optionalWith(Schema.Union(Schema.mutable(Schema.Array(SessionRepoSpecSchema)), Schema.Null), {
      exact: true,
    }),
    spawnedBy: Schema.String,
    driverId: NullableStringSchema,
    driver: Schema.optionalWith(Schema.Union(SessionSeatUserSchema, Schema.Null), { exact: true }),
    pendingSeatRequests: Schema.optionalWith(Schema.mutable(Schema.Array(SessionSeatUserSchema)), { exact: true }),
    suggestions: Schema.optionalWith(Schema.mutable(Schema.Array(SessionSuggestionSchema)), { exact: true }),
    answerProposals: Schema.optionalWith(Schema.mutable(Schema.Array(SessionAnswerProposalSchema)), { exact: true }),
    pendingQuestion: Schema.optionalWith(Schema.Union(SessionPendingQuestionSchema, Schema.Null), { exact: true }),
    providerAuthRequired: Schema.optionalWith(Schema.Union(SessionProviderAuthRequiredSchema, Schema.Null), {
      exact: true,
    }),
    githubIdentityMode: Schema.optionalWith(NullableStringSchema, { exact: true }),
    providerConnectionId: Schema.optionalWith(NullableStringSchema, { exact: true }),
    agentProfileVersionId: Schema.optionalWith(NullableStringSchema, { exact: true }),
    modelEffort: Schema.optionalWith(NullableStringSchema, { exact: true }),
    viewerCount: Schema.optionalWith(Schema.Number, { exact: true }),
    costUsd: Schema.Union(Schema.Number, Schema.String, Schema.Null),
    resultText: NullableStringSchema,
    createdAt: Schema.String,
    completedAt: NullableStringSchema,
    // Decode-with-default so an old server (deploy skew) can't fail the decode.
    archivedAt: Schema.optionalWith(NullableStringSchema, { default: () => null }),
    pinned: Schema.optionalWith(Schema.Boolean, { default: () => false }),
    lastEventId: Schema.Number,
    permalink: Schema.String,
  }),
);

export const SessionListItemSchema = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    channelId: Schema.String,
    channelName: Schema.String,
    title: Schema.String,
    status: SessionStatusSchema,
    harness: Schema.String,
    spawnedBy: Schema.String,
    spawnerName: Schema.String,
    costUsd: Schema.Number,
    createdAt: Schema.String,
    completedAt: NullableStringSchema,
    archivedAt: Schema.optionalWith(NullableStringSchema, { default: () => null }),
    pinned: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  }),
);

export const SessionResponseSchema = Schema.mutable(
  Schema.Struct({
    session: SessionWireSchema,
  }),
);

export const SessionListResponseSchema = Schema.mutable(
  Schema.Struct({
    sessions: Schema.mutable(Schema.Array(SessionListItemSchema)),
  }),
);

export interface SessionAttachmentRef {
  artifactId?: string;
  versionSeq?: number;
  path?: string;
}

// Loose on purpose: session interaction routes keep route-specific validation
// messages after this boundary decode.
export const SessionSteerBodySchema = Schema.Struct({
  text: Schema.optional(Schema.Unknown),
  effort: Schema.optional(Schema.Unknown),
  postToThread: Schema.optional(Schema.Unknown),
  attachments: Schema.optional(Schema.Unknown),
  attachmentRefs: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});
export interface SessionSteerBody {
  text: string;
  effort?: string;
  postToThread?: boolean;
  attachments?: string[];
  attachmentRefs?: SessionAttachmentRef[];
  opId?: string;
}

export const SessionAnswerQuestionBodySchema = Schema.Struct({
  questionId: Schema.String,
  answers: Schema.Unknown,
  opId: Schema.optional(Schema.Unknown),
});
export interface SessionAnswerQuestionBody {
  questionId: string;
  answers: SessionQuestionAnswers;
  opId?: string;
}

export const SessionSeatGrantBodySchema = Schema.Struct({
  userId: Schema.String,
});
export interface SessionSeatGrantBody {
  userId: string;
}

export const SessionSuggestionCreateBodySchema = Schema.Struct({
  text: Schema.optional(Schema.Unknown),
  postToThread: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});
export interface SessionSuggestionCreateBody {
  text: string;
  postToThread?: boolean;
  opId?: string;
}

export const SessionSuggestionResolveBodySchema = Schema.Struct({
  action: Schema.Literal('send', 'dismiss'),
  text: Schema.optional(Schema.Unknown),
  note: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});
export interface SessionSuggestionResolveBody {
  action: 'send' | 'dismiss';
  text?: string;
  note?: string;
  opId?: string;
}

export const SessionAnswerProposalResolveBodySchema = Schema.Struct({
  action: Schema.Literal('submit', 'dismiss'),
  note: Schema.optional(Schema.Unknown),
  opId: Schema.optional(Schema.Unknown),
});
export interface SessionAnswerProposalResolveBody {
  action: 'submit' | 'dismiss';
  note?: string;
  opId?: string;
}

export const SessionOpIdBodySchema = Schema.Struct({
  opId: Schema.optional(Schema.Unknown),
});
export interface SessionOpIdBody {
  opId?: string;
}

/**
 * Effective driver: the server seeds driver_id with the spawner at insert, so
 * a null driverId (optimistic rows, pre-Phase-3 payloads) falls back to the
 * spawner. Steer permission follows this id; cancel = spawner OR driver.
 */
export {
  HARNESS_EFFORT_LEVELS,
  HARNESS_EFFORT_PICKER_OPTIONS,
  isSessionEffortLevel,
} from './effort.js';

export function sessionDriverId(s: Session): string {
  return s.driverId ?? s.spawnedBy;
}

function optionalProp<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

/** Optimistic sessions (pre-POST-response) use this id prefix. */
export const PENDING_SESSION_PREFIX = 'pending:';

export function isPendingSessionId(id: string): boolean {
  return id.startsWith(PENDING_SESSION_PREFIX);
}

export function isTerminalSessionStatus(s: SessionStatus): boolean {
  return s === 'completed' || s === 'failed' || s === 'cancelled';
}

/** Shared archive grouping definition for all client surfaces. */
export function isArchivedSession(session: Pick<Session, 'archivedAt'>): boolean {
  return session.archivedAt !== null;
}

/**
 * A session still claiming spawning/queued this long after creation has almost
 * certainly been lost by the control plane — render it as stalled (static, no
 * pulse) instead of letting a dead status lie forever.
 */
export const STALLED_AFTER_MS = 10 * 60 * 1000;

export function isStalledSessionStatus(s: Session, now: number): boolean {
  return (s.status === 'spawning' || s.status === 'queued') && now - new Date(s.createdAt).getTime() > STALLED_AFTER_MS;
}

/** The further-along of two statuses — used to never regress from a stale fetch. */
export function maxSessionStatus(a: SessionStatus, b: SessionStatus): SessionStatus {
  return statusRank(a) >= statusRank(b) ? a : b;
}

/** Lifecycle progress rank — used to never regress status from a stale fetch. */
function statusRank(s: SessionStatus): number {
  switch (s) {
    case 'spawning':
      return 0;
    case 'queued':
      return 1;
    case 'running':
      return 2;
    case 'failed':
      return 3;
    case 'cancelled':
      return 4;
    case 'completed':
      return 5;
  }
}

const SESSION_STATUSES: readonly SessionStatus[] = [
  'spawning',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
];

export function asSessionStatus(v: unknown): SessionStatus | null {
  return typeof v === 'string' && (SESSION_STATUSES as readonly string[]).includes(v) ? (v as SessionStatus) : null;
}

export function sessionFromWire(w: SessionWire): Session {
  return {
    id: w.id,
    workspaceId: w.workspaceId,
    channelId: w.channelId,
    threadRootEventId: w.threadRootEventId ?? null,
    title: w.title,
    status: asSessionStatus(w.status) ?? 'spawning',
    harness: w.harness,
    repo: w.repo ?? null,
    branch: w.branch ?? null,
    repos: Array.isArray(w.repos) ? w.repos : null,
    spawnedBy: w.spawnedBy,
    driverId: w.driverId ?? w.driver?.userId ?? null,
    ...optionalProp('driverName', w.driver?.displayName),
    pendingSeatRequests: [...(w.pendingSeatRequests ?? [])],
    suggestions: [...(w.suggestions ?? [])],
    answerProposals: [...(w.answerProposals ?? [])],
    pendingQuestion: w.pendingQuestion ?? null,
    providerAuthRequired: parseProviderAuthRequired(w.providerAuthRequired),
    githubIdentityMode: w.githubIdentityMode ?? null,
    providerConnectionId: w.providerConnectionId ?? null,
    agentProfileVersionId: w.agentProfileVersionId ?? null,
    modelEffort: w.modelEffort ?? null,
    questionEvents: [],
    seatEvents: [],
    costUsd: Number(w.costUsd ?? 0) || 0,
    resultText: w.resultText ?? null,
    createdAt: w.createdAt,
    completedAt: w.completedAt ?? null,
    archivedAt: w.archivedAt ?? null,
    pinned: w.pinned ?? false,
    lastEventId: w.lastEventId ?? 0,
    permalink: w.permalink || `/s/${w.id}`,
  };
}

/**
 * Merge the POST /api/sessions response into whatever live WS events may have
 * already built. The response is a snapshot from insert time, so it must never
 * regress a status/cost that moved forward while the POST was in flight.
 */
export function mergeSpawnResponse(live: Session | undefined, resp: Session): Session {
  if (!live) return resp;
  const spawnerName = live.spawnerName ?? resp.spawnerName;
  const driverName = live.driverName ?? resp.driverName;
  const pendingQuestion = live.pendingQuestion ?? resp.pendingQuestion ?? null;
  const questionEvents =
    live.questionEvents && live.questionEvents.length > 0 ? live.questionEvents : (resp.questionEvents ?? []);
  return {
    ...resp,
    // Immutable spawn metadata: keep whichever side has it (an old server may
    // not echo repo/branch).
    repo: resp.repo ?? live.repo ?? null,
    branch: resp.branch ?? live.branch ?? null,
    repos: resp.repos ?? live.repos ?? null,
    githubIdentityMode: resp.githubIdentityMode ?? live.githubIdentityMode ?? null,
    providerConnectionId: resp.providerConnectionId ?? live.providerConnectionId ?? null,
    status: maxSessionStatus(live.status, resp.status),
    costUsd: Math.max(live.costUsd, resp.costUsd),
    resultText: live.resultText ?? resp.resultText,
    ...(live.latestActivity ? { latestActivity: live.latestActivity } : {}),
    completedAt: live.completedAt ?? resp.completedAt,
    archivedAt: live.archivedAt ?? resp.archivedAt,
    pinned: live.pinned ?? resp.pinned,
    ...optionalProp('spawnerName', spawnerName),
    // Seat state that moved via WS while the POST was in flight wins over the
    // insert-time snapshot (which always says driver = spawner, no requests).
    driverId: live.driverId ?? resp.driverId,
    ...optionalProp('driverName', driverName),
    pendingSeatRequests: live.pendingSeatRequests.length > 0 ? live.pendingSeatRequests : resp.pendingSeatRequests,
    suggestions: live.suggestions.length > 0 ? live.suggestions : resp.suggestions,
    answerProposals: live.answerProposals.length > 0 ? live.answerProposals : resp.answerProposals,
    pendingQuestion,
    // A live effort change (WS event mid-flight) wins over the fetch snapshot.
    modelEffort: live.modelEffort ?? resp.modelEffort ?? null,
    providerAuthRequired: live.providerAuthRequired ?? resp.providerAuthRequired ?? null,
    questionEvents,
    seatEvents: live.seatEvents.length > 0 ? live.seatEvents : resp.seatEvents,
    lastEventId: Math.max(live.lastEventId, resp.lastEventId),
  };
}

/**
 * Fold a `session.*` wire event (WS fanout or history fetch) into the entity
 * map. Returns the same reference when nothing changed.
 */
export function applySessionEvent(sessions: Record<string, Session>, ev: SessionFoldEvent): Record<string, Session> {
  const p = ev.payload ?? {};
  const sessionId =
    typeof p.sessionId === 'string' ? p.sessionId : typeof p.session_id === 'string' ? p.session_id : null;
  if (!sessionId) return sessions;
  const prev = sessions[sessionId];

  if (ev.type === 'session.spawned') {
    const base: Session = prev ?? {
      id: sessionId,
      workspaceId: ev.workspaceId,
      channelId: ev.channelId ?? '',
      threadRootEventId: ev.threadRootEventId,
      title: typeof p.title === 'string' ? p.title : '(agent task)',
      status: 'spawning',
      harness: typeof p.harness === 'string' ? p.harness : 'codex',
      repo: typeof p.repo === 'string' ? p.repo : null,
      branch: typeof p.branch === 'string' ? p.branch : null,
      repos: Array.isArray(p.repos) ? (p.repos as SessionRepoSpec[]) : null,
      spawnedBy: typeof p.by === 'string' ? p.by : (ev.actorId ?? ''),
      driverId: null,
      pendingSeatRequests: [],
      suggestions: [],
      answerProposals: [],
      pendingQuestion: null,
      providerAuthRequired: null,
      githubIdentityMode: typeof p.githubIdentityMode === 'string' ? p.githubIdentityMode : null,
      providerConnectionId: typeof p.providerConnectionId === 'string' ? p.providerConnectionId : null,
      questionEvents: [],
      seatEvents: [],
      costUsd: 0,
      resultText: null,
      createdAt: ev.createdAt,
      completedAt: null,
      archivedAt: null,
      pinned: false,
      lastEventId: 0,
      permalink: `/s/${sessionId}`,
    };
    const spawnerName = base.spawnerName ?? ev.author?.displayName;
    // Fold spawn metadata from the event too — when `prev` was an optimistic
    // entry built before the payload was known, keep whichever side has it.
    const repo = base.repo ?? (typeof p.repo === 'string' ? p.repo : null);
    const branch = base.branch ?? (typeof p.branch === 'string' ? p.branch : null);
    const repos = base.repos ?? (Array.isArray(p.repos) ? (p.repos as SessionRepoSpec[]) : null);
    const githubIdentityMode =
      base.githubIdentityMode ?? (typeof p.githubIdentityMode === 'string' ? p.githubIdentityMode : null);
    const providerConnectionId =
      base.providerConnectionId ?? (typeof p.providerConnectionId === 'string' ? p.providerConnectionId : null);
    return {
      ...sessions,
      [sessionId]: {
        ...base,
        ...optionalProp('spawnerName', spawnerName),
        repo,
        branch,
        repos,
        githubIdentityMode,
        providerConnectionId,
      },
    };
  }

  if (!prev) return sessions; // status for a session we never saw spawn — ignore

  if (ev.type === 'session.archived') {
    const archivedAt = typeof p.archivedAt === 'string' ? p.archivedAt : ev.createdAt;
    if (prev.archivedAt === archivedAt) return sessions;
    return { ...sessions, [sessionId]: { ...prev, archivedAt } };
  }

  if (ev.type === 'session.unarchived') {
    if (prev.archivedAt === null) return sessions;
    return { ...sessions, [sessionId]: { ...prev, archivedAt: null } };
  }

  if (ev.type === 'session.effort_changed') {
    const effort = typeof p.effort === 'string' ? p.effort : null;
    if (!effort || effort === prev.modelEffort) return sessions;
    return { ...sessions, [sessionId]: { ...prev, modelEffort: effort } };
  }

  if (ev.type === 'session.status_changed') {
    const status = asSessionStatus(p.status);
    if (!status) return sessions;
    // A follow-up steer legitimately regresses a terminal session to an active
    // status (completed → queued/running): that's a NEW TURN, not a stale
    // out-of-order event, so it bypasses the non-regression clamp. Clear the
    // stale completion so panes/cards go live again (the server nulls
    // completed_at on the same transition).
    const newTurn = isTerminalSessionStatus(prev.status) && !isTerminalSessionStatus(status);
    const nextStatus = newTurn ? status : maxSessionStatus(prev.status, status);
    if (nextStatus === prev.status) return sessions;
    return {
      ...sessions,
      [sessionId]: {
        ...prev,
        status: nextStatus,
        ...(newTurn ? { completedAt: null, pendingQuestion: null } : {}),
      },
    };
  }

  if (ev.type === 'session.completed') {
    const status = asSessionStatus(p.status) ?? 'completed';
    const nextStatus = maxSessionStatus(prev.status, status);
    const excerpt = typeof p.resultExcerpt === 'string' && p.resultExcerpt ? p.resultExcerpt : null;
    const permalink = typeof p.permalink === 'string' && p.permalink ? p.permalink : prev.permalink;
    return {
      ...sessions,
      [sessionId]: {
        ...prev,
        status: nextStatus,
        resultText: excerpt ?? prev.resultText,
        permalink,
        completedAt: prev.completedAt ?? ev.createdAt,
        pendingQuestion: null,
        providerAuthRequired: prev.providerAuthRequired?.provider === 'github' ? prev.providerAuthRequired : null,
      },
    };
  }

  if (ev.type === 'session.provider_auth_required') {
    const required = parseProviderAuthRequired(p);
    if (!required) return sessions;
    return {
      ...sessions,
      [sessionId]: {
        ...prev,
        providerAuthRequired: required,
        pendingQuestion: null,
        status: 'queued',
      },
    };
  }

  if (ev.type === 'session.github_auth_required') {
    const required = parseProviderAuthRequired({ ...p, provider: 'github' });
    if (!required) return sessions;
    return {
      ...sessions,
      [sessionId]: {
        ...prev,
        providerAuthRequired: required,
        pendingQuestion: null,
      },
    };
  }

  if (ev.type === 'session.provider_auth_resolved') {
    if (p.provider !== 'claude-code' && p.provider !== 'codex' && p.provider !== 'github') return sessions;
    return { ...sessions, [sessionId]: { ...prev, providerAuthRequired: null } };
  }

  if (ev.type === 'session.question_requested') {
    const questionId = typeof p.questionId === 'string' ? p.questionId : null;
    if (!questionId) return sessions;
    const questions = parseQuestionPrompts(p.questions);
    const turnId = typeof p.turnId === 'string' ? p.turnId : undefined;
    const entry = questionEventFromPayload(ev, questionId, 'requested', {
      questions,
      ...(turnId !== undefined ? { turnId } : {}),
    });
    return {
      ...sessions,
      [sessionId]: {
        ...prev,
        pendingQuestion: { questionId, questions },
        questionEvents: appendQuestionEvent(prev.questionEvents, entry),
      },
    };
  }

  if (ev.type === 'session.question_answered' || ev.type === 'session.question_resolved') {
    const questionId = typeof p.questionId === 'string' ? p.questionId : null;
    if (!questionId) return sessions;
    const isMatchingPending = prev.pendingQuestion?.questionId === questionId;
    const entry =
      ev.type === 'session.question_answered'
        ? questionEventFromPayload(ev, questionId, 'answered', {
            answers: parseQuestionAnswerSummaries(p.answers),
          })
        : questionEventFromPayload(ev, questionId, 'resolved', {
            reason: parseQuestionResolutionReason(p.reason),
          });
    return {
      ...sessions,
      [sessionId]: {
        ...prev,
        ...(isMatchingPending ? { pendingQuestion: null } : {}),
        questionEvents: appendQuestionEvent(prev.questionEvents, entry),
      },
    };
  }

  if (ev.type === 'session.seat_requested') {
    const by = typeof p.by === 'string' ? p.by : ev.actorId;
    if (!by || by === sessionDriverId(prev)) return sessions;
    if (prev.pendingSeatRequests.some((r) => r.userId === by)) return sessions;
    const displayName = ev.author?.id === by ? ev.author.displayName : by;
    return {
      ...sessions,
      [sessionId]: {
        ...prev,
        pendingSeatRequests: [...prev.pendingSeatRequests, { userId: by, displayName }],
      },
    };
  }

  if (ev.type === 'session.seat_changed') {
    const to = typeof p.to === 'string' ? p.to : null;
    if (!to) return sessions;
    if (prev.seatEvents.some((e) => e.id === ev.id)) return sessions; // WS + catch-up overlap
    const from = typeof p.from === 'string' ? p.from : null;
    const reason: SeatChangeReason = p.reason === 'taken' ? 'taken' : 'granted';
    // Best-effort name resolution from what the entity already knows; the
    // event author is the old driver for grants and the new driver for takes.
    const nameOf = (id: string | null): string | undefined => {
      if (!id) return undefined;
      if (ev.author?.id === id) return ev.author.displayName;
      const req = prev.pendingSeatRequests.find((r) => r.userId === id);
      if (req) return req.displayName;
      if (id === prev.driverId && prev.driverName) return prev.driverName;
      if (id === prev.spawnedBy) return prev.spawnerName;
      return undefined;
    };
    const entry: SeatAuditEntry = {
      id: ev.id,
      from,
      to,
      reason,
      ...optionalProp('fromName', nameOf(from)),
      ...optionalProp('toName', nameOf(to)),
      at: ev.createdAt,
    };
    const seatEvents = [...prev.seatEvents, entry].sort((a, b) => a.id - b.id);
    const { driverName: _oldDriverName, ...prevWithoutDriverName } = prev;
    const driverName = nameOf(to);
    return {
      ...sessions,
      [sessionId]: {
        ...prevWithoutDriverName,
        driverId: to,
        ...optionalProp('driverName', driverName),
        pendingSeatRequests: prev.pendingSeatRequests.filter((r) => r.userId !== to),
        seatEvents,
      },
    };
  }

  if (ev.type === 'session.suggestion_added') {
    const suggestionId = typeof p.suggestionId === 'string' ? p.suggestionId : null;
    const text = typeof p.text === 'string' ? p.text : null;
    if (!suggestionId || text === null) return sessions;
    if (prev.suggestions.some((s) => s.id === suggestionId)) return sessions; // WS + catch-up overlap
    const authorId = typeof p.authorId === 'string' ? p.authorId : (ev.actorId ?? '');
    const suggestion: SessionSuggestion = {
      id: suggestionId,
      authorId,
      text,
      status: 'pending',
      createdAt: ev.createdAt,
    };
    if (ev.author && ev.author.id === authorId && ev.author.displayName) {
      suggestion.authorName = ev.author.displayName;
    }
    return {
      ...sessions,
      [sessionId]: { ...prev, suggestions: [...prev.suggestions, suggestion] },
    };
  }

  if (ev.type === 'session.suggestion_resolved') {
    const suggestionId = typeof p.suggestionId === 'string' ? p.suggestionId : null;
    const status = p.status === 'sent' || p.status === 'dismissed' ? p.status : null;
    if (!suggestionId || !status) return sessions;
    const idx = prev.suggestions.findIndex((s) => s.id === suggestionId);
    if (idx < 0) return sessions; // resolve for a suggestion we never folded — GET will carry it
    const existing = prev.suggestions[idx]!;
    const resolvedBy = typeof p.resolvedBy === 'string' ? p.resolvedBy : (ev.actorId ?? undefined);
    const resolved: SessionSuggestion = {
      ...existing,
      status,
      resolvedAt: ev.createdAt,
      ...(resolvedBy ? { resolvedBy } : {}),
      ...(ev.author && ev.author.id === resolvedBy && ev.author.displayName
        ? { resolvedByName: ev.author.displayName }
        : {}),
      ...(typeof p.sentText === 'string' ? { sentText: p.sentText } : {}),
      ...(typeof p.note === 'string' && p.note ? { note: p.note } : {}),
    };
    const suggestions = [...prev.suggestions];
    suggestions[idx] = resolved;
    return { ...sessions, [sessionId]: { ...prev, suggestions } };
  }

  if (ev.type === 'session.answer_proposed') {
    const proposalId = typeof p.proposalId === 'string' ? p.proposalId : null;
    const questionId = typeof p.questionId === 'string' ? p.questionId : null;
    const answers = parseProposalAnswers(p.answers);
    if (!proposalId || !questionId || !answers) return sessions;
    if (prev.answerProposals.some((pr) => pr.id === proposalId)) return sessions; // WS + catch-up overlap
    const authorId = typeof p.authorId === 'string' ? p.authorId : (ev.actorId ?? '');
    const proposal: SessionAnswerProposal = {
      id: proposalId,
      questionId,
      authorId,
      answers,
      status: 'pending',
      createdAt: ev.createdAt,
    };
    if (ev.author && ev.author.id === authorId && ev.author.displayName) {
      proposal.authorName = ev.author.displayName;
    }
    return {
      ...sessions,
      [sessionId]: { ...prev, answerProposals: [...prev.answerProposals, proposal] },
    };
  }

  if (ev.type === 'session.answer_proposal_resolved') {
    const proposalId = typeof p.proposalId === 'string' ? p.proposalId : null;
    const status = p.status === 'submitted' || p.status === 'dismissed' ? p.status : null;
    if (!proposalId || !status) return sessions;
    const idx = prev.answerProposals.findIndex((pr) => pr.id === proposalId);
    if (idx < 0) return sessions;
    const existing = prev.answerProposals[idx]!;
    const resolvedBy = typeof p.resolvedBy === 'string' ? p.resolvedBy : (ev.actorId ?? undefined);
    const resolved: SessionAnswerProposal = {
      ...existing,
      status,
      resolvedAt: ev.createdAt,
      ...(resolvedBy ? { resolvedBy } : {}),
      ...(ev.author && ev.author.id === resolvedBy && ev.author.displayName
        ? { resolvedByName: ev.author.displayName }
        : {}),
      ...(typeof p.note === 'string' && p.note ? { note: p.note } : {}),
    };
    const answerProposals = [...prev.answerProposals];
    answerProposals[idx] = resolved;
    return { ...sessions, [sessionId]: { ...prev, answerProposals } };
  }

  return sessions;
}

/** Fold an ephemeral `session.activity` socket frame. Unknown sessions are
 * ignored so a deploy-skewed or out-of-order frame cannot create a partial
 * session entity. */
export function applySessionActivity(
  sessions: Record<string, Session>,
  sessionId: string,
  activity: SessionActivity,
): Record<string, Session> {
  const prev = sessions[sessionId];
  if (!prev) return sessions;
  if (prev.latestActivity?.summary === activity.summary && prev.latestActivity.at === activity.at) return sessions;
  return { ...sessions, [sessionId]: { ...prev, latestActivity: activity } };
}

/** Validate a proposal's answer map: { [questionId]: { answers: string[] } }. */
function parseProposalAnswers(value: unknown): SessionQuestionAnswers | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: SessionQuestionAnswers = {};
  for (const [qid, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const answers = (entry as Record<string, unknown>).answers;
    if (!Array.isArray(answers) || !answers.every((a) => typeof a === 'string')) return null;
    out[qid] = { answers: answers as string[] };
  }
  return out;
}

function questionEventFromPayload(
  ev: SessionFoldEvent,
  questionId: string,
  kind: SessionQuestionEvent['kind'],
  details: Partial<Pick<SessionQuestionEvent, 'questions' | 'answers' | 'reason' | 'turnId'>>,
): SessionQuestionEvent {
  const entry: SessionQuestionEvent = {
    id: ev.id,
    questionId,
    kind,
    at: ev.createdAt,
  };
  if (ev.actorId !== null) entry.actorId = ev.actorId;
  if (ev.author?.displayName) entry.actorName = ev.author.displayName;
  if (details.questions !== undefined) entry.questions = details.questions;
  if (details.answers !== undefined) entry.answers = details.answers;
  if (details.reason !== undefined) entry.reason = details.reason;
  if (details.turnId !== undefined) entry.turnId = details.turnId;
  return entry;
}

function appendQuestionEvent(
  current: SessionQuestionEvent[] | undefined,
  entry: SessionQuestionEvent,
): SessionQuestionEvent[] {
  const events = current ?? [];
  if (events.some((e) => e.id === entry.id)) return events;
  return [...events, entry].sort((a, b) => a.id - b.id);
}

function parseQuestionPrompts(value: unknown): QuestionPrompt[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): QuestionPrompt | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const raw = item as Record<string, unknown>;
      if (typeof raw.id !== 'string' || typeof raw.question !== 'string') return null;
      const options = Array.isArray(raw.options)
        ? raw.options
            .map((option): QuestionOption | null => {
              if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
              const o = option as Record<string, unknown>;
              if (typeof o.label !== 'string' || typeof o.description !== 'string') return null;
              const previewFormat =
                o.previewFormat === 'markdown' || o.previewFormat === 'html' ? o.previewFormat : undefined;
              return {
                label: o.label,
                description: o.description,
                ...(typeof o.preview === 'string' ? { preview: o.preview } : {}),
                ...(previewFormat ? { previewFormat } : {}),
              };
            })
            .filter((option): option is QuestionOption => option !== null)
        : [];
      return {
        id: raw.id,
        header: typeof raw.header === 'string' ? raw.header : 'Question',
        question: raw.question,
        multiSelect: raw.multiSelect === true,
        isOther: raw.isOther === true,
        isSecret: raw.isSecret === true,
        options,
      };
    })
    .filter((q): q is QuestionPrompt => q !== null);
}

function parseProviderAuthRequired(value: unknown): SessionProviderAuthRequired | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.provider !== 'claude-code' && raw.provider !== 'codex' && raw.provider !== 'github') return null;
  if (typeof raw.userId !== 'string') return null;
  if (raw.reason !== 'missing_token' && raw.reason !== 'invalid_token' && raw.reason !== 'auth_error') {
    return null;
  }
  return {
    provider: raw.provider,
    userId: raw.userId,
    reason: raw.reason,
    message:
      typeof raw.message === 'string' && raw.message.trim()
        ? raw.message
        : raw.provider === 'codex'
          ? 'Reconnect Codex to continue this session.'
          : raw.provider === 'github'
            ? 'Reconnect GitHub before retrying private repository access.'
            : 'Reconnect Claude Code to continue this session.',
    at: typeof raw.at === 'string' ? raw.at : new Date().toISOString(),
  };
}

function parseQuestionAnswerSummaries(value: unknown): SessionQuestionAnswerSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): SessionQuestionAnswerSummary | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const raw = item as Record<string, unknown>;
      if (typeof raw.id !== 'string') return null;
      const answers = Array.isArray(raw.answers)
        ? raw.answers.filter((answer): answer is string => typeof answer === 'string')
        : [];
      return {
        id: raw.id,
        header: typeof raw.header === 'string' ? raw.header : raw.id,
        answers,
        count: typeof raw.count === 'number' && Number.isFinite(raw.count) ? raw.count : answers.length,
      };
    })
    .filter((summary): summary is SessionQuestionAnswerSummary => summary !== null);
}

function parseQuestionResolutionReason(value: unknown): QuestionResolutionReason {
  return value === 'empty' || value === 'cancelled' || value === 'answered' ? value : 'cancelled';
}

export function formatCost(v: number): string {
  return `$${v >= 1 ? v.toFixed(2) : v.toFixed(4)}`;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}
