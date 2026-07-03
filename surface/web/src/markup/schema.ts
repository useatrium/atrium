import { defaultMarkdownParser, schema as markdownSchema } from 'prosemirror-markdown';
import type { Mark, MarkSpec, Node as ProseMirrorNode, NodeSpec } from 'prosemirror-model';
import { Schema } from 'prosemirror-model';

export const insertionMarkSpec: MarkSpec = {
  inclusive: false,
  parseDOM: [{ tag: 'ins[data-suggestion-insertion]' }],
  toDOM: () => ['ins', { 'data-suggestion-insertion': 'true', class: 'suggestion-insert' }, 0],
};

export const deletionMarkSpec: MarkSpec = {
  inclusive: false,
  parseDOM: [{ tag: 'del[data-suggestion-deletion]' }],
  toDOM: () => ['del', { 'data-suggestion-deletion': 'true', class: 'suggestion-delete' }, 0],
};

export const commentMarkSpec: MarkSpec = {
  attrs: {
    id: { default: '' },
    text: { default: '' },
    author: { default: null },
  },
  inclusive: false,
  parseDOM: [
    {
      tag: 'span[data-comment-text]',
      getAttrs: (dom) => ({
        id: (dom as HTMLElement).getAttribute('data-comment-id') || '',
        text: (dom as HTMLElement).getAttribute('data-comment-text') || '',
        author: (dom as HTMLElement).getAttribute('data-comment-author') || null,
      }),
    },
  ],
  toDOM: (mark: Mark) => [
    'span',
    {
      class: 'comment-mark',
      'data-comment-id': mark.attrs.id,
      'data-comment-text': mark.attrs.text,
      'data-comment-author': mark.attrs.author || null,
    },
    0,
  ],
};

const baseCodeBlockSpec = markdownSchema.spec.nodes.get('code_block');

const codeBlockWithCommentSpec: NodeSpec = {
  ...baseCodeBlockSpec,
  attrs: {
    ...(baseCodeBlockSpec?.attrs || {}),
    params: { default: '' },
    comment: { default: '' },
    commentAuthor: { default: null },
  },
  toDOM: (node: ProseMirrorNode) => [
    'pre',
    {
      'data-code-block-comment': node.attrs.comment || null,
      'data-code-block-comment-author': node.attrs.commentAuthor || null,
      class: node.attrs.comment ? 'code-block has-block-comment' : 'code-block',
    },
    ['code', 0],
  ],
};

export const markupSchema = new Schema({
  nodes: markdownSchema.spec.nodes.update('code_block', codeBlockWithCommentSpec),
  marks: markdownSchema.spec.marks.append({
    insertion: insertionMarkSpec,
    deletion: deletionMarkSpec,
    comment: commentMarkSpec,
  }),
});

export function parseMarkdownToMarkupDoc(markdown: string): ProseMirrorNode {
  const parsed = defaultMarkdownParser.parse(markdown);
  return markupSchema.nodeFromJSON(parsed.toJSON());
}
