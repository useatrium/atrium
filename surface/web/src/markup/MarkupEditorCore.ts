import { baseKeymap } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { Command, Plugin as ProseMirrorPlugin, Transaction } from 'prosemirror-state';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';

import { parseCriticMarkupToDoc } from './criticMarkupParse';
import { markupSchema } from './schema';

export interface MarkupEditorPluginOptions {
  onSelectionChange?: (state: EditorState) => void;
}

export function createMarkupEditorState(initialMarkdown: string, options: MarkupEditorPluginOptions = {}): EditorState {
  return EditorState.create({
    schema: markupSchema,
    doc: parseCriticMarkupToDoc(initialMarkdown),
    plugins: createMarkupPlugins(options),
  });
}

export function createMarkupPlugins(options: MarkupEditorPluginOptions = {}): ProseMirrorPlugin[] {
  return [
    history(),
    keymap({
      'Mod-z': undo,
      'Shift-Mod-z': redo,
      'Mod-y': redo,
    }),
    createSuggestingModePlugin(options),
    keymap(baseKeymap),
  ];
}

export function createSuggestingModePlugin(options: MarkupEditorPluginOptions = {}): ProseMirrorPlugin {
  return new Plugin({
    view() {
      return {
        update(view, previousState) {
          if (previousState.selection !== view.state.selection) {
            options.onSelectionChange?.(view.state);
          }
        },
      };
    },
    props: {
      handleTextInput(view, from, to, text) {
        const transaction = createSuggestionTextTransaction(view.state, from, to, text);
        if (!transaction) {
          return isInCodeBlock(view.state);
        }
        view.dispatch(transaction.scrollIntoView());
        return true;
      },
      handleKeyDown(view, event) {
        if (event.key !== 'Backspace' && event.key !== 'Delete') {
          return false;
        }

        if (isInCodeBlock(view.state)) {
          event.preventDefault();
          return true;
        }

        const transaction = createDeletionTransaction(view.state, event.key === 'Backspace' ? 'backward' : 'forward');
        if (!transaction) {
          event.preventDefault();
          return true;
        }

        event.preventDefault();
        view.dispatch(transaction.scrollIntoView());
        return true;
      },
    },
  });
}

export function isInCodeBlock(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    if ($from.node(depth).type.name === 'code_block') {
      return true;
    }
  }
  return false;
}

export function findCodeBlockAtSelection(state: EditorState): { node: ProseMirrorNode; pos: number } | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === 'code_block') {
      return { node, pos: $from.before(depth) };
    }
  }
  return null;
}

export function documentHasMarkup(doc: ProseMirrorNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (node.type.name === 'comment_pin') {
      found = true;
      return false;
    }
    if (node.type.name === 'code_block' && typeof node.attrs.comment === 'string' && node.attrs.comment.length > 0) {
      found = true;
      return false;
    }
    if (
      node.marks.some(
        (mark) => mark.type.name === 'insertion' || mark.type.name === 'deletion' || mark.type.name === 'comment',
      )
    ) {
      found = true;
      return false;
    }
    return !found;
  });
  return found;
}

export function createSuggestionTextTransaction(
  state: EditorState,
  from: number,
  to: number,
  text: string,
): Transaction | null {
  if (!text || isInCodeBlock(state)) {
    return null;
  }

  const insertion = state.schema.marks.insertion;
  const deletion = state.schema.marks.deletion;
  if (!insertion || !deletion) {
    return null;
  }

  let transaction = state.tr;
  if (from !== to) {
    transaction = transaction.addMark(from, to, deletion.create());
  }
  transaction = transaction.insertText(text, to);
  transaction = transaction.addMark(to, to + text.length, insertion.create());
  transaction = transaction.setSelection(TextSelection.create(transaction.doc, to + text.length));
  return transaction;
}

export function createDeletionTransaction(state: EditorState, direction: 'backward' | 'forward'): Transaction | null {
  if (isInCodeBlock(state)) {
    return null;
  }

  const deletion = state.schema.marks.deletion;
  if (!deletion) {
    return null;
  }

  const { selection } = state;
  let from = selection.from;
  let to = selection.to;

  if (selection.empty) {
    const pinRange = commentPinRangeAdjacentToSelection(state, direction);
    if (pinRange) {
      const transaction = state.tr.delete(pinRange.from, pinRange.to);
      return transaction.setSelection(TextSelection.create(transaction.doc, pinRange.from));
    }

    const parentOffset = selection.$from.parentOffset;
    if (direction === 'backward') {
      if (parentOffset === 0) {
        return null;
      }
      from = selection.from - 1;
      to = selection.from;
    } else {
      if (parentOffset >= selection.$from.parent.content.size) {
        return null;
      }
      from = selection.from;
      to = selection.from + 1;
    }
  }

  if (from === to) {
    return null;
  }

  const pinRanges = commentPinRangesBetween(state.doc, from, to);
  let transaction = state.tr.addMark(from, to, deletion.create());
  for (const range of pinRanges.sort((left, right) => right.from - left.from)) {
    transaction = transaction.delete(range.from, range.to);
  }

  const selectionPos = transaction.mapping.map(direction === 'backward' ? from : to, direction === 'backward' ? -1 : 1);
  return transaction.setSelection(TextSelection.create(transaction.doc, selectionPos));
}

function commentPinRangeAdjacentToSelection(
  state: EditorState,
  direction: 'backward' | 'forward',
): { from: number; to: number } | null {
  const { selection } = state;
  const node = direction === 'backward' ? selection.$from.nodeBefore : selection.$from.nodeAfter;
  if (node?.type.name !== 'comment_pin') {
    return null;
  }

  if (direction === 'backward') {
    return { from: selection.from - node.nodeSize, to: selection.from };
  }
  return { from: selection.from, to: selection.from + node.nodeSize };
}

function commentPinRangesBetween(doc: ProseMirrorNode, from: number, to: number): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'comment_pin') {
      ranges.push({ from: pos, to: pos + node.nodeSize });
      return false;
    }
    return true;
  });
  return ranges;
}

export const applySuggestEdit: (replacement: string) => Command = (replacement) => (state, dispatch) => {
  if (state.selection.empty || !replacement.trim()) {
    return false;
  }
  const transaction = createSuggestionTextTransaction(state, state.selection.from, state.selection.to, replacement);
  if (!transaction) {
    return false;
  }
  dispatch?.(transaction.scrollIntoView());
  return true;
};

export const applyStrike: Command = (state, dispatch) => {
  if (state.selection.empty || isInCodeBlock(state)) {
    return false;
  }
  const deletion = state.schema.marks.deletion;
  if (!deletion) {
    return false;
  }
  dispatch?.(state.tr.addMark(state.selection.from, state.selection.to, deletion.create()).scrollIntoView());
  return true;
};

export const applyComment: (text: string, id?: string) => Command = (text, id) => (state, dispatch) => {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const codeBlock = findCodeBlockAtSelection(state);
  if (codeBlock) {
    dispatch?.(
      state.tr
        .setNodeMarkup(codeBlock.pos, undefined, {
          ...codeBlock.node.attrs,
          comment: trimmed,
          commentAuthor: null,
        })
        .scrollIntoView(),
    );
    return true;
  }

  if (state.selection.empty) {
    return false;
  }

  const comment = state.schema.marks.comment;
  if (!comment) {
    return false;
  }

  dispatch?.(
    state.tr
      .addMark(
        state.selection.from,
        state.selection.to,
        comment.create({
          id: id || `c-${Date.now()}`,
          text: trimmed,
          author: null,
        }),
      )
      .scrollIntoView(),
  );
  return true;
};
