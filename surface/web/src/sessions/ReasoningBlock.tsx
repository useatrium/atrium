import { memo, useState } from 'react';
import type { ReasoningItem } from '@atrium/centaur-client';
import { ChevronDownIcon, ChevronRightIcon } from '../components/icons';

export const ReasoningBlock = memo(
  function ReasoningBlock({ item }: { item: ReasoningItem }) {
    const [open, setOpen] = useState(false);
    const hasSummary = Boolean(item.summary?.trim());

    if (!item.text.trim() && !hasSummary) return null;

    return (
      <section
        data-testid="reasoning-block"
        className="my-1 overflow-hidden rounded-md border border-edge bg-surface-raised/30 text-xs"
      >
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-fg-muted hover:bg-surface-overlay/30"
        >
          <span className="shrink-0 text-fg-muted">
            {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          </span>
          <span className="shrink-0 font-semibold">Thinking</span>
          {!open && hasSummary ? <span className="min-w-0 flex-1 truncate text-fg-muted">{item.summary}</span> : null}
        </button>
        {open ? (
          <div className="space-y-2 border-t border-edge/80 px-2 py-2 text-2xs leading-relaxed text-fg-muted">
            {hasSummary ? <div className="whitespace-pre-wrap">{item.summary}</div> : null}
            <div className="whitespace-pre-wrap">{item.text}</div>
          </div>
        ) : null}
      </section>
    );
  },
  (prev, next) => prev.item.text === next.item.text && prev.item.summary === next.item.summary,
);
