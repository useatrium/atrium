// HTTP API client. Parameterized so the web app can use same-origin paths +
// the session cookie, while native clients pass an absolute server origin and
// a bearer token (React Native cookie handling is unreliable).

import type { SessionWire } from './sessions';
import type { UserRef, WireEvent } from './timeline';

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
}

export interface Channel {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  lastReadEventId?: number;
  latestEventId?: number;
  muted?: boolean;
  /** Absent on older payloads — treat as 'public'. */
  kind?: 'public' | 'dm';
  /** DM channels only: both members. */
  members?: UserRef[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiOptions {
  /** Absolute server origin, e.g. "http://192.168.1.20:3001". Default: same origin. */
  baseUrl?: string;
  /** Bearer token supplier for native clients; web relies on the session cookie. */
  getToken?: () => string | null | Promise<string | null>;
}

export interface AuthMethods {
  open: boolean;
  email: true;
  google: boolean;
}

export type Api = ReturnType<typeof createApi>;

export function createApi(opts: ApiOptions = {}) {
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '');

  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const token = opts.getToken ? await opts.getToken() : null;
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
    return res.json() as Promise<T>;
  }

  return {
    authMethods: () => req<AuthMethods>('/auth/methods'),
    requestEmailCode: (email: string) =>
      req<{ ok: true; devCode?: string }>('/auth/email/request', {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),
    verifyEmailCode: (email: string, code: string) =>
      req<{ user: UserRef; token?: string }>('/auth/email/verify', {
        method: 'POST',
        body: JSON.stringify({ email, code }),
      }),
    login: (handle: string, displayName: string) =>
      req<{ user: UserRef; token?: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ handle, displayName }),
      }),
    me: () => req<{ user: UserRef }>('/auth/me'),
    logout: () => req<{ ok: true }>('/auth/logout', { method: 'POST', body: '{}' }),
    workspaces: () => req<{ workspaces: Workspace[] }>('/api/workspaces'),
    channels: () => req<{ channels: Channel[] }>('/api/channels'),
    createChannel: (name: string) =>
      req<{ channel: Channel }>('/api/channels', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    messages: (
      channelId: string,
      opts: { beforeId?: number; afterId?: number; limit?: number } = {},
    ) => {
      const q = new URLSearchParams();
      if (opts.beforeId !== undefined) q.set('before_id', String(opts.beforeId));
      if (opts.afterId !== undefined) q.set('after_id', String(opts.afterId));
      if (opts.limit !== undefined) q.set('limit', String(opts.limit));
      const qs = q.toString();
      return req<{ events: WireEvent[]; hasMore: boolean }>(
        `/api/channels/${channelId}/messages${qs ? `?${qs}` : ''}`,
      );
    },
    markRead: (channelId: string, lastReadEventId: number) =>
      req<{ lastReadEventId: number }>(`/api/channels/${channelId}/read`, {
        method: 'POST',
        body: JSON.stringify({ lastReadEventId }),
      }),
    setMute: (channelId: string, muted: boolean) =>
      req<{ muted: boolean }>(`/api/channels/${channelId}/mute`, {
        method: 'POST',
        body: JSON.stringify({ muted }),
      }),
    thread: (rootEventId: number) =>
      req<{ events: WireEvent[] }>(`/api/threads/${rootEventId}/messages`),
    postMessage: (body: {
      channelId: string;
      text: string;
      clientMsgId: string;
      threadRootEventId?: number;
      /** Uploaded file ids to attach. */
      attachments?: string[];
    }) =>
      req<{ event: WireEvent }>('/api/messages', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    createAgentSession: (body: {
      channelId: string;
      task: string;
      harness?: string;
      threadRootEventId?: number;
      /** Optimistic id echoed on session.spawned for lost-response reconcile. */
      clientSpawnId?: string;
    }) =>
      req<{ session: SessionWire }>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    createUpload: (body: {
      filename: string;
      contentType: string;
      size: number;
      width?: number;
      height?: number;
    }) =>
      req<{ fileId: string; uploadUrl: string }>('/api/uploads', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    /** Authenticated URL for an attachment body (302 → presigned S3 GET). */
    fileUrl: (fileId: string) => `${base}/api/files/${fileId}`,
    /**
     * Mint a short-lived signed URL for opening a file outside an
     * authenticated context (external browser / share sheet). The returned
     * url is server-relative; prefix with the server origin on native.
     */
    fileSignedUrl: (fileId: string) =>
      req<{ url: string; expiresAt: string }>(`/api/files/${fileId}/url`),
    editMessage: (eventId: number, text: string) =>
      req<{ event: WireEvent }>(`/api/messages/${eventId}`, {
        method: 'PATCH',
        body: JSON.stringify({ text }),
      }),
    deleteMessage: (eventId: number) =>
      req<{ event: WireEvent }>(`/api/messages/${eventId}`, { method: 'DELETE' }),
    toggleReaction: (eventId: number, emoji: string) =>
      req<{ event: WireEvent }>(`/api/messages/${eventId}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      }),
    search: (q: string, limit = 8) =>
      req<{ results: { event: WireEvent; channelName: string }[] }>(
        `/api/search?q=${encodeURIComponent(q)}&limit=${limit}`,
      ),
    users: () => req<{ users: UserRef[] }>('/api/users'),
    createDm: (userId: string) =>
      req<{ channel: Channel }>('/api/dms', {
        method: 'POST',
        body: JSON.stringify({ userId }),
      }),
    registerPush: (body: { token: string; platform: 'ios' | 'android' }) =>
      req<{ ok: true }>('/api/push/register', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    unregisterPush: (token: string) =>
      req<{ ok: true }>('/api/push/unregister', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),
    getSession: (id: string) => req<{ session: SessionWire }>(`/api/sessions/${id}`),
    steerSession: (id: string, text: string) =>
      req<{ ok: true }>(`/api/sessions/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      }),
    cancelSession: (id: string) =>
      req<{ ok: true }>(`/api/sessions/${id}/cancel`, { method: 'POST', body: '{}' }),
  };
}
