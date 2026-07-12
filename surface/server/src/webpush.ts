import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';

export interface WebPushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface WebPushConfig {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
}

export interface WebPushPayload {
  title: string;
  body: string;
  tag: string;
  badge: number;
  data: Record<string, unknown>;
}

export type WebPushUrgency = 'very-low' | 'low' | 'normal' | 'high';

export type WebPushSendResult =
  | { status: 'sent' }
  | { status: 'skipped' }
  | { status: 'dead' }
  | { status: 'failed'; error?: string };

export interface WebPushSender {
  readonly name: string;
  send(
    subscription: WebPushSubscription,
    payload: WebPushPayload,
    options?: { urgency?: WebPushUrgency },
  ): Promise<WebPushSendResult>;
}

export interface EncryptedWebPushPayload {
  body: Buffer;
  salt: Buffer;
  publicKey: Buffer;
}

export const noopWebPushSender: WebPushSender = {
  name: 'noop',
  async send(): Promise<WebPushSendResult> {
    return { status: 'skipped' };
  },
};

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function decodeBase64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function hmacSha256(key: Buffer, data: Buffer): Buffer<ArrayBufferLike> {
  return createHmac('sha256', key).update(data).digest();
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer<ArrayBufferLike> {
  const blocks: Buffer<ArrayBufferLike>[] = [];
  let previous: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for (let counter = 1; Buffer.concat(blocks).length < length; counter += 1) {
    previous = hmacSha256(prk, Buffer.concat([previous, info, Buffer.from([counter])]));
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

function jwtEs256(header: object, claims: object, privateKey: ReturnType<typeof createPrivateKey>): string {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

function p256PrivateKeyFromRaw(privateKey: Buffer, publicKey: Buffer): ReturnType<typeof createPrivateKey> {
  if (privateKey.length !== 32) throw new Error('vapid_private_key_must_be_32_bytes');
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) throw new Error('vapid_public_key_must_be_uncompressed_p256');
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: base64url(publicKey.subarray(1, 33)),
      y: base64url(publicKey.subarray(33, 65)),
      d: base64url(privateKey),
    },
    format: 'jwk',
  });
}

export function buildVapidAuthorization(
  config: WebPushConfig,
  endpoint: string,
  options: { nowSeconds?: number } = {},
): string {
  const publicKey = config.vapidPublicKey.trim();
  const privateKey = p256PrivateKeyFromRaw(decodeBase64url(config.vapidPrivateKey.trim()), decodeBase64url(publicKey));
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const jwt = jwtEs256(
    { typ: 'JWT', alg: 'ES256' },
    {
      aud: new URL(endpoint).origin,
      exp: nowSeconds + 12 * 60 * 60,
      sub: config.vapidSubject.trim(),
    },
    privateKey,
  );
  return `vapid t=${jwt}, k=${publicKey}`;
}

export function encryptWebPushPayload(
  plaintext: Buffer | string,
  subscription: WebPushSubscription,
  options: {
    appServerPrivateKey?: Buffer;
    salt?: Buffer;
    recordSize?: number;
  } = {},
): EncryptedWebPushPayload {
  const uaPublic = decodeBase64url(subscription.keys.p256dh);
  const authSecret = decodeBase64url(subscription.keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('bad_webpush_public_key');
  if (authSecret.length !== 16) throw new Error('bad_webpush_auth_secret');

  const ecdh = createECDH('prime256v1');
  if (options.appServerPrivateKey) {
    ecdh.setPrivateKey(options.appServerPrivateKey);
  } else {
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey(undefined, 'uncompressed');
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const prkKey = hmacSha256(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info', 'utf8'), Buffer.from([0]), uaPublic, asPublic]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);

  const salt = options.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new Error('bad_webpush_salt');
  const prk = hmacSha256(salt, ikm);
  const cek = hkdfExpand(
    prk,
    Buffer.concat([Buffer.from('Content-Encoding: aes128gcm', 'utf8'), Buffer.from([0])]),
    16,
  );
  const nonce = hkdfExpand(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce', 'utf8'), Buffer.from([0])]), 12);

  const recordSize = options.recordSize ?? 4096;
  const header = Buffer.alloc(21 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);

  const plain = Buffer.concat([
    Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8'),
    Buffer.from([0x02]),
  ]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { body: Buffer.concat([header, ciphertext]), salt, publicKey: asPublic };
}

export function getWebPushSender(config: WebPushConfig, fetchImpl: typeof fetch = fetch): WebPushSender {
  if (!config.vapidPublicKey.trim() || !config.vapidPrivateKey.trim() || !config.vapidSubject.trim()) {
    return noopWebPushSender;
  }

  return {
    name: 'webpush',
    async send(subscription, payload, options = {}) {
      let body: Buffer;
      let authorization: string;
      try {
        body = encryptWebPushPayload(JSON.stringify(payload), subscription).body;
        authorization = buildVapidAuthorization(config, subscription.endpoint);
      } catch (err) {
        return { status: 'failed', error: (err as Error).message };
      }

      try {
        const res = await fetchImpl(subscription.endpoint, {
          method: 'POST',
          headers: {
            authorization,
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: '259200',
            urgency: options.urgency ?? 'normal',
          },
          body: new Uint8Array(body),
        });
        if (res.ok) return { status: 'sent' };
        if (res.status === 404 || res.status === 410) return { status: 'dead' };
        return { status: 'failed', error: `webpush_status_${res.status}` };
      } catch (err) {
        return { status: 'failed', error: (err as Error).message };
      }
    },
  };
}
