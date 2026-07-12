import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type SelectionPopoverMode = 'closed' | 'menu' | 'suggest' | 'comment';

export interface SelectionPopoverState {
  mode: SelectionPopoverMode;
  top: number;
  left: number;
  codeBlock: boolean;
}

export const closedSelectionPopover: SelectionPopoverState = {
  mode: 'closed',
  top: 0,
  left: 0,
  codeBlock: false,
};

const VIEWPORT_GUTTER = 8;
const MOBILE_POPOVER_QUERY = '(max-width: 767px)';

export interface SelectionPopoverProps {
  state: SelectionPopoverState;
  onModeChange: (mode: SelectionPopoverMode) => void;
  onSuggest: (replacement: string) => void;
  onComment: (comment: string) => void;
  onStrike: () => void;
}

export function SelectionPopover({ state, onModeChange, onSuggest, onComment, onStrike }: SelectionPopoverProps) {
  const [replacement, setReplacement] = useState('');
  const [comment, setComment] = useState('');
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const replacementInputRef = useRef<HTMLInputElement | null>(null);
  const commentTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [clampedLeft, setClampedLeft] = useState(state.left);

  useEffect(() => {
    if (state.mode === 'closed') return;
    const close = () => onModeChange('closed');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onModeChange, state.mode]);

  useEffect(() => {
    if (state.mode === 'suggest') replacementInputRef.current?.focus();
    if (state.mode === 'comment') commentTextareaRef.current?.focus();
  }, [state.mode]);

  const clampPopoverToViewport = useCallback(() => {
    if (state.mode === 'closed') return;
    const popover = popoverRef.current;
    if (!popover) return;

    if (typeof window.matchMedia !== 'function' || !window.matchMedia(MOBILE_POPOVER_QUERY).matches) {
      setClampedLeft(state.left);
      return;
    }

    popover.style.left = `${state.left}px`;
    popover.style.top = `${state.top}px`;

    const rect = popover.getBoundingClientRect();
    const minLeft = VIEWPORT_GUTTER;
    const maxRight = Math.max(minLeft, window.innerWidth - VIEWPORT_GUTTER);
    let nextLeft = state.left;

    if (rect.left < minLeft) {
      nextLeft += minLeft - rect.left;
    }
    if (rect.right > maxRight) {
      nextLeft -= rect.right - maxRight;
    }

    setClampedLeft((current) => (Math.abs(current - nextLeft) > 0.5 ? nextLeft : current));
  }, [state.left, state.mode, state.top]);

  useLayoutEffect(() => {
    if (state.mode === 'closed') {
      setClampedLeft(state.left);
      return undefined;
    }
    clampPopoverToViewport();
    window.addEventListener('resize', clampPopoverToViewport);
    return () => {
      window.removeEventListener('resize', clampPopoverToViewport);
    };
  }, [clampPopoverToViewport, state.left, state.mode]);

  if (state.mode === 'closed') {
    return null;
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: preserves text selection while focusable form controls handle keyboard input.
    <div
      ref={popoverRef}
      className="atrium-markup-popover"
      style={{ top: state.top, left: clampedLeft }}
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest('input, textarea')) {
          return;
        }
        event.preventDefault();
      }}
    >
      {state.mode === 'menu' && (
        <div className="atrium-markup-popover-row">
          <button type="button" disabled={state.codeBlock} onClick={() => onModeChange('suggest')}>
            Suggest edit
          </button>
          <button type="button" onClick={() => onModeChange('comment')}>
            Comment
          </button>
          <button type="button" disabled={state.codeBlock} onClick={onStrike}>
            Strike
          </button>
        </div>
      )}

      {state.mode === 'suggest' && (
        <form
          className="atrium-markup-popover-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSuggest(replacement);
            setReplacement('');
          }}
        >
          <label>
            Replacement
            <input
              ref={replacementInputRef}
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              data-testid="markup-replacement-input"
            />
          </label>
          <button type="submit" disabled={!replacement.trim()}>
            Apply suggestion
          </button>
        </form>
      )}

      {state.mode === 'comment' && (
        <form
          className="atrium-markup-popover-form"
          onSubmit={(event) => {
            event.preventDefault();
            onComment(comment);
            setComment('');
          }}
        >
          <label>
            Comment
            <textarea
              ref={commentTextareaRef}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              data-testid="markup-comment-input"
            />
          </label>
          <button type="submit" disabled={!comment.trim()}>
            Attach comment
          </button>
        </form>
      )}
    </div>
  );
}
