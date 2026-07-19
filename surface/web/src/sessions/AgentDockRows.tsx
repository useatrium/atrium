// The dock's list layer: group sections and per-session rows.
// Split from AgentDock.tsx so the frame (spine/header/widths) and the rows can
// evolve independently — the frame passes everything rows need via
// `AgentRowContext`, so row work never has to touch the frame file.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { initials, sessionDriverId } from '@atrium/surface-client';
import { ArchiveIcon, ChevronDownIcon, ChevronRightIcon, PinIcon, PinOffIcon } from '../components/icons';
import { GlanceChip } from './GlanceChip';
import { SessionPresenceTicker } from './SessionPresenceTicker';
import { isTerminalSessionStatus, sessionAttentionKind, type Session } from './types';
import type { AgentDockGroup } from './useAgentDock';

/** Everything a row can act on, provided by the dock frame (and ultimately Chat). */
export type AgentRowContext = {
  /** The viewing user — rows use this to distinguish mine vs others' agents. */
  meId: string | null;
  /** channelId → display name, for orientation tags on cross-channel groups. */
  channelNames: ReadonlyMap<string, string>;
  /** Filter the dock to a workstream (the presence-link behavior, from a row tag). */
  onFilterChannel?: (channelId: string) => void;
  onSetArchived?: (sessionId: string, archived: boolean, previousArchivedAt: string | null) => void;
  onSetPinned?: (sessionId: string, pinned: boolean, previousPinned: boolean) => void;
};

type AgentRovingContextValue = {
  tabbableId: string | null;
  registerRow: (id: string, el: HTMLButtonElement | null) => void;
  onRowKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, id: string) => void;
};

const AgentRovingContext = createContext<AgentRovingContextValue | null>(null);

/**
 * Roving-tabindex coordinator for the dock's session rows. Rows are scattered
 * across group sections and collapsible <details>, so the flattened order is
 * given by `orderedIds` (all visible sessions, in render order) and narrowed to
 * the rows actually mounted — collapsed groups don't register a ref, so their
 * rows are skipped rather than trapping focus. One row is tabbable at a time —
 * the focused session's, else the first — and Arrow/Home/End move focus across
 * every mounted row.
 */
export function AgentDockRovingProvider({
  orderedIds,
  focusedSessionId,
  children,
}: {
  orderedIds: string[];
  focusedSessionId: string | null;
  children: ReactNode;
}) {
  const [rovingId, setRovingId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  // The tabbable row follows the focused session; a manual arrow move overrides
  // it until the focused session changes again.
  useEffect(() => {
    setRovingId(null);
  }, [focusedSessionId]);
  const registerRow = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);
  const tabbableId = useMemo(() => {
    if (rovingId && orderedIds.includes(rovingId)) return rovingId;
    if (focusedSessionId && orderedIds.includes(focusedSessionId)) return focusedSessionId;
    return orderedIds[0] ?? null;
  }, [focusedSessionId, orderedIds, rovingId]);
  const onRowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, id: string) => {
      const mounted = orderedIds.filter((sid) => rowRefs.current.has(sid));
      const index = mounted.indexOf(id);
      if (index < 0) return;
      let nextIndex: number | null = null;
      switch (event.key) {
        case 'ArrowDown':
          nextIndex = Math.min(index + 1, mounted.length - 1);
          break;
        case 'ArrowUp':
          nextIndex = Math.max(index - 1, 0);
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = mounted.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      const nextId = mounted[nextIndex];
      if (nextId == null) return;
      setRovingId(nextId);
      rowRefs.current.get(nextId)?.focus();
    },
    [orderedIds],
  );
  const value = useMemo<AgentRovingContextValue>(
    () => ({ tabbableId, registerRow, onRowKeyDown }),
    [tabbableId, registerRow, onRowKeyDown],
  );
  return <AgentRovingContext.Provider value={value}>{children}</AgentRovingContext.Provider>;
}

export function sessionAge(session: Session, now: number): { short: string; full: string } {
  const value = session.latestActivity?.at ?? session.completedAt ?? session.createdAt;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return { short: '—', full: value };

  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  const full = new Date(timestamp).toLocaleString();
  if (elapsedSeconds < 60) return { short: 'now', full };
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return { short: `${minutes}m`, full };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { short: `${hours}h`, full };
  const days = Math.floor(hours / 24);
  if (days < 7) return { short: `${days}d`, full };
  return {
    short: new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    full,
  };
}

