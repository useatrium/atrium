// Shared "this markup diverged from the source message" banner, used by both the web
// MarkupPane and the mobile webview MarkupShellPage so the affordance stays identical.
// Renders nothing unless the doc has diverged or we're currently showing the source.

export function MarkupDivergenceBanner({
  diverged,
  showingSource,
  onReset,
  onBackToLatest,
}: {
  /** True when the loaded body differs from the source message. */
  diverged: boolean;
  /** True when the editor is currently showing the original message instead of the latest body. */
  showingSource: boolean;
  /** Reset the editor to the original message text. */
  onReset: () => void;
  /** Return to the latest (evolved) markup body. */
  onBackToLatest: () => void;
}) {
  if (showingSource) {
    return (
      <div className="flex shrink-0 items-center justify-between gap-3 rounded-md border border-edge bg-surface-raised/70 px-3 py-2 text-xs text-fg-muted">
        <span className="font-medium text-fg-secondary">Showing the original message</span>
        <button
          type="button"
          onClick={onBackToLatest}
          className="shrink-0 rounded-md border border-edge px-2.5 py-1 text-xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg"
        >
          Back to latest
        </button>
      </div>
    );
  }
  if (!diverged) return null;
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 rounded-md border border-edge bg-surface-raised px-3 py-2 text-xs text-fg-secondary">
      <span className="font-medium text-fg">This markup has changed since the original message.</span>
      <button
        type="button"
        onClick={onReset}
        className="shrink-0 rounded-md border border-edge-strong px-2.5 py-1 text-xs font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg"
      >
        Reset to message
      </button>
    </div>
  );
}
