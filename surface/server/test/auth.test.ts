import { describe, expect, it } from 'vitest';
import { signSession, verifySession } from '../src/cookie.js';

const SECRET = 'test-secret';

describe('session cookie sign/verify', () => {
  it('round-trips a session id', () => {
    const id = 'f4b7a6de-1111-4222-8333-444455556666';
    const signed = signSession(id, SECRET);
    expect(signed.startsWith(`${id}.`)).toBe(true);
    expect(verifySession(signed, SECRET)).toBe(id);
  });

  it('rejects a tampered session id', () => {
    const signed = signSession('aaaa-bbbb', SECRET);
    const [, mac] = signed.split('.');
    expect(verifySession(`cccc-dddd.${mac}`, SECRET)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const signed = signSession('aaaa-bbbb', SECRET);
    const flipped = signed.slice(0, -1) + (signed.endsWith('A') ? 'B' : 'A');
    expect(verifySession(flipped, SECRET)).toBeNull();
  });

  it('rejects a cookie signed with a different secret', () => {
    const signed = signSession('aaaa-bbbb', 'other-secret');
    expect(verifySession(signed, SECRET)).toBeNull();
  });

  it('rejects malformed values', () => {
    expect(verifySession(undefined, SECRET)).toBeNull();
    expect(verifySession(null, SECRET)).toBeNull();
    expect(verifySession('', SECRET)).toBeNull();
    expect(verifySession('no-dot-here', SECRET)).toBeNull();
    expect(verifySession('.maconly', SECRET)).toBeNull();
    expect(verifySession('idonly.', SECRET)).toBeNull();
    expect(verifySession('id.not!base64url!!', SECRET)).toBeNull();
  });
});
