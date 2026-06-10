import { memo, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { TextItem, ToolCallItem } from '@atrium/centaur-client';
import { Composer } from '../components/Composer';
import type { UserRef } from '../state';
import { sessionsApi } from './api';
import { StatusChip, sessionElapsedMs, useNow } from './SessionCard';
import {
  formatCost,
  formatElapsed,
  isTerminalSessionStatus,
  normalizeExecutionStatus,
  type Session,
  type SessionStatus,
} from './types';
import { useSessionStream } from './useSessionStream';

// Skip offscreen rendering work so 500+ item transcripts scroll smoothly.
const ITEM_VIS: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' };

export function SessionPane({
  session,
  me,
  spectators,
  onClose,
}: {
  session: Session;
  me: UserRef;
  spectators: number;
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
  const costUsd = Math.max(session.costUsd, stream.costUsd);
  const resultText = stream.resultText || session.resultText || '';
  const isSpawner = session.spawnedBy === me.id;

  // Manual expand/collapse overrides; default = open while running, collapsed
  // once the tool call has a result.
  const [toolOpen, setToolOpen] = useState<Record<string, boolean>>({});

  // Autoscroll while pinned to the bottom (same pattern as Timeline).
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastEventId = stream.lastEventId;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lastEventId]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <aside className="flex w-[520px] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950/60">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-800 px-3">
        <StatusChip status={displayStatus} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-zinc-100" title={session.title}>
            {session.title}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
            <span className="truncate">{session.spawnerName ?? session.spawnedBy}</span>
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
            <span className="tabular-nums">{formatElapsed(sessionElapsedMs(session, now))}</span>
            {!connected && !displayTerminal && (
              <span className="text-amber-400/80">· reconnecting…</span>
            )}
          </div>
        </div>
        {isSpawner && !displayTerminal && (
          <button
            onClick={() => sessionsApi.cancel(session.id).catch(() => {})}
            title="Cancel this session"
            className="rounded-md border border-red-900/60 px-2 py-1 text-[11px] font-medium text-red-400 hover:bg-red-950/40 hover:text-red-300"
          >
            Cancel
          </button>
        )}
        <button
          onClick={onClose}
          title="Close session pane"
          className="rounded-md px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          ✕
        </button>
      </header>

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
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            {displayTerminal ? 'No transcript.' : (
              <span className="animate-pulse">Waiting for agent output…</span>
            )}
          </div>
        )}
        {stream.items.map((item, i) =>
          item.type === 'text' ? (
            <TextBlock key={i} item={item} />
          ) : (
            <ToolCard
              key={i}
              item={item}
              expanded={toolOpen[item.id] ?? item.result === undefined}
              onToggle={() =>
                setToolOpen((prev) => ({
                  ...prev,
                  [item.id]: !(prev[item.id] ?? item.result === undefined),
                }))
              }
            />
          ),
        )}
      </div>

      <Composer
        placeholder="Message this session"
        onSend={(text) => sessionsApi.sendMessage(session.id, text).catch(() => {})}
        disabled={!isSpawner}
        disabledHint="spectating — driver seat coming in Phase 3"
      />
    </aside>
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
              <span className="text-zinc-600">done</span>
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
