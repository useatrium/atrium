// /api/sessions client + proxied Centaur SSE stream.
//
// Every function delegates to the DEV MOCK (./devMock) when the dev server is
// started with VITE_SESSIONS_MOCK=1; otherwise it talks to the real endpoints.

import type { ArtifactPresentation, CentaurEventFrame } from '@atrium/centaur-client';
import { ApiError } from '../api';
import { sessionsMock } from './devMock';
import type { SessionListItem, SessionRepoSpec, SessionWire } from './types';

export interface CreateSessionBody {
  channelId: string;
  threadRootEventId?: number;
  task: string;
  harness?: string;
  repo?: string;
  branch?: string;
  repos?: SessionRepoSpec[];
  githubIdentityMode?: 'automatic' | 'app_installation' | 'app_user' | 'pat';
  /** Optimistic id echoed on session.spawned for lost-response reconcile. */
  clientSpawnId?: string;
  agentProfileId?: string;
  agentProfileVersionId?: string;
  opId?: string;
}

export interface SessionStreamHandle {
  close(): void;
}

export interface SessionStreamCallbacks {
  onFrame: (frame: CentaurEventFrame) => void;
  onOpen?: () => void;
  /** Stream broke — caller decides whether to recreate with a fresh cursor. */
  onError?: () => void;
  /** Server heartbeat (~15s, plus once at open). `serverTs` is the server's
   * wall clock for skew-free elapsed displays; null if the payload didn't parse. */
  onPing?: (serverTs: string | null) => void;
}

export interface AppListRow {
  id: string;
  workspaceId: string;
  channelId: string | null;
  name: string;
  scope: 'channel' | 'workspace';
  status: string;
  currentVersion: number | null;
  entryPath: string | null;
  updatedAt: string;
}

export interface SessionCapabilityItem {
  name: string;
  sources: string[];
  namespace?: string;
  description?: string;
  status?: 'available' | 'pending' | 'observed';
  count?: number;
}

export interface SessionCapabilityNamespace {
  name: string;
  sources: string[];
  description?: string;
  count: number;
}

export interface SessionCapabilityChange {
  seq: number;
  line: number;
  timestamp?: string;
  source: string;
  summary: string;
  added?: string[];
  removed?: string[];
  readded?: string[];
  counts?: Record<string, number>;
  redacted?: boolean;
}

export interface SessionCapabilitySnapshot {
  parserVersion: number;
  sessionId: string;
  harness: 'claude' | 'codex';
  sourceSha256: string;
  completeness: 'complete' | 'partial' | 'observed';
  generatedAt: string;
  runtime: Record<string, unknown>;
  counts: {
    tools: number;
    toolNamespaces: number;
    mcpServers: number;
    agents: number;
    skills: number;
    observedToolCalls: number;
    changes: number;
  };
  tools: SessionCapabilityItem[];
  toolNamespaces: SessionCapabilityNamespace[];
  mcpServers: SessionCapabilityItem[];
  agents: SessionCapabilityItem[];
  skills: SessionCapabilityItem[];
  observedToolCalls: SessionCapabilityItem[];
  pendingMcpServers: string[];
  changes: SessionCapabilityChange[];
  warnings: string[];
  redactions: string[];
}

export interface SessionCapabilitiesResponse {
  sessionId: string;
  snapshots: SessionCapabilitySnapshot[];
}

/** Every event name the Centaur durable stream emits (docs/archive/notes/build-history/phase0/results/event-schema.md). */
export const FRAME_EVENT_NAMES = [
  'execution_state',
  'execution_started',
  'amp_raw_event',
  'system_event_observed',
  'assistant_text_observed',
  'assistant_tool_use_observed',
  'tool_result_observed',
  'usage_observed',
  'result_observed',
  'execution_summary',
  'artifact.captured',
] as const;

async function reqJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await doFetch(path, init);
  return res.json() as Promise<T>;
}

/** For 202 endpoints whose body may be empty. */
async function reqAccepted(path: string, init?: RequestInit): Promise<void> {
  await doFetch(path, init);
}

