import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, type Channel } from '../api';
import type { WireEvent } from '@atrium/surface-client';
import { channelLabel, formatTime } from '@atrium/surface-client';
import { LockIcon } from './icons';
import { useDialog } from '../useDialog';
import { CompactMarkdownText } from './MessageText';

interface MessageHit {
  event: WireEvent;
  channelName: string;
}

type SessionRecordHit = Awaited<ReturnType<typeof api.searchSessions>>['results'][number];

export interface QuickSwitcherCommand {
  id: string;
  label: string;
  subtitle?: string;
  group: string;
  keywords: string[];
  run: () => void;
  icon?: ReactNode;
}

function commandMatchesQuery(command: QuickSwitcherCommand, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [command.label, command.subtitle, command.group, ...command.keywords]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((token) => haystack.includes(token));
}

/**
 * ⌘K launcher: type to run commands or filter channels, messages, and sessions in one list.
 * Arrows move across all sections, Enter activates.
 */
export function QuickSwitcher({
  channels,
  activeChannelId,
  meId,
  commands = [],
  onSelect,
  onJumpToMessage,
  onOpenSession = () => {},
  onClose,
}: {
  channels: Channel[];
  activeChannelId: string | null;
  meId: string;
  commands?: QuickSwitcherCommand[];
  onSelect: (channelId: string) => void;
  onJumpToMessage: (event: WireEvent) => void;
  onOpenSession?: (sessionId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [hits, setHits] = useState<MessageHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [sessionHits, setSessionHits] = useState<SessionRecordHit[]>([]);
  const [searchingSessions, setSearchingSessions] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = 'quick-switcher-results';

  const channelMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const label = (c: Channel) => channelLabel(c, meId).toLowerCase();
    const list = q ? channels.filter((c) => label(c).includes(q)) : channels;
    return [...list].sort((a, b) => Number(label(b).startsWith(q)) - Number(label(a).startsWith(q)));
  }, [channels, query, meId]);

  const commandMatches = useMemo(
    () => commands.filter((command) => commandMatchesQuery(command, query)),
    [commands, query],
  );

  // Debounced message search once the query is meaningful.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      api
        .search(q)
        .then(({ results }) => setHits(results))
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  // Debounced session search once the query is meaningful.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSessionHits([]);
      setSearchingSessions(false);
      return;
    }
    setSearchingSessions(true);
    const t = setTimeout(() => {
      api
        .searchSessions({ q, limit: 6 })
        .then(({ results }) => setSessionHits(results))
        .catch(() => setSessionHits([]))
        .finally(() => setSearchingSessions(false));
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  const total = commandMatches.length + channelMatches.length + hits.length + sessionHits.length;
  const selected = total > 0 ? Math.min(Math.max(index, 0), total - 1) : 0;
  const activeOptionId = total > 0 ? `quick-switcher-option-${selected}` : undefined;

  useDialog({
    open: true,
    containerRef: dialogRef,
    initialFocusRef: inputRef,
    onClose,
  });

  const openSessionHit = (hit: SessionRecordHit) => {
    onOpenSession(hit.sessionId);
    onClose();
  };

  const activate = (i: number) => {
    if (i < commandMatches.length) {
      const command = commandMatches[i];
      if (command) {
        command.run();
        onClose();
      }
      return;
    }
    const channelIndex = i - commandMatches.length;
    if (channelIndex < channelMatches.length) {
      const c = channelMatches[channelIndex];
      if (c) onSelect(c.id);
      return;
    }
    const messageIndex = channelIndex - channelMatches.length;
    if (messageIndex < hits.length) {
      const hit = hits[messageIndex];
      if (hit) onJumpToMessage(hit.event);
      return;
    }
    const hit = sessionHits[messageIndex - hits.length];
    if (hit) openSessionHit(hit);
  };

  const sessionKindLabel = (kind: SessionRecordHit['kind']) => kind.replace(/_/g, ' ');

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => (total > 0 ? Math.min(i + 1, total - 1) : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (total > 0 ? Math.max(i - 1, 0) : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(selected);
    }
  };

  const commandCount = commandMatches.length;
  const channelOffset = commandCount;
  const messageOffset = commandCount + channelMatches.length;
  const sessionOffset = messageOffset + hits.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-surface/70 md:items-start md:justify-center md:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command center and search"
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[min(82dvh,38rem)] w-full flex-col overflow-hidden rounded-t-xl border border-edge-strong bg-surface-raised shadow-2xl md:mt-20 md:w-[min(560px,calc(100vw-2rem))] md:rounded-lg"
      >
        <input
          ref={inputRef}
          autoFocus
          value={query}
          role="combobox"
          aria-expanded={total > 0}
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          placeholder="Type a command or search channels, messages, sessions…"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          aria-label="Commands and search"
          className="w-full shrink-0 border-b border-edge bg-transparent px-4 py-3 text-sm text-fg placeholder-fg-muted outline-none focus:border-edge-focus md:px-3 md:py-2.5"
        />
        <div id={listboxId} role="listbox" aria-label="Command and search results" className="overflow-y-auto py-1">
          {commandMatches.length > 0 && (
            <ul role="presentation">
              {commandMatches.map((command, i) => {
                const previous = commandMatches[i - 1];
                const showGroup = !previous || previous.group !== command.group;
                return (
                  <li key={command.id} role="presentation">
                    {showGroup && (
                      <div role="presentation" className="px-4 pb-1 pt-2 md:px-3">
                        <span className="text-3xs font-semibold uppercase tracking-wider text-fg-muted">
                          {command.group}
                        </span>
                      </div>
                    )}
                    <div
                      id={`quick-switcher-option-${i}`}
                      role="option"
                      aria-selected={i === selected}
                      tabIndex={-1}
                      onClick={() => {
                        command.run();
                        onClose();
                      }}
                      onMouseEnter={() => setIndex(i)}
                      className={`flex min-h-12 cursor-pointer items-center gap-3 px-4 py-2 text-left md:min-h-10 md:px-3 md:py-1.5 ${
                        i === selected ? 'bg-accent/20 text-fg' : 'text-fg-secondary'
                      }`}
                    >
                      {command.icon && (
                        <span className="grid size-7 shrink-0 place-items-center rounded-md border border-edge bg-surface text-fg-muted md:size-6">
                          {command.icon}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{command.label}</span>
                        {command.subtitle && (
                          <span className="block truncate text-2xs font-normal text-fg-muted">{command.subtitle}</span>
                        )}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {channelMatches.length > 0 && (
            <ul role="presentation">
              {channelMatches.map((c, j) => {
                const i = channelOffset + j;
                return (
                  <li
                    key={c.id}
                    id={`quick-switcher-option-${i}`}
                    role="option"
                    aria-selected={i === selected}
                    tabIndex={-1}
                    onClick={() => onSelect(c.id)}
                    onMouseEnter={() => setIndex(i)}
                    className={`flex min-h-10 cursor-pointer items-center gap-1.5 px-4 py-2 text-left text-sm md:min-h-8 md:px-3 md:py-1.5 ${
                      i === selected ? 'bg-accent/20 text-fg' : 'text-fg-secondary'
                    }`}
                  >
                    <span className="text-fg-muted">
                      {c.kind === 'dm' || c.kind === 'gdm'
                        ? '@'
                        : c.kind === 'private'
                          ? <LockIcon size={14} />
                          : '#'}
                    </span>
                    <span className="truncate">{channelLabel(c, meId)}</span>
                    {c.id === activeChannelId && <span className="ml-auto text-3xs text-fg-muted">current</span>}
                  </li>
                );
              })}
            </ul>
          )}

          {query.trim().length >= 2 && (
            <>
              <div className="flex items-center gap-2 px-3 pb-1 pt-2">
                <span className="text-3xs font-semibold uppercase tracking-wider text-fg-muted">Messages</span>
                {searching && <span className="text-3xs text-fg-muted">searching…</span>}
              </div>
              {!searching && hits.length === 0 && (
                <div className="px-3 py-2 text-xs text-fg-muted">No messages match "{query}"</div>
              )}
              <ul role="presentation">
                {hits.map((h, j) => {
                  const i = messageOffset + j;
                  const text = typeof h.event.payload?.text === 'string' ? h.event.payload.text : '';
                  return (
                    <li
                      key={h.event.id}
                      id={`quick-switcher-option-${i}`}
                      role="option"
                      aria-selected={i === selected}
                      tabIndex={-1}
                      onClick={() => onJumpToMessage(h.event)}
                      onMouseEnter={() => setIndex(i)}
                      className={`min-h-12 cursor-pointer px-4 py-2 text-left md:min-h-10 md:px-3 md:py-1.5 ${i === selected ? 'bg-accent/20' : ''}`}
                    >
                      <div className="flex items-baseline gap-1.5 text-2xs text-fg-muted">
                        <span className="text-fg-tertiary">#{h.channelName}</span>
                        <span>·</span>
                        <span>{h.event.author?.displayName ?? 'Unknown'}</span>
                        <span>·</span>
                        <span className="tabular-nums">{formatTime(h.event.createdAt)}</span>
                      </div>
                      <div className="truncate text-sm text-fg-body">
                        <CompactMarkdownText text={text} />
                      </div>
                    </li>
                  );
                })}
              </ul>

              <div className="flex items-center gap-2 px-3 pb-1 pt-2">
                <span className="text-3xs font-semibold uppercase tracking-wider text-fg-muted">Sessions</span>
                {searchingSessions && <span className="text-3xs text-fg-muted">searching…</span>}
              </div>
              {!searchingSessions && sessionHits.length === 0 && (
                <div className="px-3 py-2 text-xs text-fg-muted">No matching sessions</div>
              )}
              <ul role="presentation">
                {sessionHits.map((hit, j) => {
                  const i = sessionOffset + j;
                  return (
                    <li
                      key={`${hit.sessionId}-${hit.eventId}-${hit.seq}`}
                      id={`quick-switcher-option-${i}`}
                      role="option"
                      aria-selected={i === selected}
                      tabIndex={-1}
                      onClick={() => openSessionHit(hit)}
                      onMouseEnter={() => setIndex(i)}
                      className={`min-h-12 cursor-pointer px-4 py-2 text-left md:min-h-10 md:px-3 md:py-1.5 ${i === selected ? 'bg-accent/20' : ''}`}
                    >
                      <div className="flex min-w-0 items-baseline gap-1.5 text-2xs text-fg-muted">
                        <span className="inline-flex shrink-0 rounded-full bg-surface-overlay/80 px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide text-fg-tertiary">
                          {sessionKindLabel(hit.kind)}
                        </span>
                        <span className="truncate text-fg-tertiary">{hit.sessionTitle ?? hit.sessionId}</span>
                        {hit.channelName && (
                          <>
                            <span>·</span>
                            <span className="shrink-0">#{hit.channelName}</span>
                          </>
                        )}
                        <span>·</span>
                        <span className="shrink-0 tabular-nums">{formatTime(hit.ts)}</span>
                      </div>
                      <div className="truncate text-sm text-fg-body">{hit.excerpt}</div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {total === 0 && query.trim().length < 2 && (
            <div className="px-4 py-3 text-xs text-fg-muted md:px-3 md:py-2">No commands or channels match "{query}"</div>
          )}
        </div>
      </div>
    </div>
  );
}
