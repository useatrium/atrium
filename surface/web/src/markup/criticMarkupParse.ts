import type { MarkType, Node as ProseMirrorNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';

import { markupSchema, parseMarkdownToMarkupDoc } from './schema';

type InlineAnnotation = {
  kind: 'insertion' | 'deletion' | 'comment';
  startMarker: string;
  endMarker: string;
  comment?: string;
  author?: string | null;
};

type CodeBlockComment = {
  codeBlockIndex: number;
  comment: string;
  author: string | null;
};

type ScannedCriticMarkup = {
  markdown: string;
  annotations: InlineAnnotation[];
  codeBlockComments: CodeBlockComment[];
  changed: boolean;
};

type PositionedAnnotation = InlineAnnotation & {
  startFrom: number;
  startTo: number;
  contentFrom: number;
  contentTo: number;
  endFrom: number;
  endTo: number;
};

const MARKER_PREFIX = '\uE000CM';
const MARKER_MIDDLE = '\uE001';
const MARKER_SUFFIX = '\uE002';

export function parseCriticMarkupToDoc(source: string): ProseMirrorNode {
  const scanned = scanCriticMarkup(source);
  if (!scanned.changed) {
    return parseMarkdownToMarkupDoc(source);
  }

  let state = EditorState.create({
    schema: markupSchema,
    doc: parseMarkdownToMarkupDoc(scanned.markdown),
  });

  const positioned = positionAnnotations(state.doc, scanned.annotations);
  if (positioned.length > 0) {
    let transaction = state.tr;
    const markerRanges = positioned
      .flatMap((annotation) => [
        { from: annotation.startFrom, to: annotation.startTo },
        { from: annotation.endFrom, to: annotation.endTo },
      ])
      .sort((left, right) => right.from - left.from);

    for (const range of markerRanges) {
      transaction = transaction.delete(range.from, range.to);
    }

    for (const annotation of positioned) {
      const from = transaction.mapping.map(annotation.contentFrom, -1);
      const to = transaction.mapping.map(annotation.contentTo, -1);
      if (from >= to) {
        continue;
      }
      const mark = markForAnnotation(annotation);
      if (mark) {
        transaction = transaction.addMark(from, to, mark.create(markAttrsForAnnotation(annotation)));
      }
    }

    state = state.apply(transaction);
  }

  if (scanned.codeBlockComments.length > 0) {
    let transaction = state.tr;
    let codeBlockIndex = 0;
    state.doc.descendants((node, pos) => {
      if (node.type.name !== 'code_block') {
        return true;
      }
      const comment = scanned.codeBlockComments.find((item) => item.codeBlockIndex === codeBlockIndex);
      codeBlockIndex += 1;
      if (!comment) {
        return false;
      }
      transaction = transaction.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        comment: comment.comment,
        commentAuthor: comment.author,
      });
      return false;
    });
    state = state.apply(transaction);
  }

  return state.doc;
}

function scanCriticMarkup(source: string): ScannedCriticMarkup {
  const chunks: string[] = [];
  const annotations: InlineAnnotation[] = [];
  const codeBlockComments: CodeBlockComment[] = [];
  let textStart = 0;
  let index = 0;
  let markerIndex = 0;
  let codeBlockIndex = 0;
  let changed = false;

  const append = (value: string): void => {
    chunks.push(value);
  };

  const flushText = (end: number): void => {
    if (end <= textStart) {
      return;
    }
    const text = source.slice(textStart, end);
    const unescaped = unescapeCriticText(text);
    if (unescaped !== text) {
      changed = true;
    }
    append(unescaped);
  };

  const appendAnnotated = (
    kind: InlineAnnotation['kind'],
    text: string,
    attrs: Pick<InlineAnnotation, 'comment' | 'author'> = {},
  ): void => {
    const startMarker = makeMarker(markerIndex, 'S');
    const endMarker = makeMarker(markerIndex, 'E');
    markerIndex += 1;
    annotations.push({ kind, startMarker, endMarker, ...attrs });
    append(startMarker);
    append(markdownForAnnotatedText(text));
    append(endMarker);
  };

  while (index < source.length) {
    if (isLineStart(source, index)) {
      const commentedCode = readCommentedCodeAt(source, index);
      if (commentedCode) {
        flushText(index);
        const comment = parseCommentPayload(unescapeCriticText(commentedCode.comment));
        append(source.slice(index + 3, commentedCode.fenceEnd));
        codeBlockComments.push({
          codeBlockIndex,
          comment: comment.text,
          author: comment.author,
        });
        codeBlockIndex += 1;
        index = commentedCode.end;
        textStart = index;
        changed = true;
        continue;
      }

      const fence = readFenceAt(source, index);
      if (fence) {
        flushText(index);
        append(source.slice(index, fence.end));
        codeBlockIndex += 1;
        index = fence.end;
        textStart = index;
        continue;
      }
    }

    const inlineCodeEnd = readInlineCodeEnd(source, index);
    if (inlineCodeEnd !== null) {
      flushText(index);
      append(source.slice(index, inlineCodeEnd));
      index = inlineCodeEnd;
      textStart = index;
      continue;
    }

    if (isEscaped(source, index)) {
      index += 1;
      continue;
    }

    const token = readInlineTokenAt(source, index);
    if (!token) {
      index += 1;
      continue;
    }

    flushText(index);
    if (token.kind === 'deletion') {
      appendAnnotated('deletion', token.text);
    } else if (token.kind === 'insertion') {
      appendAnnotated('insertion', token.text);
    } else if (token.kind === 'substitution') {
      appendAnnotated('deletion', token.deletion);
      appendAnnotated('insertion', token.insertion);
    } else if (token.kind === 'comment') {
      appendAnnotated('comment', token.text, { comment: token.comment, author: token.author });
    } else {
      append(source.slice(index, token.end));
    }
    index = token.end;
    textStart = index;
    changed = true;
  }

  flushText(source.length);
  return { markdown: chunks.join(''), annotations, codeBlockComments, changed };
}