function fallbackActivity(session: Session): string {
  if (session.resultText?.trim()) return session.resultText.trim();
  if (isTerminalSessionStatus(session.status)) return 'Run finished';
  if (session.status === 'queued' || session.status === 'spawning') return 'Starting up…';
  return 'Waiting for activity…';
}

function sessionDriverName(session: Session): string | null {
  const driverId = sessionDriverId(session);
  if (driverId === session.driverId && session.driverName?.trim()) return session.driverName.trim();
  if (driverId === session.spawnedBy && session.spawnerName?.trim()) return session.spawnerName.trim();
  return null;
}

export function AgentRow({
  session,
  now,
  selected,
  onFocus,
  context,
  groupKind,
}: {
  session: Session;
  now: number;
  selected: boolean;
  onFocus: () => void;
  context: AgentRowContext;
  groupKind: AgentDockGroup['kind'];
}) {
  const roving = useContext(AgentRovingContext);
  const age = sessionAge(session, now);
  const canAnswer = sessionAttentionKind(session) === 'question';
  const driverId = sessionDriverId(session);
  const mine = context.meId != null && driverId === context.meId;
  const ownedByOther = context.meId != null && driverId !== context.meId;
  const driverName = ownedByOther ? sessionDriverName(session) : null;
  const question = canAnswer ? session.pendingQuestion?.questions?.[0]?.question?.trim() : undefined;
  const channelName = context.channelNames.get(session.channelId);
  const showChannelTag = (groupKind === 'needs' || groupKind === 'recent') && channelName != null;
  const canArchive = groupKind === 'recent' && isTerminalSessionStatus(session.status) && context.onSetArchived != null;
  const canPin = context.onSetPinned != null;
  const actionCount = Number(canAnswer) + Number(canArchive) + Number(canPin);
  const rightPadding =
    actionCount >= 3
      ? 'pr-32'
      : showChannelTag
        ? 'pr-24'
        : actionCount >= 2
          ? 'pr-20'
          : actionCount === 1
            ? 'pr-14'
            : 'pr-2';
  const actionClass =
    'grid size-6 shrink-0 place-items-center rounded text-fg-muted opacity-0 hover:bg-surface-overlay hover:text-fg group-hover/agent-row:opacity-100 group-focus-within/agent-row:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent [@media(hover:none)]:opacity-100';

  return (
    <li
      data-testid={`agent-dock-row-${session.id}`}
      data-mine={mine || undefined}
      data-owned-by-other={ownedByOther || undefined}
      className={`group/agent-row relative border-b border-edge/70 last:border-b-0 ${
        selected ? 'bg-accent/15' : 'hover:bg-surface-overlay/70'
      }`}
    >
      <button
        type="button"
        ref={roving ? (el) => roving.registerRow(session.id, el) : undefined}
        tabIndex={roving ? (roving.tabbableId === session.id ? 0 : -1) : undefined}
        onKeyDown={roving ? (event) => roving.onRowKeyDown(event, session.id) : undefined}
        aria-current={selected ? 'true' : undefined}
        aria-label={`Focus agent ${session.title}`}
        onClick={onFocus}
        className={`w-full min-w-0 py-2 pl-2 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${rightPadding}`}
      >
        <span
          data-testid={`agent-dock-row-content-${session.id}`}
          className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 ${
            ownedByOther ? 'opacity-70' : ''
          }`}
        >
          <GlanceChip session={session} now={now} showClock={false} className="max-w-24 overflow-hidden text-2xs" />
          <span className="flex min-w-0 items-center gap-1.5">
            {session.pinned && (
              <span role="img" aria-label="Pinned" title="Pinned" className="shrink-0 text-fg-muted">
                <PinIcon size={11} />
              </span>
            )}
            {driverName && (
              <span
                data-testid={`agent-dock-driver-${session.id}`}
                title={`Driven by ${driverName}`}
                className="grid size-4 shrink-0 place-items-center rounded bg-surface-overlay text-[7px] font-bold leading-none text-fg-muted"
              >
                {initials(driverName)}
              </span>
            )}
            <span
              className="truncate text-xs font-semibold text-fg"
              title={`${session.title} · #${channelName ?? session.channelId}`}
            >
              {session.title}
            </span>
          </span>
          <span
            data-testid={`agent-dock-age-${session.id}`}
            title={age.full}
            className={`text-3xs tabular-nums text-fg-muted ${canAnswer ? 'invisible' : ''}`}
          >
            {age.short}
          </span>
          <span className="col-start-2 col-end-4 min-w-0">
            {question ? (
              // The Needs-you prompt is the row's payload — let it wrap to two
              // lines so it stays readable at the default width; titles above
              // stay single-line.
              <span title={question} className="line-clamp-2 text-2xs text-warning-text-strong">
                “{question}”
              </span>
            ) : session.latestActivity && !isTerminalSessionStatus(session.status) ? (
              <SessionPresenceTicker session={session} />
            ) : (
              <span className="block truncate text-2xs text-fg-muted">{fallbackActivity(session)}</span>
            )}
          </span>
        </span>
      </button>
      {/* DOM order matches the visual stack: the top-right actions (Answer/Pin/
          Archive) come before the bottom-right channel chip so tab order tracks
          what the eye reads top-to-bottom. */}
      {actionCount > 0 && (
        <span className="absolute right-1 top-1 z-10 flex items-center gap-1">
          {canAnswer && (
            <button
              type="button"
              onClick={onFocus}
              className="min-h-6 rounded px-1.5 text-3xs font-semibold text-warning-text-strong hover:bg-warning-tint/50 focus-visible:outline-2 focus-visible:outline-warning"
            >
              Answer
            </button>
          )}
          {canPin && (
            <button
              type="button"
              aria-label={`${session.pinned ? 'Unpin' : 'Pin'} ${session.title}`}
              onClick={() => context.onSetPinned?.(session.id, !session.pinned, session.pinned)}
              className={actionClass}
            >
              {session.pinned ? <PinOffIcon size={14} /> : <PinIcon size={14} />}
            </button>
          )}
          {canArchive && (
            <button
              type="button"
              aria-label={`${session.archivedAt == null ? 'Archive' : 'Unarchive'} ${session.title}`}
              onClick={() => context.onSetArchived?.(session.id, session.archivedAt == null, session.archivedAt)}
              className={actionClass}
            >
              <ArchiveIcon size={14} />
            </button>
          )}
        </span>
      )}
      {showChannelTag && (
        <button
          type="button"
          title={`#${channelName}`}
          aria-label={`Filter agents to #${channelName}`}
          onClick={(event) => {
            event.stopPropagation();
            context.onFilterChannel?.(session.channelId);
          }}
          className="absolute bottom-1 right-1 z-10 flex min-h-6 max-w-20 items-center rounded px-1.5 text-3xs font-medium text-accent hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="truncate">#{channelName}</span>
        </button>
      )}
    </li>
  );
}

