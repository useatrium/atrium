import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { formatTime } from '@atrium/surface-client';
import { api } from '../api';
import { SearchIcon } from '../components/icons';
import { EmptyState } from './EmptyState';

type SessionRecordHit = Awaited<ReturnType<typeof api.searchSessions>>['results'][number];
type SearchKind = SessionRecordHit['kind'];
type FilterKind =
  | 'message'
  | 'command'
  | 'file_change'
  | 'artifact'
  | 'question'
  | 'reasoning'
  | 'plan'
  | 'tool_call';

const LEAN_KINDS: FilterKind[] = ['message', 'command', 'file_change', 'artifact', 'question'];
const FULL_ONLY_KINDS: FilterKind[] = ['reasoning', 'plan', 'tool_call'];
const SEARCH_LIMIT = 40;

const KIND_LABELS: Record<SearchKind, string> = {
  message: 'message',
  command: 'command',
  file_change: 'file change',
  artifact: 'artifact',
  question: 'question',
  reasoning: 'reasoning',
  plan: 'plan',
  tool_call: 'tool call',
  usage: 'usage',
  status: 'status',
};

const KIND_BADGE_CLASS: Record<SearchKind, string> = {
  message: 'bg-accent-hover/15 text-accent-text-strong',
  command: 'bg-info/15 text-info-text',
  file_change: 'bg-success/15 text-success-text',
  artifact: 'bg-warning/15 text-warning-text',
  question: 'bg-danger/15 text-danger-text',
  reasoning: 'bg-surface-overlay/80 text-fg-tertiary',
  plan: 'bg-accent/10 text-accent-text',
  tool_call: 'bg-edge-strong/40 text-fg-tertiary',
  usage: 'bg-surface-overlay/80 text-fg-tertiary',
  status: 'bg-edge-strong/40 text-fg-tertiary',
};

interface HitGroup {
  key: string;
  title: string;
  channelName: string | null;
  hits: { hit: SessionRecordHit; index: number }[];
}

