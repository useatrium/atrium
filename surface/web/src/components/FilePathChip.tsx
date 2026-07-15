import { useState, type MouseEvent } from 'react';
import { agentPathBasename, type AgentPathRef } from '@atrium/surface-client/agent-paths';
import { navigate, URL_PARAMS } from '../router';
import { FileIcon } from './icons';
import { showErrorToast } from './Toasts';

export interface FilePathChipProps {
  refInfo: AgentPathRef;
  sessionId?: string | null;
  channelId?: string | null;
  compact?: boolean;
}

type ResolvedFile = { artifactId: string; path: string; tombstoned: boolean };

function canonicalPathFor(refInfo: AgentPathRef, channelId?: string | null): string | null {
  if (refInfo.kind !== 'workspace-relative') return refInfo.canonicalPath;
  return channelId ? `shared/channels/${channelId}/${refInfo.relPath}` : null;
}

function fileDestination(file: ResolvedFile): string {
  const params = new URLSearchParams();
  const segments = file.path.split('/').filter(Boolean);
  const dir = segments.slice(0, -1).join('/');
  if (dir) params.set(URL_PARAMS.dir, dir);
  params.set(URL_PARAMS.file, file.artifactId);
  return `/files?${params.toString()}`;
}

export function FilePathChip({ refInfo, channelId, compact = false }: FilePathChipProps) {
  const [resolving, setResolving] = useState(false);
  const label = agentPathBasename(refInfo);

  // Failures surface as a toast and the chip stays clickable — capture can land
  // seconds after the message renders, so a later retry may succeed.
  const onClick = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (resolving) return;
    const canonicalPath = canonicalPathFor(refInfo, channelId);
    if (!canonicalPath) {
      showErrorToast(`Couldn't open ${label} — this link can't be resolved outside its session.`);
      return;
    }
    setResolving(true);
    try {
      const response = await fetch(`/api/files/by-path?path=${encodeURIComponent(canonicalPath)}`, {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        showErrorToast(
          response.status === 404
            ? `Couldn't open ${label} — the file wasn't captured or was removed.`
            : `Couldn't open ${label} — try again.`,
        );
        return;
      }
      const file = (await response.json()) as ResolvedFile;
      navigate(fileDestination(file));
    } catch {
      showErrorToast(`Couldn't open ${label} — try again.`);
    } finally {
      setResolving(false);
    }
  };

  if (compact) {
    return (
      <button
        type="button"
        title={label}
        onClick={onClick}
        className="font-medium text-accent-text no-underline hover:underline"
      >
        {label}
      </button>
    );
  }

  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className="mx-0.5 inline-flex max-w-[18rem] items-center gap-1 rounded border border-accent-border-muted/50 bg-accent-hover/10 px-1.5 py-0.5 align-[-2px] text-[0.86em] font-medium text-accent-text-strong no-underline hover:bg-accent-hover/15 hover:text-accent-text-strong"
    >
      <FileIcon size={14} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
