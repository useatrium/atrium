import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomId, useWs, type UserRef, type WireEvent } from '@atrium/surface-client';
import { ApiError, api } from '../api';
import { clearCache } from '../cacheIdb';
import { ClaudeConnectDialog } from '../components/ClaudeConnectDialog';
import { CodexConnectDialog } from '../components/CodexConnectDialog';
import { GitHubConnectionDialog } from '../components/GitHubConnectionDialog';
import { clearDesktopSession, desktopWsUrl, isDesktop } from '../desktop';
import { useAgentProfiles } from '../useAgentProfiles';
import { useConnections } from '../useConnections';
import { useProviderCredentials } from '../useProviderCredentials';
import { useTypingIndicators } from '../useTypingIndicators';
import { sessionsApi } from './api';
import { SessionPane } from './SessionPane';
import {
  applySessionEvent,
  isPendingSessionId,
  isStalledSessionStatus,
  isTerminalSessionStatus,
  sessionFromWire,
  type Session,
  type SessionStatus,
} from './types';

type LoadState = 'loading' | 'ready' | 'not-found';

// Same WS routing as Chat: desktop shell → absolute server origin with a fresh
// bearer token per attempt; e2e may override; browsers keep same-origin /ws.
const browserWsUrl = import.meta.env.VITE_ATRIUM_WS_URL?.trim();
const wsOptions = isDesktop ? { url: () => desktopWsUrl() ?? '' } : browserWsUrl ? { url: browserWsUrl } : undefined;

const TITLE_STATUS_LABELS: Partial<Record<SessionStatus, string>> = { spawning: 'starting' };

export function sessionPaneDocumentTitle(session: Session, opts: { now?: number; unseen?: boolean } = {}): string {
  const now = opts.now ?? Date.now();
  const status =
    !isTerminalSessionStatus(session.status) && isStalledSessionStatus(session, now)
      ? 'stalled'
      : (TITLE_STATUS_LABELS[session.status] ?? session.status);
  return `${opts.unseen ? '● ' : ''}${session.title} · ${status}`;
}

