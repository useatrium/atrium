import * as http2 from 'node:http2';
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import type { Db } from './db.js';
import { pruneTokens } from './push.js';

export type VoipPlatform = 'ios' | 'android';

export interface IncomingCallVoipPayload {
  type: 'incoming_call';
  callId: string;
  callerId: string;
  callerName: string;
  channelId: string;
  channelName: string;
  room: string;
}

export interface VoipPushToken {
  token: string;
  userId: string;
  platform: VoipPlatform;
}

export type VoipSendResult =
  | { status: 'sent' }
  | { status: 'skipped' }
  | { status: 'dead'; error?: string }
  | { status: 'failed'; error?: string };

export interface VoipPushSender {
  readonly name: string;
  send(token: VoipPushToken, payload: IncomingCallVoipPayload): Promise<VoipSendResult>;
}

export interface VoipConfig {
  apnsTeamId: string;
  apnsKeyId: string;
  apnsAuthKeyP8: string;
  apnsBundleId: string;
  /** Use the APNs sandbox host — required for dev/debug builds, whose PushKit
   * tokens are sandbox tokens (production host rejects them as BadDeviceToken). */
  apnsSandbox: boolean;
  fcmProjectId: string;
  fcmServiceAccountJson: string;
}

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  authKeyP8: string;
  bundleId: string;
  sandbox: boolean;
}

export interface ApnsVoipRequest {
  path: string;
  headers: Record<string, string>;
  body: string;
}

interface FcmServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

const APNS_ORIGIN = 'https://api.push.apple.com';
const APNS_SANDBOX_ORIGIN = 'https://api.sandbox.push.apple.com';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const noopVoipSender: VoipPushSender = {
  name: 'noop',
  async send(): Promise<VoipSendResult> {
    return { status: 'skipped' };
  },
};

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function normalizePem(value: string): string {
  const raw = value.trim().replace(/\\n/g, '\n');
  if (raw.includes('BEGIN')) return raw;
  const decoded = Buffer.from(raw, 'base64').toString('utf8').trim().replace(/\\n/g, '\n');
  return decoded.includes('BEGIN') ? decoded : raw;
}

function jwtEs256(header: object, claims: object, privateKeyPem: string): string {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(privateKeyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

function jwtRs256(header: object, claims: object, privateKeyPem: string): string {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), normalizePem(privateKeyPem));
  return `${signingInput}.${base64url(signature)}`;
}

/** expo-callkit-telecom's native parser expects this nested shape (not our flat
 * internal payload). A fresh eventId per push; serverCallId is the stable call id. */
function toIncomingCallObject(payload: IncomingCallVoipPayload, eventId: string = randomUUID()) {
  return {
    eventId,
    serverCallId: payload.callId,
    hasVideo: false,
    caller: { id: payload.callerId, displayName: payload.callerName },
    metadata: {
      channelId: payload.channelId,
      channelName: payload.channelName,
      room: payload.room,
    },
  };
}

export function buildApnsVoipRequest(
  config: ApnsConfig,
  deviceToken: string,
  payload: IncomingCallVoipPayload,
  options: { nowSeconds: number; eventId: string; jwt?: string },
): ApnsVoipRequest {
  const path = `/3/device/${deviceToken}`;
  const jwt =
    options.jwt ??
    jwtEs256(
      { alg: 'ES256', kid: config.keyId },
      { iss: config.teamId, iat: options.nowSeconds },
      normalizePem(config.authKeyP8),
    );
  return {
    path,
    headers: {
      ':method': 'POST',
      ':path': path,
      authorization: `bearer ${jwt}`,
      'apns-topic': `${config.bundleId}.voip`,
      'apns-push-type': 'voip',
      'apns-priority': '10',
      'apns-expiration': '0',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ incomingCall: toIncomingCallObject(payload, options.eventId) }),
  };
}

function createApnsSender(config: ApnsConfig): VoipPushSender {
  const authKey = normalizePem(config.authKeyP8);
  let cachedJwt = '';
  let cachedJwtIat = 0;
  let cachedUntil = 0;
  let session: http2.ClientHttp2Session | null = null;

  function providerJwt(): { jwt: string; iat: number } {
    if (cachedJwt && Date.now() < cachedUntil) return { jwt: cachedJwt, iat: cachedJwtIat };
    cachedJwtIat = Math.floor(Date.now() / 1000);
    cachedJwt = jwtEs256(
      { alg: 'ES256', kid: config.keyId },
      { iss: config.teamId, iat: cachedJwtIat },
      authKey,
    );
    cachedUntil = Date.now() + 50 * 60 * 1000;
    return { jwt: cachedJwt, iat: cachedJwtIat };
  }

  // Reuse one HTTP/2 session across pushes — APNs multiplexes; a fresh connection
  // per push adds a TLS handshake each time and can leak streams.
  function getSession(): http2.ClientHttp2Session {
    if (!session || session.destroyed || session.closed) {
      session = http2.connect(config.sandbox ? APNS_SANDBOX_ORIGIN : APNS_ORIGIN);
      session.on('error', () => {
        session = null;
      });
    }
    return session;
  }

  return {
    name: 'apns',
    async send(token, payload) {
      if (token.platform !== 'ios') return { status: 'skipped' };
      const jwt = providerJwt();
      return sendApnsVoip(getSession(), config, token.token, payload, jwt.iat, jwt.jwt);
    },
  };
}

