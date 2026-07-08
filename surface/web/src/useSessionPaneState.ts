import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppAction, AppState, Channel, Session, UserRef } from '@atrium/surface-client';
import { isPendingSessionId, sessionFromWire } from './sessions/types';
import { sessionsApi, type SessionApi } from './sessions/api';
import type { SessionView } from './sessions/ViewToggle';

const NO_WATCHERS: UserRef[] = [];

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
  // Layout grammar: channel / split / focus. A permalink may set focus from Chat.
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    setFocused(Boolean(openSessionId && focusedFromUrl));
  }, [focusedFromUrl, openSessionId]);

  const view: SessionView = openSessionId ? (focused ? 'focus' : 'split') : 'channel';
  const sessionPaneLayout: SessionView = isMobileViewport ? 'focus' : focused ? 'focus' : 'split';

  const setView = useCallback(
    (next: SessionView) => {
      if (next === 'channel') dispatch({ type: 'close-session' });
      else if (openSessionId) setFocused(next === 'focus');
    },
    [dispatch, openSessionId],
  );

  const openSession = useCallback(
    (sessionId: string) => {
      if (isPendingSessionId(sessionId)) return;
      setFocused(false);
      dispatch({ type: 'open-session', sessionId });
      client
        .get(sessionId)
        .then(({ session }) =>
          dispatch({ type: 'session-upsert', session: sessionFromWire(session) }),
        )
        .catch(() => dispatch({ type: 'session-load-failed', sessionId }));
    },
    [client, dispatch],
  );

  const paneSession: Session | null = openSessionId ? sessions[openSessionId] ?? null : null;

  const hasChannelSessions = useMemo(
    () =>
      activeChannel != null &&
      Object.values(sessions).some((session) => session.channelId === activeChannel.id),
    [activeChannel, sessions],
  );

  const paneWatchers = paneSession ? presence[`session:${paneSession.id}`] ?? NO_WATCHERS : NO_WATCHERS;

  const spectators = useMemo(() => sessionSpectatorCounts(presence), [presence]);

  const toggleFocus = useCallback(() => setFocused((value) => !value), []);

  return {
    focused,
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
