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
  /** Driver display info (Phase 3 server; may be absent on older payloads). */
  driver?: SessionSeatUser | null;
  pendingSeatRequests?: SessionSeatUser[];
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
  /** Display name of the current driver when known. */
  driverName?: string;
  /** Open seat requests, oldest-first (deduped by userId). */
  pendingSeatRequests: SessionSeatUser[];
  /** Seat handoff audit log folded from session.seat_changed, oldest-first. */
  seatEvents: SeatAuditEntry[];
  costUsd: number;
  resultText: string | null;
  createdAt: string;
  completedAt: string | null;
  lastEventId: number;
  permalink: string;
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
    driverId: w.driverId ?? w.driver?.userId ?? null,
    driverName: w.driver?.displayName,
    pendingSeatRequests: [...(w.pendingSeatRequests ?? [])],
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
    status: statusRank(live.status) >= statusRank(resp.status) ? live.status : resp.status,
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
      harness: typeof p.harness === 'string' ? p.harness : 'claude-code',
      spawnedBy: typeof p.by === 'string' ? p.by : (ev.actorId ?? ''),
      driverId: null,
      pendingSeatRequests: [],
      seatEvents: [],
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
