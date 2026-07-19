import { useMemo } from 'react';
import { fetch as expoFetch } from 'expo/fetch';
import { type SessionStream, useSessionStreamCore } from '@atrium/surface-client';
import { useRequiredSession } from './session';
import { createMobileSessionStreamTransport } from './sessionStreamCore';

export type { SessionStream };

export function useSessionStream(sessionId: string | null, active = false): SessionStream {
  const { serverUrl, token } = useRequiredSession();
  // Rebuild the fetch-SSE transport only when auth inputs change, so the core's
  // machine effect fires on sessionId|serverUrl|token (matching the pre-shared hook).
  const transport = useMemo(
    () => createMobileSessionStreamTransport({ baseUrl: serverUrl, token, fetchImpl: expoFetch }),
    [serverUrl, token],
  );
  return useSessionStreamCore(sessionId, active, transport);
}