function sendApnsVoip(
  session: http2.ClientHttp2Session,
  config: ApnsConfig,
  deviceToken: string,
  payload: IncomingCallVoipPayload,
  nowSeconds: number,
  jwt: string,
): Promise<VoipSendResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let status = 0;
    let settled = false;
    const settle = (result: VoipSendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Never let a stalled APNs stream hang the fire-and-forget chain forever.
    const timer = setTimeout(() => settle({ status: 'failed', error: 'apns_timeout' }), 10_000);

    const request = buildApnsVoipRequest(config, deviceToken, payload, {
      nowSeconds,
      eventId: randomUUID(),
      jwt,
    });
    const req = session.request(request.headers);
    req.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('error', (err) => settle({ status: 'failed', error: err.message }));
    req.on('end', () => {
      if (status >= 200 && status < 300) {
        settle({ status: 'sent' });
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const reason = apnsReason(body);
      if (isDeadApnsReason(reason)) {
        settle({ status: 'dead', error: reason });
      } else {
        settle({ status: 'failed', error: reason || `apns_status_${status}` });
      }
    });
    req.end(request.body);
  });
}

function apnsReason(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : '';
  } catch {
    return '';
  }
}

function isDeadApnsReason(reason: string): boolean {
  return reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic' || reason === 'Unregistered';
}

