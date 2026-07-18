import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppAction, AppState, Channel, Session, UserRef } from '@atrium/surface-client';
import { isPendingSessionId, sessionFromWire } from './sessions/types';
import { sessionsApi, type SessionApi } from './sessions/api';
import type { SessionView } from './sessions/ViewToggle';

const NO_WATCHERS: UserRef[] = [];
export const AGENT_SPLIT_OPT_IN_KEY = 'atrium.agentSplitOptIn';

type DispatchAppAction = (action: AppAction) => void;

export function sessionSpectatorCounts(presence: AppState['presence']): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, users] of Object.entries(presence)) {
    if (key.startsWith('session:')) out[key.slice('session:'.length)] = users.length;
  }
  return out;
}

export function useSessionPaneState({
  activeChannel,
  client = sessionsApi,
  dispatch,
  focusedFromUrl = false,
  isMobileViewport,
  openSessionId,
  presence,
  sessions,
}: {
  activeChannel: Channel | null;
  client?: Pick<SessionApi, 'get'>;
  dispatch: DispatchAppAction;
  focusedFromUrl?: boolean;
  isMobileViewport: boolean;
  openSessionId: string | null;
  presence: AppState['presence'];
  sessions: AppState['sessions'];
}) {
  // Agent focus owns MAIN by default. Split remains a durable user opt-in.
  const [focused, setFocused] = useState(false);
  const [splitOptIn, setSplitOptIn] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem(AGENT_SPLIT_OPT_IN_KEY) === 'true',
  );

  useEffect(() => {
    setFocused(Boolean(openSessionId && focusedFromUrl));
  }, [focusedFromUrl, openSessionId]);

  const focusLayout = isMobileViewport || focusedFromUrl || !splitOptIn || focused;
  const view: SessionView = openSessionId ? (focusLayout ? 'focus' : 'split') : 'channel';
  const sessionPaneLayout: SessionView = focusLayout ? 'focus' : 'split';

  const persistSplitOptIn = useCallback((enabled: boolean) => {
    setSplitOptIn(enabled);
    if (typeof window !== 'undefined') window.localStorage.setItem(AGENT_SPLIT_OPT_IN_KEY, String(enabled));
  }, []);

  const setView = useCallback(
    (next: SessionView) => {
      if (next === 'channel') dispatch({ type: 'close-session' });
      else if (openSessionId) {
        const split = next === 'split';
        persistSplitOptIn(split);
        setFocused(!split);
      }
    },
    [dispatch, openSessionId, persistSplitOptIn],
  );

  const openSession = useCallback(
    (sessionId: string) => {
      if (isPendingSessionId(sessionId)) return;
      setFocused(false);
      dispatch({ type: 'open-session', sessionId });
      client
        .get(sessionId)
        .then(({ session }) => dispatch({ type: 'session-upsert', session: sessionFromWire(session) }))
        .catch(() => dispatch({ type: 'session-load-failed', sessionId }));
    },
    [client, dispatch],
  );

  const paneSession: Session | null = openSessionId ? (sessions[openSessionId] ?? null) : null;

  const hasChannelSessions = useMemo(
    () => activeChannel != null && Object.values(sessions).some((session) => session.channelId === activeChannel.id),
    [activeChannel, sessions],
  );

  const paneWatchers = paneSession ? (presence[`session:${paneSession.id}`] ?? NO_WATCHERS) : NO_WATCHERS;

  const spectators = useMemo(() => sessionSpectatorCounts(presence), [presence]);

  const toggleFocus = useCallback(() => {
    const split = focusLayout;
    persistSplitOptIn(split);
    setFocused(!split);
  }, [focusLayout, persistSplitOptIn]);

  return {
    focused: focusLayout,
    hasChannelSessions,
    openSession,
    paneSession,
    paneWatchers,
    sessionPaneLayout,
    setFocused,
    setView,
    spectators,
    toggleFocus,
    view,
  };
}
