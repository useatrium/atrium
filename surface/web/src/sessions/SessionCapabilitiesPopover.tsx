import { Fragment, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type {
  SessionCapabilityItem,
  SessionCapabilityNamespace,
  SessionCapabilitySnapshot,
} from '@atrium/surface-client';
import { useDialog } from '../useDialog';
import { RefreshCwIcon, SearchIcon, XIcon } from '../components/icons';
import { TimestampDisclosure } from '../components/TimestampDisclosure';
import { sessionsApi } from './api';

export function SessionCapabilitiesPopover({
  sessionId,
  open,
  invokerRef,
  details,
  onClose,
}: {
  sessionId: string;
  open: boolean;
  invokerRef: RefObject<HTMLButtonElement | null>;
  /** Session metadata rows (spawner, cost, repo…) shown above the scope. */
  details?: Array<{ label: string; value: string }>;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const requestSeqRef = useRef(0);
  const [snapshots, setSnapshots] = useState<SessionCapabilitySnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [expandedLists, setExpandedLists] = useState<Record<string, boolean>>({});

  const close = useCallback(() => onClose(), [onClose]);
  useDialog({
    open,
    containerRef: popoverRef,
    initialFocusRef: closeButtonRef,
    invokerRef,
    closeOnOutsidePointer: true,
    onClose: close,
  });

  const loadCapabilities = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setError(null);
    setLoading(true);
    try {
      const response = await sessionsApi.getCapabilities(sessionId);
      if (requestSeqRef.current !== seq) return;
      setSnapshots(response.snapshots);
    } catch (err: unknown) {
      if (requestSeqRef.current !== seq) return;
      setSnapshots([]);
      setError(err instanceof Error ? err.message : 'Could not load capabilities');
    } finally {
      if (requestSeqRef.current === seq) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    void loadCapabilities();
  }, [loadCapabilities, open]);

  useEffect(() => {
    requestSeqRef.current += 1;
    setSnapshots(null);
    setError(null);
    setLoading(false);
    setQuery('');
    setExpandedLists({});
  }, [sessionId]);

  if (!open) return null;
  const errorId = 'session-capabilities-error';

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Session capabilities"
      aria-describedby={error ? errorId : undefined}
      aria-busy={loading ? 'true' : undefined}
      className="absolute right-0 top-8 z-30 flex max-h-[min(74vh,44rem)] w-[44rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-md border border-edge-strong bg-surface-raised shadow-xl"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-xs font-semibold text-fg">Capability scope</h3>
          <p className="truncate text-3xs text-fg-muted">What this session's harness could see or call</p>
        </div>
        <button
          type="button"
          onClick={() => void loadCapabilities()}
          disabled={loading}
          title="Refresh capabilities"
          aria-label="Refresh capabilities"
          className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg disabled:cursor-default disabled:opacity-50"
        >
          <RefreshCwIcon size={14} className={loading ? 'animate-spin' : undefined} />
        </button>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={close}
          title="Close capabilities"
          aria-label="Close capabilities"
          className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          <XIcon size={14} />
        </button>
      </header>
      {details && details.length > 0 && (
        <dl
          data-testid="session-details"
          className="grid shrink-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-edge px-3 py-2 text-xs"
        >
          {details.map((row) => (
            <Fragment key={row.label}>
              <dt className="text-fg-muted">{row.label}</dt>
              <dd className="min-w-0 truncate text-fg-body" title={row.value}>
                {row.value}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      <div className="min-h-0 overflow-y-auto p-3 text-xs">
        {error && (
          <div
            id={errorId}
            role="alert"
            className="mb-3 rounded-md border border-danger-border bg-danger-tint/30 px-3 py-2 text-danger-text"
          >
            {error}
          </div>
        )}
        {snapshots && snapshots.length > 0 && (
          <label className="mb-3 flex h-8 items-center gap-2 rounded-md border border-edge bg-surface px-2 text-fg-muted focus-within:border-edge-strong focus-within:text-fg-secondary">
            <SearchIcon size={14} className="shrink-0" />
            <input
              type="search"
              aria-label="Filter capabilities"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter tools, MCP servers, agents, skills..."
              className="min-w-0 flex-1 bg-transparent text-2xs text-fg outline-none placeholder:text-fg-faint"
            />
            {loading && <span className="shrink-0 text-3xs text-fg-muted">Refreshing</span>}
          </label>
        )}
        {!snapshots && !error && <p className="text-fg-muted">Loading capabilities...</p>}
        {snapshots && snapshots.length === 0 && !error && (
          <p className="text-fg-muted">No harness capability snapshot has been captured yet.</p>
        )}
        {snapshots?.map((snapshot) => (
          <SnapshotSection
            key={snapshot.harness}
            snapshot={snapshot}
            query={query}
            expandedLists={expandedLists}
            onToggleList={(key) => setExpandedLists((current) => ({ ...current, [key]: !current[key] }))}
          />
        ))}
      </div>
    </div>
  );
}

function SnapshotSection({
  snapshot,
  query,
  expandedLists,
  onToggleList,
}: {
  snapshot: SessionCapabilitySnapshot;
  query: string;
  expandedLists: Record<string, boolean>;
  onToggleList: (key: string) => void;
}) {
  const runtimeRows = Object.entries(snapshot.runtime)
    .filter(([, value]) => value != null && value !== '')
    .slice(0, 12);
  const changes = snapshot.changes.slice(-8).reverse();
  const latestChange = snapshot.changes.at(-1);

  return (
    <section className="mb-3 overflow-hidden rounded-md border border-edge bg-surface last:mb-0">
      <div className="border-b border-edge bg-surface-raised/35 px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h4 className="text-xs font-semibold capitalize text-fg">{snapshot.harness}</h4>
              <Badge tone={snapshot.completeness === 'partial' ? 'warning' : 'neutral'}>{snapshot.completeness}</Badge>
              <span className="font-mono text-3xs text-fg-muted">{shortSha(snapshot.sourceSha256)}</span>
            </div>
            <p className="mt-1 text-2xs text-fg-secondary">{summaryLine(snapshot)}</p>
            {snapshot.completeness === 'partial' && (
              <p className="mt-0.5 text-3xs text-warning-text">
                Codex transcripts expose observed and lazily loaded tools, not every always-on tool.
              </p>
            )}
          </div>
          <div className="shrink-0 text-right text-3xs text-fg-muted">
            <div>
              <TimestampDisclosure
                iso={snapshot.generatedAt}
                label={formatCompactTimestamp(snapshot.generatedAt)}
                align="right"
                className="tabular-nums"
              >
                {formatCompactTimestamp(snapshot.generatedAt)}
              </TimestampDisclosure>
            </div>
            {latestChange && <div>last change: line {latestChange.line}</div>}
          </div>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 text-3xs sm:grid-cols-6">
          <Metric label="tools" value={snapshot.counts.tools} />
          <Metric label="mcp" value={snapshot.counts.mcpServers} />
          <Metric label="agents" value={snapshot.counts.agents} />
          <Metric label="skills" value={snapshot.counts.skills} />
          <Metric label="observed" value={snapshot.counts.observedToolCalls} />
          <Metric label="changes" value={snapshot.counts.changes} />
        </div>
      </div>
      <div className="grid gap-3 p-3 md:grid-cols-2">
        <CapabilityList
          listKey={`${snapshot.harness}:namespaces`}
          title="Tool namespaces"
          items={snapshot.toolNamespaces}
          query={query}
          expanded={!!expandedLists[`${snapshot.harness}:namespaces`]}
          onToggle={onToggleList}
        />
        <CapabilityList
          listKey={`${snapshot.harness}:observed`}
          title="Observed calls"
          items={snapshot.observedToolCalls}
          query={query}
          expanded={!!expandedLists[`${snapshot.harness}:observed`]}
          countKey="count"
          onToggle={onToggleList}
        />
        <CapabilityList
          listKey={`${snapshot.harness}:mcp`}
          title="MCP servers"
          items={snapshot.mcpServers}
          query={query}
          expanded={!!expandedLists[`${snapshot.harness}:mcp`]}
          onToggle={onToggleList}
        />
        <CapabilityList
          listKey={`${snapshot.harness}:agents`}
          title="Agents"
          items={snapshot.agents}
          query={query}
          expanded={!!expandedLists[`${snapshot.harness}:agents`]}
          onToggle={onToggleList}
        />
        <CapabilityList
          listKey={`${snapshot.harness}:skills`}
          title="Skills"
          items={snapshot.skills}
          query={query}
          expanded={!!expandedLists[`${snapshot.harness}:skills`]}
          onToggle={onToggleList}
        />
        <CapabilityList
          listKey={`${snapshot.harness}:tools`}
          title="Tools"
          items={snapshot.tools}
          query={query}
          expanded={!!expandedLists[`${snapshot.harness}:tools`]}
          onToggle={onToggleList}
        />
      </div>
      {runtimeRows.length > 0 && (
        <div className="border-t border-edge px-3 py-2">
          <h5 className="mb-1.5 text-2xs font-semibold text-fg-secondary">Runtime</h5>
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-2xs">
            {runtimeRows.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="truncate text-fg-muted">{labelize(key)}</dt>
                <dd className="min-w-0 break-words font-mono text-fg-secondary">{formatValue(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {changes.length > 0 && (
        <div className="border-t border-edge px-3 py-2">
          <h5 className="mb-1.5 text-2xs font-semibold text-fg-secondary">Lifecycle</h5>
          <ol className="space-y-1.5">
            {changes.map((change) => (
              <li key={`${change.seq}:${change.line}`} className="text-2xs text-fg-secondary">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium text-fg-body">{change.summary}</span>
                  <span className="shrink-0 text-fg-muted">line {change.line}</span>
                  {change.timestamp && (
                    <TimestampDisclosure
                      iso={change.timestamp}
                      label={formatCompactTimestamp(change.timestamp)}
                      className="shrink-0 text-fg-muted"
                    >
                      {formatCompactTimestamp(change.timestamp)}
                    </TimestampDisclosure>
                  )}
                </div>
                <div className="truncate text-fg-muted">
                  {change.source}
                  {change.redacted ? ' - redacted' : ''}
                  {change.added?.length ? ` - +${change.added.length}` : ''}
                  {change.removed?.length ? ` - -${change.removed.length}` : ''}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
      {(snapshot.redactions.length > 0 || snapshot.warnings.length > 0) && (
        <div className="border-t border-edge bg-surface-raised/30 px-3 py-2 text-2xs text-fg-muted">
          {[...snapshot.redactions, ...snapshot.warnings].slice(0, 4).map((note) => (
            <p key={note} className="truncate">
              {note}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

function CapabilityList({
  listKey,
  title,
  items,
  query,
  expanded,
  countKey,
  onToggle,
}: {
  listKey: string;
  title: string;
  items: (SessionCapabilityItem | SessionCapabilityNamespace)[];
  query: string;
  expanded: boolean;
  countKey?: 'count';
  onToggle: (key: string) => void;
}) {
  if (items.length === 0) return null;
  const filtered = items.filter((item) => matchesQuery(item, query));
  if (filtered.length === 0) return null;
  const limit = expanded || query.trim() ? filtered.length : 8;
  const visible = filtered.slice(0, limit);
  const hiddenCount = filtered.length - visible.length;

  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center gap-2">
        <h5 className="min-w-0 flex-1 truncate text-2xs font-semibold text-fg-secondary">
          {title}
          <span className="ml-1 font-normal text-fg-muted">{filtered.length}</span>
        </h5>
        {items.length > 8 && !query.trim() && (
          <button
            type="button"
            onClick={() => onToggle(listKey)}
            aria-label={`${expanded ? 'Collapse' : 'Show all'} ${title.toLowerCase()}`}
            className="shrink-0 rounded px-1.5 py-0.5 text-3xs text-fg-muted hover:bg-surface-overlay hover:text-fg"
          >
            {expanded ? 'Collapse' : 'Show all'}
          </button>
        )}
      </div>
      <ul className="divide-y divide-edge/70">
        {visible.map((item) => (
          <li key={item.name} className="min-w-0 py-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-body" title={item.name}>
                {item.name}
              </span>
              {'status' in item && item.status && <StatusBadge status={item.status} />}
              {countKey && typeof item.count === 'number' && (
                <span className="shrink-0 tabular-nums text-3xs text-fg-muted">{item.count}</span>
              )}
            </div>
            {item.description && <p className="mt-0.5 line-clamp-2 text-3xs text-fg-muted">{item.description}</p>}
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && <p className="mt-1 text-3xs text-fg-muted">+{hiddenCount} more</p>}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0">
      <div className="font-mono tabular-nums text-fg-secondary">{value}</div>
      <div className="truncate text-fg-muted">{label}</div>
    </div>
  );
}

function Badge({ children, tone = 'neutral' }: { children: string; tone?: 'neutral' | 'warning' }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-3xs font-medium ${
        tone === 'warning' ? 'bg-warning/15 text-warning-text' : 'bg-surface-overlay text-fg-secondary'
      }`}
    >
      {children}
    </span>
  );
}

function StatusBadge({ status }: { status: NonNullable<SessionCapabilityItem['status']> }) {
  return <span className="shrink-0 rounded bg-surface-overlay px-1 py-px text-3xs text-fg-muted">{status}</span>;
}

function summaryLine(snapshot: SessionCapabilitySnapshot): string {
  const harness = snapshot.harness === 'codex' ? 'Codex' : 'Claude';
  const observed =
    snapshot.counts.observedToolCalls > 0 ? `, ${counted(snapshot.counts.observedToolCalls, 'observed call')}` : '';
  return `${harness} ${snapshot.completeness} snapshot: ${counted(snapshot.counts.tools, 'tool')}, ${counted(snapshot.counts.mcpServers, 'MCP server')}, ${counted(snapshot.counts.agents, 'agent')}, ${counted(snapshot.counts.skills, 'skill')}${observed}.`;
}

function shortSha(value: string): string {
  return value ? value.slice(0, 10) : '';
}

const compactTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatCompactTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return compactTimestampFormatter.format(date);
}

function labelize(value: string): string {
  return value.replace(/[A-Z]/g, (match) => ` ${match.toLowerCase()}`).replace(/^./, (match) => match.toUpperCase());
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

function counted(value: number, label: string): string {
  return `${value} ${label}${value === 1 ? '' : 's'}`;
}

function matchesQuery(item: SessionCapabilityItem | SessionCapabilityNamespace, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    item.name,
    item.description,
    ...item.sources,
    'namespace' in item ? item.namespace : undefined,
    'status' in item ? item.status : undefined,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}
