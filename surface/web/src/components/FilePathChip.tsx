import { useState, type MouseEvent } from 'react';
import { agentPathBasename, type AgentPathRef } from '@atrium/surface-client/agent-paths';
import { navigate, URL_PARAMS } from '../router';
import { FileIcon } from './icons';

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
  const [unavailable, setUnavailable] = useState(false);
  const label = agentPathBasename(refInfo);
  const title = unavailable ? 'File not available (not captured or removed)' : label;

  const onClick = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (unavailable) return;
    const canonicalPath = canonicalPathFor(refInfo, channelId);
    if (!canonicalPath) {
      setUnavailable(true);
      return;
    }
    try {
      const response = await fetch(`/api/files/by-path?path=${encodeURIComponent(canonicalPath)}`, {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        setUnavailable(true);
        return;
      }
      const file = (await response.json()) as ResolvedFile;
      navigate(fileDestination(file));
    } catch {
      setUnavailable(true);
    }
  };

  if (compact) {
    return (
      <button
        type="button"
        title={title}
        disabled={unavailable}
        onClick={onClick}
        className={`font-medium no-underline ${
          unavailable ? 'cursor-default text-fg-muted' : 'text-accent-text hover:underline'
        }`}
      >
        {label}
      </button>
    );
  }

  return (
    <button
      type="button"
      title={title}
      disabled={unavailable}
      onClick={onClick}
      className={`mx-0.5 inline-flex max-w-[18rem] items-center gap-1 rounded border border-accent-border-muted/50 bg-accent-hover/10 px-1.5 py-0.5 align-[-2px] text-[0.86em] font-medium no-underline ${
        unavailable
          ? 'cursor-default text-fg-muted'
          : 'text-accent-text-strong hover:bg-accent-hover/15 hover:text-accent-text-strong'
      }`}
    >
      <FileIcon size={14} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
