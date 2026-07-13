import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { groupedShortcuts } from '../../lib/shortcuts';
import { useDialog } from '../../useDialog';
import { Kbd } from './Kbd';

/**
 * Keyboard-shortcuts cheatsheet, rendered from the central registry. Typically
 * toggled by pressing `?`. A modal dialog: focus-trapped, Escape-to-close, and
 * focus returns to the invoker on close (via `useDialog`).
 */
export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog({ open, containerRef, onClose });

  if (!open) return null;
  const groups = groupedShortcuts();

  return createPortal(
    <div className="fixed inset-0 z-max flex items-center justify-center p-4">
      {/* Backdrop: mouse-dismiss only. Keyboard close is handled by useDialog (Escape) and the Close button. */}
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" onClick={onClose} />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-edge-strong bg-surface-raised shadow-xl"
      >
        <header className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 id={titleId} className="text-sm font-semibold text-fg">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded text-fg-muted hover:bg-surface-overlay hover:text-fg"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        </header>
        <div className="overflow-y-auto px-4 py-3">
          {groups.map((g) => (
            <section key={g.group} className="mb-4 last:mb-0">
              <h3 className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-fg-faint">{g.group}</h3>
              <ul className="flex flex-col gap-1">
                {g.items.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-4 text-sm text-fg-body">
                    <span>{s.label}</span>
                    <Kbd keys={s.keys} decorative />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
