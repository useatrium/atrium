// HTTP API client. Parameterized so the web app can use same-origin paths +
// the session cookie, while native clients pass an absolute server origin and
// a bearer token (React Native cookie handling is unreliable).

import type { CallJoin } from './calls';
import type { UserPrefs } from './prefs';
import type { SyncResponse } from './sync';
import type { SessionListItem, SessionWire } from './sessions';
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
  kind?: 'public' | 'private' | 'dm' | 'gdm';
  /** DM/GDM channels only: members. */
  members?: UserRef[];
  /** Private channels only: member count without full member list. */
  memberCount?: number;
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
  email: boolean;
  google: boolean;
  calls: boolean;
}

export type ProviderCredentialProvider = 'claude-code' | 'codex';

export interface ProviderCredentialStatus {
  provider: ProviderCredentialProvider;
  connected: boolean;
  status: 'connected' | 'needs_auth';
  lastValidatedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export type Api = ReturnType<typeof createApi>;

export interface ListSessionsOptions {
  status?: 'running' | 'recent' | 'all';
  limit?: number;
}

export type ReactionAction = 'add' | 'remove';
export type ReactionResponse = { event: WireEvent } | { event: null; applied: false };
export interface OpOptions {
  opId?: string;
}

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
    /** `prefs` is absent on servers that predate the user-prefs migration. */
    me: () => req<{ user: UserRef; prefs?: UserPrefs }>('/auth/me'),
    providerCredentials: () =>
      req<{ providers: ProviderCredentialStatus[] }>('/api/me/provider-credentials'),
    connectClaudeCode: (token: string) =>
      req<{ provider: ProviderCredentialStatus }>('/api/me/provider-credentials/claude-code', {
        method: 'PUT',
        body: JSON.stringify({ token }),
      }),
    connectCodex: (authJson: string) =>
      req<{ provider: ProviderCredentialStatus }>('/api/me/provider-credentials/codex', {
        method: 'PUT',
        body: JSON.stringify({ authJson }),
      }),
    disconnectClaudeCode: () =>
      req<{ ok: true }>('/api/me/provider-credentials/claude-code', {
        method: 'DELETE',
      }),
    disconnectCodex: () =>
      req<{ ok: true }>('/api/me/provider-credentials/codex', {
        method: 'DELETE',
      }),
    /** Partial update; server merges over stored prefs and fans the full
     * normalized result out to all of the user's sockets via {type:'prefs'}. */
    patchPrefs: (patch: Partial<UserPrefs>, op: OpOptions = {}) =>
      req<{ prefs: UserPrefs }>('/api/me/prefs', {
        method: 'PATCH',
        body: JSON.stringify({ ...patch, ...(op.opId ? { opId: op.opId } : {}) }),
      }),
    setDraft: (draftKey: string, text: string, op: OpOptions = {}) =>
      req<{ ok: true }>(`/api/me/drafts/${encodeURIComponent(draftKey)}`, {
        method: 'PUT',
        body: JSON.stringify({ text, ...(op.opId ? { opId: op.opId } : {}) }),
      }),
    logout: () => req<{ ok: true }>('/auth/logout', { method: 'POST', body: '{}' }),
    workspaces: () => req<{ workspaces: Workspace[] }>('/api/workspaces'),
    channels: () => req<{ channels: Channel[] }>('/api/channels'),
    sync: (after: number, opts: { limit?: number } = {}) => {
      const q = new URLSearchParams({ after: String(after) });
      if (opts.limit !== undefined) q.set('limit', String(opts.limit));
      return req<SyncResponse>(`/api/sync?${q.toString()}`);
    },
    createChannel: (name: string, opts: { private?: boolean } = {}) =>
      req<{ channel: Channel }>('/api/channels', {
        method: 'POST',
        body: JSON.stringify({ name, private: opts.private === true }),
      }),
    channelMembers: (channelId: string) =>
      req<{ members: UserRef[] }>(`/api/channels/${channelId}/members`),
    addChannelMember: (channelId: string, userId: string, op: OpOptions = {}) =>
      req<{ member: UserRef }>(`/api/channels/${channelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId, ...(op.opId ? { opId: op.opId } : {}) }),
      }),
    leaveChannelMembership: (channelId: string, op: OpOptions = {}) =>
      req<{ ok: true }>(`/api/channels/${channelId}/members/me`, {
        method: 'DELETE',
        body: JSON.stringify(op.opId ? { opId: op.opId } : {}),
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
    markRead: (channelId: string, lastReadEventId: number, op: OpOptions = {}) =>
      req<{ lastReadEventId: number }>(`/api/channels/${channelId}/read`, {
        method: 'POST',
        body: JSON.stringify({ lastReadEventId, ...(op.opId ? { opId: op.opId } : {}) }),
      }),
    setMute: (channelId: string, muted: boolean, op: OpOptions = {}) =>
      req<{ muted: boolean }>(`/api/channels/${channelId}/mute`, {
        method: 'POST',
        body: JSON.stringify({ muted, ...(op.opId ? { opId: op.opId } : {}) }),
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
      /** Present for voice messages: the audio is `attachments[0]`. The server
       * stores this on `payload.voice` and enqueues async transcription. */
      voice?: { durationMs: number; waveform?: number[] };
      opId?: string;
    }) =>
      req<{ event: WireEvent }>('/api/messages', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    /** Re-run speech-to-text for a voice message whose transcript `failed`.
     * The server resets the job to `pending` and broadcasts a `voice.transcribed`
     * `pending` event; the eventual `done`/`failed` arrives over the socket. */
    retryTranscript: (fileId: string) =>
      req<{ event: WireEvent }>(`/api/voice/${encodeURIComponent(fileId)}/retranscribe`, {
        method: 'POST',
      }),
    createAgentSession: (body: {
      channelId: string;
      task: string;
      harness?: string;
      /** Spawn-dialog git metadata (optional). */
      repo?: string;
      branch?: string;
      threadRootEventId?: number;
      /** Optimistic id echoed on session.spawned for lost-response reconcile. */
      clientSpawnId?: string;
      opId?: string;
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
      contentHash?: string;
    }) =>
      req<{ fileId: string; uploadUrl: string; existing?: boolean }>('/api/uploads', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    refreshUpload: (fileId: string) =>
      req<{ uploadUrl: string }>(`/api/uploads/${fileId}/refresh`, {
        method: 'POST',
        body: '{}',
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
    editMessage: (eventId: number, text: string, op: OpOptions = {}) =>
      req<{ event: WireEvent }>(`/api/messages/${eventId}`, {
        method: 'PATCH',
        body: JSON.stringify({ text, ...(op.opId ? { opId: op.opId } : {}) }),
      }),
    deleteMessage: (eventId: number, op: OpOptions = {}) =>
      req<{ event: WireEvent }>(`/api/messages/${eventId}`, {
        method: 'DELETE',
        body: JSON.stringify(op.opId ? { opId: op.opId } : {}),
      }),
    setReaction: (eventId: number, emoji: string, action: ReactionAction, op: OpOptions = {}) =>
      req<ReactionResponse>(`/api/messages/${eventId}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji, action, ...(op.opId ? { opId: op.opId } : {}) }),
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
    createDmWithUsers: (userIds: string[]) =>
      req<{ channel: Channel }>('/api/dms', {
        method: 'POST',
        body: JSON.stringify({ userIds }),
      }),
    /** Start a call in a channel: creates the call, mints the caller's LiveKit
     * token, and rings the other channel members over the WS hub. */
    startCall: (channelId: string, op: OpOptions = {}) =>
      req<CallJoin>('/api/calls', {
        method: 'POST',
        body: JSON.stringify({ channelId, ...(op.opId ? { opId: op.opId } : {}) }),
      }),
    /** Accept a ringing call: mints this user's token + marks them joined. */
    acceptCall: (callId: string) =>
      req<CallJoin>(`/api/calls/${callId}/accept`, { method: 'POST', body: '{}' }),
    declineCall: (callId: string) =>
      req<{ ok: true }>(`/api/calls/${callId}/decline`, { method: 'POST', body: '{}' }),
    /** Leave a call; the server ends it when the last participant leaves. */
    leaveCall: (callId: string) =>
      req<{ ok: true }>(`/api/calls/${callId}/leave`, { method: 'POST', body: '{}' }),
    /** `kind` distinguishes the Expo notification token ('expo', default) from
     * the VoIP/PushKit (iOS) or FCM-data (Android) call-ringing token ('voip'). */
    registerPush: (body: { token: string; platform: 'ios' | 'android'; kind?: 'expo' | 'voip' }) =>
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
    listSessions: (opts: ListSessionsOptions = {}) => {
      const q = new URLSearchParams();
      if (opts.status) q.set('status', opts.status);
      if (opts.limit !== undefined) q.set('limit', String(opts.limit));
      const qs = q.toString();
      return req<{ sessions: SessionListItem[] }>(`/api/sessions${qs ? `?${qs}` : ''}`);
    },
    steerSession: (id: string, text: string, op: OpOptions = {}) =>
      req<{ ok: true }>(`/api/sessions/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text, ...(op.opId ? { opId: op.opId } : {}) }),
      }),
    answerSessionQuestion: (
      id: string,
      questionId: string,
      answers: Record<string, { answers: string[] }>,
      op: OpOptions = {},
    ) =>
      req<{ ok: true }>(`/api/sessions/${id}/answer`, {
        method: 'POST',
        body: JSON.stringify({ questionId, answers, ...(op.opId ? { opId: op.opId } : {}) }),
      }),
    cancelSession: (id: string, op: OpOptions = {}) =>
      req<{ ok: true }>(`/api/sessions/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify(op.opId ? { opId: op.opId } : {}),
      }),
  };
}
