import { useState } from 'react';

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

export interface SelectionPopoverProps {
  state: SelectionPopoverState;
  onModeChange: (mode: SelectionPopoverMode) => void;
  onSuggest: (replacement: string) => void;
  onComment: (comment: string) => void;
  onStrike: () => void;
}

export function SelectionPopover({
  state,
  onModeChange,
  onSuggest,
  onComment,
  onStrike,
}: SelectionPopoverProps) {
  const [replacement, setReplacement] = useState('');
  const [comment, setComment] = useState('');

  if (state.mode === 'closed') {
    return null;
  }

  return (
    <div
      className="atrium-markup-popover"
      style={{ top: state.top, left: state.left }}
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
              autoFocus
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
              autoFocus
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

