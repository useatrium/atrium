import { useEffect, useRef, useState } from 'react';
import { toolDisplay, type FoldedTurnRow, type TurnWorkItem } from '@atrium/centaur-client';
import { StepDetail } from './StepDetail';

function durationLabel(durationMs: number | undefined, live: boolean): string {
  if (live) return 'live';
  if (durationMs === undefined) return '<1s';
  if (durationMs < 1000) return '<1s';
  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

function stepSummary(item: TurnWorkItem): string {
  if (item.type === 'reasoning') return firstLine(item.summary || item.text) || 'Reasoning';
  const descriptor = toolDisplay(item);
  return descriptor.subtitle ? `${descriptor.title} · ${descriptor.subtitle}` : descriptor.title;
}

function StepGlyph({ item }: { item: TurnWorkItem }) {
  if (item.type === 'reasoning') return <span className="text-accent-text">✳</span>;
  if (item.result?.is_error) return <span className="text-danger-text">✕</span>;
  if (item.result) return <span className="text-success-text">✓</span>;
  return <span className="animate-pulse text-accent-text motion-reduce:animate-none">●</span>;
}

export function WorkFold({ fold, live, onOpenWork }: { fold: FoldedTurnRow; live: boolean; onOpenWork?: () => void }) {
  const [open, setOpen] = useState(live);
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
  const wasLive = useRef(live);

  useEffect(() => {
    if (live) setOpen(true);
    else if (wasLive.current) setOpen(false);
    wasLive.current = live;
  }, [live]);

  const duration = durationLabel(fold.durationMs, live);
  const names = fold.toolNames.slice(0, 3).join(', ');
  const countLabel = `${fold.items.length} ${fold.items.length === 1 ? 'step' : 'steps'}`;

  if (!open) {
    return (
      <button
        type="button"
        data-testid="work-fold-collapsed"
        onClick={() => setOpen(true)}
        className="my-1 ml-[43px] flex max-w-[calc(100%-59px)] items-center gap-1 truncate rounded-md border border-edge px-2 py-1.5 text-left text-[12.5px] text-fg-muted transition-colors hover:border-edge-strong hover:text-fg-secondary"
      >
        <span aria-hidden>▶</span>
        <span aria-hidden>⚙</span>
        <span className="truncate">
          {countLabel}
          {names ? ` · ${names}` : ''} · {duration}
        </span>
      </button>
    );
  }

  return (
    <section
      data-testid="work-fold-expanded"
      className="my-1 ml-[43px] max-w-[calc(100%-59px)] overflow-hidden rounded-md border border-edge bg-surface-raised/45"
    >
      <div className="flex items-center gap-1 border-b border-edge bg-surface-overlay/55 px-2 py-1.5 text-[12.5px] text-fg-secondary">
        <span aria-hidden>▼</span>
        <span aria-hidden>⚙</span>
        <span>
          {countLabel} · {duration}
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="ml-auto text-xs text-fg-muted hover:text-fg hover:underline"
        >
          collapse
        </button>
      </div>
      <div className="divide-y divide-edge/70">
        {fold.items.map((item) => {
          const stepOpen = openSteps[item.id] === true;
          return (
            <div key={item.id} className="px-2 py-1.5 font-mono text-xs">
              <button
                type="button"
                aria-expanded={stepOpen}
                onClick={() => setOpenSteps((current) => ({ ...current, [item.id]: !stepOpen }))}
                className="flex w-full min-w-0 items-center gap-1.5 text-left text-fg-secondary hover:text-fg"
              >
                <StepGlyph item={item} />
                <span className="truncate">{stepSummary(item)}</span>
                <span aria-hidden className="ml-auto text-fg-muted">
                  {stepOpen ? '▼' : '▶'}
                </span>
              </button>
              {stepOpen && <StepDetail item={item} onOpenWork={onOpenWork} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}