function makeMarker(index: number, side: 'S' | 'E'): string {
  return `${MARKER_PREFIX}${index}${MARKER_MIDDLE}${side}${MARKER_SUFFIX}`;
}

function markdownForAnnotatedText(text: string): string {
  return text.replace(/\r?\n/g, '\\\n');
}

function positionAnnotations(doc: ProseMirrorNode, annotations: InlineAnnotation[]): PositionedAnnotation[] {
  const flattened = flattenTextPositions(doc);
  const positioned: PositionedAnnotation[] = [];
  let searchStart = 0;

  for (const annotation of annotations) {
    const startIndex = flattened.text.indexOf(annotation.startMarker, searchStart);
    const endIndex = startIndex >= 0 ? flattened.text.indexOf(annotation.endMarker, startIndex + annotation.startMarker.length) : -1;
    if (startIndex < 0 || endIndex < 0) {
      continue;
    }

    const startFrom = flattened.positions[startIndex];
    const startTo = positionAfter(flattened.positions, startIndex + annotation.startMarker.length - 1);
    const endFrom = flattened.positions[endIndex];
    const endTo = positionAfter(flattened.positions, endIndex + annotation.endMarker.length - 1);

    if (startFrom === undefined || startTo === undefined || endFrom === undefined || endTo === undefined) {
      continue;
    }

    positioned.push({
      ...annotation,
      startFrom,
      startTo,
      contentFrom: startTo,
      contentTo: endFrom,
      endFrom,
      endTo,
    });
    searchStart = endIndex + annotation.endMarker.length;
  }

  return positioned;
}

function flattenTextPositions(doc: ProseMirrorNode): { text: string; positions: number[] } {
  let text = '';
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) {
      return true;
    }
    const value = node.text || '';
    for (let offset = 0; offset < value.length; offset += 1) {
      text += value[offset];
      positions.push(pos + offset);
    }
    return false;
  });
  return { text, positions };
}

function positionAfter(positions: number[], index: number): number | undefined {
  const position = positions[index];
  return position === undefined ? undefined : position + 1;
}

function markForAnnotation(annotation: InlineAnnotation): MarkType | null {
  if (annotation.kind === 'insertion') {
    return markupSchema.marks.insertion ?? null;
  }
  if (annotation.kind === 'deletion') {
    return markupSchema.marks.deletion ?? null;
  }
  return markupSchema.marks.comment ?? null;
}

function markAttrsForAnnotation(annotation: InlineAnnotation): Record<string, unknown> | undefined {
  if (annotation.kind !== 'comment') {
    return undefined;
  }
  return {
    id: '',
    text: annotation.comment || '',
    author: annotation.author ?? null,
  };
}

type InlineToken =
  | { kind: 'deletion'; text: string; end: number }
  | { kind: 'insertion'; text: string; end: number }
  | { kind: 'substitution'; deletion: string; insertion: string; end: number }
  | { kind: 'comment'; text: string; comment: string; author: string | null; end: number }
  | { kind: 'literal-comment'; end: number };

function readInlineTokenAt(source: string, index: number): InlineToken | null {
  if (source.startsWith('{--', index)) {
    const close = findClose(source, '--}', index + 3);
    if (close < 0) {
      return null;
    }
    return { kind: 'deletion', text: unescapeCriticText(source.slice(index + 3, close)), end: close + 3 };
  }

  if (source.startsWith('{++', index)) {
    const close = findClose(source, '++}', index + 3);
    if (close < 0) {
      return null;
    }
    return { kind: 'insertion', text: unescapeCriticText(source.slice(index + 3, close)), end: close + 3 };
  }

  if (source.startsWith('{~~', index)) {
    const middle = findClose(source, '~>', index + 3);
    if (middle < 0) {
      return null;
    }
    const close = findClose(source, '~~}', middle + 2);
    if (close < 0) {
      return null;
    }
    return {
      kind: 'substitution',
      deletion: unescapeCriticText(source.slice(index + 3, middle)),
      insertion: unescapeCriticText(source.slice(middle + 2, close)),
      end: close + 3,
    };
  }

  if (source.startsWith('{==', index)) {
    const close = findClose(source, '==}', index + 3);
    if (close < 0) {
      return null;
    }
    const comment = readCommentAt(source, close + 3);
    if (!comment) {
      return null;
    }
    const payload = parseCommentPayload(unescapeCriticText(comment.comment));
    return {
      kind: 'comment',
      text: unescapeCriticText(source.slice(index + 3, close)),
      comment: payload.text,
      author: payload.author,
      end: comment.end,
    };
  }

  const comment = readCommentAt(source, index);
  if (comment) {
    return { kind: 'literal-comment', end: comment.end };
  }

  return null;
}

