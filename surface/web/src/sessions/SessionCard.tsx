import { useEffect, useState } from 'react';
import { sessionsApi } from './api';
import type { Session } from './types';

/** Compact repo label used by the session pane's details popover. */
export function repoBranchTitle(repo: string, branch?: string | null): string {
  return branch ? `${repo} · branch ${branch}` : repo;
}

/** 1s ticker for live elapsed displays; idle when `active` is false. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const TOUCH_TARGET =
  '[@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center';

function SteerActionLink({
  sessionId,
  prompt,
  label,
  sentLabel,
  testid,
  nowrap = false,
}: {
  sessionId: string;
  prompt: string;
  label: string;
  sentLabel: string;
  testid: string;
  nowrap?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);
  if (sent) return <span className={`text-2xs text-fg-muted ${nowrap ? 'whitespace-nowrap' : ''}`}>{sentLabel}</span>;
  return (
    <button
      type="button"
      data-testid={testid}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        setError(false);
        sessionsApi
          .sendMessage(sessionId, prompt, undefined, true)
          .then(() => setSent(true))
          .catch(() => setError(true))
          .finally(() => setBusy(false));
      }}
      className={`inline-block text-2xs font-semibold text-danger-text hover:underline disabled:opacity-60 ${
        nowrap ? 'whitespace-nowrap' : ''
      } ${TOUCH_TARGET}`}
    >
      {error ? `${label} didn't send — try again` : label}
    </button>
  );
}

export function RetryTurnAction({ sessionId, nowrap = false }: { sessionId: string; nowrap?: boolean }) {
  return (
    <SteerActionLink
      sessionId={sessionId}
      prompt="Retry the failed turn."
      label="Retry turn"
      sentLabel="Retrying…"
      testid="card-retry-turn"
      nowrap={nowrap}
    />
  );
}

export function AskWhyAction({ sessionId, nowrap = false }: { sessionId: string; nowrap?: boolean }) {
  return (
    <SteerActionLink
      sessionId={sessionId}
      prompt="The last turn failed — explain what went wrong and what you'd try differently, then wait for my go-ahead."
      label="Ask why"
      sentLabel="Asked — check the thread"
      testid="card-ask-why"
      nowrap={nowrap}
    />
  );
}

export function sessionElapsedMs(session: Session, now: number): number {
  const start = new Date(session.createdAt).getTime();
  const end = session.completedAt ? new Date(session.completedAt).getTime() : now;
  return end - start;
}
