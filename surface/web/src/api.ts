import type { UserRef, WireEvent } from './state';

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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
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
  return res.json() as Promise<T>;
}

export const api = {
  login: (handle: string, displayName: string) =>
    req<{ user: UserRef }>('/auth/login', {
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
};
