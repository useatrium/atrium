import { useState } from 'react';
import type { FoldedTurnRow, SubagentGroup, SubagentStatus } from '@atrium/centaur-client';
import { WorkFold } from './WorkFold';

/** Roster glyph, matching WorkFold's per-step vocabulary: running pulses, done
 *  is a check, failed is a cross. */
function StatusGlyph({ status }: { status: SubagentStatus }) {
  if (status === 'failed') return <span className="text-danger-text">✕</span>;
  if (status === 'completed') return <span className="text-success-text">✓</span>;
  return <span className="animate-pulse text-accent-text motion-reduce:animate-none">●</span>;
}

function subagentLabel(group: SubagentGroup): string {
  return group.subagentType?.trim() || 'subagent';
}

/** A subagent's own steps rendered through the same fold the main transcript
 *  uses — reuse, not a fork. */
function subagentFold(group: SubagentGroup): FoldedTurnRow {
  const toolNames = [...new Set(group.items.flatMap((item) => (item.type === 'tool_call' ? [item.name] : [])))];
  return {
    kind: 'fold',
    key: `subagent-${group.parentId}`,
    turn: 0,
    executionId: null,
    items: group.items,
    toolNames,
    startIndex: 0,
    endIndex: Math.max(0, group.items.length - 1),
    triggerIndex: null,
    triggerOrdinal: null,
    replyIndex: null,
    completed: group.status !== 'running',
  };
}

function SubagentRow({ group }: { group: SubagentGroup }) {
  const [open, setOpen] = useState(false);
  const stepLabel = `${group.stepCount} ${group.stepCount === 1 ? 'step' : 'steps'}`;
  const hasSteps = group.items.length > 0;

  return (
    <div data-testid={`subagent-${group.parentId}`}>
      <button
        type="button"
        aria-expanded={open}
        disabled={!hasSteps}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-fg-secondary transition-colors hover:text-fg disabled:cursor-default disabled:hover:text-fg-secondary"
      >
        <StatusGlyph status={group.status} />
        <span className="font-medium text-fg">{subagentLabel(group)}</span>
        {group.description ? <span className="truncate text-fg-muted">· {group.description}</span> : null}
        <span className="ml-auto shrink-0 text-fg-muted">{stepLabel}</span>
        {hasSteps ? (
          <span aria-hidden className="shrink-0 text-fg-muted">
            {open ? '▼' : '▶'}
          </span>
        ) : null}
      </button>
      {open && hasSteps ? (
        <WorkFold fold={subagentFold(group)} live={group.status === 'running'} nested expandAll />
      ) : null}
    </div>
  );
}

/**
 * The live "Agents" strip: a compact roster of a turn's Task-tool subagents with
 * per-agent status, each expandable to drill into that subagent's own step
 * stream (reusing WorkFold/StepDetail). Renders nothing when no subagents ran.
 */
export function AgentsStrip({ groups }: { groups: readonly SubagentGroup[] }) {
  const [open, setOpen] = useState(true);
  if (groups.length === 0) return null;

  const running = groups.filter((group) => group.status === 'running').length;
  const countLabel = `${groups.length} ${groups.length === 1 ? 'agent' : 'agents'}`;

  return (
    <div data-testid="agents-strip" className="border-t border-edge px-3.5 py-1.5 text-2xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 text-left text-fg-muted transition-colors hover:text-fg-secondary"
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        <span className="font-medium text-fg-secondary">{countLabel}</span>
        {running > 0 ? (
          <span data-testid="agents-strip-running" className="rounded-full bg-accent-hover/15 px-1.5 text-accent-text">
            {running} running
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-0.5">
          {groups.map((group) => (
            <SubagentRow key={group.parentId} group={group} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
