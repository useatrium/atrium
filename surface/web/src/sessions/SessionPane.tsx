import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { isTerminalExecutionStatus, type TextItem, type ToolCallItem } from '@atrium/centaur-client';
import { ApiError } from '../api';
import { Composer } from '../components/Composer';
import type { UserRef } from '@atrium/surface-client';
import { formatTime } from '@atrium/surface-client';
import { sessionsApi } from './api';
import { StatusChip, sessionElapsedMs, useNow } from './SessionCard';
import {
  formatCost,
  formatElapsed,
  isStalledSessionStatus,
  isTerminalSessionStatus,
  normalizeExecutionStatus,
  sessionDriverId,
  type SeatAuditEntry,
  type Session,
  type SessionStatus,
} from './types';
import { useSessionStream } from './useSessionStream';

// Skip offscreen rendering work so 500+ item transcripts scroll smoothly.
const ITEM_VIS: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' };

export function SessionPane({
  session,
  me,
  watchers,
  onClose,
}: {
  session: Session;
  me: UserRef;
  /** Presence list for `session:<id>` — everyone with this pane open. */
  watchers: UserRef[];
  onClose: () => void;
}) {
  const { stream, connected } = useSessionStream(session.id);

  const terminal = isTerminalSessionStatus(session.status);
  const displayStatus: SessionStatus = terminal
    ? session.status
    : stream.status !== 'idle'
      ? normalizeExecutionStatus(stream.status)
      : session.status;
  const displayTerminal = isTerminalSessionStatus(displayStatus);
  const now = useNow(!displayTerminal);
  const stalled = !displayTerminal && stream.status === 'idle' && isStalledSessionStatus(session, now);
  const costUsd = Math.max(session.costUsd, stream.costUsd);
  const resultText = stream.resultText || session.resultText || '';
  const isSpawner = session.spawnedBy === me.id;
  const spectators = watchers.length;

  // ---- driver seat (Phase 3) ----
  const driverId = sessionDriverId(session);
  const isDriver = driverId === me.id;
  const driverPresent = isDriver || watchers.some((u) => u.id === driverId);

  const nameFor = (userId: string | null): string => {
    if (!userId) return 'someone';
    if (userId === me.id) return me.displayName;
    const watcher = watchers.find((u) => u.id === userId);
    if (watcher) return watcher.displayName;
    if (userId === session.driverId && session.driverName) return session.driverName;
    if (userId === session.spawnedBy && session.spawnerName) return session.spawnerName;
    const req = session.pendingSeatRequests.find((r) => r.userId === userId);
    if (req) return req.displayName;
    return userId;
  };
  const driverName = nameFor(driverId);

  // Spectator → driver ask state. 'confirm-take' = take clicked once, waiting
  // for confirmation; 'seat-held' = a take bounced with 409 and we fell back
  // to a request.
  const [seatAsk, setSeatAsk] = useState<'idle' | 'confirm-take' | 'requested' | 'seat-held'>(
    'idle',
  );
  useEffect(() => {
    if (isDriver) setSeatAsk('idle');
  }, [isDriver]);
  // Unconfirmed take reverts on its own — it shouldn't linger as a landmine.
  useEffect(() => {
    if (seatAsk !== 'confirm-take') return;
    const t = setTimeout(() => setSeatAsk('idle'), 5000);
    return () => clearTimeout(t);
  }, [seatAsk]);
  const seatRequested =
    seatAsk === 'requested' ||
    seatAsk === 'seat-held' ||
    session.pendingSeatRequests.some((r) => r.userId === me.id);

  const requestSeat = () => {
    setSeatAsk('requested');
    sessionsApi.requestSeat(session.id).catch(() => setSeatAsk('idle'));
  };
  const takeSeat = () => {
    setSeatAsk('idle');
    sessionsApi.takeSeat(session.id).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        // Seat actually held (driver is watching after all) — note it and
        // fall back to a polite request.
        setSeatAsk('seat-held');
        sessionsApi.requestSeat(session.id).catch(() => {});
      }
    });
  };

  // Driver steer sends: never swallow a lost instruction — keep the text and
  // surface a retry right where the action happened.
  const [steerError, setSteerError] = useState<string | null>(null);
  const sendSteer = (text: string) => {
    setSteerError(null);
    sessionsApi.sendMessage(session.id, text).catch(() => setSteerError(text));
  };

  // Cancel is destructive and possibly shared — two-step inline confirm.
  const [cancelAsk, setCancelAsk] = useState<'idle' | 'confirm' | 'failed'>('idle');
  useEffect(() => {
    if (cancelAsk !== 'confirm') return;
    const t = setTimeout(() => setCancelAsk('idle'), 5000);
    return () => clearTimeout(t);
  }, [cancelAsk]);
  const onCancel = () => {
    if (cancelAsk === 'idle') {
      setCancelAsk('confirm');
      return;
    }
    setCancelAsk('idle');
    sessionsApi.cancel(session.id).catch(() => setCancelAsk('failed'));
  };

  // Driver-side grant banner; Ignore is a local dismissal only.
  const [ignoredRequests, setIgnoredRequests] = useState<ReadonlySet<string>>(new Set());
  const seatRequest = isDriver
    ? session.pendingSeatRequests.find((r) => !ignoredRequests.has(r.userId)) ?? null
    : null;

  // Audit-line anchoring: a seat line renders right after the transcript items
  // that were already visible when it arrived (append-like, chronological).
  // Entries that predate the pane mount (full reload / reopening the pane)
  // have no arrival point — v0 limitation: they render grouped after the
  // transcript content instead of interleaved at their original positions.
  const seatAnchorsRef = useRef<Map<number, number> | null>(null);
  if (seatAnchorsRef.current === null) {
    seatAnchorsRef.current = new Map(
      session.seatEvents.map((e) => [e.id, Number.MAX_SAFE_INTEGER]),
    );
  }
  const seatAnchors = seatAnchorsRef.current;
  for (const e of session.seatEvents) {
    if (!seatAnchors.has(e.id)) seatAnchors.set(e.id, stream.items.length);
  }
  const seatLinesAt = (i: number): SeatAuditEntry[] =>
    session.seatEvents.filter(
      (e) => Math.min(seatAnchors.get(e.id) ?? Number.MAX_SAFE_INTEGER, stream.items.length) === i,
    );

  // Manual expand/collapse overrides; default = open while running. When the
  // result arrives the card auto-collapses only if the view is pinned to the
  // bottom — if the user scrolled up to read it, it stays open under them.
  const [toolOpen, setToolOpen] = useState<Record<string, boolean>>({});
  const toolDefaultsRef = useRef(new Map<string, boolean>());
  const toolDefaultOpen = (item: ToolCallItem): boolean => {
    if (item.result === undefined) return true;
    let d = toolDefaultsRef.current.get(item.id);
    if (d === undefined) {
      d = !stickRef.current;
      toolDefaultsRef.current.set(item.id, d);
    }
    return d;
  };

  // Autoscroll while pinned to the bottom (same pattern as Timeline).
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastEventId = stream.lastEventId;
  const seatEventCount = session.seatEvents.length;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lastEventId, seatEventCount]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <aside className="flex w-[min(520px,42vw)] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950/60">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-800 px-3">
        <StatusChip status={displayStatus} stalled={stalled} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-zinc-100" title={session.title}>
            {session.title}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
            {driverId !== session.spawnedBy && (
              <span className="truncate">{session.spawnerName ?? session.spawnedBy}</span>
            )}
            <span
              data-testid="driver-chip"
              className={`shrink-0 truncate rounded-full px-1.5 py-px font-medium ${
                isDriver ? 'bg-indigo-500/15 text-indigo-300' : 'bg-zinc-800/80 text-zinc-300'
              }`}
            >
              driver: {driverName}
            </span>
            {spectators > 0 && (
              <>
                <span className="text-zinc-700">·</span>
                <span className="tabular-nums">{spectators} watching</span>
              </>
            )}
            {costUsd > 0 && (
              <>
                <span className="text-zinc-700">·</span>
                <span className="tabular-nums">{formatCost(costUsd)}</span>
              </>
            )}
            <span className="text-zinc-700">·</span>
            {stalled ? (
              <span className="tabular-nums">started {formatTime(session.createdAt)}</span>
            ) : (
              <span className="tabular-nums">{formatElapsed(sessionElapsedMs(session, now))}</span>
            )}
            {!connected && !displayTerminal && (
              <span role="status" className="text-amber-400/80">
                · reconnecting…
              </span>
            )}
          </div>
        </div>
        {(isSpawner || isDriver) && !displayTerminal && (
          <button
            onClick={onCancel}
            title="Cancel this session"
            className={`rounded-md border px-2 py-1 text-[11px] font-medium ${
              cancelAsk === 'confirm'
                ? 'border-red-700 bg-red-950/60 text-red-200 hover:bg-red-900/60'
                : 'border-red-900/60 text-red-400 hover:bg-red-950/40 hover:text-red-300'
            }`}
          >
            {cancelAsk === 'confirm'
              ? 'Confirm cancel'
              : cancelAsk === 'failed'
                ? 'Cancel failed — retry'
                : 'Cancel'}
          </button>
        )}
        <button
          onClick={onClose}
          title="Close session pane"
          aria-label="Close session pane"
          className="rounded-md px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          ✕
        </button>
      </header>

      {seatRequest && !displayTerminal && (
        <div
          data-testid="seat-request-banner"
          className="flex shrink-0 items-center gap-2 border-b border-indigo-900/40 bg-indigo-950/30 px-3 py-1.5 text-xs"
        >
          <span className="min-w-0 flex-1 truncate text-zinc-200">
            <span className="font-semibold">{seatRequest.displayName}</span> requests the seat
          </span>
          <button
            onClick={() => sessionsApi.grantSeat(session.id, seatRequest.userId).catch(() => {})}
            className="rounded-md bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-500"
          >
            Grant
          </button>
          <button
            onClick={() =>
              setIgnoredRequests((prev) => new Set(prev).add(seatRequest.userId))
            }
            className="rounded-md px-2 py-0.5 text-[11px] font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            Ignore
          </button>
        </div>
      )}

      {displayTerminal && resultText && (
        <div
          data-testid="session-result"
          className="shrink-0 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2"
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Result
          </div>
          <div className="mt-0.5 max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-200">
            {resultText}
          </div>
        </div>
      )}

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 py-2">
        {stream.items.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs text-zinc-500">
            {!displayTerminal ? (
              <span className="animate-pulse">Waiting for agent output…</span>
            ) : isTerminalExecutionStatus(stream.status) ? (
              'No transcript.'
            ) : (
              'Loading transcript…'
            )}
          </div>
        )}
        {stream.items.map((item, i) => (
          <Fragment key={i}>
            {seatLinesAt(i).map((e) => (
              <SeatAuditLine key={e.id} entry={e} nameFor={nameFor} />
            ))}
            {item.type === 'text' ? (
              <TextBlock item={item} />
            ) : (
              <ToolCard
                item={item}
                expanded={toolOpen[item.id] ?? toolDefaultOpen(item)}
                onToggle={() =>
                  setToolOpen((prev) => ({
                    ...prev,
                    [item.id]: !(prev[item.id] ?? toolDefaultOpen(item)),
                  }))
                }
              />
            )}
          </Fragment>
        ))}
        {seatLinesAt(stream.items.length).map((e) => (
          <SeatAuditLine key={e.id} entry={e} nameFor={nameFor} />
        ))}
      </div>

      {displayTerminal ? (
        <div className="shrink-0 border-t border-zinc-800 px-4 py-2.5 text-[11px] text-zinc-500">
          Session ended — transcript is read-only.
        </div>
      ) : (
        <>
          {steerError && (
            <div
              role="alert"
              data-testid="steer-error"
              className="flex shrink-0 items-center gap-2 border-t border-red-900/40 bg-red-950/20 px-3 py-1.5 text-xs"
            >
              <span className="min-w-0 flex-1 truncate text-red-300">
                Message didn't send: "{steerError}"
              </span>
              <button
                onClick={() => sendSteer(steerError)}
                className="rounded-md bg-red-900/50 px-2 py-0.5 text-[11px] font-medium text-red-200 hover:bg-red-900/80"
              >
                Retry
              </button>
              <button
                onClick={() => setSteerError(null)}
                className="rounded-md px-2 py-0.5 text-[11px] font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              >
                Dismiss
              </button>
            </div>
          )}
          <Composer
            placeholder={
              isDriver ? 'You have the seat — message this session' : 'Message this session'
            }
            onSend={sendSteer}
            disabled={!isDriver}
            disabledHint={`spectating — ${driverName} has the seat`}
            footer={
              isDriver ? undefined : (
                <span data-testid="seat-footer" className="flex items-center gap-2">
                  {seatRequested ? (
                    <span>
                      {seatAsk === 'seat-held' && (
                        <span className="text-amber-400/80">seat held · </span>
                      )}
                      requested — waiting for {driverName}
                    </span>
                  ) : seatAsk === 'confirm-take' ? (
                    <>
                      <span className="text-zinc-400">take the seat from {driverName}?</span>
                      <button
                        onClick={takeSeat}
                        className="rounded border border-indigo-800/60 px-2 py-0.5 font-medium text-indigo-300 hover:bg-indigo-950/40 hover:text-indigo-200"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setSeatAsk('idle')}
                        className="rounded px-2 py-0.5 font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                      >
                        Keep watching
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={driverPresent ? requestSeat : () => setSeatAsk('confirm-take')}
                      className="rounded border border-indigo-800/60 px-2 py-0.5 font-medium text-indigo-300 hover:bg-indigo-950/40 hover:text-indigo-200"
                    >
                      {driverPresent ? 'Request seat' : 'Take seat'}
                    </button>
                  )}
                </span>
              )
            }
          />
        </>
      )}
    </aside>
  );
}

