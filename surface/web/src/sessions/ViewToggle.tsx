// Channel / Split / Focus — the layout grammar segmented control. Lives in the
// channel header (and is mirrored on the focused pane). "Split" and "Focus" need
// a session to point at, so they disable when no pane has been opened.

export type SessionView = 'channel' | 'split' | 'focus';

const SEGMENTS: { value: SessionView; label: string; title: string }[] = [
  { value: 'channel', label: 'Channel', title: 'Channel + sessions rail' },
  { value: 'split', label: 'Split', title: 'Channel beside the session' },
  { value: 'focus', label: 'Focus', title: 'Session only, full width' },
];

export function ViewToggle({
  view,
  hasSession,
  onSetView,
}: {
  view: SessionView;
  /** A session is open (or was) — enables Split/Focus. */
  hasSession: boolean;
  onSetView: (view: SessionView) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Layout"
      className="flex shrink-0 rounded-md border border-edge bg-surface p-0.5"
    >
      {SEGMENTS.map((seg) => {
        const active = view === seg.value;
        const disabled = seg.value !== 'channel' && !hasSession;
        return (
          <button
            key={seg.value}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            title={seg.title}
            onClick={() => onSetView(seg.value)}
            className={`h-7 rounded px-2.5 text-2xs font-medium transition-colors ${
              active
                ? 'bg-surface-overlay text-fg shadow-sm'
                : disabled
                  ? 'cursor-not-allowed text-fg-faint'
                  : 'text-fg-tertiary hover:bg-surface-overlay/60 hover:text-fg-body'
            }`}
          >
            {seg.label}
          </button>
        );
      })}
    </div>
  );
}
