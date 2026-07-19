import { useEffect, useMemo, useState } from 'react';
import type { Channel } from '@atrium/surface-client';
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExpandIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  ShrinkIcon,
  XIcon,
} from '../components/icons';
import { GlanceChip } from './GlanceChip';
import { useNow } from './SessionCard';
import { SessionPresenceTicker } from './SessionPresenceTicker';
import {
  deriveSessionGlance,
  isLiveAgentWork,
  isTerminalSessionStatus,
  sessionAttentionKind,
  type Session,
} from './types';
import { agentDockCounts, agentDockGroups, type AgentDockGroup } from './useAgentDock';

export type AgentDockProps = {
  sessions: Record<string, Session>;
  channels: Channel[];
  activeChannelId: string | null;
  focusedSessionId: string | null;
  immersed: boolean;
  onFocusAgent: (id: string) => void;
  onToggleImmersed: () => void;
  onNewAgent: () => void;
  filterChannelId?: string | null;
  onClearFilter?: () => void;
  /** Foundation seam for the full Needs-you view; the dock lane will place it. */
  onOpenAttention?: () => void;
};

const DOT_STYLES = {
  working: 'bg-accent-hover',
  needs_you: 'bg-warning',
  stalled: 'bg-fg-muted',
  done: 'bg-success',
  failed: 'bg-danger',
  stopped: 'bg-fg-faint',
} as const;

