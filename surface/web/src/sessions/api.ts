// /api/sessions client + proxied Centaur SSE stream.

import type { ArtifactPresentation, CentaurEventFrame } from '@atrium/centaur-client';
import { decodeSessionListResponse, decodeSessionResponse } from '@atrium/surface-client';
import type {
  SessionAnswerProposalResolveBody,
  SessionAnswerQuestionBody,
  SessionOpIdBody,
  SessionQuestionAnswers,
  SessionSeatGrantBody,
  SessionSteerBody,
  SessionSuggestionCreateBody,
  SessionSuggestionResolveBody,
} from '@atrium/surface-client';
import { ApiError } from '../api';
import { desktopApiOptions } from '../desktop';
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
const FRAME_EVENT_NAMES = [
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

const apiOptions = desktopApiOptions();
const base = (apiOptions?.baseUrl ?? '').replace(/\/+$/, '');

function withDesktopToken(path: string): string {
  const token = apiOptions?.getToken?.() ?? null;
  if (!token) return base + path;
  const url = new URL(base + path);
  url.searchParams.set('token', token);
  return url.toString();
}

function sessionOpIdBody(opId?: string): SessionOpIdBody {
  return opId ? { opId } : {};
}

type ResponseDecoder<T> = (input: unknown) => T;

async function reqJson<T>(path: string, init?: RequestInit, decode?: ResponseDecoder<T>): Promise<T> {
  const res = await doFetch(path, init);
  if (decode) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ApiError(502, 'bad_response', 'invalid server response');
    }
    return decode(body);
  }
  return res.json() as Promise<T>;
}

/** For 202 endpoints whose body may be empty. */
async function reqAccepted(path: string, init?: RequestInit): Promise<void> {
  await doFetch(path, init);
}

async function doFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = apiOptions?.getToken?.() ?? null;
  const res = await fetch(base + path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
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
function parseFrame(name: string, raw: string): CentaurEventFrame | null {
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
    return reqJson<{ session: SessionWire }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    }, decodeSessionResponse);
  },

  get(id: string): Promise<{ session: SessionWire }> {
    return reqJson<{ session: SessionWire }>(`/api/sessions/${id}`, undefined, decodeSessionResponse);
  },

  list(opts: { status?: 'running' | 'recent' | 'all' | 'archived'; limit?: number } = {}): Promise<{
    sessions: SessionListItem[];
  }> {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return reqJson<{ sessions: SessionListItem[] }>(
      `/api/sessions${qs ? `?${qs}` : ''}`,
      undefined,
      decodeSessionListResponse,
    );
  },

  sendMessage(id: string, text: string, effort?: string): Promise<void> {
    const body: SessionSteerBody = { text, ...(effort ? { effort } : {}) };
    return reqAccepted(`/api/sessions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  answerQuestion(
    id: string,
    questionId: string,
    answers: SessionQuestionAnswers,
    opId?: string,
  ): Promise<void> {
    const body: SessionAnswerQuestionBody = { questionId, answers, ...(opId ? { opId } : {}) };
    return reqAccepted(`/api/sessions/${id}/answer`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  cancel(id: string, opId?: string): Promise<void> {
    const body = sessionOpIdBody(opId);
    return reqAccepted(`/api/sessions/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  listPresentations(id: string): Promise<{ presentations: ArtifactPresentation[] }> {
    return reqJson<{ presentations: ArtifactPresentation[] }>(
      `/api/sessions/${id}/artifacts/presentations`,
    );
  },

  getCapabilities(id: string): Promise<SessionCapabilitiesResponse> {
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
    const body: SessionOpIdBody = {};
    return reqAccepted(`/api/sessions/${id}/seat/request`, { method: 'POST', body: JSON.stringify(body) });
  },

  /** Driver-only. */
  grantSeat(id: string, userId: string): Promise<void> {
    const body: SessionSeatGrantBody = { userId };
    return reqAccepted(`/api/sessions/${id}/seat/grant`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** Rejects with ApiError(409, 'seat_held') while the driver is watching. */
  takeSeat(id: string): Promise<void> {
    const body: SessionOpIdBody = {};
    return reqAccepted(`/api/sessions/${id}/seat/take`, { method: 'POST', body: JSON.stringify(body) });
  },

  // ---- suggestion queue (Phase 2) ----

  /** A watcher proposes a steer the driver later sends or dismisses. */
  createSuggestion(id: string, text: string, opId?: string): Promise<void> {
    const body: SessionSuggestionCreateBody = { text, ...(opId ? { opId } : {}) };
    return reqAccepted(`/api/sessions/${id}/suggestions`, {
      method: 'POST',
      body: JSON.stringify(body),
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
    const body: SessionSuggestionResolveBody = { action, ...opts, ...(opId ? { opId } : {}) };
    return reqAccepted(`/api/sessions/${id}/suggestions/${suggestionId}/resolve`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  // ---- HITL answer proposals (Phase 2) ----

  /** A watcher proposes an answer to the pending question. */
  proposeAnswer(
    id: string,
    questionId: string,
    answers: SessionQuestionAnswers,
    opId?: string,
  ): Promise<void> {
    const body: SessionAnswerQuestionBody = { questionId, answers, ...(opId ? { opId } : {}) };
    return reqAccepted(`/api/sessions/${id}/question-proposals`, {
      method: 'POST',
      body: JSON.stringify(body),
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
    const body: SessionAnswerProposalResolveBody = { action, ...opts, ...(opId ? { opId } : {}) };
    return reqAccepted(`/api/sessions/${id}/question-proposals/${proposalId}/resolve`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** Cookie-authed SSE of Centaur frames, resumable via after_event_id. */
  openStream(
    sessionId: string,
    afterEventId: number,
    cb: SessionStreamCallbacks,
  ): SessionStreamHandle {
    const es = new EventSource(
      withDesktopToken(`/api/sessions/${sessionId}/stream?after_event_id=${afterEventId}`),
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
