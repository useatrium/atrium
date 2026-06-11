import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { api, type Channel } from '../api';
import type { WireEvent } from '@atrium/surface-client';
import { channelLabel, formatTime } from '@atrium/surface-client';
import { LockIcon } from './icons';

interface MessageHit {
  event: WireEvent;
  channelName: string;
}

/**
 * ⌘K launcher: type to filter channels and search messages in one list.
 * Arrows move across both sections, Enter activates.
 */
export function QuickSwitcher({
  channels,
  activeChannelId,
  meId,
  onSelect,
  onJumpToMessage,
  onClose,
}: {
  channels: Channel[];
  activeChannelId: string | null;
  meId: string;
  onSelect: (channelId: string) => void;
  onJumpToMessage: (event: WireEvent) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [hits, setHits] = useState<MessageHit[]>([]);
  const [searching, setSearching] = useState(false);

  const channelMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const label = (c: Channel) => channelLabel(c, meId).toLowerCase();
    const list = q ? channels.filter((c) => label(c).includes(q)) : channels;
    return [...list].sort(
      (a, b) => Number(label(b).startsWith(q)) - Number(label(a).startsWith(q)),
    );
  }, [channels, query, meId]);

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

  const total = channelMatches.length + hits.length;
  const selected = Math.min(index, Math.max(0, total - 1));

  const activate = (i: number) => {
    if (i < channelMatches.length) {
      const c = channelMatches[i];
      if (c) onSelect(c.id);
      return;
    }
    const hit = hits[i - channelMatches.length];
    if (hit) onJumpToMessage(hit.event);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, total - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(selected);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-surface/60"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Jump to channel or search messages"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="mx-auto mt-24 w-[520px] overflow-hidden rounded-lg border border-edge-strong bg-surface-raised shadow-2xl"
      >
        <input
          autoFocus
          value={query}
          placeholder="Jump to channel or search messages…"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          aria-label="Channel and message search"
          className="w-full border-b border-edge bg-transparent px-3 py-2.5 text-sm text-fg placeholder-fg-muted outline-none"
        />
        <div className="max-h-96 overflow-y-auto py-1">
          {channelMatches.length > 0 && (
            <ul role="listbox" aria-label="Channels">
              {channelMatches.map((c, i) => (
                <li key={c.id} role="option" aria-selected={i === selected}>
                  <button
                    onClick={() => onSelect(c.id)}
                    onMouseEnter={() => setIndex(i)}
                    className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm ${
                      i === selected ? 'bg-accent/20 text-fg' : 'text-fg-secondary'
                    }`}
                  >
                    <span className="text-fg-muted">
                      {c.kind === 'dm' || c.kind === 'gdm' ? '@' : c.kind === 'private' ? <LockIcon size={14} /> : '#'}
                    </span>
                    <span className="truncate">{channelLabel(c, meId)}</span>
                    {c.id === activeChannelId && (
                      <span className="ml-auto text-3xs text-fg-muted">current</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {query.trim().length >= 2 && (
            <>
              <div className="flex items-center gap-2 px-3 pb-1 pt-2">
                <span className="text-3xs font-semibold uppercase tracking-wider text-fg-muted">
                  Messages
                </span>
                {searching && <span className="text-3xs text-fg-faint">searching…</span>}
              </div>
              {!searching && hits.length === 0 && (
                <div className="px-3 py-2 text-xs text-fg-muted">No messages match "{query}"</div>
              )}
              <ul role="listbox" aria-label="Message results">
                {hits.map((h, j) => {
                  const i = channelMatches.length + j;
                  const text = typeof h.event.payload?.text === 'string' ? h.event.payload.text : '';
                  return (
                    <li key={h.event.id} role="option" aria-selected={i === selected}>
                      <button
                        onClick={() => onJumpToMessage(h.event)}
                        onMouseEnter={() => setIndex(i)}
                        className={`w-full px-3 py-1.5 text-left ${
                          i === selected ? 'bg-accent/20' : ''
                        }`}
                      >
                        <div className="flex items-baseline gap-1.5 text-2xs text-fg-muted">
                          <span className="text-fg-tertiary">#{h.channelName}</span>
                          <span>·</span>
                          <span>{h.event.author?.displayName ?? 'Unknown'}</span>
                          <span>·</span>
                          <span className="tabular-nums">{formatTime(h.event.createdAt)}</span>
                        </div>
                        <div className="truncate text-sm text-fg-body">{text}</div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {total === 0 && query.trim().length < 2 && (
            <div className="px-3 py-2 text-xs text-fg-muted">No channels match "{query}"</div>
          )}
        </div>
      </div>
    </div>
  );
}
