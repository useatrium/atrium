import type { UserRef } from '@atrium/surface-client';
import { useState } from 'react';
import { Tooltip } from '../components/a11y';
import { ArrowUpIcon } from '../components/icons';
import type { SeatAuditEntry } from './types';

function seatLineLabel(entry: SeatAuditEntry, nameFor: (id: string | null) => string): string {
  const to = entry.toName ?? nameFor(entry.to);
  const from = entry.from ? (entry.fromName ?? nameFor(entry.from)) : null;
  return entry.reason === 'taken'
    ? `${to} took the seat${from ? ` from ${from}` : ''}`
    : `${from ?? 'the driver'} granted the seat to ${to}`;
}

function hhmm(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** ChatGPT-style turn spine: ticks at the right edge, hover → floating turn list. */
export function TurnRail({ turns, onJump }: { turns: { id: string; text: string }[]; onJump: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (turns.length === 0) return null;
  const shown = turns.slice(-14);
  const jumpToTurn = (id: string) => {
    setOpen(false);
    onJump(id);
  };
  return (
    <div data-testid="turn-rail" className="group absolute right-1.5 top-1/2 z-10 -translate-y-1/2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Open turn navigation"
        aria-expanded={open}
        className="flex flex-col items-end gap-1.5 rounded-md py-1 text-fg-faint transition-opacity group-hover:opacity-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-edge-focus max-md:min-h-11 max-md:min-w-11 max-md:justify-center [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 [@media(pointer:coarse)]:justify-center"
      >
        {shown.map((turn) => (
          <span key={turn.id} className="block h-0.5 w-4 rounded-full bg-fg-faint" />
        ))}
      </button>
      <div className={`absolute right-0 top-1/2 -translate-y-1/2 ${open ? 'block' : 'hidden'} group-hover:block`}>
        <div className="max-h-[60vh] w-56 overflow-y-auto rounded-lg border border-edge bg-surface-raised py-1 shadow-lg">
          {shown.map((turn) => (
            <Tooltip key={turn.id} content={turn.text}>
              <button
                type="button"
                onClick={() => jumpToTurn(turn.id)}
                className="block w-full truncate px-3 py-1.5 text-left text-xs text-fg-body hover:bg-surface-overlay max-md:min-h-11 [@media(pointer:coarse)]:min-h-11"
              >
                {turn.text}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>
    </div>
  );
}

/** "X is composing…" line above the session composer (calm, ephemeral). */
export function SessionTypingLine({ typers }: { typers: UserRef[] }) {
  const names = typers.map((user) => user.displayName);
  const label =
    names.length === 0
      ? ''
      : names.length === 1
        ? `${names[0]} is composing…`
        : names.length === 2
          ? `${names[0]} and ${names[1]} are composing…`
          : 'Several people are composing…';
  return (
    <div aria-live="polite" className="h-4 shrink-0 px-4 text-3xs leading-4 text-fg-muted">
      {label}
    </div>
  );
}

export function SeatAuditLine({ entry, nameFor }: { entry: SeatAuditEntry; nameFor: (id: string | null) => string }) {
  return (
    <div data-testid="seat-audit-line" className="my-1 flex items-center gap-1.5 text-2xs text-fg-muted">
      <span aria-hidden className="text-fg-faint">
        <ArrowUpIcon size={12} />
      </span>
      <span className="truncate">{seatLineLabel(entry, nameFor)}</span>
      <span className="text-fg-faint">·</span>
      <span className="tabular-nums">{hhmm(entry.at)}</span>
    </div>
  );
}
