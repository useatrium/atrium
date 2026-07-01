import { config } from './config.js';
import {
  IronControlRequestError,
  type IronControlAdminClient,
  atriumPrincipalForeignId,
  codexAccountIdSecretForeignId,
  codexBearerSecretForeignId,
  codexBrokerCredentialForeignId,
} from './iron-control.js';

/**
 * Result of wiring a Codex BYO grant. `live` = the broker minted an access token
 * and the bearer is deliverable now; `pending` = still minting after the bounded
 * wait (rare — the token should land shortly); `dead` = the refresh token was
 * rejected, so the connection is not usable and the user must reconnect.
 */
export type CodexGrantOutcome = 'live' | 'pending' | 'dead';

export async function convergeCodexBrokerGrant(
  ironControl: IronControlAdminClient,
  args: { workspaceId: string; userId: string; refreshToken: string; accountId: string },
): Promise<CodexGrantOutcome> {
  const { workspaceId, userId, refreshToken, accountId } = args;
  const foreignId = atriumPrincipalForeignId(workspaceId, userId);
  const labels = {
    source: 'atrium',
    provider: 'codex',
    atrium_workspace_id: workspaceId,
    atrium_user_id: userId,
  };

  const principal = await ironControl.upsertPrincipal({
    foreignId,
    name: `Atrium Workspace ${workspaceId} User ${userId}`,
    labels: {
      source: 'atrium',
      atrium_workspace_id: workspaceId,
      atrium_user_id: userId,
    },
  });

  const infra = await ironControl.lookupRole('infra');
  try {
    await ironControl.assignRole(principal.id, infra.id);
  } catch (err) {
    if (!(err instanceof IronControlRequestError && (err.status === 409 || err.status === 422))) {
      throw err;
    }
  }

  const broker = await ironControl.upsertBrokerCredential({
    foreignId: codexBrokerCredentialForeignId(workspaceId, userId),
    name: `Codex sub for ${foreignId}`,
    tokenEndpoint: `${config.codexOauthIssuer}/oauth/token`,
    clientId: config.codexOauthClientId,
    refreshToken,
    scopes: [],
    labels,
  });

  const bearer = await ironControl.upsertInjectSecret({
    foreignId: codexBearerSecretForeignId(workspaceId, userId),
    name: `Codex bearer ${foreignId}`,
    header: 'Authorization',
    formatter: 'Bearer {{.Value}}',
    host: 'chatgpt.com',
    source: { kind: 'token_broker', brokerCredentialId: broker.id },
    labels,
  });

  const account = await ironControl.upsertInjectSecret({
    foreignId: codexAccountIdSecretForeignId(workspaceId, userId),
    name: `Codex account ${foreignId}`,
    header: 'ChatGPT-Account-ID',
    host: 'chatgpt.com',
    source: { kind: 'control_plane', secret: accountId },
    labels,
  });

  const grants = await ironControl.listPrincipalGrants(principal.id);
  for (const secret of [bearer, account]) {
    if (!grants.some((grant) => grant.static_secret_id === secret.id)) {
      await ironControl.createPrincipalStaticGrant(principal.id, secret.id);
    }
  }

  // The broker mints the first access token asynchronously (console enqueues an
  // eager refresh on seed). Wait — briefly — for it to land so the caller only
  // reports "connected" once the bearer is actually deliverable, closing the race
  // where a session spawned right after connect would inject no token.
  return waitForCodexBrokerLive(ironControl, broker.id);
}

const BROKER_LIVE_TIMEOUT_MS = 6000;
const BROKER_LIVE_POLL_MS = 400;

async function waitForCodexBrokerLive(
  ironControl: IronControlAdminClient,
  brokerId: string,
): Promise<CodexGrantOutcome> {
  const deadline = Date.now() + BROKER_LIVE_TIMEOUT_MS;
  for (;;) {
    let status: string | undefined;
    try {
      status = (await ironControl.getBrokerCredential(brokerId)).status;
    } catch {
      // Transient read error — keep polling until the deadline.
    }
    if (status === 'live') return 'live';
    if (status === 'dead') return 'dead';
    if (Date.now() >= deadline) return 'pending';
    await new Promise((resolve) => setTimeout(resolve, BROKER_LIVE_POLL_MS));
  }
}
