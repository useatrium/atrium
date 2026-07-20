// Configured API instance for the web client. In the browser: same-origin paths
// + the httpOnly session cookie (no bearer token). In the Electron desktop
// shell: an absolute server origin + a bearer token (the mobile model).

import { createApi } from '@atrium/surface-client';
import { desktopApiOptions } from './desktop';

export { ApiError } from '@atrium/surface-client';
export type {
  AuthMethods,
  Workspace,
  Channel,
  AgentProfile,
  AgentProfileProposal,
  AgentProfileProvider,
  AgentProfileVersion,
  ConnectionIdentity,
  ConnectionProvider,
  ConnectionStatus,
  CredentialStoreItem,
  CredentialStoreStatus,
  NormalizedEntry,
  ProviderCredentialProvider,
  ProviderCredentialStatus,
} from '@atrium/surface-client';

const apiOptions = desktopApiOptions();
const baseApi = createApi(apiOptions);
const base = (apiOptions?.baseUrl ?? '').replace(/\/+$/, '');

export const PROVIDER_CREDENTIALS_REFRESH_SENTINEL = '__atrium_provider_credentials_refresh_after_oauth__';

export interface CodexDeviceStartResponse {
  userCode: string;
  verificationUri: string;
  pendingId: string;
  intervalSec?: number;
}

export type CodexDevicePollResponse =
  | { status: 'pending'; message?: string }
  | { status: 'finalizing' }
  | { status: 'connected'; message?: string }
  | { status: 'error'; message?: string }
  | { status: 'expired'; message?: string };

export interface ClaudeCodeOAuthStartResponse {
  authorizeUrl: string;
  pendingId: string;
}

export type ClaudeCodeOAuthExchangeResponse =
  | { status: 'connected'; message?: string }
  | { status: 'error'; message?: string }
  | { status: 'expired'; message?: string };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = apiOptions?.getToken ? await apiOptions.getToken() : null;
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
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function refreshProviderCredential(provider: 'claude-code' | 'codex') {
  const { providers } = await baseApi.providerCredentials();
  const next = providers.find((candidate) => candidate.provider === provider);
  if (!next) throw new Error(`Could not refresh ${provider} credential status`);
  return { provider: next };
}

export function startCodexDeviceFlow() {
  return req<CodexDeviceStartResponse>('/api/me/provider-credentials/codex/device/start', {
    method: 'POST',
  });
}

export function pollCodexDeviceFlow(pendingId: string) {
  return req<CodexDevicePollResponse>('/api/me/provider-credentials/codex/device/poll', {
    method: 'POST',
    body: JSON.stringify({ pendingId }),
  });
}

export function startClaudeCodeOAuth() {
  return req<ClaudeCodeOAuthStartResponse>('/api/me/provider-credentials/claude-code/oauth/start', {
    method: 'POST',
  });
}

export function exchangeClaudeCodeOAuth(pendingId: string, code: string) {
  return req<ClaudeCodeOAuthExchangeResponse>('/api/me/provider-credentials/claude-code/oauth/exchange', {
    method: 'POST',
    body: JSON.stringify({ pendingId, code }),
  });
}

export const api = {
  ...baseApi,
  connectClaudeCode: (token: string) =>
    token === PROVIDER_CREDENTIALS_REFRESH_SENTINEL
      ? refreshProviderCredential('claude-code')
      : baseApi.connectClaudeCode(token),
  connectCodex: (authJson: string) =>
    authJson === PROVIDER_CREDENTIALS_REFRESH_SENTINEL
      ? refreshProviderCredential('codex')
      : baseApi.connectCodex(authJson),
};
