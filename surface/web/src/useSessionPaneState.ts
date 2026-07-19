import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppAction, AppState, Channel, Session, UserRef } from '@atrium/surface-client';
import { isPendingSessionId, sessionFromWire } from './sessions/types';
import { sessionsApi, type SessionApi } from './sessions/api';
export type SessionView = 'channel' | 'split' | 'focus';

const NO_WATCHERS: UserRef[] = [];
export const AGENT_SPLIT_OPT_IN_KEY = 'atrium.agentSplitOptIn';
export const AGENT_FOCUS_OPT_IN_KEY = 'atrium.agentFocusOptIn';

type DispatchAppAction = (action: AppAction) => void;

/**
 * Whether the channel <main> should render. `/c/:id/t/:root` is a channel
 * place: the thread keeps its attached session selected for mode-flip
 * continuity, but that retained selection must not keep MAIN swapped to the
 * agent (the focus-default layout would otherwise unmount the channel and
 * leave the thread panel floating beside a blank).
 */
export function channelMainVisible(view: SessionView, threadRouteOpen: boolean): boolean {
  return view !== 'focus' || threadRouteOpen;
}

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
  // The agent opens beside MAIN by default. Focus is a durable user opt-in.
  const [focused, setFocused] = useState(false);
  const [focusOptIn, setFocusOptIn] = useState(() => {
    if (typeof window === 'undefined') return false;
    const legacySplitOptIn = window.localStorage.getItem(AGENT_SPLIT_OPT_IN_KEY);
    if (legacySplitOptIn === 'true') return false;
    return window.localStorage.getItem(AGENT_FOCUS_OPT_IN_KEY) === 'true';
  });

  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(AGENT_SPLIT_OPT_IN_KEY);
  }, []);

  useEffect(() => {
    setFocused(Boolean(openSessionId && focusedFromUrl));
  }, [focusedFromUrl, openSessionId]);

  const focusLayout = isMobileViewport || focusedFromUrl || focusOptIn || focused;
  const view: SessionView = openSessionId ? (focusLayout ? 'focus' : 'split') : 'channel';
  const sessionPaneLayout: SessionView = focusLayout ? 'focus' : 'split';

  const persistFocusOptIn = useCallback((enabled: boolean) => {
    setFocusOptIn(enabled);
    if (typeof window !== 'undefined') window.localStorage.setItem(AGENT_FOCUS_OPT_IN_KEY, String(enabled));
  }, []);

  const setView = useCallback(
    (next: SessionView) => {
      if (next === 'channel') dispatch({ type: 'close-session' });
      else if (openSessionId) {
        const nextFocused = next === 'focus';
        persistFocusOptIn(nextFocused);
        setFocused(nextFocused);
      }
    },
    [dispatch, openSessionId, persistFocusOptIn],
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
    const nextFocused = !focusLayout;
    persistFocusOptIn(nextFocused);
    setFocused(nextFocused);
  }, [focusLayout, persistFocusOptIn]);

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
