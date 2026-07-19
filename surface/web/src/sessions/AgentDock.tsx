// The Agent Dock frame: resting spine ↔ open list ↔ immersed. The list layer
// (groups/rows) lives in AgentDockRows.tsx and receives everything it needs via
// AgentRowContext — frame work and row work stay in separate files.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { sessionDriverId } from '@atrium/surface-client';
import type { Channel } from '@atrium/surface-client';
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExpandIcon,
  PlusIcon,
  SearchIcon,
  ShrinkIcon,
  XIcon,
} from '../components/icons';
import { AgentGroup, type AgentRowContext } from './AgentDockRows';
import { useNow } from './SessionCard';
import { deriveSessionGlance, isLiveAgentWork, isTerminalSessionStatus, type Session } from './types';
import { useAgentDockMineFilter, useAgentDockOpen } from './useAgentDockPrefs';
import {
  AGENT_DOCK_FALLBACK_WIDTH,
  AGENT_DOCK_MAX_VW,
  AGENT_DOCK_MIN_WIDTH,
  agentDockWidthConfig,
  usePaneSize,
} from './useSessionPaneWidth';
import { agentDockCounts, agentDockGroups, type AgentDockGroup } from './useAgentDock';
import { EscapeLayer, escapeHasLocalMeaning, useEscapeLayer } from '../lib/escapeLayers';

