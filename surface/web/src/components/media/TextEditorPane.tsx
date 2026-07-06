import { useEffect, useState } from 'react';
import type { PreviewFile } from './types';

export function TextEditorPane({
  file,
  baseSeq,
  initialText,
  onSave,
  onCancel,
  saving,
  error,
}: {
  file: PreviewFile;
  baseSeq: number;
  initialText: string;
  onSave: (text: string) => void | Promise<void>;
  onCancel: () => void;
  saving: boolean;
  error?: string | null;
}) {
  const [draft, setDraft] = useState(initialText);

  useEffect(() => {
    setDraft(initialText);
  }, [initialText]);

  const errorId = 'text-editor-pane-error';

  return (
    <div
      aria-busy={saving ? 'true' : undefined}
      className="flex min-h-0 flex-1 flex-col gap-2 p-3"
    >
      <div className="flex shrink-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-2xs font-semibold text-fg-body" title={file.name}>
            {file.name}
          </div>
          <div className="mt-0.5 font-mono text-3xs text-fg-muted">Editing from v{baseSeq}</div>
        </div>
        <button
          type="button"
          onClick={() => void onSave(draft)}
          disabled={saving}
          className="rounded-md bg-accent px-2 py-1 text-2xs font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-surface-overlay disabled:text-fg-muted"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-edge-strong px-2 py-1 text-2xs font-semibold text-fg-secondary hover:bg-surface-overlay hover:text-fg disabled:cursor-not-allowed disabled:text-fg-faint"
        >
          Cancel
        </button>
      </div>
      {error && (
        <div id={errorId} role="alert" className="shrink-0 rounded-md border border-danger-border bg-danger-tint px-2 py-1.5 text-2xs text-danger-text">
          {error}
        </div>
      )}
      <textarea
        aria-label="File contents"
        aria-describedby={error ? errorId : undefined}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="min-h-0 flex-1 resize-none rounded-md border border-edge bg-surface p-2 font-mono text-2xs leading-relaxed text-fg-body outline-none focus:border-edge-focus"
      />
    </div>
  );
}
