import {
  Suspense,
  createContext,
  lazy,
  useContext,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import {
  containsCriticMarkup,
  parseCriticMarkup,
  type CriticBlock,
} from '@atrium/surface-client';
import { resolveEntryQuote, type ResolvedEntryQuote } from '../lib/entryLinks';
import { CriticMarkupView } from './CriticMarkupView';
import { splitMarkdownFrontmatter } from './MarkupPane';

const MAX_EXCERPT_LENGTH = 200;
const MAX_MARKUP_CARD_BYTES = 64 * 1024;

export interface EntryQuoteApplyContext {
  channelId: string;
  sessions?: Record<string, import('../sessions/types').Session>;
  onSpawnNewAgent?: (task: string) => void;
}

const EntryQuoteApplyContext = createContext<EntryQuoteApplyContext | null>(null);

export function EntryQuoteApplyContextProvider({
  value,
  children,
}: {
  value: EntryQuoteApplyContext | null;
  children: ReactNode;
}) {
  return <EntryQuoteApplyContext.Provider value={value}>{children}</EntryQuoteApplyContext.Provider>;
}

type ApplyMarkupMenuProps = {
  artifactId: string;
  path: string;
  channelId: string;
  sessions?: Record<string, import('../sessions/types').Session>;
  onSpawnNewAgent?: (task: string) => void;
};

// Static specifier so Vite bundles the menu as a lazy chunk.
const ApplyMarkupMenu = lazy(async () => {
  const mod = await import('./ApplyMarkupMenu');
  return { default: mod.default as ComponentType<ApplyMarkupMenuProps> };
});

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

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

function artifactIdFromHandle(handle: string): string | null {
  return handle.startsWith('art_') ? handle.slice(4) : null;
}

function frontmatterTitle(frontmatter: string): string | null {
  const match = frontmatter.match(/(?:^|\r?\n)title:\s*(.+?)(?:\r?\n|$)/);
  if (!match) return null;
  return match[1]!.trim().replace(/^['"]|['"]$/g, '') || null;
}

function isProbablyText(contentType: string, text: string): boolean {
  const type = contentType.toLowerCase();
  if (
    type.startsWith('text/') ||
    type.includes('json') ||
    type.includes('xml') ||
    type.includes('markdown') ||
    type.includes('javascript') ||
    type.includes('typescript')
  ) {
    return true;
  }
  if (text.includes('\0')) return false;
  const sample = text.slice(0, 2048);
  if (!sample) return true;
  const odd = Array.from(sample).filter((char) => {
    const code = char.charCodeAt(0);
    return code < 9 || (code > 13 && code < 32);
  }).length;
  return odd / sample.length < 0.02;
}

function countCriticChanges(blocks: CriticBlock[]): number {
  let count = 0;
  for (const block of blocks) {
    if (block.type === 'prose') {
      count += block.segments.filter((segment) => segment.kind !== 'text').length;
    } else if (block.type === 'commented-code') {
      count += 1;
    }
  }
  return count;
}

type MarkupArtifact = {
  artifactId: string;
  path: string;
  title: string;
  body: string;
  blocks: CriticBlock[];
  changeCount: number;
};

function useMarkupArtifact(entry: ResolvedEntryQuote): MarkupArtifact | null {
  const [markup, setMarkup] = useState<MarkupArtifact | null>(null);

  useEffect(() => {
    let active = true;
    setMarkup(null);
    if (entry.targetType !== 'artifact' || entry.tombstoned) return undefined;
    const artifactId =
      typeof entry.meta.artifactId === 'string' ? entry.meta.artifactId : artifactIdFromHandle(entry.handle);
    const path = typeof entry.meta.path === 'string' ? entry.meta.path : entry.text;
    if (!artifactId) return undefined;

    void fetch(`/api/files/artifact/${encodeURIComponent(artifactId)}/content`, {
      credentials: 'same-origin',
    })
      .then(async (response) => {
        if (!response.ok) return null;
        const contentLength = Number(response.headers.get('Content-Length') ?? '0');
        if (contentLength > MAX_MARKUP_CARD_BYTES) return null;
        const text = await response.text();
        if (new Blob([text]).size > MAX_MARKUP_CARD_BYTES) return null;
        if (!isProbablyText(response.headers.get('Content-Type') ?? '', text)) return null;
        const { frontmatter, body } = splitMarkdownFrontmatter(text);
        if (!containsCriticMarkup(body)) return null;
        const blocks = parseCriticMarkup(body);
        return {
          artifactId,
          path,
          title: frontmatterTitle(frontmatter) ?? basename(path),
          body,
          blocks,
          changeCount: countCriticChanges(blocks),
        };
      })
      .then((next) => {
        if (active && next) setMarkup(next);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [entry.handle, entry.meta, entry.targetType, entry.text, entry.tombstoned]);

  return markup;
}

function contextLine(entry: ResolvedEntryQuote): string | null {
  const parts = [
    entry.location.channelName ? `#${entry.location.channelName}` : null,
    entry.location.sessionTitle,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(' - ') : null;
}

export function EntryQuoteCard({
  entry,
  applyContext,
}: {
  entry: ResolvedEntryQuote;
  applyContext?: EntryQuoteApplyContext | null;
}) {
  const context = contextLine(entry);
  const contextApply = useContext(EntryQuoteApplyContext);
  const effectiveApplyContext = applyContext === undefined ? contextApply : applyContext;
  const markup = useMarkupArtifact(entry);
  const [expanded, setExpanded] = useState(false);

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

  if (markup) {
    return (
      <article className="block rounded-md border border-edge bg-surface-raised/55 px-3 py-2 text-fg-body">
        <div className="flex items-center gap-2 text-xs text-fg-secondary">
          <span className="text-accent-text">
            <ArtifactIcon />
          </span>
          <a href={`/e/${entry.handle}`} className="min-w-0 truncate font-medium text-fg no-underline hover:underline">
            {markup.title}
          </a>
          <span className="rounded border border-edge-strong bg-surface-overlay px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide text-fg-muted">
            markup
          </span>
          <span className="text-fg-muted">
            {markup.changeCount} {markup.changeCount === 1 ? 'change' : 'changes'}
          </span>
        </div>
        <div className="relative mt-2">
          <div className={expanded ? '' : 'max-h-[19.6rem] overflow-hidden'}>
            <CriticMarkupView text={markup.body} blocks={markup.blocks} className="text-[0.82rem]" />
          </div>
          {!expanded && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-surface-raised"
            />
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="text-xs font-medium text-accent-text hover:underline"
          >
            {expanded ? 'Show fewer changes' : `Show all changes (${markup.changeCount})`}
          </button>
          {effectiveApplyContext ? (
            <Suspense fallback={null}>
              <ApplyMarkupMenu
                artifactId={markup.artifactId}
                path={markup.path}
                channelId={effectiveApplyContext.channelId}
                sessions={effectiveApplyContext.sessions}
                onSpawnNewAgent={effectiveApplyContext.onSpawnNewAgent}
              />
            </Suspense>
          ) : null}
        </div>
        {context ? <div className="mt-1 text-xs text-fg-muted">{context}</div> : null}
      </article>
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

export function EntryQuoteCards({
  handles,
  applyContext,
}: {
  handles: string[];
  applyContext?: EntryQuoteApplyContext | null;
}) {
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
        <EntryQuoteCard key={entry.handle} entry={entry} applyContext={applyContext} />
      ))}
    </div>
  );
}
