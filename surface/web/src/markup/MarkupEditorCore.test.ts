// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { redo, undo } from 'prosemirror-history';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as ProseMirrorNode } from 'prosemirror-model';

import {
  createDeletionTransaction,
  createMarkupEditorState,
  createSuggestionTextTransaction,
  documentHasMarkup,
  isInCodeBlock,
} from './MarkupEditorCore';
import { serializeToCriticMarkup } from './criticMarkup';

describe('MarkupEditorCore suggesting transactions', () => {
  it('turns typed text into insertion marks', () => {
    let state = createMarkupEditorState('Hello world.');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 7)));
    const transaction = createSuggestionTextTransaction(state, state.selection.from, state.selection.to, 'new ');
    expect(transaction).not.toBeNull();
    state = state.apply(transaction!);

    expect(documentHasMarkup(state.doc)).toBe(true);
    expect(serializeToCriticMarkup(state.doc)).toBe('Hello {++new ++}world.');
  });

  it('turns backspace into a deletion mark without removing text', () => {
    let state = createMarkupEditorState('Hello.');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 6)));
    const transaction = createDeletionTransaction(state, 'backward');
    expect(transaction).not.toBeNull();
    state = state.apply(transaction!);

    expect(serializeToCriticMarkup(state.doc)).toBe('Hell{--o--}.');
  });

  it('deletes a comment pin with backspace instead of creating a tracked deletion', () => {
    let state = createMarkupEditorState('Hello {>>note<<}world.');
    const pinPos = findCommentPinPos(state.doc);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pinPos + 1)));
    const transaction = createDeletionTransaction(state, 'backward');
    expect(transaction).not.toBeNull();
    state = state.apply(transaction!);
    const serialized = serializeToCriticMarkup(state.doc);

    expect(serialized).toBe('Hello world.');
    expect(serialized).not.toContain('{--');
    expect(serialized).not.toContain('{>>note<<}');
  });

  it('deletes a selected comment pin instead of creating a tracked deletion', () => {
    let state = createMarkupEditorState('Hello {>>note<<}world.');
    const pinPos = findCommentPinPos(state.doc);
    state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, pinPos)));
    const transaction = createDeletionTransaction(state, 'forward');
    expect(transaction).not.toBeNull();
    state = state.apply(transaction!);
    const serialized = serializeToCriticMarkup(state.doc);

    expect(serialized).toBe('Hello world.');
    expect(serialized).not.toContain('{--');
    expect(serialized).not.toContain('{>>note<<}');
  });

  it('types next to a comment pin without disturbing the pin', () => {
    let state = createMarkupEditorState('Hello {>>note<<}world.');
    const pinPos = findCommentPinPos(state.doc);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pinPos + 1)));
    const transaction = createSuggestionTextTransaction(state, state.selection.from, state.selection.to, 'new ');
    expect(transaction).not.toBeNull();
    state = state.apply(transaction!);

    expect(serializeToCriticMarkup(state.doc)).toBe('Hello {>>note<<}{++new ++}world.');
  });

  it('treats backspace at the start of a paragraph as a no-op', () => {
    let state = createMarkupEditorState('First.\n\nSecond.');
    const original = state.doc.toJSON();
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 9)));
    const host = document.createElement('div');
    document.body.append(host);
    const view = new EditorView(host, { state });

    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));

    expect(view.state.doc.toJSON()).toEqual(original);
    view.destroy();
    host.remove();
  });

  it('blocks direct text suggestions inside code blocks', () => {
    let state = createMarkupEditorState('```ts\nconst value = 1;\n```');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 5)));

    expect(isInCodeBlock(state)).toBe(true);
    expect(createSuggestionTextTransaction(state, state.selection.from, state.selection.to, 'x')).toBeNull();
  });

  it('keeps suggested edits in the history stack for undo and redo', () => {
    let state = createMarkupEditorState('Hello world.');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 7, 12)));
    const transaction = createSuggestionTextTransaction(state, state.selection.from, state.selection.to, 'there');
    expect(transaction).not.toBeNull();
    state = state.apply(transaction!);
    expect(serializeToCriticMarkup(state.doc)).toBe('Hello {~~world~>there~~}.');

    let nextState = state;
    expect(
      undo(state, (undoTransaction) => {
        nextState = nextState.apply(undoTransaction);
      }),
    ).toBe(true);
    state = nextState;
    expect(serializeToCriticMarkup(state.doc)).toBe('Hello world.');

    expect(
      redo(state, (redoTransaction) => {
        nextState = nextState.apply(redoTransaction);
      }),
    ).toBe(true);
    state = nextState;
    expect(serializeToCriticMarkup(state.doc)).toBe('Hello {~~world~>there~~}.');
  });
});

function findCommentPinPos(doc: ProseMirrorNode): number {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (node.type.name === 'comment_pin') {
      found = pos;
      return false;
    }
    return true;
  });
  if (found === null) {
    throw new Error('Could not find comment pin');
  }
  return found;
}
