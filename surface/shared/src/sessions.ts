// Session entities + pure fold helpers. No React imports — unit tested directly.

import type { WireEvent } from './timeline';

export type SessionStatus =
  | 'spawning'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

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
  /** Driver who resolved it (present once sent/dismissed). */
  resolvedBy?: string;
  resolvedByName?: string;
  /** The actually-sent text when edited-then-sent (differs from `text`). */
  sentText?: string;
  /** Optional "why" on dismiss — never required. */
  note?: string;
  createdAt: string;
  resolvedAt?: string;
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
  answers: Record<string, { answers: string[] }>;
  status: AnswerProposalStatus;
  /** Driver who resolved it (present once submitted/dismissed). */
  resolvedBy?: string;
  resolvedByName?: string;
  /** Optional "why" on dismiss — never required. */
  note?: string;
  createdAt: string;
  resolvedAt?: string;
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
  costUsd: number | string | null;
  resultText: string | null;
  createdAt: string;
  completedAt: string | null;
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
  /** Live-only client audit log folded from session.question_* events. */
  questionEvents?: SessionQuestionEvent[];
  /** Seat handoff audit log folded from session.seat_changed, oldest-first. */
  seatEvents: SeatAuditEntry[];
  costUsd: number;
  resultText: string | null;
  createdAt: string;
  completedAt: string | null;
  lastEventId: number;
  permalink: string;
}

export interface SessionRepoSpec {
  repo: string;
  ref?: string;
  subdir?: string;
  private?: boolean;
}

/**
 * Effective driver: the server seeds driver_id with the spawner at insert, so
 * a null driverId (optimistic rows, pre-Phase-3 payloads) falls back to the
 * spawner. Steer permission follows this id; cancel = spawner OR driver.
 */
export function sessionDriverId(s: Session): string {
  return s.driverId ?? s.spawnedBy;
}

/** Optimistic sessions (pre-POST-response) use this id prefix. */
export const PENDING_SESSION_PREFIX = 'pending:';

export function isPendingSessionId(id: string): boolean {
  return id.startsWith(PENDING_SESSION_PREFIX);
}

export function isTerminalSessionStatus(s: SessionStatus): boolean {
  return s === 'completed' || s === 'failed' || s === 'cancelled';
}

/**
 * A session still claiming spawning/queued this long after creation has almost
 * certainly been lost by the control plane — render it as stalled (static, no
 * pulse) instead of letting a dead status lie forever.
 */
export const STALLED_AFTER_MS = 10 * 60 * 1000;

export function isStalledSessionStatus(s: Session, now: number): boolean {
  return (
    (s.status === 'spawning' || s.status === 'queued') &&
    now - new Date(s.createdAt).getTime() > STALLED_AFTER_MS
  );
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
  return typeof v === 'string' && (SESSION_STATUSES as readonly string[]).includes(v)
    ? (v as SessionStatus)
    : null;
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
    driverName: w.driver?.displayName,
    pendingSeatRequests: [...(w.pendingSeatRequests ?? [])],
    suggestions: [...(w.suggestions ?? [])],
    answerProposals: [...(w.answerProposals ?? [])],
    pendingQuestion: w.pendingQuestion ?? null,
    providerAuthRequired: parseProviderAuthRequired(w.providerAuthRequired),
    githubIdentityMode: w.githubIdentityMode ?? null,
    providerConnectionId: w.providerConnectionId ?? null,
    agentProfileVersionId: w.agentProfileVersionId ?? null,
    questionEvents: [],
    seatEvents: [],
    costUsd: Number(w.costUsd ?? 0) || 0,
    resultText: w.resultText ?? null,
    createdAt: w.createdAt,
    completedAt: w.completedAt ?? null,
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
    completedAt: live.completedAt ?? resp.completedAt,
    spawnerName: live.spawnerName ?? resp.spawnerName,
    // Seat state that moved via WS while the POST was in flight wins over the
    // insert-time snapshot (which always says driver = spawner, no requests).
    driverId: live.driverId ?? resp.driverId,
    driverName: live.driverName ?? resp.driverName,
    pendingSeatRequests:
      live.pendingSeatRequests.length > 0 ? live.pendingSeatRequests : resp.pendingSeatRequests,
    suggestions: live.suggestions.length > 0 ? live.suggestions : resp.suggestions,
    answerProposals:
      live.answerProposals.length > 0 ? live.answerProposals : resp.answerProposals,
    pendingQuestion: live.pendingQuestion ?? resp.pendingQuestion,
    providerAuthRequired: live.providerAuthRequired ?? resp.providerAuthRequired ?? null,
    questionEvents:
      (live.questionEvents?.length ?? 0) > 0 ? live.questionEvents : (resp.questionEvents ?? []),
    seatEvents: live.seatEvents.length > 0 ? live.seatEvents : resp.seatEvents,
    lastEventId: Math.max(live.lastEventId, resp.lastEventId),
  };
}

/**
 * Fold a `session.*` wire event (WS fanout or history fetch) into the entity
 * map. Returns the same reference when nothing changed.
 */
export function applySessionEvent(
  sessions: Record<string, Session>,
  ev: WireEvent,
): Record<string, Session> {
  const p = ev.payload ?? {};
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
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
      githubIdentityMode:
        typeof p.githubIdentityMode === 'string' ? p.githubIdentityMode : null,
      providerConnectionId:
        typeof p.providerConnectionId === 'string' ? p.providerConnectionId : null,
      questionEvents: [],
      seatEvents: [],
      costUsd: 0,
      resultText: null,
      createdAt: ev.createdAt,
      completedAt: null,
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
      [sessionId]: { ...base, spawnerName, repo, branch, repos, githubIdentityMode, providerConnectionId },
    };
  }

  if (!prev) return sessions; // status for a session we never saw spawn — ignore

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
        pendingQuestion: isMatchingPending ? null : prev.pendingQuestion,
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
      fromName: nameOf(from),
      toName: nameOf(to),
      at: ev.createdAt,
    };
    const seatEvents = [...prev.seatEvents, entry].sort((a, b) => a.id - b.id);
    return {
      ...sessions,
      [sessionId]: {
        ...prev,
        driverId: to,
        driverName: nameOf(to),
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
    const resolvedBy = typeof p.resolvedBy === 'string' ? p.resolvedBy : ev.actorId ?? undefined;
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
    const resolvedBy = typeof p.resolvedBy === 'string' ? p.resolvedBy : ev.actorId ?? undefined;
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

/** Validate a proposal's answer map: { [questionId]: { answers: string[] } }. */
function parseProposalAnswers(value: unknown): Record<string, { answers: string[] }> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, { answers: string[] }> = {};
  for (const [qid, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const answers = (entry as Record<string, unknown>).answers;
    if (!Array.isArray(answers) || !answers.every((a) => typeof a === 'string')) return null;
    out[qid] = { answers: answers as string[] };
  }
  return out;
}

function questionEventFromPayload(
  ev: WireEvent,
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
  if (
    raw.reason !== 'missing_token' &&
    raw.reason !== 'invalid_token' &&
    raw.reason !== 'auth_error'
  ) {
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
