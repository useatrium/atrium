import { createContext, useContext, type ReactNode } from 'react';
import type { Channel, Session } from '@atrium/surface-client';

export interface SessionsContextValue {
  sessions: Record<string, Session>;
  channels: Channel[];
  requestSession: (id: string) => void;
}

/**
 * Live session/channel state for leaf components that need an ARBITRARY id.
 *
 * The rest of this app prop-drills `state.sessions`, and that is still right for
 * anything an ancestor already knows it needs. A link card is different: the ids
 * it wants come from message text, so no ancestor can pass them down — and
 * `MessageRow` is `memo(...)`, so a resolver drilled through it would stop
 * re-rendering when a session's status moved, leaving a card claiming "Working"
 * on finished work. Context updates cross memoized boundaries; that is the whole
 * reason this exists. Read-only by design: `requestSession` fetches a miss once
 * and dispatches into the same store, so liveness keeps flowing over the WS.
 */
const SessionsContext = createContext<SessionsContextValue | null>(null);

export function SessionsContextProvider({ value, children }: { value: SessionsContextValue; children: ReactNode }) {
  return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>;
}

export function useSessionsContext(): SessionsContextValue | null {
  return useContext(SessionsContext);
}
