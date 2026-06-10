import { useMemo, useState, type KeyboardEvent } from 'react';
import type { Channel } from '../api';

/** ⌘K channel jumper: type to filter, arrows to move, Enter to go. */
export function QuickSwitcher({
  channels,
  activeChannelId,
  onSelect,
  onClose,
}: {
  channels: Channel[];
  activeChannelId: string | null;
  onSelect: (channelId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? channels.filter((c) => c.name.toLowerCase().includes(q)) : channels;
    // Exact-prefix matches first, then the rest alphabetically (already sorted).
    return [...list].sort(
      (a, b) =>
        Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)),
    );
  }, [channels, query]);
  const selected = Math.min(index, Math.max(0, matches.length - 1));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = matches[selected];
      if (target) onSelect(target.id);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-zinc-950/60"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Jump to channel"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="mx-auto mt-24 w-96 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
      >
        <input
          autoFocus
          value={query}
          placeholder="Jump to channel…"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          aria-label="Channel search"
          className="w-full border-b border-zinc-800 bg-transparent px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none"
        />
        <ul className="max-h-64 overflow-y-auto py-1" role="listbox">
          {matches.length === 0 && (
            <li className="px-3 py-2 text-xs text-zinc-500">No channels match "{query}"</li>
          )}
          {matches.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === selected}>
              <button
                onClick={() => onSelect(c.id)}
                onMouseEnter={() => setIndex(i)}
                className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm ${
                  i === selected ? 'bg-indigo-600/20 text-zinc-100' : 'text-zinc-300'
                }`}
              >
                <span className="text-zinc-500">#</span>
                <span className="truncate">{c.name}</span>
                {c.id === activeChannelId && (
                  <span className="ml-auto text-[10px] text-zinc-500">current</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