export function SessionPanePage({ sessionId, me }: { sessionId: string; me: UserRef }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [watchers, setWatchers] = useState<UserRef[]>([]);
  const [failedSteer, setFailedSteer] = useState<string | null>(null);
  const [failedCancel, setFailedCancel] = useState(false);
  const [hasUnseenOutputs, setHasUnseenOutputs] = useState(false);
  const lastSessionTypingSentRef = useRef(0);
  const { onSessionTyping, sessionTyping } = useTypingIndicators({
    activeChannelId: null,
    meId: me.id,
  });
  const {
    disconnectClaude,
    disconnectCodex,
    providerCredentials,
    providerDialog,
    saveClaudeToken,
    saveCodexAuthJson,
    setProviderDialog,
  } = useProviderCredentials();
  const {
    activateGitHubIdentity,
    available: connectionsAvailable,
    connectGitHub,
    connectionDialog,
    disconnectGitHub,
    githubConnection,
    setConnectionDialog,
  } = useConnections();
  const agentProfiles = useAgentProfiles();
  const onApiError = useCallback((err: unknown) => {
    if (!(err instanceof ApiError && err.status === 401)) return;
    void clearCache()
      .catch(() => {})
      .finally(() => {
        void clearDesktopSession().finally(() => {
          window.location.assign('/');
        });
      });
  }, []);

  const fetchSession = useCallback(
    async ({ showLoading }: { showLoading: boolean }) => {
      if (isPendingSessionId(sessionId)) {
        setSession(null);
        setLoadState('not-found');
        return;
      }
      if (showLoading) setLoadState('loading');
      try {
        const { session: wire } = await sessionsApi.get(sessionId);
        setSession(sessionFromWire(wire));
        setLoadState('ready');
      } catch (err) {
        console.warn('failed to load session pane', err);
        if (err instanceof ApiError && err.status === 401) {
          onApiError(err);
          return;
        }
        setSession(null);
        setLoadState('not-found');
      }
    },
    [onApiError, sessionId],
  );

  useEffect(() => {
    let disposed = false;
    async function load() {
      if (isPendingSessionId(sessionId)) {
        setSession(null);
        setLoadState('not-found');
        return;
      }
      setSession(null);
      setWatchers([]);
      setHasUnseenOutputs(false);
      setLoadState('loading');
      try {
        const { session: wire } = await sessionsApi.get(sessionId);
        if (!disposed) {
          setSession(sessionFromWire(wire));
          setLoadState('ready');
        }
      } catch (err) {
        console.warn('failed to load session pane', err);
        if (err instanceof ApiError && err.status === 401) {
          if (!disposed) onApiError(err);
          return;
        }
        if (!disposed) {
          setSession(null);
          setLoadState('not-found');
        }
      }
    }
    void load();
    return () => {
      disposed = true;
    };
  }, [onApiError, sessionId]);

  const wsKeys = useMemo(() => {
    if (!session) return [];
    return [`session:${session.id}`, session.channelId];
  }, [session]);

  const ws = useWs(
    wsKeys.length > 0,
    wsKeys,
    {
      onEvent: (event: WireEvent) => {
        if (!event.type.startsWith('session.')) return;
        setSession((prev) => {
          if (!prev) return prev;
          const next = applySessionEvent({ [prev.id]: prev }, event)[prev.id];
          return next ?? prev;
        });
      },
      onPresence: (key, users) => {
        if (key === `session:${sessionId}`) setWatchers(users);
      },
      onSessionTyping: (typingSessionId, user) => {
        if (typingSessionId === sessionId) onSessionTyping(typingSessionId, user);
      },
      onOpen: () => {
        void fetchSession({ showLoading: false });
      },
      onStatus: () => {},
    },
    null,
    wsOptions,
  );

  useEffect(() => {
    if (session) document.title = sessionPaneDocumentTitle(session, { unseen: hasUnseenOutputs });
  }, [hasUnseenOutputs, session]);

  const notifySessionTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastSessionTypingSentRef.current < 2500) return;
    lastSessionTypingSentRef.current = now;
    ws.sendSessionTyping(sessionId);
  }, [sessionId, ws]);

  const steerSession = useCallback(async (id: string, text: string, effort?: string) => {
    setFailedSteer(null);
    try {
      await sessionsApi.sendMessage(id, text, effort);
    } catch (err) {
      setFailedSteer(text);
      throw err;
    }
  }, []);

  const answerQuestion = useCallback(
    (id: string, questionId: string, answers: Record<string, { answers: string[] }>) =>
      sessionsApi.answerQuestion(id, questionId, answers, randomId()),
    [],
  );

  const cancelSession = useCallback(async (id: string) => {
    setFailedCancel(false);
    try {
      await sessionsApi.cancel(id, randomId());
    } catch (err) {
      setFailedCancel(true);
      throw err;
    }
  }, []);

  const stopTurn = useCallback(async (id: string) => {
    setFailedCancel(false);
    try {
      await api.stopTurn(id, { opId: randomId() });
    } catch (err) {
      setFailedCancel(true);
      throw err;
    }
  }, []);

  return (
    <div data-testid="session-pane-page" className="flex h-dvh min-w-0 bg-surface">
      {session ? (
        <SessionPane
          key={sessionId}
          session={session}
          me={me}
          watchers={watchers}
          typers={Object.values(sessionTyping[session.id] ?? {}).map((t) => t.user)}
          onComposerTyping={notifySessionTyping}
          onClose={() => {}}
          onAnswerQuestion={answerQuestion}
          onSteer={steerSession}
          failedSteer={failedSteer}
          onClearFailedSteer={() => setFailedSteer(null)}
          onCancelSession={cancelSession}
          onStopTurn={stopTurn}
          failedCancel={failedCancel}
          onClearFailedCancel={() => setFailedCancel(false)}
          providerCredentials={providerCredentials}
          githubConnection={githubConnection}
          onConnectProvider={setProviderDialog}
          onConnectGitHub={() => setConnectionDialog('github')}
          agentProfiles={agentProfiles}
          layout="focus"
          popout
          onUnseenOutputs={setHasUnseenOutputs}
          filesDefaultScope="session"
          onApiError={onApiError}
        />
      ) : (
        <SessionPanePagePlaceholder notFound={loadState === 'not-found'} sessionId={sessionId} />
      )}

      {connectionDialog === 'github' && (
        <GitHubConnectionDialog
          available={connectionsAvailable}
          status={githubConnection}
          onCancel={() => setConnectionDialog(null)}
          onConnect={connectGitHub}
          onActivate={activateGitHubIdentity}
          onDisconnect={disconnectGitHub}
        />
      )}

      {providerDialog === 'claude-code' && (
        <ClaudeConnectDialog
          status={providerCredentials['claude-code']}
          onCancel={() => setProviderDialog(null)}
          onSave={saveClaudeToken}
          onDisconnect={disconnectClaude}
        />
      )}

      {providerDialog === 'codex' && (
        <CodexConnectDialog
          status={providerCredentials.codex}
          onCancel={() => setProviderDialog(null)}
          onSave={saveCodexAuthJson}
          onDisconnect={disconnectCodex}
        />
      )}
    </div>
  );
}

function SessionPanePagePlaceholder({ notFound, sessionId }: { notFound: boolean; sessionId: string }) {
  return (
    <aside className="flex min-w-0 flex-1 flex-col border-l border-edge bg-surface">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-4">
        <h2 className="text-sm font-semibold text-fg">Agent</h2>
        <a
          href={`/s/${sessionId}`}
          className="rounded-md px-2 py-1 text-2xs text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          Full app
        </a>
      </header>
      {notFound ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
          <div className="text-sm font-medium text-fg-secondary">Agent not found</div>
          <div className="text-xs text-fg-muted">It may have been removed, or the link is wrong.</div>
          <a
            href={`/s/${sessionId}`}
            className="mt-2 rounded-md border border-edge-strong px-3 py-1 text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg"
          >
            Open full app
          </a>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">Loading session…</div>
      )}
    </aside>
  );
}
