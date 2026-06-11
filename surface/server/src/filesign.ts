// Short-lived, file-scoped URL signatures. These exist so a file URL can be
// opened outside an authenticated context (external browser, share sheet)
// without ever embedding a session credential in the URL.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Seconds a minted file URL stays valid. */
export const FILE_URL_TTL_S = 300;

/** HMAC over "file:<id>:<expires>" — scoped to one file and one deadline. */
export function fileSignature(fileId: string, expires: number, secret: string): string {
  return createHmac('sha256', secret).update(`file:${fileId}:${expires}`).digest('base64url');
}

export function verifyFileSignature(
  fileId: string,
  expires: number,
  sig: string,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (!Number.isFinite(expires) || expires * 1000 < nowMs) return false;
  const expected = Buffer.from(fileSignature(fileId, expires, secret));
  const actual = Buffer.from(sig);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
