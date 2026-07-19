import type { NoticeItem } from '@atrium/centaur-client';

/**
 * A quiet, non-work transcript marker: review-mode enter/exit, context
 * compaction, and agent thread renames. These are trust/status signals, so they
 * stay legible in both the full and focus views rather than folding into a work
 * step — but stay deliberately understated so they never compete with the
 * conversation.
 */
export function TranscriptNotice({ item }: { item: NoticeItem }) {
  if (item.notice === 'context_compacted') {
    return (
      <div data-testid={`notice-${item.id}`} className="flex items-center gap-2 py-1.5 text-2xs text-fg-muted">
        <span className="h-px flex-1 bg-edge" />
        <span className="shrink-0 uppercase tracking-wide">Context compacted</span>
        <span className="h-px flex-1 bg-edge" />
      </div>
    );
  }

  if (item.notice === 'thread_named') {
    return (
      <div data-testid={`notice-${item.id}`} className="py-1 text-xs text-fg-muted">
        Agent named this thread <span className="font-medium text-fg-secondary">{item.text}</span>
      </div>
    );
  }

  const label = item.notice === 'review_started' ? 'Review started' : 'Review ended';
  return (
    <div data-testid={`notice-${item.id}`} className="flex items-center gap-2 py-1 text-xs text-fg-muted">
      <span className="inline-flex items-center rounded-full border border-edge bg-surface-raised/60 px-2 py-0.5 font-medium">
        {label}
      </span>
      {item.text ? <span className="min-w-0 flex-1 truncate">{item.text}</span> : null}
    </div>
  );
}
