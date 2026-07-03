// HTTP API client. Parameterized so the web app can use same-origin paths +
// the session cookie, while native clients pass an absolute server origin and
// a bearer token (React Native cookie handling is unreliable).

import type { CallJoin } from './calls';
import type { UserPrefs } from './prefs';
import type { SyncResponse } from './sync';
import type { SessionListItem, SessionRepoSpec, SessionWire } from './sessions';
import type { UserRef, WireEvent } from './timeline';
import type {
  HubFileConflict,
  HubFileDeleteResponse,
  HubFileLabelResponse,
  HubFileListQuery,
  HubFileListResult,
  HubFileRenameResponse,
  HubFileResolveChoice,
  HubFileRestoreResponse,
  HubFileRevertResponse,
  HubFileSaveResult,
  HubFileStarResponse,
  HubFileVersionsResponse,
} from './files-hub';
import type {
  AgentProfile,
  AgentProfileProposal,
  AgentProfileProposalPayload,
  AgentProfileProvider,
  AgentProfileVersion,
} from './agentProfiles';

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
  /** True when at least one unread message explicitly mentioned this user. */
  mentionedSinceRead?: boolean;
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

export type ConnectionProvider = 'github' | (string & {});
export type ConnectionTokenKind = 'pat' | 'app_installation' | 'app_user' | 'public_read' | (string & {});

