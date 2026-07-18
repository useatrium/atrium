// The dock's list layer: group sections and per-session rows.
// Split from AgentDock.tsx so the frame (spine/header/widths) and the rows can
// evolve independently — the frame passes everything rows need via
// `AgentRowContext`, so row work never has to touch the frame file.

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
              <span title={question} className="block truncate text-2xs text-warning-text-strong">
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
          <span className="tabular-nums text-fg-faint">{group.sessions.length}</span>
        </summary>
        <div className="mt-1">{rows}</div>
      </details>
    );
  }

  return (
    <section data-testid="agent-dock-group" data-kind={group.kind} className="space-y-1.5">
      <h2
        className={`flex items-center gap-1.5 px-1 text-xs font-semibold ${
          group.kind === 'needs' ? 'text-warning-text-strong' : 'text-fg-muted'
        }`}
      >
        <span>{group.label}</span>
        <span className="tabular-nums text-fg-faint">{group.sessions.length}</span>
      </h2>
      {rows}
    </section>
  );
}
