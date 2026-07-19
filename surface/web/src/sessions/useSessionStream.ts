import type { SessionStreamTransport } from '@atrium/centaur-client';
import { type SessionStream, useSessionStreamCore } from '@atrium/surface-client';
import { sessionsApi } from './api';

export type { SessionStream };

// Module-constant transport over the proxied EventSource — a stable identity so
// the core's machine effect fires on sessionId only (matching the pre-shared hook).
const transport: SessionStreamTransport = {
  open: (id, afterEventId, callbacks) => sessionsApi.openStream(id, afterEventId, callbacks),
};

export function useSessionStream(sessionId: string | null, active = false): SessionStream {
  return useSessionStreamCore(sessionId, active, transport);
}
