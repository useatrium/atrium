// Session entities + pure fold helpers. No React imports — unit tested directly.

import type { ExecutionStatus } from '@atrium/centaur-client';
import type { WireEvent } from '../state';

export type SessionStatus =
  | 'spawning'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Session JSON as served by POST/GET /api/sessions. */
export interface SessionWire {
  id: string;
  workspaceId: string;
  channelId: string;
  threadRootEventId: number | null;
  title: string;
  status: SessionStatus;
  harness: string;
  spawnedBy: string;
  driverId: string | null;
  costUsd: number | string | null;
  resultText: string | null;
  createdAt: string;
  completedAt: string | null;
  lastEventId: number;
  permalink: string;
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
  spawnedBy: string;
  /** Display name of the spawner when known (from WS author / me). */
  spawnerName?: string;
  driverId: string | null;
  costUsd: number;
  resultText: string | null;
  createdAt: string;
  completedAt: string | null;
  lastEventId: number;
  permalink: string;
}

/** Optimistic sessions (pre-POST-response) use this id prefix. */
export const PENDING_SESSION_PREFIX = 'pending:';

export function isPendingSessionId(id: string): boolean {
  return id.startsWith(PENDING_SESSION_PREFIX);
}

export function isTerminalSessionStatus(s: SessionStatus): boolean {
  return s === 'completed' || s === 'failed' || s === 'cancelled';
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
    default:
      return 3; // terminal
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

/** Map a Centaur execution status (stream) onto the session status vocabulary. */
export function normalizeExecutionStatus(s: ExecutionStatus): SessionStatus {
  switch (s) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'failed_permanent':
      return 'failed';
    default:
      return 'running';
  }
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
    spawnedBy: w.spawnedBy,
    driverId: w.driverId ?? null,
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
    status: statusRank(live.status) >= statusRank(resp.status) ? live.status : resp.status,
    costUsd: Math.max(live.costUsd, resp.costUsd),
    resultText: live.resultText ?? resp.resultText,
    completedAt: live.completedAt ?? resp.completedAt,
    spawnerName: live.spawnerName ?? resp.spawnerName,
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
      harness: typeof p.harness === 'string' ? p.harness : 'claude-code',
      spawnedBy: typeof p.by === 'string' ? p.by : (ev.actorId ?? ''),
      driverId: null,
      costUsd: 0,
      resultText: null,
      createdAt: ev.createdAt,
      completedAt: null,
      lastEventId: 0,
      permalink: `/s/${sessionId}`,
    };
    const spawnerName = base.spawnerName ?? ev.author?.displayName;
    return { ...sessions, [sessionId]: { ...base, spawnerName } };
  }

  if (!prev) return sessions; // status for a session we never saw spawn — ignore

  if (ev.type === 'session.status_changed') {
    const status = asSessionStatus(p.status);
    if (!status || status === prev.status) return sessions;
    return { ...sessions, [sessionId]: { ...prev, status } };
  }

  if (ev.type === 'session.completed') {
    const status = asSessionStatus(p.status) ?? 'completed';
    const excerpt = typeof p.resultExcerpt === 'string' && p.resultExcerpt ? p.resultExcerpt : null;
    const permalink = typeof p.permalink === 'string' && p.permalink ? p.permalink : prev.permalink;
    return {
      ...sessions,
      [sessionId]: {
        ...prev,
        status,
        resultText: excerpt ?? prev.resultText,
        permalink,
        completedAt: prev.completedAt ?? ev.createdAt,
      },
    };
  }

  return sessions;
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
