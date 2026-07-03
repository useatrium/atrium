import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';

import { applyComment, applyStrike, applySuggestEdit, createMarkupEditorState } from './MarkupEditorCore';
import { serializeToCriticMarkup } from './criticMarkup';
import { parseMarkdownToMarkupDoc } from './schema';

const pocSample = `# Release Review Memo

The agent-produced draft has a clear structure, but priority sections still need tracked editorial changes before it is sent to the team.

## Open Questions

- Should the launch checklist include the data export review?
- Does the migration note need a stronger warning?
- Are the support owners named clearly enough?

The second paragraph is intentionally worded in a way that invites a comment. It should remain readable while annotations sit beside it.

\`\`\`ts
export function summarize(items: string[]) {
  return items.map((item) => item.trim()).filter(Boolean).join(", ");
}
\`\`\`

Final paragraph with plain markdown text so serialization can prove that untouched prose survives next to CriticMarkup suggestions.`;

describe('serializeToCriticMarkup', () => {
  it('round-trips the POC sample markdown structures byte-identically without markup', () => {
    const state = createMarkupEditorState(pocSample);

    expect(serializeToCriticMarkup(state.doc)).toBe(pocSample);
  });

  it('preserves common inline markdown marks', () => {
    const markdown = 'A paragraph with **strong**, *emphasis*, `code`, and [a link](https://example.com).';
    const state = createMarkupEditorState(markdown);

    expect(serializeToCriticMarkup(state.doc)).toBe(markdown);
  });

  it('serializes insertion, deletion, substitution, and comments', () => {
    let state = createMarkupEditorState('Alpha beta gamma.');
    state = withSelection(state, 'beta');
    state = applyCommand(state, applySuggestEdit('delta'));
    state = withSelection(state, 'Alpha');
    state = applyCommand(state, applyStrike);
    state = withSelection(state, 'gamma');
    state = applyCommand(state, applyComment('Needs source.', 'c-test'));

    expect(serializeToCriticMarkup(state.doc)).toBe('{--Alpha--} {~~beta~>delta~~} {==gamma==}{>>Needs source.<<}.');
  });

  it('stamps author-less comments with the current comment author', () => {
    let state = createMarkupEditorState('Alpha beta.');
    state = withSelection(state, 'beta');
    state = applyCommand(state, applyComment('Needs source.', 'c-test'));

    expect(serializeToCriticMarkup(state.doc, { commentAuthor: 'agent' })).toBe('Alpha {==beta==}{>>@agent: Needs source.<<}.');
  });

  it('serializes multi-paragraph suggestions without dropping structure', () => {
    let state = createMarkupEditorState('First paragraph here.\n\nSecond paragraph here.');
    state = withRange(state, 7, 45);
    state = applyCommand(state, applySuggestEdit('combined replacement'));

    expect(serializeToCriticMarkup(state.doc)).toBe('First {--paragraph here.--}\n\n{~~Second paragraph here~>combined replacement~~}.');
  });

  it('serializes a whole code-fence comment as a block comment', () => {
    let state = createMarkupEditorState('Before.\n\n```ts\nconst value = 1;\n```\n\nAfter.');
    state = withSelection(state, 'value');
    state = applyCommand(state, applyComment('Check this code.', 'c-code'));

    expect(serializeToCriticMarkup(state.doc)).toContain('{==```ts\nconst value = 1;\n```==}{>>Check this code.<<}');
  });

  it('preserves plain braces and backslashes in prose and inline code', () => {
    const markdown = 'Plain {braces} and path\\to\\file plus `code {x} path\\to\\file {++raw++}`.';
    const state = createMarkupEditorState(markdown);

    expect(serializeToCriticMarkup(state.doc)).toBe(markdown);
  });

  it('escapes literal CriticMarkup-looking tokens in prose', () => {
    const doc = parseMarkdownToMarkupDoc('Literal {++not a suggestion++} text.');

    expect(serializeToCriticMarkup(doc)).toBe('Literal \\{++not a suggestion++\\} text.');
  });

  it('omits text marked as both insertion and deletion', () => {
    let state = createMarkupEditorState('Alpha ghost omega.');
    const insertion = state.schema.marks.insertion;
    const deletion = state.schema.marks.deletion;
    expect(insertion).toBeDefined();
    expect(deletion).toBeDefined();
    const insertionMark = insertion!.create();
    const deletionMark = deletion!.create();
    state = state.apply(state.tr.addMark(7, 12, insertionMark).addMark(7, 12, deletionMark));

    expect(serializeToCriticMarkup(state.doc)).toBe('Alpha  omega.');
  });
});

function withSelection(state: EditorState, needle: string): EditorState {
  const text = state.doc.textBetween(0, state.doc.content.size, '\n\n');
  const index = text.indexOf(needle);
  if (index === -1) {
    throw new Error(`Could not find "${needle}"`);
  }
  return withRange(state, index + 1, index + needle.length + 1);
}

function withRange(state: EditorState, from: number, to: number): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

function applyCommand(state: EditorState, command: Parameters<typeof runCommand>[1]): EditorState {
  return runCommand(state, command);
}

function runCommand(state: EditorState, command: import('prosemirror-state').Command): EditorState {
  let nextState = state;
  const didApply = command(state, (transaction) => {
    nextState = nextState.apply(transaction);
  });
  if (!didApply) {
    throw new Error('Command did not apply');
  }
  return nextState;
}