function parseServiceAccount(raw: string): FcmServiceAccount | null {
  const text = raw.trim();
  const candidates = [text, Buffer.from(text, 'base64').toString('utf8')];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<FcmServiceAccount>;
      if (typeof parsed.client_email === 'string' && typeof parsed.private_key === 'string') {
        return {
          client_email: parsed.client_email,
          private_key: parsed.private_key.replace(/\\n/g, '\n'),
          token_uri: parsed.token_uri,
          project_id: parsed.project_id,
        };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function createFcmSender(
  projectId: string,
  serviceAccount: FcmServiceAccount,
  fetchImpl: typeof fetch = fetch,
): VoipPushSender {
  let accessToken = '';
  let tokenUntil = 0;

  async function getAccessToken(): Promise<string> {
    if (accessToken && Date.now() < tokenUntil) return accessToken;
    const tokenUri = serviceAccount.token_uri || GOOGLE_TOKEN_URL;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const assertion = jwtRs256(
      { alg: 'RS256', typ: 'JWT' },
      {
        iss: serviceAccount.client_email,
        scope: FCM_SCOPE,
        aud: tokenUri,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      },
      serviceAccount.private_key,
    );
    const res = await fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!res.ok) throw new Error(`fcm_oauth_${res.status}`);
    const data = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== 'string') throw new Error('fcm_oauth_missing_access_token');
    accessToken = data.access_token;
    const expiresInMs =
      typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
        ? data.expires_in * 1000
        : 3600 * 1000;
    tokenUntil = Date.now() + Math.max(60_000, expiresInMs - 60_000);
    return accessToken;
  }

  return {
    name: 'fcm',
    async send(token, payload) {
      if (token.platform !== 'android') return { status: 'skipped' };
      try {
        const bearer = await getAccessToken();
        const res = await fetchImpl(
          `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${bearer}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                token: token.token,
                android: { priority: 'high' },
                // FCM data values must all be strings; the device parses the
                // nested incomingCall object from this string.
                data: {
                  messageType: 'incomingCall',
                  incomingCall: JSON.stringify(toIncomingCallObject(payload)),
                },
              },
            }),
          },
        );
        if (res.ok) return { status: 'sent' };
        const error = await parseFcmError(res);
        if (isDeadFcmError(error)) return { status: 'dead', error: error.code || error.status };
        return { status: 'failed', error: error.code || error.status || `fcm_status_${res.status}` };
      } catch (err) {
        return { status: 'failed', error: (err as Error).message };
      }
    },
  };
}

async function parseFcmError(res: Response): Promise<{ status: string; code: string }> {
  try {
    const body = (await res.json()) as {
      error?: { status?: unknown; details?: Array<Record<string, unknown>> };
    };
    const status = typeof body.error?.status === 'string' ? body.error.status : '';
    const fcm = body.error?.details?.find((detail) =>
      String(detail['@type'] ?? '').includes('google.firebase.fcm.v1.FcmError'),
    );
    const code = typeof fcm?.errorCode === 'string' ? fcm.errorCode : '';
    return { status, code };
  } catch {
    return { status: '', code: '' };
  }
}

function isDeadFcmError(error: { status: string; code: string }): boolean {
  return error.status === 'NOT_FOUND' || error.code === 'UNREGISTERED' || error.code === 'INVALID_ARGUMENT';
}

export function getVoipSender(config: VoipConfig): VoipPushSender {
  const apns =
    config.apnsTeamId.trim() &&
    config.apnsKeyId.trim() &&
    config.apnsAuthKeyP8.trim() &&
    config.apnsBundleId.trim()
      ? createApnsSender({
          teamId: config.apnsTeamId.trim(),
          keyId: config.apnsKeyId.trim(),
          authKeyP8: config.apnsAuthKeyP8,
          bundleId: config.apnsBundleId.trim(),
          sandbox: config.apnsSandbox,
        })
      : null;
  const serviceAccount = config.fcmServiceAccountJson.trim()
    ? parseServiceAccount(config.fcmServiceAccountJson)
    : null;
  const fcmProjectId = config.fcmProjectId.trim() || serviceAccount?.project_id?.trim() || '';
  const fcm = fcmProjectId && serviceAccount ? createFcmSender(fcmProjectId, serviceAccount) : null;

  if (!apns && !fcm) return noopVoipSender;
  return {
    name: [apns?.name, fcm?.name].filter(Boolean).join('+'),
    async send(token, payload) {
      if (token.platform === 'ios') return apns ? apns.send(token, payload) : { status: 'skipped' };
      return fcm ? fcm.send(token, payload) : { status: 'skipped' };
    },
  };
}

export async function sendIncomingCallVoipPushes(
  pool: Db,
  sender: VoipPushSender,
  args: {
    recipientIds: string[];
    callId: string;
    callerId: string;
    callerName: string;
    channelId: string;
  },
): Promise<{ attempted: number; pruned: string[]; payload: IncomingCallVoipPayload }> {
  const recipientIds = [...new Set(args.recipientIds)];
  const room = `call:${args.callId}`;
  // Guard before the channel-name DB query: no recipients → nothing to resolve.
  if (recipientIds.length === 0) {
    return {
      attempted: 0,
      pruned: [],
      payload: {
        type: 'incoming_call',
        callId: args.callId,
        callerId: args.callerId,
        callerName: args.callerName,
        channelId: args.channelId,
        channelName: '',
        room,
      },
    };
  }
  const payload: IncomingCallVoipPayload = {
    type: 'incoming_call',
    callId: args.callId,
    callerId: args.callerId,
    callerName: args.callerName,
    channelId: args.channelId,
    channelName: await resolveChannelName(pool, args.channelId, {
      id: args.callerId,
      displayName: args.callerName,
    }),
    room,
  };

  const tokens = await pool.query<VoipPushToken>(
    `SELECT token, user_id AS "userId", platform
     FROM push_tokens
     WHERE kind = 'voip' AND user_id = ANY($1::uuid[])
     ORDER BY user_id ASC, token ASC`,
    [recipientIds],
  );

  // Independent per-token sends — run them concurrently.
  const results = await Promise.all(
    tokens.rows.map(async (token) => {
      const result = await sender.send(token, payload);
      return result.status === 'dead' ? token.token : null;
    }),
  );
  const pruned = results.filter((t): t is string => t !== null);
  await pruneTokens(pool, pruned);
  return { attempted: tokens.rows.length, pruned, payload };
}

async function resolveChannelName(
  pool: Db,
  channelId: string,
  caller: { id: string; displayName: string },
): Promise<string> {
  const channel = await pool.query<{ name: string; kind: 'public' | 'private' | 'dm' | 'gdm' }>(
    'SELECT name, kind FROM channels WHERE id = $1',
    [channelId],
  );
  const row = channel.rows[0];
  if (!row) return '';
  if (row.kind === 'dm') return caller.displayName;
  if (row.kind !== 'gdm') return row.name;

  const members = await pool.query<{ display_name: string }>(
    `SELECT u.display_name
     FROM channel_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.channel_id = $1
     ORDER BY u.handle ASC`,
    [channelId],
  );
  const label = members.rows.map((member) => member.display_name).join(', ');
  return label || row.name;
}