async function doFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let code = 'http_error';
    let message = res.statusText;
    try {
      const body = await res.json();
      code = body.error ?? code;
      message = body.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message);
  }
  return res;
}

/**
 * Parse one SSE frame. The server proxies Centaur frames verbatim
 * (`event: <name>` / `data: <json incl event_id>`); tolerate both
 * `{event_id, data}` envelopes and flat `{event_id, ...payload}` bodies.
 */
export function parseFrame(name: string, raw: string): CentaurEventFrame | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const data =
      parsed.data && typeof parsed.data === 'object'
        ? (parsed.data as Record<string, unknown>)
        : parsed;
    const eventId =
      typeof parsed.event_id === 'number'
        ? parsed.event_id
        : typeof data.event_id === 'number'
          ? data.event_id
          : 0;
    const ts =
      typeof parsed.atrium_ts === 'string'
        ? parsed.atrium_ts
        : typeof data.atrium_ts === 'string'
          ? data.atrium_ts
          : undefined;
    return { event: name, event_id: eventId, data, ...(ts ? { ts } : {}) } as CentaurEventFrame;
  } catch {
    return null;
  }
}

export const sessionsApi = {
  create(body: CreateSessionBody): Promise<{ session: SessionWire }> {
    if (sessionsMock) return sessionsMock.createSession(body);
    return reqJson<{ session: SessionWire }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  get(id: string): Promise<{ session: SessionWire }> {
    if (sessionsMock) return sessionsMock.getSession(id);
    return reqJson<{ session: SessionWire }>(`/api/sessions/${id}`);
  },

  list(opts: { status?: 'running' | 'recent' | 'all'; limit?: number } = {}): Promise<{
    sessions: SessionListItem[];
  }> {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return reqJson<{ sessions: SessionListItem[] }>(`/api/sessions${qs ? `?${qs}` : ''}`);
  },

  sendMessage(id: string, text: string): Promise<void> {
    if (sessionsMock) return sessionsMock.sendMessage(id, text);
    return reqAccepted(`/api/sessions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },

  answerQuestion(
    id: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
    opId?: string,
  ): Promise<void> {
    if (sessionsMock) return sessionsMock.answerQuestion(id, questionId, answers);
    return reqAccepted(`/api/sessions/${id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ questionId, answers, ...(opId ? { opId } : {}) }),
    });
  },

  cancel(id: string, opId?: string): Promise<void> {
    if (sessionsMock) return sessionsMock.cancel(id);
    return reqAccepted(`/api/sessions/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify(opId ? { opId } : {}),
    });
  },

  listPresentations(id: string): Promise<{ presentations: ArtifactPresentation[] }> {
    return reqJson<{ presentations: ArtifactPresentation[] }>(
      `/api/sessions/${id}/artifacts/presentations`,
    );
  },

  getCapabilities(id: string): Promise<SessionCapabilitiesResponse> {
    if (sessionsMock) return sessionsMock.getCapabilities(id);
    return reqJson<SessionCapabilitiesResponse>(`/api/sessions/${id}/atrium/capabilities`);
  },

  listApps(): Promise<{ apps: AppListRow[] }> {
    return reqJson<{ apps: AppListRow[] }>('/api/apps');
  },

  publishApp(
    sessionId: string,
    body: { name: string; entry?: string; scope?: 'channel' | 'workspace' },
  ): Promise<{ appId: string; version: number; files: string[]; entry: string }> {
    return reqJson<{ appId: string; version: number; files: string[]; entry: string }>(
      `/api/sessions/${sessionId}/apps`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
  },

  launchApp(appId: string, version?: number): Promise<{ url: string; expires: string; version: number }> {
    return reqJson<{ url: string; expires: string; version: number }>(`/api/apps/${appId}/launch`, {
      method: 'POST',
      body: JSON.stringify(version === undefined ? {} : { version }),
    });
  },

  // ---- driver seat (Phase 3) ----

  requestSeat(id: string): Promise<void> {
    if (sessionsMock) return sessionsMock.requestSeat(id);
    return reqAccepted(`/api/sessions/${id}/seat/request`, { method: 'POST', body: '{}' });
  },

  /** Driver-only. */
  grantSeat(id: string, userId: string): Promise<void> {
    if (sessionsMock) return sessionsMock.grantSeat(id, userId);
    return reqAccepted(`/api/sessions/${id}/seat/grant`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  },

  /** Rejects with ApiError(409, 'seat_held') while the driver is watching. */
  takeSeat(id: string): Promise<void> {
    if (sessionsMock) return sessionsMock.takeSeat(id);
    return reqAccepted(`/api/sessions/${id}/seat/take`, { method: 'POST', body: '{}' });
  },

  // ---- suggestion queue (Phase 2) ----

  /** A watcher proposes a steer the driver later sends or dismisses. */
  createSuggestion(id: string, text: string, opId?: string): Promise<void> {
    if (sessionsMock) return sessionsMock.createSuggestion(id, text);
    return reqAccepted(`/api/sessions/${id}/suggestions`, {
      method: 'POST',
      body: JSON.stringify({ text, ...(opId ? { opId } : {}) }),
    });
  },

  /** Driver-only. `send` may carry edited text; `dismiss` an optional reason. */
  resolveSuggestion(
    id: string,
    suggestionId: string,
    action: 'send' | 'dismiss',
    opts: { text?: string; note?: string } = {},
    opId?: string,
  ): Promise<void> {
    if (sessionsMock) return sessionsMock.resolveSuggestion(id, suggestionId, action, opts);
    return reqAccepted(`/api/sessions/${id}/suggestions/${suggestionId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action, ...opts, ...(opId ? { opId } : {}) }),
    });
  },

  // ---- HITL answer proposals (Phase 2) ----

  /** A watcher proposes an answer to the pending question. */
  proposeAnswer(
    id: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
    opId?: string,
  ): Promise<void> {
    if (sessionsMock) return sessionsMock.proposeAnswer(id, questionId, answers);
    return reqAccepted(`/api/sessions/${id}/question-proposals`, {
      method: 'POST',
      body: JSON.stringify({ questionId, answers, ...(opId ? { opId } : {}) }),
    });
  },

  /** Driver-only. `submit` answers the question; `dismiss` takes an optional reason. */
  resolveAnswerProposal(
    id: string,
    proposalId: string,
    action: 'submit' | 'dismiss',
    opts: { note?: string } = {},
    opId?: string,
  ): Promise<void> {
    if (sessionsMock) return sessionsMock.resolveAnswerProposal(id, proposalId, action, opts);
    return reqAccepted(`/api/sessions/${id}/question-proposals/${proposalId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action, ...opts, ...(opId ? { opId } : {}) }),
    });
  },

  /** Cookie-authed SSE of Centaur frames, resumable via after_event_id. */
  openStream(
    sessionId: string,
    afterEventId: number,
    cb: SessionStreamCallbacks,
  ): SessionStreamHandle {
    if (sessionsMock) return sessionsMock.openStream(sessionId, afterEventId, cb);
    const es = new EventSource(
      `/api/sessions/${sessionId}/stream?after_event_id=${afterEventId}`,
    );
    es.onopen = () => cb.onOpen?.();
    es.onerror = () => cb.onError?.();
    es.addEventListener('ping', (e) => {
      let serverTs: string | null = null;
      try {
        const data = JSON.parse((e as MessageEvent<string>).data) as { atrium_ts?: unknown };
        if (typeof data.atrium_ts === 'string') serverTs = data.atrium_ts;
      } catch {
        /* malformed ping — still counts as liveness */
      }
      cb.onPing?.(serverTs);
    });
    for (const name of FRAME_EVENT_NAMES) {
      es.addEventListener(name, (e) => {
        const frame = parseFrame(name, (e as MessageEvent<string>).data);
        if (frame) cb.onFrame(frame);
      });
    }
    return { close: () => es.close() };
  },
};

export type SessionApi = typeof sessionsApi;
