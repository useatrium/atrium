import { useEffect, useState } from 'react';
import { resolveEntryQuote, type ResolvedEntryQuote } from '../lib/entryLinks';

const MAX_EXCERPT_LENGTH = 200;

function EventIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4">
      <path
        d="M4.5 5.5h11v6.75h-6L6.25 15v-2.75H4.5z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function RecordIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4">
      <path
        d="M5.5 4.5h9v11h-9zM7.75 8h4.5M7.75 10.5h4.5M7.75 13h2.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function ArtifactIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4">
      <path
        d="M6 4.5h5.25L14.5 8v7.5H6zM11.25 4.75V8h3"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function TargetIcon({ targetType }: { targetType: ResolvedEntryQuote['targetType'] }) {
  if (targetType === 'record') return <RecordIcon />;
  if (targetType === 'artifact') return <ArtifactIcon />;
  return <EventIcon />;
}

function targetLabel(targetType: ResolvedEntryQuote['targetType']): string {
  if (targetType === 'record') return 'Transcript record';
  if (targetType === 'artifact') return 'Artifact';
  return 'Chat event';
}

function excerpt(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_EXCERPT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_EXCERPT_LENGTH - 3).trimEnd()}...`;
}

function contextLine(entry: ResolvedEntryQuote): string | null {
  const parts = [
    entry.location.channelName ? `#${entry.location.channelName}` : null,
    entry.location.sessionTitle,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(' - ') : null;
}

export function EntryQuoteCard({ entry }: { entry: ResolvedEntryQuote }) {
  const context = contextLine(entry);

  if (entry.tombstoned) {
    return (
      <a
        href={`/e/${entry.handle}`}
        className="block rounded-md border border-edge bg-surface-raised/45 px-3 py-2 text-fg-muted no-underline hover:border-edge-strong hover:bg-surface-raised/65"
      >
        <div className="flex items-center gap-2 text-xs">
          <span className="text-fg-muted">
            <TargetIcon targetType={entry.targetType} />
          </span>
          <span className="font-medium">deleted entry</span>
          {context ? <span className="truncate text-fg-muted">{context}</span> : null}
        </div>
      </a>
    );
  }

  return (
    <a
      href={`/e/${entry.handle}`}
      className="block rounded-md border border-edge bg-surface-raised/55 px-3 py-2 text-fg-body no-underline hover:border-accent-hover/70 hover:bg-surface-raised"
    >
      <div className="flex items-center gap-2 text-xs text-fg-secondary">
        <span className="text-accent-text">
          <TargetIcon targetType={entry.targetType} />
        </span>
        <span className="font-medium text-fg">{entry.actorLabel || targetLabel(entry.targetType)}</span>
        <span className="text-fg-muted">{targetLabel(entry.targetType)}</span>
      </div>
      <blockquote className="mt-1 border-l-2 border-edge-strong pl-2 text-sm leading-relaxed text-fg-body">
        {excerpt(entry.text)}
      </blockquote>
      {context ? <div className="mt-1 text-xs text-fg-muted">{context}</div> : null}
    </a>
  );
}

export function EntryQuoteCards({ handles }: { handles: string[] }) {
  const key = handles.join('\n');
  const [entries, setEntries] = useState<ResolvedEntryQuote[]>([]);

  useEffect(() => {
    let active = true;
    setEntries([]);
    if (handles.length === 0) return undefined;

    void Promise.all(handles.map((handle) => resolveEntryQuote(handle))).then((resolved) => {
      if (!active) return;
      setEntries(resolved.filter((entry): entry is ResolvedEntryQuote => entry != null));
    });

    return () => {
      active = false;
    };
  }, [key]);

  if (entries.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-1.5 whitespace-normal">
      {entries.map((entry) => (
        <EntryQuoteCard key={entry.handle} entry={entry} />
      ))}
    </div>
  );
}
