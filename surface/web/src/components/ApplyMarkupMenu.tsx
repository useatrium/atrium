import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { ChevronDownIcon, PlusIcon } from './icons';
import { showErrorToast } from './Toasts';
import { StatusChip } from '../sessions/SessionCard';
import type { Session } from '../sessions/types';

const SESSION_CAP = 8;

export interface ApplyMarkupMenuProps {
  artifactId: string;
  path: string;
  channelId: string;
  sessions?: Record<string, Session>;
  onSpawnNewAgent?: (task: string) => void;
}

function applyTask(path: string): string {
  return `Apply the markup in ${path} (my tracked changes + comments): read it, apply the edits, address the comments, and produce a clean revision of the file.`;
}

function isNoMarkupError(err: unknown): boolean {
  if (err instanceof ApiError && err.status === 400) {
    return /no[_ -]?markup|No markup/i.test(err.message);
  }
  return err instanceof Error && /no[_ -]?markup|No markup/i.test(err.message);
}

function steerableSession(session: Session, channelId: string): boolean {
  return session.channelId === channelId && (session.status === 'running' || session.status === 'completed');
}

export function ApplyMarkupMenu({
  artifactId,
  path,
  channelId,
  sessions = {},
  onSpawnNewAgent,
}: ApplyMarkupMenuProps) {
  const [open, setOpen] = useState(false);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const sessionList = useMemo(
    () =>
      Object.values(sessions)
        .filter((session) => steerableSession(session, channelId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, SESSION_CAP),
    [channelId, sessions],
  );

  const showNotice = (message: string) => {
    setNotice(message);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 2600);
  };

  const applyToSession = async (session: Session) => {
    setBusySessionId(session.id);
    try {
      await api.applyArtifactMarkup(artifactId, { sessionId: session.id, opId: crypto.randomUUID() });
      setOpen(false);
      showNotice(`Sent to ${session.title}`);
    } catch (err) {
      if (isNoMarkupError(err)) showErrorToast('No markup in this document');
      else showErrorToast(err instanceof Error ? err.message : 'Could not apply markup');
    } finally {
      setBusySessionId(null);
    }
  };

  const spawnNewAgent = () => {
    onSpawnNewAgent?.(applyTask(path));
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-strong bg-surface-overlay px-2.5 text-xs font-semibold text-fg-secondary shadow-sm hover:bg-edge-strong hover:text-fg"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Apply with agent
        <ChevronDownIcon size={13} />
      </button>
      {notice && (
        <div role="status" className="absolute right-0 top-9 z-[80] w-56 rounded-md border border-success/30 bg-surface-overlay px-3 py-2 text-xs text-success-text shadow-lg">
          {notice}
        </div>
      )}
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-[80] w-72 overflow-hidden rounded-md border border-edge-strong bg-surface-raised py-1 shadow-2xl"
        >
          <div className="px-3 py-2 text-3xs font-semibold uppercase tracking-wider text-fg-muted">
            Choose session
          </div>
          {sessionList.length === 0 ? (
            <div className="px-3 py-3 text-xs text-fg-muted">No running or completed sessions in this channel</div>
          ) : (
            sessionList.map((session) => (
              <button
                key={session.id}
                type="button"
                role="menuitem"
                disabled={busySessionId != null}
                onClick={() => void applyToSession(session)}
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-overlay disabled:cursor-default disabled:opacity-60"
              >
                <StatusChip status={session.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-fg">{session.title}</span>
                  {busySessionId === session.id && (
                    <span className="mt-0.5 block text-3xs text-fg-muted">Sending...</span>
                  )}
                </span>
              </button>
            ))
          )}
          <div className="my-1 border-t border-edge" />
          <button
            type="button"
            role="menuitem"
            onClick={spawnNewAgent}
            disabled={!onSpawnNewAgent}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg disabled:cursor-default disabled:text-fg-faint"
          >
            <PlusIcon size={14} />
            New agent...
          </button>
        </div>
      )}
    </div>
  );
}

export default ApplyMarkupMenu;