export function SessionSearch({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const headingId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [query, setQuery] = useState('');
  const [full, setFull] = useState(false);
  const [selectedKinds, setSelectedKinds] = useState<FilterKind[]>(LEAN_KINDS);
  const [results, setResults] = useState<SessionRecordHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const trimmedQuery = query.trim();
  const visibleKinds = useMemo<FilterKind[]>(
    () => (full ? [...LEAN_KINDS, ...FULL_ONLY_KINDS] : LEAN_KINDS),
    [full],
  );
  const activeKinds = useMemo(
    () => visibleKinds.filter((kind) => selectedKinds.includes(kind)),
    [selectedKinds, visibleKinds],
  );
  const activeKindKey = activeKinds.join(',');
  const singleActiveKind = activeKinds.length === 1 ? activeKinds[0] : null;

  useEffect(() => {
    setSelectedKinds((current) => {
      const allowed = new Set(full ? [...LEAN_KINDS, ...FULL_ONLY_KINDS] : LEAN_KINDS);
      const next = current.filter((kind) => allowed.has(kind));
      if (full) {
        for (const kind of FULL_ONLY_KINDS) {
          if (!next.includes(kind)) next.push(kind);
        }
      }
      return next.length > 0 ? next : LEAN_KINDS;
    });
  }, [full]);

  useEffect(() => {
    if (trimmedQuery.length < 2) {
      setResults([]);
      setSearching(false);
      setError(null);
      setActiveIndex(0);
      return;
    }

    let cancelled = false;
    setSearching(true);
    setError(null);
    const timeout = window.setTimeout(() => {
      api
        .searchSessions({ q: trimmedQuery, kinds: activeKinds, full, limit: SEARCH_LIMIT })
        .then(({ results: hits }) => {
          if (cancelled) return;
          setResults(hits);
          setActiveIndex(0);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setResults([]);
          setError(err instanceof Error ? err.message : 'Search failed.');
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [activeKindKey, full, trimmedQuery]);

  useEffect(() => {
    rowRefs.current = rowRefs.current.slice(0, results.length);
  }, [results.length]);

  const groups = useMemo<HitGroup[]>(() => {
    const bySession = new Map<string, HitGroup>();
    results.forEach((hit, index) => {
      let group = bySession.get(hit.sessionId);
      if (!group) {
        group = {
          key: hit.sessionId,
          title: hit.sessionTitle ?? hit.sessionId,
          channelName: hit.channelName,
          hits: [],
        };
        bySession.set(hit.sessionId, group);
      }
      group.hits.push({ hit, index });
    });
    return [...bySession.values()];
  }, [results]);

  const toggleKind = (kind: FilterKind) => {
    setSelectedKinds((current) => {
      if (current.includes(kind)) {
        return current.length === 1 ? current : current.filter((item) => item !== kind);
      }
      return [...current, kind];
    });
  };

  const focusRow = (nextIndex: number) => {
    if (results.length === 0) return;
    const bounded = Math.min(Math.max(nextIndex, 0), results.length - 1);
    setActiveIndex(bounded);
    window.requestAnimationFrame(() => rowRefs.current[bounded]?.focus());
  };

  const openHit = (hit: SessionRecordHit) => onOpenSession?.(hit.sessionId);

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault();
      focusRow(activeIndex);
    } else if (event.key === 'Enter') {
      const hit = results[activeIndex];
      if (!hit) return;
      event.preventDefault();
      openHit(hit);
    }
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRow(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (index === 0) {
        inputRef.current?.focus();
      } else {
        focusRow(index - 1);
      }
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusRow(results.length - 1);
    } else if (event.key === 'Escape') {
      inputRef.current?.focus();
    }
  };

  const showingResults = trimmedQuery.length >= 2 && !error && results.length > 0;

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-h-0 flex-1 flex-col bg-surface text-fg-body"
    >
      <header className="shrink-0 border-b border-edge bg-surface/80 px-4 py-3">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 id={headingId} className="text-sm font-semibold text-fg">
                Session search
              </h2>
              <div className="mt-0.5 text-xs text-fg-muted">
                {full ? 'Full transcript tier' : 'Lean transcript tier'}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="rounded-full border border-edge bg-surface-raised px-2 py-0.5 text-3xs font-semibold uppercase tracking-wide text-fg-muted">
                {full ? 'full' : 'lean'}
              </span>
              <span id={`${headingId}-full-toggle`} className="text-xs font-medium text-fg-secondary">
                Include reasoning & tools
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={full}
                aria-labelledby={`${headingId}-full-toggle`}
                onClick={() => setFull((value) => !value)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
                  full
                    ? 'border-accent-border bg-accent'
                    : 'border-edge-strong bg-surface-overlay'
                }`}
              >
                <span
                  className={`size-4 rounded-full bg-fg shadow-sm transition-transform ${
                    full ? 'translate-x-5' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>

          <div className="relative">
            <SearchIcon
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted"
            />
            <input
              ref={inputRef}
              type="search"
              value={query}
              aria-label="Search session records"
              aria-controls={`${headingId}-results`}
              placeholder="Search session records..."
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onInputKeyDown}
              className="h-10 w-full rounded-md border border-edge-strong bg-surface-raised pl-9 pr-3 text-sm text-fg placeholder-fg-muted outline-none transition-colors focus:border-accent-border"
            />
          </div>

          <div className="flex flex-wrap gap-1.5" aria-label="Kind filters">
            {visibleKinds.map((kind) => {
              const selected = activeKinds.includes(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleKind(kind)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                    selected
                      ? 'border-accent-border bg-accent/20 text-accent-text-strong'
                      : 'border-edge bg-surface-raised text-fg-muted hover:border-edge-strong hover:text-fg-secondary'
                  }`}
                >
                  {KIND_LABELS[kind]}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {trimmedQuery.length < 2 && (
          <EmptyState
            icon={<SearchIcon size={16} />}
            title={trimmedQuery.length === 0 ? 'Search session records' : 'Keep typing'}
            hint={
              trimmedQuery.length === 0
                ? 'Find messages, commands, files, artifacts, and questions across sessions.'
                : 'Search starts after two characters.'
            }
          />
        )}

        {searching && results.length === 0 && <SearchSkeleton />}

        {error && trimmedQuery.length >= 2 && (
          <div className="flex min-h-full flex-1 items-center justify-center p-6 text-center">
            <div className="max-w-sm rounded-lg border border-danger-border bg-danger-tint/20 px-5 py-4">
              <div className="text-sm font-semibold text-danger-text-strong">
                Could not search sessions
              </div>
              <div className="mt-1 text-xs leading-5 text-danger-text">{error}</div>
            </div>
          </div>
        )}

        {trimmedQuery.length >= 2 && !searching && !error && results.length === 0 && (
          <EmptyState
            icon={<SearchIcon size={16} />}
            title="No session records found"
            hint={`No ${full ? 'full' : 'lean'} ${singleActiveKind ? KIND_LABELS[singleActiveKind] : 'records'} matched "${trimmedQuery}".`}
          />
        )}

        {showingResults && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 px-1">
              <span className="text-3xs font-semibold uppercase tracking-wider text-fg-muted">
                Results
              </span>
              <span className="text-3xs tabular-nums text-fg-faint">{results.length}</span>
              {searching && <span className="text-3xs text-fg-faint">searching...</span>}
            </div>

            <div
              id={`${headingId}-results`}
              role="listbox"
              aria-label="Session search results"
              aria-busy={searching}
              className="space-y-3"
            >
              {groups.map((group) => (
                <section
                  key={group.key}
                  role="group"
                  aria-labelledby={`${headingId}-${group.key}`}
                  className="overflow-hidden rounded-lg border border-edge bg-surface-raised/70"
                >
                  <div className="flex items-baseline gap-2 border-b border-edge px-3 py-2">
                    <h3
                      id={`${headingId}-${group.key}`}
                      className="min-w-0 truncate text-sm font-semibold text-fg"
                    >
                      {group.title}
                    </h3>
                    {group.channelName && (
                      <span className="shrink-0 text-2xs text-fg-muted">#{group.channelName}</span>
                    )}
                    <span className="ml-auto text-3xs tabular-nums text-fg-faint">
                      {group.hits.length}
                    </span>
                  </div>

                  <ul role="presentation" className="divide-y divide-edge">
                    {group.hits.map(({ hit, index }) => (
                      <li key={`${hit.sessionId}-${hit.eventId}-${hit.seq}`} role="presentation">
                        <button
                          ref={(node) => {
                            rowRefs.current[index] = node;
                          }}
                          type="button"
                          role="option"
                          aria-selected={index === activeIndex}
                          onClick={() => openHit(hit)}
                          onFocus={() => setActiveIndex(index)}
                          onMouseEnter={() => setActiveIndex(index)}
                          onKeyDown={(event) => onRowKeyDown(event, index)}
                          className={`group/hit grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-3 py-2 text-left transition-colors ${
                            index === activeIndex
                              ? 'bg-accent/20'
                              : 'hover:bg-surface-overlay/60 focus:bg-accent/20'
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-2xs text-fg-muted">
                              <KindBadge kind={hit.kind} />
                              <span>{actorDriverLabel(hit)}</span>
                              <span className="text-fg-faint">·</span>
                              <span className="text-fg-tertiary">{hit.viewTier}</span>
                            </div>
                            <div className="line-clamp-2 whitespace-pre-wrap break-words text-sm leading-5 text-fg-body">
                              {hit.excerpt}
                            </div>
                          </div>
                          <div className="pt-0.5 text-2xs tabular-nums text-fg-muted">
                            {formatTime(hit.ts)}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function KindBadge({ kind }: { kind: SearchKind }) {
  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-3xs font-semibold uppercase tracking-wide ${KIND_BADGE_CLASS[kind]}`}
    >
      {KIND_LABELS[kind]}
    </span>
  );
}

function actorDriverLabel(hit: SessionRecordHit): string {
  return hit.driver ? `${hit.actor} · ${hit.driver}` : hit.actor;
}

function SearchSkeleton() {
  return (
    <div aria-label="Searching sessions" className="animate-pulse space-y-3">
      {[0, 1, 2].map((item) => (
        <div key={item} className="overflow-hidden rounded-lg border border-edge bg-surface-raised/70">
          <div className="border-b border-edge px-3 py-2">
            <div className="h-3 w-48 rounded bg-surface-overlay/80" />
          </div>
          <div className="space-y-2 px-3 py-3">
            <div className="h-3 w-40 rounded bg-surface-overlay/80" />
            <div
              className="h-3 rounded bg-surface-overlay/50"
              style={{ width: `${76 - item * 12}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