// ---- seat audit lines --------------------------------------------------------

function seatLineLabel(e: SeatAuditEntry, nameFor: (id: string | null) => string): string {
  const to = e.toName ?? nameFor(e.to);
  const from = e.from ? (e.fromName ?? nameFor(e.from)) : null;
  return e.reason === 'taken'
    ? `${to} took the seat${from ? ` from ${from}` : ''}`
    : `${from ?? 'the driver'} granted the seat to ${to}`;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function SeatAuditLine({
  entry,
  nameFor,
}: {
  entry: SeatAuditEntry;
  nameFor: (id: string | null) => string;
}) {
  return (
    <div
      data-testid="seat-audit-line"
      className="my-1 flex items-center gap-1.5 text-[11px] text-zinc-500"
    >
      <span aria-hidden className="text-zinc-600">
        ⇄
      </span>
      <span className="truncate">{seatLineLabel(entry, nameFor)}</span>
      <span className="text-zinc-700">·</span>
      <span className="tabular-nums">{hhmm(entry.at)}</span>
    </div>
  );
}

// ---- transcript items -------------------------------------------------------

const TextBlock = memo(
  function TextBlock({ item }: { item: TextItem }) {
    return (
      <div
        style={ITEM_VIS}
        className="whitespace-pre-wrap break-words py-1 text-sm leading-relaxed text-zinc-200"
      >
        {item.text}
      </div>
    );
  },
  (prev, next) => prev.item.text === next.item.text,
);

function firstInputLine(item: ToolCallItem): string {
  const command = item.input['command'];
  if (typeof command === 'string' && command) return command.split('\n')[0] ?? '';
  const keys = Object.keys(item.input);
  return keys.length === 0 ? '' : JSON.stringify(item.input).slice(0, 120);
}

const ToolCard = memo(
  function ToolCard({
    item,
    expanded,
    onToggle,
  }: {
    item: ToolCallItem;
    expanded: boolean;
    onToggle: () => void;
  }) {
    const running = item.result === undefined;
    const isError = item.result?.is_error === true;
    const command = typeof item.input['command'] === 'string' ? (item.input['command'] as string) : null;
    const rest = Object.fromEntries(Object.entries(item.input).filter(([k]) => k !== 'command'));
    const restJson = Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : null;

    return (
      <div
        style={ITEM_VIS}
        data-testid="tool-card"
        className={`my-1 rounded-md border text-xs ${
          isError ? 'border-red-900/60 bg-red-950/20' : 'border-zinc-800 bg-zinc-900/50'
        }`}
      >
        <button
          onClick={onToggle}
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-zinc-800/40"
        >
          <span className="text-[10px] text-zinc-500">{expanded ? '▾' : '▸'}</span>
          <span className="shrink-0 font-mono font-semibold text-zinc-200">{item.name}</span>
          {!expanded && (
            <span className="min-w-0 flex-1 truncate font-mono text-zinc-500">
              {firstInputLine(item)}
            </span>
          )}
          <span className="ml-auto shrink-0">
            {running ? (
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" />
            ) : isError ? (
              <span className="font-semibold text-red-400">error</span>
            ) : (
              <span className="text-zinc-500">done</span>
            )}
          </span>
        </button>
        {expanded && (
          <div className="border-t border-zinc-800/80 px-2 py-1.5">
            {command !== null && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-300">
                {command}
              </pre>
            )}
            {restJson && (
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-500">
                {restJson}
              </pre>
            )}
            {item.result && (
              <pre
                className={`mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded border px-2 py-1.5 font-mono text-[11px] leading-relaxed ${
                  isError
                    ? 'border-red-900/60 bg-red-950/30 text-red-200'
                    : 'border-zinc-800 bg-zinc-950/70 text-zinc-300'
                }`}
              >
                {item.result.content}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  },
  // onToggle is intentionally excluded: it is a fresh closure every render but
  // only reads stable fields (item.id) plus state via a functional update.
  (prev, next) =>
    prev.expanded === next.expanded &&
    prev.item.name === next.item.name &&
    prev.item.input === next.item.input &&
    prev.item.result?.content === next.item.result?.content &&
    prev.item.result?.is_error === next.item.result?.is_error,
);