export interface ConnectionStatus {
  id: string;
  provider: ConnectionProvider;
  workspaceId: string;
  connected: boolean;
  status: 'connected' | 'needs_auth' | 'public_read' | 'unavailable';
  tokenKind: ConnectionTokenKind | null;
  accountLogin: string | null;
  accountLabel: string | null;
  scopes: string[];
  capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
  identities: ConnectionIdentity[];
  lastValidatedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface ConnectionIdentity {
  id: string;
  provider: ConnectionProvider;
  workspaceId: string;
  active: boolean;
  connected: boolean;
  status: 'connected' | 'needs_auth';
  tokenKind: Exclude<ConnectionTokenKind, 'public_read'>;
  accountLogin: string | null;
  accountLabel: string | null;
  scopes: string[];
  capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
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
export interface AgentAttachmentRef {
  artifactId?: string;
  versionSeq?: number;
  path?: string;
}
export interface EntryComment {
  id: number;
  author?: UserRef;
  text: string;
  createdAt: string;
  deleted?: boolean;
}
export interface EntryAnnotations {
  comments: WireEvent[];
  reactions: { emoji: string; userIds: string[] }[];
}
export type NormalizedEntryTargetType = 'event' | 'record' | 'artifact';
export interface NormalizedEntry {
  handle: string;
  kind: string;
  actor: string | null;
  /** Human-readable actor (display name for user actors); null when unknown. */
  actorLabel: string | null;
  text: string;
  meta: Record<string, unknown>;
  targetType: NormalizedEntryTargetType;
  sourceRefs: string[];
  tombstoned: boolean;
  location: {
    workspaceId: string;
    channelId: string | null;
    channelName: string | null;
    sessionId: string | null;
    sessionTitle: string | null;
  };
}

export interface WebPushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface RegisterPushBody {
  token: string;
  platform: 'ios' | 'android' | 'web';
  kind?: 'expo' | 'voip' | 'webpush';
  subscription?: WebPushSubscription;
}

export type ActivityItem = {
  eventId: string;
  kind: 'mention' | 'dm' | 'agent_question' | 'session_completed';
  channelId: string;
  channelName: string;
  actorId: string | null;
  actorName: string | null;
  snippet: string;
  createdAt: string;
};

export function createApi(opts: ApiOptions = {}) {
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '');

  function filesHubQuery(query?: HubFileListQuery): string {
    if (!query) return '';
    const params = new URLSearchParams();
    if (query.origin && query.origin.length > 0) params.set('origin', query.origin.join(','));
    if (query.mediaKind && query.mediaKind.length > 0) params.set('mediaKind', query.mediaKind.join(','));
    if (query.channelId) params.set('channelId', query.channelId);
    if (query.sessionId) params.set('sessionId', query.sessionId);
    if (query.label) params.set('label', query.label);
    if (query.starred !== undefined) params.set('starred', String(query.starred));
    if (query.q) params.set('q', query.q);
    if (query.includeDeleted !== undefined) params.set('includeDeleted', String(query.includeDeleted));
    if (query.includeScratch !== undefined) params.set('includeScratch', String(query.includeScratch));
    if (query.sort) params.set('sort', query.sort);
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }

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
    providerCredentials: () => req<{ providers: ProviderCredentialStatus[] }>('/api/me/provider-credentials'),
    connections: () => req<{ connections: ConnectionStatus[] }>('/api/me/connections'),
    connectConnection: (provider: ConnectionProvider, body: Record<string, unknown> = {}) =>
      req<{ connection: ConnectionStatus; authorizeUrl?: string }>(
        `/api/me/connections/${encodeURIComponent(provider)}`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      ),
    disconnectConnection: (provider: ConnectionProvider, workspaceId?: string) => {
      const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
      return req<{ connection: ConnectionStatus }>(`/api/me/connections/${encodeURIComponent(provider)}${query}`, {
        method: 'DELETE',
      });
    },
    connectGitHub: (body: Record<string, unknown> = {}) =>
      req<{ connection: ConnectionStatus; authorizeUrl?: string }>('/api/me/connections/github', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    activateGitHubIdentity: (body: { workspaceId?: string; identityId: string }) =>
      req<{ connection: ConnectionStatus }>('/api/me/connections/github/active', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    disconnectGitHub: (workspaceId?: string) => {
      const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
      return req<{ connection: ConnectionStatus }>(`/api/me/connections/github${query}`, {
        method: 'DELETE',
      });
    },
    agentProfiles: () => req<{ profiles: AgentProfile[] }>('/api/me/agent-profiles'),
    createAgentProfile: (body: { provider: AgentProfileProvider; name: string }) =>
      req<{ profile: AgentProfile }>('/api/me/agent-profiles', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    createAgentProfileVersion: (profileId: string, proposal: AgentProfileProposalPayload) =>
      req<{ version: AgentProfileVersion }>(`/api/me/agent-profiles/${profileId}/versions`, {
        method: 'POST',
        body: JSON.stringify(proposal),
      }),
    importLocalAgentProfile: (body: { provider: AgentProfileProvider; proposal: AgentProfileProposalPayload }) =>
      req<{ proposal: AgentProfileProposal }>('/api/me/agent-profiles/import-local', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    sessionProfileProposals: (sessionId: string) =>
      req<{ proposals: AgentProfileProposal[] }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/profile-change-proposals`,
      ),
    discardSessionProfileProposal: (sessionId: string, proposalId: string) =>
      req<{ proposal: AgentProfileProposal }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/profile-change-proposals/${encodeURIComponent(proposalId)}/discard`,
        { method: 'POST', body: '{}' },
      ),
    applySessionProfileProposalToLineage: (sessionId: string, proposalId: string) =>
      req<{ proposal: AgentProfileProposal }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/profile-change-proposals/${encodeURIComponent(proposalId)}/apply-lineage`,
        { method: 'POST', body: '{}' },
      ),
    saveSessionProfileProposalToCurrent: (
      sessionId: string,
      proposalId: string,
      body: { profileId?: string; name?: string } = {},
    ) =>
      req<{ proposal: AgentProfileProposal; profile: AgentProfile; version: AgentProfileVersion }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/profile-change-proposals/${encodeURIComponent(proposalId)}/save-current-profile`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    saveSessionProfileProposalAsNew: (sessionId: string, proposalId: string, body: { name: string }) =>
      req<{ proposal: AgentProfileProposal; profile: AgentProfile; version: AgentProfileVersion }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/profile-change-proposals/${encodeURIComponent(proposalId)}/save-new-profile`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
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
    channelMembers: (channelId: string) => req<{ members: UserRef[] }>(`/api/channels/${channelId}/members`),
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
    messages: (channelId: string, opts: { beforeId?: number; afterId?: number; limit?: number } = {}) => {
      const q = new URLSearchParams();
      if (opts.beforeId !== undefined) q.set('before_id', String(opts.beforeId));
      if (opts.afterId !== undefined) q.set('after_id', String(opts.afterId));
      if (opts.limit !== undefined) q.set('limit', String(opts.limit));
      const qs = q.toString();
      return req<{ events: WireEvent[]; hasMore: boolean }>(`/api/channels/${channelId}/messages${qs ? `?${qs}` : ''}`);
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
    getActivity: (cursor?: string) => {
      const q = new URLSearchParams();
      if (cursor !== undefined) q.set('cursor', cursor);
      const qs = q.toString();
      return req<{ items: ActivityItem[]; nextCursor: string | null }>(`/api/activity${qs ? `?${qs}` : ''}`);
    },
    thread: (rootEventId: number) => req<{ events: WireEvent[] }>(`/api/threads/${rootEventId}/messages`),
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
      repos?: SessionRepoSpec[];
      githubIdentityMode?: 'automatic' | 'app_installation' | 'app_user' | 'pat';
      githubIdentityId?: string;
      agentProfileId?: string;
      agentProfileVersionId?: string;
      threadRootEventId?: number;
      /** Optimistic id echoed on session.spawned for lost-response reconcile. */
      clientSpawnId?: string;
      /** Uploaded file ids to attach to the initial agent message. */
      attachments?: string[];
      /** Existing artifact refs to attach when the UI can pick them. */
      attachmentRefs?: AgentAttachmentRef[];
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
    fileSignedUrl: (fileId: string) => req<{ url: string; expiresAt: string }>(`/api/files/${fileId}/url`),
    // === files-hub (P1) ===
    listWorkspaceFiles: (workspaceId: string, query?: HubFileListQuery) =>
      req<HubFileListResult>(`/api/workspaces/${encodeURIComponent(workspaceId)}/files${filesHubQuery(query)}`),
    listChannelFiles: (channelId: string, query?: HubFileListQuery) =>
      req<HubFileListResult>(`/api/channels/${encodeURIComponent(channelId)}/files${filesHubQuery(query)}`),
    starFile: (id: string) =>
      req<HubFileStarResponse>(`/api/files/${encodeURIComponent(id)}/star`, {
        method: 'POST',
        body: '{}',
      }),
    unstarFile: (id: string) =>
      req<HubFileStarResponse>(`/api/files/${encodeURIComponent(id)}/star`, {
        method: 'DELETE',
      }),
    addFileLabel: (id: string, label: string) =>
      req<HubFileLabelResponse>(`/api/files/${encodeURIComponent(id)}/labels`, {
        method: 'POST',
        body: JSON.stringify({ label }),
      }),
    removeFileLabel: (id: string, label: string) =>
      req<HubFileLabelResponse>(`/api/files/${encodeURIComponent(id)}/labels/${encodeURIComponent(label)}`, {
        method: 'DELETE',
      }),
    renameFile: (id: string, name: string) =>
      req<HubFileRenameResponse>(`/api/files/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
    deleteFile: (id: string) =>
      req<HubFileDeleteResponse>(`/api/files/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    restoreFile: (id: string) =>
      req<HubFileRestoreResponse>(`/api/files/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
        body: '{}',
      }),
    fileContentUrl: (artifactId: string, atSeq?: number) =>
      `${base}/api/files/artifact/${encodeURIComponent(artifactId)}/content${atSeq != null ? `?at=${atSeq}` : ''}`,
    /** Embed-only HTML/app preview URL. Server returns 403 on a top-level document
     * navigation, so callers must fetch it with `sec-fetch-dest: iframe` (or embed
     * it in an iframe) rather than navigating a WebView straight to it. */
    filePreviewUrl: (artifactId: string, renderer?: string) =>
      `${base}/api/files/${encodeURIComponent(artifactId)}/preview${
        renderer ? `?renderer=${encodeURIComponent(renderer)}` : ''
      }`,
    // === files-hub version history + text edit + conflict (web + mobile parity) ===
    listFileVersions: (id: string) => req<HubFileVersionsResponse>(`/api/files/${encodeURIComponent(id)}/versions`),
    revertFileVersion: (id: string, seq: number) =>
      req<HubFileRevertResponse>(`/api/files/${encodeURIComponent(id)}/revert`, {
        method: 'POST',
        body: JSON.stringify({ seq }),
      }),
    saveTextFile: (id: string, text: string, baseSeq: number, mime = 'text/plain') =>
      req<HubFileSaveResult>(`/api/files/${encodeURIComponent(id)}/content`, {
        method: 'PUT',
        headers: { 'content-type': mime, 'x-artifact-base-seq': String(baseSeq) },
        body: text,
      }),
    loadFileConflict: (id: string) => req<HubFileConflict>(`/api/files/${encodeURIComponent(id)}/conflict`),
    resolveFileConflict: (id: string, conflict: HubFileConflict, choice: HubFileResolveChoice, mime = 'text/plain') => {
      // Resolved bytes = the chosen side's text (or the hand-merged text). A side
      // with a null sha is the "deleted" side of a delete-vs-edit conflict → stay deleted.
      const text =
        choice.kind === 'left' ? conflict.left.text : choice.kind === 'right' ? conflict.right.text : choice.text;
      const stayDeleted =
        (choice.kind === 'left' && conflict.left.sha === null) ||
        (choice.kind === 'right' && conflict.right.sha === null);
      return req<HubFileSaveResult>(`/api/files/${encodeURIComponent(id)}/resolve`, {
        method: 'POST',
        headers: {
          'content-type': mime,
          'x-artifact-base-seq': String(conflict.conflictSeq),
          ...(stayDeleted ? { 'x-artifact-delete': 'true' } : {}),
        },
        body: text,
      });
    },
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
    // === entry-annotation client additions ===
    getEntryAnnotations: (handle: string) =>
      req<EntryAnnotations>(`/api/entries/${encodeURIComponent(handle)}/annotations`),
    postEntryComment: (handle: string, text: string, op: OpOptions = {}) =>
      req<{ event: WireEvent }>(`/api/entries/${encodeURIComponent(handle)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ text, ...(op.opId ? { opId: op.opId } : {}) }),
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
    acceptCall: (callId: string) => req<CallJoin>(`/api/calls/${callId}/accept`, { method: 'POST', body: '{}' }),
    declineCall: (callId: string) => req<{ ok: true }>(`/api/calls/${callId}/decline`, { method: 'POST', body: '{}' }),
    /** Leave a call; the server ends it when the last participant leaves. */
    leaveCall: (callId: string) => req<{ ok: true }>(`/api/calls/${callId}/leave`, { method: 'POST', body: '{}' }),
    /** `kind` distinguishes Expo message pushes, VoIP call-ringing tokens,
     * and browser PushSubscription rows. */
    registerPush: (body: RegisterPushBody) =>
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
    steerSession: (
      id: string,
      text: string,
      op: OpOptions = {},
      opts: {
        effort?: string;
        attachments?: string[];
        attachmentRefs?: AgentAttachmentRef[];
      } = {},
    ) =>
      req<{ ok: true }>(`/api/sessions/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          text,
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
          ...(opts.attachmentRefs && opts.attachmentRefs.length > 0 ? { attachmentRefs: opts.attachmentRefs } : {}),
          ...(op.opId ? { opId: op.opId } : {}),
        }),
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
    stopTurn: (id: string, op: OpOptions = {}) =>
      req<{ ok: true }>(`/api/sessions/${id}/stop-turn`, {
        method: 'POST',
        body: JSON.stringify(op.opId ? { opId: op.opId } : {}),
      }),
    // Control loop (collaborative steering): seat hand-off, the suggestion queue,
    // and answer proposals. Endpoints already exist server-side (web uses them);
    // these expose them on the shared client so mobile can reach them too.
    requestSeat: (id: string, op: OpOptions = {}) =>
      req<{ ok: true }>(`/api/sessions/${id}/seat/request`, {
        method: 'POST',
        body: JSON.stringify(op.opId ? { opId: op.opId } : {}),
      }),
    grantSeat: (id: string, userId: string, op: OpOptions = {}) =>
      req<{ ok: true }>(`/api/sessions/${id}/seat/grant`, {
        method: 'POST',
        body: JSON.stringify({ userId, ...(op.opId ? { opId: op.opId } : {}) }),
      }),
    takeSeat: (id: string, op: OpOptions = {}) =>
      req<{ ok: true }>(`/api/sessions/${id}/seat/take`, {
        method: 'POST',
        body: JSON.stringify(op.opId ? { opId: op.opId } : {}),
      }),
    createSuggestion: (id: string, text: string, op: OpOptions = {}) =>
      req<{ ok: true }>(`/api/sessions/${id}/suggestions`, {
        method: 'POST',
        body: JSON.stringify({ text, ...(op.opId ? { opId: op.opId } : {}) }),
      }),
    resolveSuggestion: (
      id: string,
      suggestionId: string,
      action: 'send' | 'dismiss',
      opts: { text?: string; note?: string } = {},
      op: OpOptions = {},
    ) =>
      req<{ ok: true }>(`/api/sessions/${id}/suggestions/${suggestionId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ action, ...opts, ...(op.opId ? { opId: op.opId } : {}) }),
      }),
    proposeAnswer: (
      id: string,
      questionId: string,
      answers: Record<string, { answers: string[] }>,
      op: OpOptions = {},
    ) =>
      req<{ ok: true }>(`/api/sessions/${id}/question-proposals`, {
        method: 'POST',
        body: JSON.stringify({ questionId, answers, ...(op.opId ? { opId: op.opId } : {}) }),
      }),
    resolveAnswerProposal: (
      id: string,
      proposalId: string,
      action: 'submit' | 'dismiss',
      opts: { note?: string } = {},
      op: OpOptions = {},
    ) =>
      req<{ ok: true }>(`/api/sessions/${id}/question-proposals/${proposalId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ action, ...opts, ...(op.opId ? { opId: op.opId } : {}) }),
      }),
    // === session-search additions (#72) ===
    searchSessions: (opts: { q: string; kinds?: string[]; full?: boolean; limit?: number }) => {
      const q = new URLSearchParams({ q: opts.q, full: opts.full ? '1' : '0' });
      if (opts.kinds && opts.kinds.length > 0) q.set('kinds', opts.kinds.join(','));
      if (opts.limit !== undefined) q.set('limit', String(opts.limit));
      return req<{
        results: {
          sessionId: string;
          sessionTitle: string | null;
          channelId: string | null;
          channelName: string | null;
          eventId: number;
          seq: number;
          kind:
            | 'message'
            | 'command'
            | 'file_change'
            | 'artifact'
            | 'question'
            | 'reasoning'
            | 'plan'
            | 'tool_call'
            | 'usage'
            | 'status';
          actor: 'user' | 'agent' | 'system';
          driver: 'claude' | 'codex' | null;
          viewTier: 'lean' | 'full';
          excerpt: string;
          ts: string;
        }[];
      }>(`/api/search/sessions?${q.toString()}`);
    },
    // === mk703-extract additions ===
    extractEntry: (handle: string) =>
      req<{ artifactId: string; path: string; seq: number; workspaceId: string }>(
        `/api/entries/${encodeURIComponent(handle)}/extract`,
        { method: 'POST', body: '{}' },
      ),
    // === end mk703-extract additions ===
    // === mk703-feedback additions ===
    sendArtifactFeedback: (
      artifactId: string,
      body: {
        content: string;
        baseSeq: number;
        sessionId: string;
        note?: string;
        intent?: 'response' | 'revise';
        opId?: string;
      },
    ) =>
      req<{ seq: number; status: 'normal' | 'conflict'; steered: true }>(
        `/api/files/${encodeURIComponent(artifactId)}/feedback`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      ),
    // === end mk703-feedback additions ===
    // === mk708-route additions ===
    resolveEntry: (handle: string) => req<NormalizedEntry>(`/api/entries/${encodeURIComponent(handle)}`),
    // === end mk708-route additions ===
  };
}