function sessionAge(session: Session, now: number): { short: string; full: string } {
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

function AgentRow({
  session,
  now,
  selected,
  onFocus,
}: {
  session: Session;
  now: number;
  selected: boolean;
  onFocus: () => void;
}) {
  const age = sessionAge(session, now);
  const canAnswer = sessionAttentionKind(session) === 'question';

  return (
    <li
      data-testid={`agent-dock-row-${session.id}`}
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
          <span className="truncate text-xs font-semibold text-fg" title={session.title}>
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

function AgentGroup({
  group,
  now,
  focusedSessionId,
  onFocusAgent,
}: {
  group: AgentDockGroup;
  now: number;
  focusedSessionId: string | null;
  onFocusAgent: (id: string) => void;
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

export function AgentDock({
  sessions,
  channels,
  activeChannelId,
  focusedSessionId,
  immersed,
  onFocusAgent,
  onToggleImmersed,
  onNewAgent,
  filterChannelId,
  onClearFilter,
  onOpenAttention,
}: AgentDockProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const now = useNow(Object.values(sessions).some(isLiveAgentWork));

  useEffect(() => {
    if (immersed || filterChannelId) setOpen(true);
  }, [filterChannelId, immersed]);

  const filteredSessions = useMemo(
    () =>
      filterChannelId
        ? Object.fromEntries(Object.entries(sessions).filter(([, session]) => session.channelId === filterChannelId))
        : sessions,
    [filterChannelId, sessions],
  );
  const counts = agentDockCounts(filteredSessions);
  const groups = useMemo(
    () => agentDockGroups(filteredSessions, { activeChannelId, now, channels }),
    [activeChannelId, channels, filteredSessions, now],
  );
  const visibleGroups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return groups;
    return groups
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((session) =>
          [session.title, session.harness, group.label].some((value) => value.toLowerCase().includes(normalized)),
        ),
      }))
      .filter((group) => group.sessions.length > 0);
  }, [groups, query]);
  const total = visibleGroups.reduce((sum, group) => sum + group.sessions.length, 0);
  const liveDots = useMemo(
    () =>
      Object.values(filteredSessions)
        .filter(isLiveAgentWork)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .slice(0, 6),
    [filteredSessions],
  );
  const filterChannel = filterChannelId ? channels.find((channel) => channel.id === filterChannelId) : undefined;
  const state = immersed ? 'immersed' : open ? 'open' : 'resting';

  return (
    <aside
      data-testid="agent-dock"
      data-state={state}
      aria-label="Agents"
      className={`flex h-full min-h-0 shrink-0 flex-col border-l border-edge bg-surface-raised transition-[width] duration-200 motion-reduce:transition-none ${
        immersed ? 'w-80' : open ? 'w-64' : 'w-13'
      }`}
    >
      {state === 'resting' ? (
        <div className="flex h-full min-h-0 flex-col items-center py-2">
          <button
            type="button"
            aria-label={`Open agent dock${counts.needsYou > 0 ? `, ${counts.needsYou} need you` : ''}`}
            onClick={() => setOpen(true)}
            className="flex min-h-0 w-full flex-1 flex-col items-center gap-3 rounded-sm py-1 text-fg-muted hover:bg-surface-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
          >
            <span className="relative grid size-8 place-items-center rounded-md bg-surface-overlay/70">
              <BotIcon size={17} />
              {counts.needsYou > 0 && (
                <span
                  data-testid="agent-dock-needs-badge"
                  title={`${counts.needsYou} agents need you`}
                  className="absolute -right-1.5 -top-1.5 grid min-w-4 place-items-center rounded-full bg-warning px-1 text-3xs font-bold leading-4 text-surface"
                >
                  {counts.needsYou}
                </span>
              )}
            </span>
            {liveDots.length > 0 && (
              <span
                role="img"
                aria-label={`${liveDots.length} live agents`}
                className="flex flex-col items-center gap-1.5"
              >
                {liveDots.map((session) => {
                  const glance = deriveSessionGlance(session, now);
                  return (
                    <span
                      key={session.id}
                      title={`${session.title}: ${glance.label}`}
                      className={`size-2 rounded-full ${DOT_STYLES[glance.kind]} ${
                        glance.pulse ? 'animate-pulse motion-reduce:animate-none' : ''
                      }`}
                    />
                  );
                })}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={onNewAgent}
            aria-label="New agent"
            className="mt-2 grid size-9 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-surface-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
          >
            <PlusIcon size={17} />
          </button>
        </div>
      ) : (
        <>
          <header className="shrink-0 border-b border-edge px-2 py-2">
            <div className="flex h-8 items-center gap-1">
              <h1 className="min-w-0 flex-1 truncate px-1 text-sm font-bold text-fg">Agents</h1>
              <span className="mr-1 text-xs tabular-nums text-fg-muted">{total}</span>
              {!immersed && (
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Collapse agent dock"
                  className="grid size-7 place-items-center rounded text-fg-muted hover:bg-surface-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <ChevronRightIcon size={14} />
                </button>
              )}
              <button
                type="button"
                onClick={onToggleImmersed}
                aria-label={immersed ? 'Exit immersed agent dock' : 'Immerse agent dock'}
                className="grid size-7 place-items-center rounded text-fg-muted hover:bg-surface-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              >
                {immersed ? <ShrinkIcon size={14} /> : <ExpandIcon size={14} />}
              </button>
              <button
                type="button"
                onClick={onNewAgent}
                aria-label="New agent"
                className="grid size-7 place-items-center rounded bg-accent text-on-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <PlusIcon size={14} />
              </button>
            </div>
            <label className="mt-2 flex h-8 items-center gap-2 rounded-md border border-edge bg-surface px-2 text-fg-muted focus-within:border-edge-focus">
              <SearchIcon size={13} className="shrink-0" />
              <span className="sr-only">Filter agents</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter agents…"
                className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-muted"
              />
            </label>
            <div className="mt-2 flex min-h-6 items-center gap-2 px-1">
              {filterChannelId && (
                <span className="flex min-w-0 flex-1 items-center gap-1 text-2xs text-fg-muted">
                  <span className="min-w-0 truncate">Workstream: #{filterChannel?.name ?? filterChannelId}</span>
                  {onClearFilter && (
                    <button
                      type="button"
                      onClick={onClearFilter}
                      aria-label="Clear workstream filter"
                      className="grid size-5 shrink-0 place-items-center rounded text-fg-muted hover:bg-surface-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <XIcon size={11} />
                    </button>
                  )}
                </span>
              )}
              {counts.needsYou > 0 && onOpenAttention && (
                <button
                  type="button"
                  onClick={onOpenAttention}
                  className="ml-auto shrink-0 rounded px-1.5 py-1 text-2xs font-semibold text-warning-text-strong hover:bg-warning-tint/50 focus-visible:outline-2 focus-visible:outline-warning"
                >
                  Triage {counts.needsYou} →
                </button>
              )}
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
            {visibleGroups.length > 0 ? (
              <div className="space-y-4">
                {visibleGroups.map((group) => (
                  <AgentGroup
                    key={group.key}
                    group={group}
                    now={now}
                    focusedSessionId={focusedSessionId}
                    onFocusAgent={onFocusAgent}
                  />
                ))}
              </div>
            ) : (
              <div className="px-3 py-8 text-center">
                <p className="text-xs font-medium text-fg-secondary">
                  {query.trim() ? 'No matching agents' : 'No agents in this workstream'}
                </p>
                <p className="mt-1 text-2xs leading-relaxed text-fg-muted">
                  {query.trim() ? 'Try a title, harness, or channel name.' : 'New agent work will appear here.'}
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
