import { config } from './config.js';
import { convergeCodexBrokerGrant } from './codex-iron-control.js';
import type { IronControlAdminClient } from './iron-control.js';
import { type PendingOAuthStore, postForm } from './provider-oauth.js';

type JsonObject = Record<string, unknown>;

type CodexDeviceState = {
  deviceAuthId: string;
};

export async function startCodexDevice(
  deps: { pendingOAuth: PendingOAuthStore },
  userId: string,
): Promise<{ userCode: string; verificationUri: string; pendingId: string; intervalSec: number }> {
  const response = await postForm<unknown>(`${config.codexOauthIssuer}/api/accounts/deviceauth/usercode`, {
    client_id: config.codexOauthClientId,
  });
  if (!response.ok) {
    throw new CodexOAuthError(502, 'codex_device_start_failed', 'Codex device authorization failed to start');
  }

  const body = jsonObject(response.body);
  const userCode = stringField(body, 'user_code') ?? stringField(body, 'userCode');
  const deviceAuthId =
    stringField(body, 'device_auth_id') ??
    stringField(body, 'deviceAuthId') ??
    stringField(body, 'device_code') ??
    stringField(body, 'deviceCode');
  if (!userCode || !deviceAuthId) {
    throw new CodexOAuthError(502, 'codex_device_start_failed', 'Codex device authorization returned missing fields');
  }

  const expiresIn = positiveNumberField(body, 'expires_in') ?? positiveNumberField(body, 'expiresIn') ?? 900;
  const interval = positiveNumberField(body, 'interval') ?? positiveNumberField(body, 'interval_sec') ?? 5;
  const pendingId = await deps.pendingOAuth.start<CodexDeviceState>({
    userId,
    provider: 'codex',
    kind: 'device',
    state: { deviceAuthId },
    ttlMs: expiresIn * 1000,
  });

  return {
    userCode,
    verificationUri: `${config.codexOauthIssuer}/codex/device`,
    pendingId,
    intervalSec: interval,
  };
}

export async function pollCodexDevice(
  deps: { pendingOAuth: PendingOAuthStore; ironControl: IronControlAdminClient },
  userId: string,
  workspaceId: string,
  pendingId: string,
): Promise<{ status: 'expired' | 'pending' | 'connected' | 'error'; message?: string }> {
  const pending = await deps.pendingOAuth.get<CodexDeviceState>(pendingId, userId);
  if (!pending) return { status: 'expired' };

  const response = await postForm<unknown>(`${config.codexOauthIssuer}/api/accounts/deviceauth/token`, {
    device_auth_id: pending.state.deviceAuthId,
    client_id: config.codexOauthClientId,
  });
  const body = jsonObject(response.body);
  if (!response.ok && isAuthorizationPending(body)) {
    return { status: 'pending' };
  }

  const authorizationCode =
    stringField(body, 'authorization_code') ?? stringField(body, 'authorizationCode') ?? stringField(body, 'code');
  const codeVerifier = stringField(body, 'code_verifier') ?? stringField(body, 'codeVerifier');
  if (authorizationCode && codeVerifier) {
    const token = await postForm<unknown>(`${config.codexOauthIssuer}/oauth/token`, {
      grant_type: 'authorization_code',
      client_id: config.codexOauthClientId,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: `${config.codexOauthIssuer}/deviceauth/callback`,
    });
    const tokenBody = jsonObject(token.body);
    if (!token.ok) {
      await deps.pendingOAuth.markError(pendingId, JSON.stringify(tokenBody).slice(0, 300));
      return { status: 'error', message: 'token exchange failed' };
    }

    const refreshToken = stringField(tokenBody, 'refresh_token') ?? stringField(tokenBody, 'refreshToken');
    const idToken = stringField(tokenBody, 'id_token') ?? stringField(tokenBody, 'idToken');
    const accountId = idToken ? codexAccountIdFromIdToken(idToken) : null;
    if (!refreshToken || !accountId) {
      await deps.pendingOAuth.markError(pendingId, JSON.stringify(tokenBody).slice(0, 300));
      return { status: 'error', message: 'token exchange returned missing fields' };
    }

    await convergeCodexBrokerGrant(deps.ironControl, { workspaceId, userId, refreshToken, accountId });
    await deps.pendingOAuth.consume(pendingId, userId);
    return { status: 'connected' };
  }

  await deps.pendingOAuth.markError(pendingId, JSON.stringify(body).slice(0, 300));
  return { status: 'error', message: 'device auth failed' };
}

export class CodexOAuthError extends Error {
  constructor(
    readonly statusCode: number,
    readonly error: string,
    message: string,
  ) {
    super(message);
  }
}

function codexAccountIdFromIdToken(idToken: string): string | null {
  const [, payload] = idToken.split('.');
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JsonObject;
    const auth = claims['https://api.openai.com/auth'];
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null;
    return stringField(auth as JsonObject, 'chatgpt_account_id') ?? stringField(auth as JsonObject, 'chatgptAccountId');
  } catch {
    return null;
  }
}

function isAuthorizationPending(body: JsonObject): boolean {
  const error = stringField(body, 'error')?.toLowerCase();
  const errorDescription = stringField(body, 'error_description')?.toLowerCase();
  const status = stringField(body, 'status')?.toLowerCase();
  const text = [error, errorDescription, status].filter(Boolean).join(' ');
  return (
    text.includes('authorization_pending') ||
    text.includes('pending') ||
    text.includes('not_ready') ||
    text.includes('slow_down')
  );
}

function stringField(body: JsonObject, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveNumberField(body: JsonObject, key: string): number | null {
  const value = body[key];
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}
