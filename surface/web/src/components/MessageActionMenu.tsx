import { QUICK_REACTIONS } from '@atrium/surface-client/reactions';
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { useDialog } from '../useDialog';
import { ReactionPicker } from './ReactionPicker';

export type MessageActionMenuState =
  | { mode: 'sheet' }
  | { mode: 'popover'; anchor: { x: number; y: number } };

export type MessageActionMenuAction = {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  variant?: 'default' | 'danger';
  closeOnSelect?: boolean;
  /** Only rendered in the touch bottom sheet — for affordances that are redundant with a mouse (e.g. Select text). */
  sheetOnly?: boolean;
};

export type MessageActionMenuReactions = {
  onSelect: (emoji: string) => void;
};

const POPOVER_WIDTH = 240;
const POPOVER_MAX_HEIGHT = 360;
const VIEWPORT_MARGIN = 8;

export function MessageActionMenu({
  state,
  onClose,
  restoreFocusRef,
  actions,
  reactions,
  label = 'Message actions',
}: {
  state: MessageActionMenuState | null;
  onClose: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  actions: MessageActionMenuAction[];
  reactions?: MessageActionMenuReactions;
  label?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const addReactionButtonRef = useRef<HTMLButtonElement | null>(null);
  const sheetHasFreshPointerDownRef = useRef(false);
  const mode = state?.mode;
  const open = state != null;

  const closeMenu = useCallback(() => {
    setPickerOpen(false);
    onClose();
  }, [onClose]);

  useDialog({
    open,
    containerRef: menuRef,
    invokerRef: restoreFocusRef,
    closeOnOutsidePointer: true,
    onClose: closeMenu,
  });

  useEffect(() => {
    if (open && reactions) return;
    setPickerOpen(false);
  }, [open, reactions]);

  useEffect(() => {
    if (!open) {
      sheetHasFreshPointerDownRef.current = false;
      return;
    }
    sheetHasFreshPointerDownRef.current = mode !== 'sheet';
    if (typeof window !== 'undefined') window.getSelection()?.removeAllRanges();
  }, [mode, open]);

  if (!state) return null;

  const compact = mode === 'popover';
  const actionRowClass = compact
    ? 'flex min-h-9 w-full items-center rounded px-2.5 py-1.5 text-left text-sm text-fg-secondary hover:bg-edge-strong hover:text-fg focus:bg-edge-strong focus:text-fg focus:outline-none'
    : 'flex min-h-11 w-full items-center rounded-md px-3 py-2 text-left text-sm text-fg-secondary hover:bg-edge-strong hover:text-fg focus:bg-edge-strong focus:text-fg focus:outline-none';
  const destructiveRowClass = compact
    ? 'flex min-h-9 w-full items-center rounded px-2.5 py-1.5 text-left text-sm text-danger-text hover:bg-danger-tint/70 focus:bg-danger-tint/70 focus:outline-none'
    : 'flex min-h-11 w-full items-center rounded-md px-3 py-2 text-left text-sm text-danger-text hover:bg-danger-tint/70 focus:bg-danger-tint/70 focus:outline-none';

  const markFreshSheetPointerDown = () => {
    if (mode !== 'sheet') return;
    sheetHasFreshPointerDownRef.current = true;
  };

  const canActivateFromClick = (event: MouseEvent<HTMLElement>) => {
    if (mode !== 'sheet' || sheetHasFreshPointerDownRef.current || event.detail === 0) return true;
    event.preventDefault();
    event.stopPropagation();
    return false;
  };

  const chooseReaction = (emoji: string) => {
    reactions?.onSelect(emoji);
    closeMenu();
  };

  const runAction = (action: MessageActionMenuAction) => {
    action.onSelect();
    if (action.closeOnSelect !== false) closeMenu();
  };

  const menu = (
    <div
      ref={menuRef}
      role="dialog"
      aria-label={label}
      style={mode === 'popover' ? popoverStyle(state.anchor) : undefined}
      className={
        mode === 'sheet'
          ? 'fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[85dvh] max-w-xl overflow-y-auto rounded-t-xl border border-edge-strong bg-surface-overlay p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] shadow-2xl'
          : 'fixed z-50 w-60 overflow-y-auto rounded-md border border-edge-strong bg-surface-overlay p-1.5 shadow-lg'
      }
    >
      {reactions && (
        <div className={compact ? 'mb-1 flex items-center gap-1 border-b border-edge pb-1' : 'mb-2 flex items-center gap-1 border-b border-edge pb-2'}>
          {QUICK_REACTIONS.map((emoji) => (
            <button
              type="button"
              key={emoji}
              onClick={(event) => {
                if (canActivateFromClick(event)) chooseReaction(emoji);
              }}
              aria-label={`React with ${emoji}`}
              className={
                compact
                  ? 'flex h-8 w-8 items-center justify-center rounded-md text-lg hover:bg-edge-strong focus:bg-edge-strong focus:outline-none'
                  : 'flex h-11 flex-1 items-center justify-center rounded-md text-2xl hover:bg-edge-strong focus:bg-edge-strong focus:outline-none'
              }
            >
              {emoji}
            </button>
          ))}
          <button
            type="button"
            ref={addReactionButtonRef}
            onClick={(event) => {
              if (canActivateFromClick(event)) setPickerOpen((value) => !value);
            }}
            aria-label="Add reaction"
            aria-expanded={pickerOpen}
            aria-haspopup="dialog"
            className={
              compact
                ? 'flex h-8 w-8 items-center justify-center rounded-md text-lg text-fg-secondary hover:bg-edge-strong hover:text-fg focus:bg-edge-strong focus:text-fg focus:outline-none'
                : 'flex h-11 flex-1 items-center justify-center rounded-md text-2xl text-fg-secondary hover:bg-edge-strong hover:text-fg focus:bg-edge-strong focus:text-fg focus:outline-none'
            }
          >
            ＋
          </button>
        </div>
      )}
      {reactions && (
        <ReactionPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={chooseReaction}
          invokerRef={addReactionButtonRef}
          restoreFocus={false}
          closeOnOutsidePointer={false}
          className={compact ? 'mb-1 max-h-72 w-full shadow-none' : 'mb-2 w-full shadow-none'}
        />
      )}
      <div className={compact ? 'space-y-0.5' : 'space-y-1'}>
        {actions.filter((action) => mode === 'sheet' || !action.sheetOnly).map((action) => (
          <button
            key={action.key}
            type="button"
            onClick={(event) => {
              if (canActivateFromClick(event)) runAction(action);
            }}
            className={action.variant === 'danger' ? destructiveRowClass : actionRowClass}
          >
            {action.icon && <span className="mr-2 inline-flex shrink-0 items-center">{action.icon}</span>}
            {action.label}
          </button>
        ))}
        {mode === 'sheet' && (
          <button
            type="button"
            onClick={(event) => {
              if (canActivateFromClick(event)) closeMenu();
            }}
            className={actionRowClass}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );

  if (mode === 'popover') return menu;

  return (
    <div className="fixed inset-0 z-40" onPointerDownCapture={markFreshSheetPointerDown}>
      <button
        type="button"
        aria-label={`Close ${label.toLowerCase()}`}
        onClick={(event) => {
          if (canActivateFromClick(event)) closeMenu();
        }}
        className="absolute inset-0 h-full w-full cursor-default bg-black/35"
      />
      {menu}
    </div>
  );
}

function popoverStyle(anchor: { x: number; y: number }) {
  if (typeof window === 'undefined') {
    return { left: anchor.x, top: anchor.y };
  }
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - POPOVER_MAX_HEIGHT - VIEWPORT_MARGIN);
  return {
    left: Math.max(VIEWPORT_MARGIN, Math.min(anchor.x, maxLeft)),
    top: Math.max(VIEWPORT_MARGIN, Math.min(anchor.y, maxTop)),
    maxHeight: `calc(100dvh - ${VIEWPORT_MARGIN * 2}px)`,
  };
}
