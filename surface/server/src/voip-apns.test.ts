import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import { buildApnsVoipRequest, type IncomingCallVoipPayload } from './voip.js';

describe('buildApnsVoipRequest', () => {
  it('builds the exact APNs VoIP request and signs a deterministic ES256 JWT', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const authKeyP8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const payload: IncomingCallVoipPayload = {
      type: 'incoming_call',
      callId: 'call-123',
      callerId: 'user-456',
      callerName: 'Alice',
      channelId: 'channel-789',
      channelName: 'General',
      room: 'call:call-123',
    };

    const request = buildApnsVoipRequest(
      {
        teamId: 'TEAMID1234',
        keyId: 'KEYID1234',
        authKeyP8,
        bundleId: 'com.atrium.app',
        sandbox: false,
      },
      'device-token-abc',
      payload,
      { nowSeconds: 1_765_000_000, eventId: 'event-uuid-1' },
    );

    expect(request.path).toBe('/3/device/device-token-abc');
    expect(request.headers).toMatchObject({
      ':method': 'POST',
      ':path': '/3/device/device-token-abc',
      'apns-topic': 'com.atrium.app.voip',
      'apns-push-type': 'voip',
      'apns-priority': '10',
      'apns-expiration': '0',
      'content-type': 'application/json',
    });

    const authorization = request.headers.authorization;
    expect(authorization).toBeDefined();
    if (!authorization) throw new Error('missing authorization header');
    expect(authorization.startsWith('bearer ')).toBe(true);
    const jwt = authorization.slice('bearer '.length);
    const [encodedHeader, encodedClaims, encodedSignature] = jwt.split('.');
    expect(encodedHeader).toBeTruthy();
    expect(encodedClaims).toBeTruthy();
    expect(encodedSignature).toBeTruthy();

    const header = JSON.parse(Buffer.from(encodedHeader!, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(encodedClaims!, 'base64url').toString('utf8'));
    expect(header).toEqual({ alg: 'ES256', kid: 'KEYID1234' });
    expect(claims).toEqual({ iss: 'TEAMID1234', iat: 1_765_000_000 });
    expect(
      verify(
        'sha256',
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(encodedSignature!, 'base64url'),
      ),
    ).toBe(true);

    expect(JSON.parse(request.body)).toEqual({
      incomingCall: {
        eventId: 'event-uuid-1',
        serverCallId: 'call-123',
        hasVideo: false,
        caller: { id: 'user-456', displayName: 'Alice' },
        metadata: {
          channelId: 'channel-789',
          channelName: 'General',
          room: 'call:call-123',
        },
      },
    });
  });
});