export type AgentDockProps = {
  sessions: Record<string, Session>;
  channels: Channel[];
  activeChannelId: string | null;
  focusedSessionId: string | null;
  immersed: boolean;
  /** The viewing user, for mine-vs-others treatment in rows and counts. */
  meId: string | null;
  onFocusAgent: (id: string) => void;
  onToggleImmersed: () => void;
  onNewAgent: () => void;
  filterChannelId?: string | null;
  onClearFilter?: () => void;
  /** Filter the dock to a workstream (rows' channel tags reuse the presence-link behavior). */
  onFilterChannel?: (channelId: string) => void;
  onSetArchived?: (sessionId: string, archived: boolean, previousArchivedAt: string | null) => void;
  onSetPinned?: (sessionId: string, pinned: boolean, previousPinned: boolean) => void;
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

const HISTORY_OLDER_MS = 7 * 24 * 60 * 60 * 1_000;

function sessionHistoryTimestamp(session: Session): number {
  const timestamp = Date.parse(session.completedAt ?? session.latestActivity?.at ?? session.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isOlderHistorySession(session: Session, now: number): boolean {
  return now - sessionHistoryTimestamp(session) > HISTORY_OLDER_MS;
}

export function sidebarImmersionClassName(immersed: boolean): string {
  return immersed ? 'contents md:block md:w-0 md:shrink-0 md:overflow-hidden' : 'contents';
}

function GroupRows({
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
  return (
    <div className="[&>section]:space-y-0 [&>section>h2]:sr-only">
      <AgentGroup
        group={{ ...group, kind: 'channel' }}
        now={now}
        focusedSessionId={focusedSessionId}
        onFocusAgent={onFocusAgent}
        context={context}
      />
    </div>
  );
}

function SoftenedGroup({
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
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      open={expanded}
      data-testid="agent-dock-softened-group"
      data-kind={group.kind}
      className="group/disclosure border-t border-edge pt-2 opacity-60 open:opacity-80"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: summary is the native interactive disclosure control. */}
      <summary
        onClick={(event) => {
          event.preventDefault();
          setExpanded((value) => !value);
        }}
        className="flex cursor-pointer list-none items-center gap-1.5 rounded px-1 py-1 text-xs font-semibold text-fg-muted hover:bg-surface-overlay hover:text-fg-secondary focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden"
      >
        <ChevronRightIcon size={12} className="group-open/disclosure:hidden" />
        <ChevronDownIcon size={12} className="hidden group-open/disclosure:block" />
        <span>{group.label}</span>
        <span className="tabular-nums text-fg-faint">{group.sessions.length}</span>
      </summary>
      {expanded && (
        <div className="mt-1">
          <GroupRows
            group={group}
            now={now}
            focusedSessionId={focusedSessionId}
            onFocusAgent={onFocusAgent}
            context={context}
          />
        </div>
      )}
    </details>
  );
}

function HistoryGroup({
  group,
  now,
  softened,
  focusedSessionId,
  onFocusAgent,
  context,
  onSetArchived,
}: {
  group: AgentDockGroup;
  now: number;
  softened: boolean;
  focusedSessionId: string | null;
  onFocusAgent: (id: string) => void;
  context: AgentRowContext;
  onSetArchived?: AgentDockProps['onSetArchived'];
}) {
  const [expanded, setExpanded] = useState(false);
  const [olderExpanded, setOlderExpanded] = useState(false);
  const recent = group.sessions.filter((session) => !isOlderHistorySession(session, now));
  const older = group.sessions.filter((session) => isOlderHistorySession(session, now));
  const clearHistory = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!onSetArchived || !window.confirm(`Archive ${group.sessions.length} terminal sessions?`)) return;
    for (const session of group.sessions) {
      if (isTerminalSessionStatus(session.status)) onSetArchived(session.id, true, session.archivedAt);
    }
  };

  return (
    <details
      open={expanded}
      data-testid="agent-dock-history"
      className={`group/history border-t border-edge pt-2 ${softened ? 'opacity-60 open:opacity-80' : ''}`}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: summary is the native interactive disclosure control. */}
      <summary
        onClick={(event) => {
          event.preventDefault();
          setExpanded((value) => !value);
        }}
        className="flex cursor-pointer list-none items-center gap-1.5 rounded px-1 py-1 text-xs font-semibold text-fg-muted hover:bg-surface-overlay hover:text-fg-secondary focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden"
      >
        <ChevronRightIcon size={12} className="group-open/history:hidden" />
        <ChevronDownIcon size={12} className="hidden group-open/history:block" />
        <span>History</span>
        <span className="tabular-nums text-fg-faint">{group.sessions.length}</span>
        {onSetArchived && (
          <button
            type="button"
            onClick={clearHistory}
            className="ml-auto rounded px-1.5 py-1 text-2xs font-medium text-fg-muted hover:bg-surface-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
          >
            Clear
          </button>
        )}
      </summary>
      {expanded && (
        <div className="mt-1 space-y-2">
          {recent.length > 0 && (
            <GroupRows
              group={{ ...group, sessions: recent }}
              now={now}
              focusedSessionId={focusedSessionId}
              onFocusAgent={onFocusAgent}
              context={context}
            />
          )}
          {older.length > 0 && (
            <details open={olderExpanded} className="group/older">
              {/* biome-ignore lint/a11y/noStaticElementInteractions: summary is the native interactive disclosure control. */}
              <summary
                onClick={(event) => {
                  event.preventDefault();
                  setOlderExpanded((value) => !value);
                }}
                className="flex cursor-pointer list-none items-center gap-1.5 rounded px-1 py-1 text-2xs font-semibold text-fg-muted hover:bg-surface-overlay hover:text-fg-secondary focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden"
              >
                <ChevronRightIcon size={11} className="group-open/older:hidden" />
                <ChevronDownIcon size={11} className="hidden group-open/older:block" />
                <span>Show older</span>
                <span className="tabular-nums text-fg-faint">{older.length}</span>
              </summary>
              {olderExpanded && (
                <div className="mt-1">
                  <GroupRows
                    group={{ ...group, label: 'Older history', sessions: older }}
                    now={now}
                    focusedSessionId={focusedSessionId}
                    onFocusAgent={onFocusAgent}
                    context={context}
                  />
                </div>
              )}
            </details>
          )}
        </div>
      )}
    </details>
  );
}

