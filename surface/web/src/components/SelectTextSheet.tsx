import { useRef, type ReactNode, type RefObject } from 'react';
import { useDialog } from '../useDialog';

/**
 * Bottom sheet that presents message/transcript content as natively-selectable
 * text. On touch devices long-press is claimed by the action menu, so partial
 * text selection is impossible in place — this sheet is the escape hatch: no
 * gesture handlers, no selection suppression, so the OS loupe/callout work.
 */
export function SelectTextSheet({
  open,
  onClose,
  restoreFocusRef,
  children,
}: {
  open: boolean;
  onClose: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const doneRef = useRef<HTMLButtonElement | null>(null);

  useDialog({
    open,
    containerRef,
    invokerRef: restoreFocusRef,
    // The Done button is the only tabbable, so useDialog's focus-first-in
    // lands there instead of stealing focus from the selectable text.
    initialFocusRef: doneRef,
    closeOnOutsidePointer: true,
    onClose,
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-overlay">
      <button
        type="button"
        aria-label="Close select text"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/35"
      />
      <div
        ref={containerRef}
        role="dialog"
        aria-label="Select text"
        className="fixed inset-x-0 bottom-0 z-overlay mx-auto flex max-h-[85dvh] max-w-xl flex-col rounded-t-xl border border-edge-strong bg-surface-overlay shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-2">
          <span className="text-sm font-semibold text-fg">Select text</span>
          <button
            ref={doneRef}
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-fg-secondary hover:bg-edge-strong hover:text-fg focus:bg-edge-strong focus:text-fg focus:outline-none"
          >
            Done
          </button>
        </div>
        {/* Plain div, not a button: buttons carry implicit user-select:none. */}
        <div
          data-testid="select-text-content"
          className="select-text overflow-y-auto px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
        >
          {children}
        </div>
      </div>
    </div>
  );
}