function parseCommentPayload(value: string): { text: string; author: string | null } {
  const match = /^@([^:\s][^:]*):\s?([\s\S]*)$/.exec(value);
  if (!match) {
    return { text: value, author: null };
  }
  return { author: match[1] || null, text: match[2] || '' };
}

function readCommentAt(source: string, index: number): { comment: string; end: number } | null {
  if (!source.startsWith('{>>', index)) {
    return null;
  }
  const close = findClose(source, '<<}', index + 3);
  if (close < 0) {
    return null;
  }
  return { comment: source.slice(index + 3, close), end: close + 3 };
}

function readCommentedCodeAt(source: string, index: number): { comment: string; fenceEnd: number; end: number } | null {
  if (!source.startsWith('{==', index)) {
    return null;
  }
  const fence = readWrappedFenceAt(source, index + 3);
  if (!fence || !source.startsWith('==}', fence.end)) {
    return null;
  }
  const comment = readCommentAt(source, fence.end + 3);
  if (!comment) {
    return null;
  }
  return { comment: comment.comment, fenceEnd: fence.end, end: comment.end };
}

function readFenceAt(source: string, index: number): { end: number } | null {
  const opener = /^(`{3,}[^\n\r]*)(?:\r?\n)/.exec(source.slice(index));
  if (!opener) {
    return null;
  }
  const tickCount = leadingBackticks(opener[1] || '');
  let lineStart = index + opener[0].length;

  while (lineStart <= source.length) {
    const lineEnd = source.indexOf('\n', lineStart);
    const physicalLineEnd = lineEnd >= 0 ? lineEnd : source.length;
    const line = source.slice(lineStart, physicalLineEnd).replace(/\r$/, '');
    if (isClosingFenceLine(line, tickCount)) {
      return { end: lineEnd >= 0 ? lineEnd + 1 : physicalLineEnd };
    }
    if (lineEnd < 0) {
      break;
    }
    lineStart = lineEnd + 1;
  }

  return null;
}

function readWrappedFenceAt(source: string, index: number): { end: number } | null {
  const opener = /^(`{3,}[^\n\r]*)(?:\r?\n)/.exec(source.slice(index));
  if (!opener) {
    return null;
  }
  const tickCount = leadingBackticks(opener[1] || '');
  let lineStart = index + opener[0].length;

  while (lineStart <= source.length) {
    const ticks = /^`+/.exec(source.slice(lineStart))?.[0];
    if (ticks && ticks.length >= tickCount && source.startsWith('==}', lineStart + ticks.length)) {
      return { end: lineStart + ticks.length };
    }

    const lineEnd = source.indexOf('\n', lineStart);
    if (lineEnd < 0) {
      break;
    }
    lineStart = lineEnd + 1;
  }

  return null;
}

function readInlineCodeEnd(source: string, index: number): number | null {
  if (source[index] !== '`' || isEscaped(source, index)) {
    return null;
  }
  const ticks = /^`+/.exec(source.slice(index))?.[0];
  if (!ticks) {
    return null;
  }
  const close = source.indexOf(ticks, index + ticks.length);
  return close >= 0 ? close + ticks.length : null;
}

function findClose(source: string, close: string, start: number): number {
  for (let index = source.indexOf(close, start); index >= 0; index = source.indexOf(close, index + 1)) {
    if (!isEscaped(source, index + close.length - 1)) {
      return index;
    }
  }
  return -1;
}

function leadingBackticks(value: string): number {
  let count = 0;
  while (value[count] === '`') {
    count += 1;
  }
  return count;
}

function isClosingFenceLine(line: string, tickCount: number): boolean {
  const match = /^(`+)\s*$/.exec(line);
  return Boolean(match?.[1] && match[1].length >= tickCount);
}

function isLineStart(source: string, index: number): boolean {
  return index === 0 || source[index - 1] === '\n';
}

function isEscaped(source: string, index: number): boolean {
  if (index <= 0 || source[index - 1] !== '\\') {
    return false;
  }
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function unescapeCriticText(value: string): string {
  return value.replace(/\\\{(?=(?:\+\+|--|~~|==|>>))/g, '{').replace(/(\+\+|--|~~|==|>>|<<)\\\}/g, '$1}');
}
