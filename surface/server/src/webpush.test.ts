import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildVapidAuthorization,
  encryptWebPushPayload,
  getWebPushSender,
} from './webpush.js';

describe('encryptWebPushPayload', () => {
  it('matches the RFC 8291 Appendix A aes128gcm vector', () => {
    const subscription = {
      endpoint: 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV',
      keys: {
        p256dh:
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      },
    };

    const encrypted = encryptWebPushPayload(
      'When I grow up, I want to be a watermelon',
      subscription,
      {
        appServerPrivateKey: Buffer.from(
          'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
          'base64url',
        ),
        salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
      },
    );

    expect(encrypted.body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });
});

describe('buildVapidAuthorization', () => {
  it('builds a verifiable RFC 8292 VAPID authorization header', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const privateJwk = privateKey.export({ format: 'jwk' });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const publicRaw = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(publicJwk.x!, 'base64url'),
      Buffer.from(publicJwk.y!, 'base64url'),
    ]).toString('base64url');
    const header = buildVapidAuthorization(
      {
        vapidPublicKey: publicRaw,
        vapidPrivateKey: privateJwk.d!,
        vapidSubject: 'mailto:ops@example.com',
      },
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      { nowSeconds: 1_765_000_000 },
    );

    expect(header.startsWith('vapid t=')).toBe(true);
    expect(header.endsWith(`, k=${publicRaw}`)).toBe(true);
    const token = header.slice('vapid t='.length, header.indexOf(', k='));
    const [encodedHeader, encodedClaims, encodedSignature] = token.split('.');
    expect(JSON.parse(Buffer.from(encodedHeader!, 'base64url').toString('utf8'))).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    });
    expect(JSON.parse(Buffer.from(encodedClaims!, 'base64url').toString('utf8'))).toEqual({
      aud: 'https://updates.push.services.mozilla.com',
      exp: 1_765_043_200,
      sub: 'mailto:ops@example.com',
    });
    const verifyingKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: publicJwk.x!, y: publicJwk.y! },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        { key: verifyingKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(encodedSignature!, 'base64url'),
      ),
    ).toBe(true);
  });
});

describe('getWebPushSender', () => {
  it('is a noop when VAPID config is incomplete', async () => {
    const sender = getWebPushSender({
      vapidPublicKey: '',
      vapidPrivateKey: '',
      vapidSubject: '',
    });
    await expect(
      sender.send(
        { endpoint: 'https://push.example.test/1', keys: { p256dh: 'x', auth: 'y' } },
        { title: 't', body: 'b', tag: 'tag', badge: 0, data: {} },
      ),
    ).resolves.toEqual({ status: 'skipped' });
  });
});
