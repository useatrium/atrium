import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { EditorView } from 'prosemirror-view';
import type { Command } from 'prosemirror-state';

import { applyComment, applyStrike, applySuggestEdit, createMarkupEditorState, documentHasMarkup, isInCodeBlock } from './MarkupEditorCore';
import { serializeToCriticMarkup } from './criticMarkup';
import { closedSelectionPopover, SelectionPopover, type SelectionPopoverMode, type SelectionPopoverState } from './SelectionPopover';
import './MarkupEditor.css';

export interface MarkupEditorProps {
  /** Document body to edit — markdown WITHOUT YAML frontmatter. */
  initialMarkdown: string;
  /** Current author's handle for newly-created comment stamps during serialization. */
  commentAuthor?: string | null;
  /** Fires whenever dirty state (any suggestion/comment/edit present) changes. */
  onDirtyChange?: (dirty: boolean) => void;
  className?: string;
}

export interface MarkupEditorHandle {
  /** Current document serialized to CriticMarkup markdown. */
  serialize(): string;
  /** True if the doc contains any tracked change or comment. */
  hasMarkup(): boolean;
}

type MarkupEditorDom = HTMLElement & { __atriumMarkupEditorView?: EditorView };

export const MarkupEditor = forwardRef<MarkupEditorHandle, MarkupEditorProps>(function MarkupEditor(
  { initialMarkdown, commentAuthor = null, onDirtyChange, className },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const dirtyRef = useRef(false);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const [popover, setPopover] = useState<SelectionPopoverState>(closedSelectionPopover);

  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);

  useImperativeHandle(
    ref,
    () => ({
      serialize() {
        const view = viewRef.current;
        return view ? serializeToCriticMarkup(view.state.doc, { commentAuthor }) : initialMarkdown;
      },
      hasMarkup() {
        const view = viewRef.current;
        return view ? documentHasMarkup(view.state.doc) : false;
      },
    }),
    [commentAuthor, initialMarkdown],
  );

  useEffect(() => {
    if (!hostRef.current || viewRef.current) {
      return;
    }

    const updateDirty = (view: EditorView) => {
      const dirty = documentHasMarkup(view.state.doc);
      if (dirtyRef.current !== dirty) {
        dirtyRef.current = dirty;
        onDirtyChangeRef.current?.(dirty);
      }
    };

    const state = createMarkupEditorState(initialMarkdown, {
      onSelectionChange: () => {
        const view = viewRef.current;
        if (view) {
          updatePopoverFromSelection(view, setPopover);
        }
      },
    });

    const view = new EditorView(hostRef.current, {
      state,
      dispatchTransaction(transaction) {
        const nextState = view.state.apply(transaction);
        view.updateState(nextState);
        updateDirty(view);
        window.setTimeout(() => updatePopoverFromSelection(view, setPopover), 0);
      },
      attributes: {
        'aria-label': 'Rendered markdown editor with suggesting mode',
        'data-testid': 'markup-editor',
        class: 'atrium-markup-prosemirror',
      },
    });

    viewRef.current = view;
    if (import.meta.env.DEV) {
      (view.dom as MarkupEditorDom).__atriumMarkupEditorView = view;
    }
    updateDirty(view);

    return () => {
      if (import.meta.env.DEV) {
        delete (view.dom as MarkupEditorDom).__atriumMarkupEditorView;
      }
      view.destroy();
      viewRef.current = null;
    };
  }, [initialMarkdown]);

  const runCommand = (command: Command) => {
    const view = viewRef.current;
    if (!view || !executeCommand(view, command)) {
      return;
    }
    setPopover(closedSelectionPopover);
    view.focus();
  };

  const rootClassName = className ? `atrium-markup-editor ${className}` : 'atrium-markup-editor';

  return (
    <>
      <div className={rootClassName}>
        <div ref={hostRef} className="atrium-markup-editor-host" />
      </div>
      <SelectionPopover
        state={popover}
        onModeChange={(mode: SelectionPopoverMode) => setPopover((current) => ({ ...current, mode }))}
        onSuggest={(replacement) => runCommand(applySuggestEdit(replacement))}
        onComment={(comment) => runCommand(applyComment(comment))}
        onStrike={() => runCommand(applyStrike)}
      />
    </>
  );
});

function executeCommand(view: EditorView, command: Command): boolean {
  return command(view.state, view.dispatch, view);
}

function updatePopoverFromSelection(
  view: EditorView,
  setPopover: Dispatch<SetStateAction<SelectionPopoverState>>,
): void {
  const { selection } = view.state;
  if (selection.empty || !view.hasFocus()) {
    setPopover((current) => (current.mode === 'closed' ? current : closedSelectionPopover));
    return;
  }

  try {
    const start = view.coordsAtPos(selection.from);
    const end = view.coordsAtPos(selection.to);
    setPopover({
      mode: 'menu',
      top: Math.min(start.top, end.top) - 56 + window.scrollY,
      left: (start.left + end.right) / 2 + window.scrollX,
      codeBlock: isInCodeBlock(view.state),
    });
  } catch {
    setPopover(closedSelectionPopover);
  }
}
