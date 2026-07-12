import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { ChevronDownIcon, PlusIcon } from './icons';
import { showErrorToast } from './Toasts';
import { StatusChip } from '../sessions/SessionCard';
import type { Session } from '../sessions/types';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from './a11y';

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

export function ApplyMarkupMenu({ artifactId, path, channelId, sessions = {}, onSpawnNewAgent }: ApplyMarkupMenuProps) {
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
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-strong bg-surface-overlay px-2.5 text-xs font-semibold text-fg-secondary shadow-sm hover:bg-edge-strong hover:text-fg max-md:h-11"
          >
            Apply with agent
            <ChevronDownIcon size={13} />
          </button>
        </MenuTrigger>
        <MenuContent align="end" className="w-72 max-w-[calc(100vw-1rem)] bg-surface-raised">
          <MenuLabel className="px-2 py-1.5 text-3xs">Choose session</MenuLabel>
          {sessionList.length === 0 ? (
            <div className="px-2 py-2 text-xs text-fg-muted">No running or completed sessions in this channel</div>
          ) : (
            sessionList.map((session) => (
              <MenuItem
                key={session.id}
                disabled={busySessionId != null}
                onSelect={(event) => {
                  event.preventDefault();
                  void applyToSession(session);
                }}
                className="items-start gap-2 py-2 text-left max-md:min-h-11"
              >
                <StatusChip status={session.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-fg">{session.title}</span>
                  {busySessionId === session.id && (
                    <span className="mt-0.5 block text-3xs text-fg-muted">Sending...</span>
                  )}
                </span>
              </MenuItem>
            ))
          )}
          <MenuSeparator />
          <MenuItem
            onSelect={spawnNewAgent}
            disabled={!onSpawnNewAgent}
            className="text-xs font-medium text-fg-secondary data-[highlighted]:text-fg data-[disabled]:text-fg-faint max-md:min-h-11"
          >
            <PlusIcon size={14} />
            New agent...
          </MenuItem>
        </MenuContent>
      </Menu>
      {notice && (
        <div
          role="status"
          className="absolute right-0 top-9 z-[80] w-56 rounded-md border border-success/30 bg-surface-overlay px-3 py-2 text-xs text-success-text shadow-lg"
        >
          {notice}
        </div>
      )}
    </div>
  );
}
