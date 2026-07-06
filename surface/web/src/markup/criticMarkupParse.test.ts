import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as ProseMirrorNode } from 'prosemirror-model';

import { applyComment, applyStrike, createMarkupEditorState } from './MarkupEditorCore';
import { parseCriticMarkupToDoc } from './criticMarkupParse';
import { serializeToCriticMarkup } from './criticMarkup';
import { parseMarkdownToMarkupDoc } from './schema';

describe('parseCriticMarkupToDoc', () => {
  it.each([
    ['insertion', 'Alpha {++beta++} gamma.'],
    ['deletion', 'Alpha {--beta--} gamma.'],
    ['substitution', 'Alpha {~~beta~>delta~~} gamma.'],
    ['comment', 'Alpha {==beta==}{>>Needs source.<<} gamma.'],
    ['standalone comment', 'Alpha {>>Needs source.<<} gamma.'],
    ['standalone authored comment', 'Alpha {>>@gary: Needs source.<<} gamma.'],
    ['multi-line insertion', 'Alpha {++beta\nand delta++} gamma.'],
    [
      'mixed document',
      '# Title\n\nAlpha {--old--} {++new++} and {==note==}{>>Check this.<<} {>>Standalone note.<<}.\n\n- Item {~~one~>two~~}',
    ],
    [
      'mixed document with authored standalone comment',
      'Alpha {++new++} {>>@gary: Pin note.<<} {--old--} and {==span==}{>>Anchored note.<<}.',
    ],
  ])('round-trips %s markup', (_name, source) => {
    expect(serializeToCriticMarkup(parseCriticMarkupToDoc(source))).toBe(source);
  });

  it('parses standalone comments as comment pin nodes', () => {
    const doc = parseCriticMarkupToDoc('Alpha {>>Needs source.<<} gamma.');
    const pins = commentPins(doc);

    expect(pins).toHaveLength(1);
    expect(pins[0]?.node.attrs).toMatchObject({ comment: 'Needs source.', author: null });
    expect(doc.toJSON()).toMatchObject({
      content: [
        {
          content: [
            { type: 'text', text: 'Alpha ' },
            { type: 'comment_pin', attrs: { comment: 'Needs source.', author: null } },
            { type: 'text', text: ' gamma.' },
          ],
        },
      ],
    });
  });

  it('parses standalone comment author stamps into comment pin attrs', () => {
    const doc = parseCriticMarkupToDoc('Alpha {>>@gary: Needs source.<<} gamma.');
    const pins = commentPins(doc);

    expect(pins).toHaveLength(1);
    expect(pins[0]?.node.attrs).toMatchObject({ comment: 'Needs source.', author: 'gary' });
  });

  it.each([
    ['mid-sentence', 'Alpha {>>middle<<} beta.'],
    ['between paragraphs', 'First.\n\n{>>between<<}\n\nSecond.'],
    ['at document start', '{>>start<<} Alpha.'],
    ['at document end', 'Alpha. {>>end<<}'],
  ])('places standalone comment pins %s', (_name, source) => {
    const doc = parseCriticMarkupToDoc(source);

    expect(commentPins(doc)).toHaveLength(1);
    expect(serializeToCriticMarkup(doc)).toBe(source);
  });

  it('keeps parsed author-less standalone comment pins author-less when serializing with a comment author', () => {
    const source = 'Alpha {>>Needs source.<<} gamma.';
    const doc = parseCriticMarkupToDoc(source);

    expect(serializeToCriticMarkup(doc, { commentAuthor: 'agent' })).toBe(source);
  });

  it('preserves foreign comment authors and stamps only author-less comments', () => {
    const doc = parseCriticMarkupToDoc('Alpha {==beta==}{>>@gary: existing note<<} and {==gamma==}{>>new note<<}.');

    expect(serializeToCriticMarkup(doc, { commentAuthor: 'agent' })).toBe(
      'Alpha {==beta==}{>>@gary: existing note<<} and {==gamma==}{>>@agent: new note<<}.',
    );
  });

  it('round-trips whole-code-block comments with author attrs', () => {
    const source = 'Before.\n\n{==```ts\nconst value = 1;\n```==}{>>@gary: Check this code.<<}\n\nAfter.';

    expect(serializeToCriticMarkup(parseCriticMarkupToDoc(source))).toBe(source);
  });

  it('round-trips escaped CriticMarkup-looking literals', () => {
    const source = 'Literal \\{++not a suggestion++\\} text and \\{>>not a comment<<\\}.';

    expect(serializeToCriticMarkup(parseCriticMarkupToDoc(source))).toBe(source);
  });

  it('round-trips escaped standalone-comment-looking literals', () => {
    const source = 'Literal \\{>>x<<\\} text.';

    expect(serializeToCriticMarkup(parseCriticMarkupToDoc(source))).toBe(source);
  });

  it('keeps malformed tokens as literal text', () => {
    const doc = parseCriticMarkupToDoc('Alpha {++unterminated beta.');

    expect(doc.textContent).toBe('Alpha {++unterminated beta.');
    expect(serializeToCriticMarkup(doc)).toBe('Alpha \\{++unterminated beta.');
  });

  it('parses plain markdown identically to the previous markdown parser', () => {
    const source = '# Title\n\nA paragraph with **strong**, *emphasis*, `code`, and [a link](https://example.com).';

    expect(parseCriticMarkupToDoc(source).toJSON()).toEqual(parseMarkdownToMarkupDoc(source).toJSON());
  });

  it('parse(serialize(doc)) preserves editor-built marks', () => {
    let state = createMarkupEditorState('Alpha beta gamma.');
    state = withSelection(state, 'beta');
    state = applyCommand(state, applyStrike);
    state = withSelection(state, 'gamma');
    state = applyCommand(state, applyComment('Needs source.', 'c-test'));

    const serialized = serializeToCriticMarkup(state.doc);
    const reparsed = parseCriticMarkupToDoc(serialized);

    expect(serializeToCriticMarkup(reparsed)).toBe(serialized);
    expect(reparsed.toJSON()).toMatchObject({
      content: [
        {
          content: expect.arrayContaining([
            expect.objectContaining({
              marks: [expect.objectContaining({ type: 'deletion' })],
              text: 'beta',
            }),
            expect.objectContaining({
              marks: [
                expect.objectContaining({
                  type: 'comment',
                  attrs: expect.objectContaining({ text: 'Needs source.', author: null }),
                }),
              ],
              text: 'gamma',
            }),
          ]),
        },
      ],
    });
  });

  it('lets parsed insertions be retracted by striking them', () => {
    let state = EditorState.create({
      schema: parseCriticMarkupToDoc('Alpha {++beta++} gamma.').type.schema,
      doc: parseCriticMarkupToDoc('Alpha {++beta++} gamma.'),
    });
    state = withSelection(state, 'beta');
    state = applyCommand(state, applyStrike);

    expect(serializeToCriticMarkup(state.doc)).toBe('Alpha  gamma.');
  });

  it('stamps only new author-less comments added after parse', () => {
    let state = createMarkupEditorState('Alpha {==beta==}{>>@gary: existing note<<} gamma.');
    state = withSelection(state, 'gamma');
    state = applyCommand(state, applyComment('new note', 'c-new'));

    expect(serializeToCriticMarkup(state.doc, { commentAuthor: 'agent' })).toBe(
      'Alpha {==beta==}{>>@gary: existing note<<} {==gamma==}{>>@agent: new note<<}.',
    );
  });
});

function withSelection(state: EditorState, needle: string): EditorState {
  const text = state.doc.textBetween(0, state.doc.content.size, '\n\n');
  const index = text.indexOf(needle);
  if (index === -1) {
    throw new Error(`Could not find "${needle}"`);
  }
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, index + 1, index + needle.length + 1)));
}

function applyCommand(state: EditorState, command: import('prosemirror-state').Command): EditorState {
  let nextState = state;
  const didApply = command(state, (transaction) => {
    nextState = nextState.apply(transaction);
  });
  if (!didApply) {
    throw new Error('Command did not apply');
  }
  return nextState;
}

function commentPins(doc: ProseMirrorNode): Array<{ node: ProseMirrorNode; pos: number }> {
  const pins: Array<{ node: ProseMirrorNode; pos: number }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'comment_pin') {
      pins.push({ node, pos });
    }
    return true;
  });
  return pins;
}
