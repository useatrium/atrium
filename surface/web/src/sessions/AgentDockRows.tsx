// The dock's list layer: group sections and per-session rows.
// Split from AgentDock.tsx so the frame (spine/header/widths) and the rows can
// evolve independently — the frame passes everything rows need via
// `AgentRowContext`, so row work never has to touch the frame file.

import { sessionDriverId } from '@atrium/surface-client';
import { ChevronDownIcon, ChevronRightIcon, PinIcon } from '../components/icons';
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

export function AgentRow({
  session,
  now,
  selected,
  onFocus,
  context,
}: {
  session: Session;
  now: number;
  selected: boolean;
  onFocus: () => void;
  context: AgentRowContext;
}) {
  const age = sessionAge(session, now);
  const canAnswer = sessionAttentionKind(session) === 'question';
  const mine = context.meId != null && sessionDriverId(session) === context.meId;

  return (
    <li
      data-testid={`agent-dock-row-${session.id}`}
      data-mine={mine || undefined}
      className={`group/agent-row relative border-b border-edge/70 last:border-b-0 ${
        selected ? 'bg-accent/15' : 'hover:bg-surface-overlay/70'
      }`}
    >
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        aria-label={`Focus agent ${session.title}`}
        onClick={onFocus}
        className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 px-2 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      >
        <GlanceChip session={session} now={now} showClock={false} className="max-w-24 overflow-hidden text-2xs" />
        <span className="flex min-w-0 items-center gap-1.5">
          {session.pinned && (
            <span role="img" aria-label="Pinned" title="Pinned" className="shrink-0 text-fg-muted">
              <PinIcon size={11} />
            </span>
          )}
          <span
            className="truncate text-xs font-semibold text-fg"
            title={`${session.title} · #${context.channelNames.get(session.channelId) ?? session.channelId}`}
          >
            {session.title}
          </span>
        </span>
        <span
          title={age.full}
          className={`text-3xs tabular-nums text-fg-muted transition-opacity ${
            canAnswer ? 'group-hover/agent-row:opacity-0 group-focus-within/agent-row:opacity-0' : ''
          }`}
        >
          {age.short}
        </span>
        <span className="col-start-2 col-end-4 min-w-0">
          {session.latestActivity && !isTerminalSessionStatus(session.status) ? (
            <SessionPresenceTicker session={session} />
          ) : (
            <span className="block truncate text-2xs text-fg-muted">{fallbackActivity(session)}</span>
          )}
        </span>
      </button>
      {canAnswer && (
        <button
          type="button"
          onClick={onFocus}
          className="absolute right-1.5 top-1.5 rounded px-1.5 py-1 text-3xs font-semibold text-warning-text-strong opacity-0 hover:bg-warning-tint/50 focus:opacity-100 focus-visible:outline-2 focus-visible:outline-warning group-hover/agent-row:opacity-100"
        >
          Answer
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
