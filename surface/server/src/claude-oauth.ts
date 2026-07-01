import { config } from './config.js';
import { convergeClaudeStaticGrant } from './claude-iron-control.js';
import type { IronControlAdminClient } from './iron-control.js';
import { type PendingOAuthStore, generatePkce, postForm, randomState } from './provider-oauth.js';

type ClaudePendingState = {
  verifier: string;
  oauthState: string;
};

type ClaudeTokenResponse = {
  access_token?: unknown;
};

export async function startClaudeOauth(
  { pendingOAuth }: { pendingOAuth: PendingOAuthStore },
  userId: string,
): Promise<{ authorizeUrl: string; pendingId: string }> {
  const { verifier, challenge } = generatePkce();
  const state = randomState();
  const pendingId = await pendingOAuth.start({
    userId,
    provider: 'claude-code',
    kind: 'pkce',
    state: { verifier, oauthState: state },
    ttlMs: 15 * 60 * 1000,
  });
  const authorizeUrl =
    `${config.claudeOauthAuthorizeUrl}?` +
    new URLSearchParams({
      code: 'true',
      client_id: config.claudeOauthClientId,
      response_type: 'code',
      redirect_uri: config.claudeOauthRedirectUri,
      scope: 'user:inference',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }).toString();
  return { authorizeUrl, pendingId };
}

export async function exchangeClaudeCode(
  {
    pendingOAuth,
    ironControl,
  }: {
    pendingOAuth: PendingOAuthStore;
    ironControl: IronControlAdminClient;
  },
  userId: string,
  workspaceId: string,
  pendingId: string,
  rawCode: string,
): Promise<{ status: 'connected' } | { status: 'expired' } | { status: 'error'; message: string }> {
  const pending = await pendingOAuth.get<ClaudePendingState>(pendingId, userId);
  if (!pending) return { status: 'expired' };

  const code = String(rawCode).trim().split('#')[0] ?? '';
  const t = await postForm<ClaudeTokenResponse>(config.claudeOauthTokenUrl, {
    grant_type: 'authorization_code',
    client_id: config.claudeOauthClientId,
    code,
    code_verifier: pending.state.verifier,
    redirect_uri: config.claudeOauthRedirectUri,
  });
  if (!t.ok) {
    await pendingOAuth.markError(pendingId, JSON.stringify(t.body).slice(0, 300));
    return { status: 'error', message: 'exchange failed' };
  }

  const token = typeof t.body.access_token === 'string' ? t.body.access_token : '';
  if (!token) {
    await pendingOAuth.markError(pendingId, 'missing access_token');
    return { status: 'error', message: 'exchange failed' };
  }

  await convergeClaudeStaticGrant(ironControl, { workspaceId, userId, token });
  await pendingOAuth.consume(pendingId, userId);
  return { status: 'connected' };
}