export function AgentGroup({
  group,
  now,
  focusedSessionId,
  onFocusAgent,
  context,
}: {
  group: AgentDockGroup;
  now: number;
  focusedSessionId: string | null;
  onFocusAgent: (id: string) => void;
  context: AgentRowContext;
}) {
  const rows = (
    <ul className="overflow-hidden rounded-md border border-edge bg-surface/45">
      {group.sessions.map((session) => (
        <AgentRow
          key={session.id}
          session={session}
          now={now}
          selected={session.id === focusedSessionId}
          onFocus={() => onFocusAgent(session.id)}
          context={context}
          groupKind={group.kind}
        />
      ))}
    </ul>
  );

  if (group.kind === 'hibernating' || group.kind === 'recent') {
    return (
      <details
        data-testid="agent-dock-group"
        data-kind={group.kind}
        className="group/disclosure border-t border-edge pt-2"
      >
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded px-1 py-1 text-xs font-semibold text-fg-muted hover:bg-surface-overlay hover:text-fg-secondary focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon size={12} className="group-open/disclosure:hidden" />
          <ChevronDownIcon size={12} className="hidden group-open/disclosure:block" />
          <span>{group.label}</span>
          <span className="tabular-nums text-fg-body">{group.sessions.length}</span>
        </summary>
        <div className="mt-1">{rows}</div>
      </details>
    );
  }

  return (
    <section data-testid="agent-dock-group" data-kind={group.kind} className="space-y-1.5">
      <h3
        className={`flex items-center gap-1.5 px-1 text-xs font-semibold ${
          group.kind === 'needs' ? 'text-warning-text-strong' : 'text-fg-muted'
        }`}
      >
        <span>{group.label}</span>
        <span className="tabular-nums text-fg-faint">{group.sessions.length}</span>
      </h3>
      {rows}
    </section>
  );
}