export function AgentDock({
  sessions,
  channels,
  activeChannelId,
  focusedSessionId,
  immersed,
  meId,
  onFocusAgent,
  onToggleImmersed,
  onNewAgent,
  filterChannelId,
  onClearFilter,
  onFilterChannel,
  onSetArchived,
  onSetPinned,
  onOpenAttention,
}: AgentDockProps) {
  const [open, setOpen] = useAgentDockOpen();
  const [mineFilter, setMineFilter] = useAgentDockMineFilter();
  const [query, setQuery] = useState('');
  const filterInputRef = useRef<HTMLInputElement>(null);
  const now = useNow(Object.values(sessions).some(isLiveAgentWork));
  const dockSize = usePaneSize(agentDockWidthConfig);

  useEffect(() => {
    if (immersed || filterChannelId) setOpen(true);
  }, [filterChannelId, immersed, setOpen]);

  // Lowest of the dismiss layers: Escape only collapses the dock once nothing
  // above it (a running turn, an open pane, the filter query) claims the press.
  useEscapeLayer(
    EscapeLayer.dock,
    (event) => {
      // A non-empty filter query clears first; an empty one falls through to
      // collapse. Any other editable field or menu keeps its own Escape.
      if (event.target === filterInputRef.current) {
        if (query) {
          setQuery('');
          return true;
        }
      } else if (escapeHasLocalMeaning(event)) {
        return false;
      }
      if (immersed) onToggleImmersed();
      else setOpen(false);
      return true;
    },
    open || immersed,
  );

  // The Triage entry is GLOBAL — it always matches the Attention view it opens
  // across every workstream and driver (splitting the two is what produced
  // "Triage 1 →" opening a view that says 3 are waiting). The spine BADGE is
  // the interruption surface, so it counts only the viewer's own agents when
  // the viewer is known — a teammate's blocked agent should be visible in the
  // list, not paging you from across the room.
  const counts = agentDockCounts(sessions);
  const badgeCounts = meId ? agentDockCounts(sessions, { mineOnly: meId }) : counts;
  const listSessions = useMemo(() => {
    if (!mineFilter || !meId) return sessions;
    return Object.fromEntries(Object.entries(sessions).filter(([, session]) => sessionDriverId(session) === meId));
  }, [meId, mineFilter, sessions]);
  const groups = useMemo(
    () => agentDockGroups(listSessions, { activeChannelId, now, channels }),
    [activeChannelId, channels, listSessions, now],
  );
  const visibleGroups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return groups;
    return groups
      .map((group) => ({
        ...group,
        sessions:
          filterChannelId && group.kind === 'needs'
            ? group.sessions
            : group.sessions.filter((session) =>
                [session.title, session.harness, group.label].some((value) => value.toLowerCase().includes(normalized)),
              ),
      }))
      .filter((group) => group.sessions.length > 0);
  }, [filterChannelId, groups, query]);
  const total = visibleGroups.reduce((sum, group) => sum + group.sessions.length, 0);
  const liveDots = useMemo(
    () =>
      Object.values(sessions)
        .filter((session) => !filterChannelId || session.channelId === filterChannelId)
        .filter(isLiveAgentWork)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .slice(0, 6),
    [filterChannelId, sessions],
  );
  const channelNames = useMemo(() => new Map(channels.map((channel) => [channel.id, channel.name])), [channels]);
  const rowContext = useMemo<AgentRowContext>(
    () => ({
      meId,
      channelNames,
      ...(onFilterChannel ? { onFilterChannel } : {}),
      ...(onSetArchived ? { onSetArchived } : {}),
      ...(onSetPinned ? { onSetPinned } : {}),
    }),
    [channelNames, meId, onFilterChannel, onSetArchived, onSetPinned],
  );
  const filterChannel = filterChannelId ? channels.find((channel) => channel.id === filterChannelId) : undefined;
  const state = immersed ? 'immersed' : open ? 'open' : 'resting';
  const dockMaxWidth =
    typeof window === 'undefined'
      ? AGENT_DOCK_FALLBACK_WIDTH
      : Math.max(AGENT_DOCK_MIN_WIDTH, Math.round((window.innerWidth * AGENT_DOCK_MAX_VW) / 100));

  const renderGroup = (group: AgentDockGroup) => {
    if (group.kind === 'recent') {
      return (
        <HistoryGroup
          key={group.key}
          group={group}
          now={now}
          softened={Boolean(filterChannelId)}
          focusedSessionId={focusedSessionId}
          onFocusAgent={onFocusAgent}
          context={rowContext}
          onSetArchived={onSetArchived}
        />
      );
    }

    const softened =
      Boolean(filterChannelId) &&
      group.kind !== 'needs' &&
      !(group.kind === 'channel' && group.channelId === filterChannelId);
    if (softened) {
      return (
        <SoftenedGroup
          key={group.key}
          group={group}
          now={now}
          focusedSessionId={focusedSessionId}
          onFocusAgent={onFocusAgent}
          context={rowContext}
        />
      );
    }

    return (
      <AgentGroup
        key={group.key}
        group={group}
        now={now}
        focusedSessionId={focusedSessionId}
        onFocusAgent={onFocusAgent}
        context={rowContext}
      />
    );
  };

  return (
    <>
      {state !== 'resting' && (
        <button
          type="button"
          aria-label="Close agent dock sheet"
          onClick={() => (immersed ? onToggleImmersed() : setOpen(false))}
          className="fixed inset-0 z-overlay cursor-default bg-black/50 md:hidden"
        />
      )}
      <aside
        data-testid="agent-dock"
        data-state={state}
        aria-label="Agents"
        className={`flex min-h-0 shrink-0 flex-col bg-surface-raised motion-safe:transition-[width,height] motion-safe:duration-200 motion-reduce:transition-none ${
          state === 'resting'
            ? 'fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[calc(1rem+env(safe-area-inset-right))] z-overlay size-12 rounded-full border border-edge-strong shadow-lg md:relative md:inset-auto md:z-auto md:h-full md:w-13 md:rounded-none md:border-y-0 md:border-r-0 md:border-l md:border-edge md:shadow-none'
            : immersed
              ? 'fixed inset-0 z-overlay h-dvh w-full border-edge shadow-2xl md:relative md:inset-auto md:z-auto md:h-full md:w-(--agent-dock-w) md:border-y-0 md:border-r-0 md:border-l md:shadow-none'
              : 'fixed inset-x-0 bottom-0 z-overlay h-[60dvh] w-full rounded-t-xl border border-edge-strong shadow-2xl md:relative md:inset-auto md:z-auto md:h-full md:w-(--agent-dock-w) md:rounded-none md:border-y-0 md:border-r-0 md:border-l md:border-edge md:shadow-none'
        }`}
        style={{ '--agent-dock-w': '256px', ...dockSize.style } as CSSProperties}
      >
        {state !== 'resting' && (
          <>
            <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-edge-strong md:hidden" />
            {/* biome-ignore lint/a11y/useSemanticElements: pointer-capture separator mirrors the sidebar handle. */}
            <div
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="Resize agent dock"
              aria-valuemin={AGENT_DOCK_MIN_WIDTH}
              aria-valuemax={dockMaxWidth}
              aria-valuenow={dockSize.size ?? AGENT_DOCK_FALLBACK_WIDTH}
              title="Drag to resize · double-click to reset"
              data-testid="agent-dock-resize-handle"
              onPointerDown={dockSize.startResize}
              onDoubleClick={dockSize.resetSize}
              className={`absolute inset-y-0 -left-0.5 z-raised w-1.5 cursor-col-resize touch-none transition-colors hover:bg-accent/50 max-md:hidden ${
                dockSize.resizing ? 'bg-accent/50' : ''
              }`}
            />
          </>
        )}
        {state === 'resting' ? (
          <div className="flex h-full min-h-0 flex-col items-center md:py-2">
            <button
              type="button"
              aria-label={`Open agent dock${badgeCounts.needsYou > 0 ? `, ${badgeCounts.needsYou} need you` : ''}`}
              onClick={() => setOpen(true)}
              className="flex size-12 flex-none items-center justify-center rounded-full text-fg-muted hover:bg-surface-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent md:min-h-0 md:w-full md:flex-1 md:flex-col md:gap-3 md:rounded-sm md:py-1"
            >
              <span className="relative grid size-8 place-items-center rounded-md bg-surface-overlay/70">
                <BotIcon size={17} />
                {badgeCounts.needsYou > 0 && (
                  // Deliberately not live: agent event bursts can change this badge rapidly,
                  // while the opening button's accessible name always exposes the current count.
                  <span
                    data-testid="agent-dock-needs-badge"
                    title={`${badgeCounts.needsYou} of your agents need you`}
                    className="absolute -right-1.5 -top-1.5 grid min-w-4 place-items-center rounded-full bg-warning px-1 text-3xs font-bold leading-4 text-surface"
                  >
                    {badgeCounts.needsYou}
                  </span>
                )}
              </span>
              {liveDots.length > 0 && (
                // biome-ignore lint/a11y/useSemanticElements: a semantic ul is invalid phrasing content inside this full-spine button.
                <span role="list" aria-label="Live agents" className="hidden flex-col items-center gap-1.5 md:flex">
                  {liveDots.map((session) => {
                    const glance = deriveSessionGlance(session, now);
                    return (
                      // biome-ignore lint/a11y/useSemanticElements: see the parent list's phrasing-content constraint.
                      <span
                        key={session.id}
                        role="listitem"
                        aria-label={`${session.title}: ${glance.label}`}
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
              className="mt-2 hidden size-9 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-surface-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-accent md:grid"
            >
              <PlusIcon size={17} />
            </button>
          </div>
        ) : (
          <>
            <header className="shrink-0 border-b border-edge px-2 py-2">
              <div className="flex h-11 items-center gap-1 md:h-8">
                <h1 className="min-w-0 flex-1 truncate px-1 text-sm font-bold text-fg">Agents</h1>
                <span className="mr-1 text-xs tabular-nums text-fg-muted">{total}</span>
                {!immersed && (
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="Collapse agent dock"
                    className="grid size-11 place-items-center rounded text-fg-muted hover:bg-surface-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-accent md:size-7"
                  >
                    <XIcon size={16} className="md:hidden" />
                    <ChevronRightIcon size={14} className="max-md:hidden" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={onToggleImmersed}
                  aria-label={immersed ? 'Exit immersed agent dock' : 'Immerse agent dock'}
                  className="grid size-11 place-items-center rounded text-fg-muted hover:bg-surface-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-accent md:size-7"
                >
                  {immersed ? <ShrinkIcon size={14} /> : <ExpandIcon size={14} />}
                </button>
                <button
                  type="button"
                  onClick={onNewAgent}
                  aria-label="New agent"
                  className="grid size-11 place-items-center rounded bg-accent text-on-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:size-7"
                >
                  <PlusIcon size={14} />
                </button>
              </div>
              <label className="mt-2 flex h-11 items-center gap-2 rounded-md border border-edge bg-surface px-2 text-fg-muted focus-within:border-edge-focus md:h-8">
                <SearchIcon size={13} className="shrink-0" />
                <span className="sr-only">Filter agents</span>
                <input
                  ref={filterInputRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter agents…"
                  className="min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-muted md:text-xs"
                />
              </label>
              <div className="mt-2 flex min-h-6 items-center gap-2 px-1">
                {meId && (
                  // biome-ignore lint/a11y/useSemanticElements: compact segmented control exposes a named group with pressed buttons; fieldset would alter header layout (same idiom as ViewToggle).
                  <div
                    role="group"
                    aria-label="Show agents"
                    className="flex shrink-0 rounded-md border border-edge bg-surface p-0.5"
                  >
                    {(
                      [
                        { mine: true, label: 'Mine' },
                        { mine: false, label: 'All' },
                      ] as const
                    ).map(({ mine, label }) => (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={mineFilter === mine}
                        onClick={() => setMineFilter(mine)}
                        className={`min-h-6 rounded px-1.5 text-2xs font-semibold focus-visible:outline-2 focus-visible:outline-accent ${
                          mineFilter === mine ? 'bg-surface-overlay text-fg' : 'text-fg-muted hover:text-fg'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
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

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:pb-3">
              {visibleGroups.length > 0 ? (
                <div className="space-y-4">{visibleGroups.map(renderGroup)}</div>
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
    </>
  );
}
