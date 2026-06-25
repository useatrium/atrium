import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AppGrant {
  appId: string;
  version: number;
  relPath: string;
  expires: number;
}

export function appLaunchSignature(grant: AppGrant, secret: string): string {
  return createHmac('sha256', secret)
    .update(`app:${grant.appId}:${grant.version}:${grant.relPath}:${grant.expires}`)
    .digest('base64url');
}

export function verifyAppLaunchSignature(
  grant: AppGrant,
  sig: string,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (!Number.isSafeInteger(grant.version) || grant.version <= 0) return false;
  if (!Number.isFinite(grant.expires) || grant.expires * 1000 < nowMs) return false;
  const expected = Buffer.from(appLaunchSignature(grant, secret));
  const actual = Buffer.from(sig);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
