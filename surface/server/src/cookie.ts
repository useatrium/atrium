import { createHmac, timingSafeEqual } from 'node:crypto';

/** Sign a session id: returns `<sessionId>.<base64url hmac-sha256>`. */
export function signSession(sessionId: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(sessionId).digest('base64url');
  return `${sessionId}.${mac}`;
}

/**
 * Verify a signed cookie value. Returns the session id on success, null on
 * any failure (missing, malformed, bad signature). Constant-time compare.
 */
export function verifySession(
  value: string | undefined | null,
  secret: string,
): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  const sessionId = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(sessionId).digest();
  const actual = Buffer.from(mac, 'base64url');
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;
  return sessionId;
}
