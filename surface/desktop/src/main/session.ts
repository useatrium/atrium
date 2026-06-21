import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';

/**
 * Persistent desktop login, mirroring the mobile session model
 * (surface/mobile/src/lib/session.tsx): server origin + bearer token + user.
 * Encrypted at rest with the OS keychain via Electron safeStorage.
 */
export interface DesktopSession {
  serverUrl: string;
  token: string;
  user: { id: string; handle: string; displayName: string };
}

function sessionFile(): string {
  return join(app.getPath('userData'), 'session.bin');
}

function isValid(value: unknown): value is DesktopSession {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.serverUrl === 'string' &&
    typeof s.token === 'string' &&
    typeof s.user === 'object' &&
    s.user !== null &&
    typeof (s.user as Record<string, unknown>).id === 'string'
  );
}

export function loadSession(): DesktopSession | null {
  try {
    const file = sessionFile();
    if (!existsSync(file)) return null;
    const raw = readFileSync(file);
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession(session: DesktopSession): void {
  if (!isValid(session)) return;
  const json = JSON.stringify(session);
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8');
  writeFileSync(sessionFile(), data, { mode: 0o600 });
}

export function clearSession(): void {
  try {
    rmSync(sessionFile(), { force: true });
  } catch {
    /* nothing to clear */
  }
}
