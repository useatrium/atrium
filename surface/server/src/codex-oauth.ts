import { config } from './config.js';
import { convergeCodexBrokerGrant } from './codex-iron-control.js';
import type { IronControlAdminClient } from './iron-control.js';
import { type PendingOAuthStore, postForm, postJson } from './provider-oauth.js';

type JsonObject = Record<string, unknown>;

type CodexDeviceState = {
  deviceAuthId: string;
  // The poll endpoint (`/api/accounts/deviceauth/token`) requires the user_code
  // alongside the device_auth_id, so we stash it with the handshake.
  userCode: string;
};

export async function startCodexDevice(
  deps: { pendingOAuth: PendingOAuthStore },
  userId: string,
): Promise<{ userCode: string; verificationUri: string; pendingId: string; intervalSec: number }> {
  const response = await postJson<unknown>(`${config.codexOauthIssuer}/api/accounts/deviceauth/usercode`, {
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

  // The usercode response carries an absolute `expires_at`; fall back to a
  // 15-minute TTL (it historically returned `expires_in`, so honour that too).
  const expiresIn =
    positiveNumberField(body, 'expires_in') ??
    positiveNumberField(body, 'expiresIn') ??
    secondsUntil(stringField(body, 'expires_at') ?? stringField(body, 'expiresAt')) ??
    900;
  const interval = positiveNumberField(body, 'interval') ?? positiveNumberField(body, 'interval_sec') ?? 5;
  const pendingId = await deps.pendingOAuth.start<CodexDeviceState>({
    userId,
    provider: 'codex',
    kind: 'device',
    state: { deviceAuthId, userCode },
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

  const response = await postJson<unknown>(`${config.codexOauthIssuer}/api/accounts/deviceauth/token`, {
    device_auth_id: pending.state.deviceAuthId,
    user_code: pending.state.userCode,
  });
  const body = jsonObject(response.body);
  if (!response.ok) {
    // While the user hasn't approved yet, the endpoint answers 403/404 with a
    // `deviceauth_authorization_pending` (or slow_down) code — keep polling.
    if (isAuthorizationPending(body) || response.status === 403 || response.status === 404) {
      return { status: 'pending' };
    }
    await deps.pendingOAuth.markError(pendingId, JSON.stringify(body).slice(0, 300));
    return { status: 'error', message: 'device auth failed' };
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
      // Device flow: redirect_uri is `{issuer}/deviceauth/callback` (NO `/codex/` —
      // verified against openai/codex codex-rs/login `complete_device_code_login`).
      // It must exactly match what the deviceauth grant used, or /oauth/token returns
      // `token_exchange_user_error`.
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

    const outcome = await convergeCodexBrokerGrant(deps.ironControl, {
      workspaceId,
      userId,
      refreshToken,
      accountId,
    });
    await deps.pendingOAuth.consume(pendingId, userId);
    if (outcome === 'dead') {
      // The refresh token was rejected when the broker tried to mint — don't
      // report a false "connected". The handshake is consumed, so Try Again
      // starts a fresh device flow.
      return {
        status: 'error',
        message: 'Codex sign-in could not be verified (token rejected). Please connect again.',
      };
    }
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
  // The live endpoint nests the reason under an `error` object, e.g.
  // { error: { code: "deviceauth_authorization_pending", message: "…" } }.
  // Gather candidate strings from both the top level and the nested object.
  const nested = jsonObject(body['error']);
  const candidates = [
    stringField(body, 'error'),
    stringField(body, 'error_description'),
    stringField(body, 'status'),
    stringField(nested, 'code'),
    stringField(nested, 'message'),
    stringField(nested, 'type'),
    stringField(nested, 'error'),
  ];
  const text = candidates.filter(Boolean).join(' ').toLowerCase();
  return (
    text.includes('authorization_pending') ||
    text.includes('pending') ||
    text.includes('not_ready') ||
    text.includes('slow_down')
  );
}

/** Seconds from now until an ISO-8601 timestamp, or null if unparseable/past. */
function secondsUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const seconds = Math.floor((ms - Date.now()) / 1000);
  return seconds > 0 ? seconds : null;
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
