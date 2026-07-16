import { useEffect, useRef, useState } from 'react';
import { toolDisplay, type FoldedTurnRow, type TurnWorkItem } from '@atrium/centaur-client';
import { StepDetail } from './StepDetail';

/**
 * A fold that owns a row hangs in the avatar gutter of the messages around it:
 * indented past the avatar but deliberately short of the text column (measured
 * against a live thread — the message row puts its avatar at 16px and its text
 * at 60px, and the fold sits at 43px), and inset on the right by that row's own
 * `px-4` so the two right edges line up — hence 59 = 43 + 16. The pair has to
 * move together; changing one alone knocks the fold out of alignment.
 *
 * Tailwind only generates classes it can see as literal strings, so these stay
 * spelled out rather than computed. A `nested` fold renders inside a message's
 * content column, which has already applied the gutter, and takes none of this.
 */
const STANDALONE_GUTTER = 'ml-[43px] max-w-[calc(100%-59px)]';

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

export function WorkFold({
  fold,
  live,
  expandAll = false,
  nested = false,
  revealStepHandle = null,
  highlightedStepHandle = null,
  onOpenWork,
  onDiscussStep,
}: {
  fold: FoldedTurnRow;
  live: boolean;
  /** Pane-level disclosure preference. ThreadPanel leaves this uncontrolled. */
  expandAll?: boolean;
  /** Rendered inside a message's content column (already past the avatar
   *  gutter), so it drops the standalone row's gutter offset. */
  nested?: boolean;
  /** Opens a linked step so SessionPane entry deep-links remain addressable. */
  revealStepHandle?: string | null;
  highlightedStepHandle?: string | null;
  onOpenWork?: () => void;
  onDiscussStep?: (item: TurnWorkItem) => void;
}) {
  const revealedStep = fold.items.find((item) => item.handle === revealStepHandle);
  const [open, setOpen] = useState(live || expandAll || revealedStep != null);
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>(() =>
    revealedStep ? { [revealedStep.id]: true } : {},
  );
  const wasLive = useRef(live);
  const wasExpandAll = useRef(expandAll);

  useEffect(() => {
    if (live || expandAll) setOpen(true);
    else if (wasLive.current || wasExpandAll.current) setOpen(false);
    wasLive.current = live;
    wasExpandAll.current = expandAll;
  }, [expandAll, live]);

  useEffect(() => {
    const step = fold.items.find((item) => item.handle === revealStepHandle);
    if (!step) return;
    setOpen(true);
    setOpenSteps((current) => (current[step.id] ? current : { ...current, [step.id]: true }));
  }, [fold.items, revealStepHandle]);

  const duration = durationLabel(fold.durationMs, live);
  const names = fold.toolNames.slice(0, 3).join(', ');
  const countLabel = `${fold.items.length} ${fold.items.length === 1 ? 'step' : 'steps'}`;

  const offset = nested ? '' : STANDALONE_GUTTER;

  if (!open) {
    return (
      <button
        type="button"
        data-testid="work-fold-collapsed"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className={`my-1 ${offset} flex items-center gap-1 truncate rounded-md border border-edge px-2 py-1.5 text-left text-[12.5px] text-fg-muted transition-colors hover:border-edge-strong hover:text-fg-secondary`}
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
      className={`my-1 ${offset} overflow-hidden rounded-md border border-edge bg-surface-raised/45`}
    >
      {/* The whole header toggles, mirroring the collapsed chip — the ▼ used to
          be inert, so the fold could only ever be opened, never closed. */}
      <button
        type="button"
        aria-expanded
        onClick={() => setOpen(false)}
        className="flex w-full items-center gap-1 border-b border-edge bg-surface-overlay/55 px-2 py-1.5 text-left text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-overlay hover:text-fg"
      >
        <span aria-hidden>▼</span>
        <span aria-hidden>⚙</span>
        <span>
          {countLabel} · {duration}
        </span>
      </button>
      <div className="divide-y divide-edge/70">
        {fold.items.map((item) => {
          const stepOpen = openSteps[item.id] === true;
          return (
            <div
              key={item.id}
              data-entry-handle={item.handle ?? undefined}
              className={`px-2 py-1.5 font-mono text-xs ${
                item.handle != null && item.handle === highlightedStepHandle ? 'entry-flash bg-accent-hover/10' : ''
              }`}
            >
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
              {stepOpen && (
                <StepDetail
                  item={item}
                  onOpenWork={onOpenWork}
                  onDiscuss={onDiscussStep && item.handle?.startsWith('rec_') ? () => onDiscussStep(item) : undefined}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
