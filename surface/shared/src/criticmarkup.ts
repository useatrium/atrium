export type CriticSegment =
  | { kind: 'text'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'ins'; text: string }
  | { kind: 'sub'; del: string; ins: string }
  | { kind: 'highlight'; text: string; comment: string }
  | { kind: 'comment'; comment: string };

export type CriticBlock =
  | { type: 'prose'; segments: CriticSegment[] }
  | { type: 'code'; fence: string; content: string }
  | { type: 'commented-code'; fence: string; content: string; comment: string }
  | { type: 'separator' };

export interface ParsedMarkupSteer {
  intent: 'response' | 'revise';
  title: string | null;
  path: string | null;
  sourceEntryHandle: string | null;
  doc: string;
  truncated: boolean;
  note: string | null;
  conflict: boolean;
}

const RESPONSE_PREAMBLE_RE =
  /^I marked up your message \("([^"]*)"(?:, entry ([^)]+))?\) instead of replying in prose\. The markup uses CriticMarkup: \{--deletion--\}, \{\+\+insertion\+\+\}, \{~~old~>new~~\}, \{>>comment<<\}, \{==highlight==\} \(a highlight binds the following comment to that span\)\. Treat edits as requested changes and comments as my reactions\/questions\. This is my response to what you wrote - not a request to edit a file\./;

const REVISE_PREAMBLE_RE =
  /^I marked up `([^`]+)` \(my v\d+, on top of your v\d+\) with changes and comments in CriticMarkup: \{--deletion--\}, \{\+\+insertion\+\+\}, \{~~old~>new~~\}, \{>>comment<<\}, \{==highlight==\}\. The file in your workspace already has my markup\. Please apply the edits, address the comments, and produce a clean next revision of `([^`]+)` \(remove all CriticMarkup syntax in your revision\)\./;

const CONFLICT_SENTENCE =
  "The save recorded a conflict against a newer version; please inspect the file's conflict state before producing the clean revision.";

const FULL_DOCUMENT_RE =
  /^Full document: (.+) \(already synced into your workspace; my markup is v\d+, diff against v\d+\)\./;

const OPENERS = ['{--', '{++', '{~~', '{==', '{>>'] as const;
const REFERENCED_ENTRIES_APPENDIX_MARKER = '\n\n---\nReferenced entries:';

export function parseCriticMarkup(source: string): CriticBlock[] {
  const blocks: CriticBlock[] = [];
  let proseStart = 0;
  let index = 0;

  const flushProse = (end: number): void => {
    if (end <= proseStart) return;
    const text = source.slice(proseStart, end);
    if (text) blocks.push({ type: 'prose', segments: parseProseSegments(text) });
  };

  while (index < source.length) {
    if (!isLineStart(source, index)) {
      index += 1;
      continue;
    }

    const commented = readCommentedCodeAt(source, index);
    if (commented) {
      flushProse(index);
      blocks.push({
        type: 'commented-code',
        fence: commented.fence,
        content: commented.content,
        comment: unescapeCriticText(commented.comment),
      });
      index = commented.end;
      proseStart = index;
      continue;
    }

    const fence = readFenceAt(source, index);
    if (fence) {
      flushProse(index);
      blocks.push({ type: 'code', fence: fence.fence, content: fence.content });
      index = fence.end;
      proseStart = index;
      continue;
    }

    const separatorEnd = readSeparatorAt(source, index);
    if (separatorEnd !== null) {
      flushProse(index);
      blocks.push({ type: 'separator' });
      index = separatorEnd;
      proseStart = index;
      continue;
    }

    index += 1;
  }

  flushProse(source.length);
  return blocks;
}

export function containsCriticMarkup(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const inlineCodeEnd = readInlineCodeEnd(text, index);
    if (inlineCodeEnd !== null) {
      index = inlineCodeEnd - 1;
      continue;
    }
    if (isEscaped(text, index)) continue;
    if (OPENERS.some((opener) => text.startsWith(opener, index))) return true;
  }
  return false;
}

// Coupled to surface/server/src/markup-feedback.ts composeFeedbackSteer.
// Keep these preamble/fence/full-document strings in sync with that composer.
export function parseMarkupSteer(text: string): ParsedMarkupSteer | null {
  text = stripReferencedEntriesAppendix(text);
  const responseMatch = RESPONSE_PREAMBLE_RE.exec(text);
  const reviseMatch = responseMatch ? null : REVISE_PREAMBLE_RE.exec(text);
  if (!responseMatch && !reviseMatch) return null;

  const intent = responseMatch ? 'response' : 'revise';
  const preambleEnd = (responseMatch ?? reviseMatch)?.[0].length;
  if (preambleEnd === undefined || !text.startsWith('\n\n', preambleEnd)) return null;

  const fence = readFenceAt(text, preambleEnd + 2, true, false);
  if (!fence || !/^`{3,}markdown$/.test(fence.fence)) return null;

  let cursor = fence.end;
  let truncated = hasSeparatorLine(fence.content);

  if (text.startsWith('\n\nFull document: ', cursor)) {
    const fullDocumentStart = cursor + 2;
    const nextPart = text.indexOf('\n\n', fullDocumentStart);
    const lineEnd = nextPart >= 0 ? nextPart : text.length;
    const fullDocumentLine = text.slice(fullDocumentStart, lineEnd);
    if (!FULL_DOCUMENT_RE.test(fullDocumentLine)) return null;
    truncated = true;
    cursor = lineEnd;
  }

  let note: string | null = null;
  let conflict = false;

  if (text.startsWith('\n\nNote from me: ', cursor)) {
    const noteStart = cursor + '\n\nNote from me: '.length;
    const conflictStart = text.indexOf(`\n\n${CONFLICT_SENTENCE}`, noteStart);
    if (conflictStart >= 0) {
      note = text.slice(noteStart, conflictStart);
      cursor = conflictStart;
    } else {
      note = text.slice(noteStart);
      cursor = text.length;
    }
  }

  if (text.startsWith(`\n\n${CONFLICT_SENTENCE}`, cursor)) {
    conflict = true;
    cursor += `\n\n${CONFLICT_SENTENCE}`.length;
  }

  if (cursor !== text.length) return null;

  if (responseMatch) {
    return {
      intent,
      title: responseMatch[1] ?? null,
      path: null,
      sourceEntryHandle: responseMatch[2] ?? null,
      doc: fence.content,
      truncated,
      note,
      conflict,
    };
  }

  const path = reviseMatch?.[1] ?? null;
  if (path !== (reviseMatch?.[2] ?? null)) return null;
  return {
    intent,
    title: null,
    path,
    sourceEntryHandle: null,
    doc: fence.content,
    truncated,
    note,
    conflict,
  };
}

function stripReferencedEntriesAppendix(text: string): string {
  const markerStart = text.lastIndexOf(REFERENCED_ENTRIES_APPENDIX_MARKER);
  return markerStart >= 0 ? text.slice(0, markerStart) : text;
}

function parseProseSegments(source: string): CriticSegment[] {
  const segments: CriticSegment[] = [];
  let textStart = 0;
  let index = 0;

  const flushText = (end: number): void => {
    if (end <= textStart) return;
    pushText(segments, source.slice(textStart, end));
  };

  while (index < source.length) {
    const inlineCodeEnd = readInlineCodeEnd(source, index);
    if (inlineCodeEnd !== null) {
      index = inlineCodeEnd;
      continue;
    }

    if (isEscaped(source, index)) {
      index += 1;
      continue;
    }

    const parsed = readInlineTokenAt(source, index);
    if (!parsed) {
      index += 1;
      continue;
    }

    flushText(index);
    pushSegment(segments, parsed.segment);
    index = parsed.end;
    textStart = index;
  }

  flushText(source.length);
  return collapseAdjacentSubstitutions(segments);
}

function readInlineTokenAt(source: string, index: number): { segment: CriticSegment; end: number } | null {
  if (source.startsWith('{--', index)) {
    const close = findClose(source, '--}', index + 3);
    if (close < 0) return null;
    return { segment: { kind: 'del', text: unescapeCriticText(source.slice(index + 3, close)) }, end: close + 3 };
  }

  if (source.startsWith('{++', index)) {
    const close = findClose(source, '++}', index + 3);
    if (close < 0) return null;
    return { segment: { kind: 'ins', text: unescapeCriticText(source.slice(index + 3, close)) }, end: close + 3 };
  }

  if (source.startsWith('{~~', index)) {
    const middle = source.indexOf('~>', index + 3);
    if (middle < 0) return null;
    const close = findClose(source, '~~}', middle + 2);
    if (close < 0) return null;
    return {
      segment: {
        kind: 'sub',
        del: unescapeCriticText(source.slice(index + 3, middle)),
        ins: unescapeCriticText(source.slice(middle + 2, close)),
      },
      end: close + 3,
    };
  }

  if (source.startsWith('{==', index)) {
    const close = findClose(source, '==}', index + 3);
    if (close < 0) return null;
    const comment = readCommentAt(source, close + 3);
    if (!comment) return null;
    return {
      segment: {
        kind: 'highlight',
        text: unescapeCriticText(source.slice(index + 3, close)),
        comment: unescapeCriticText(comment.comment),
      },
      end: comment.end,
    };
  }

  const comment = readCommentAt(source, index);
  if (comment) {
    return { segment: { kind: 'comment', comment: unescapeCriticText(comment.comment) }, end: comment.end };
  }

  return null;
}

function readCommentAt(source: string, index: number): { comment: string; end: number } | null {
  if (!source.startsWith('{>>', index)) return null;
  const close = findClose(source, '<<}', index + 3);
  if (close < 0) return null;
  return { comment: source.slice(index + 3, close), end: close + 3 };
}

function readInlineCodeEnd(source: string, index: number): number | null {
  if (source[index] !== '`' || isEscaped(source, index)) return null;
  const ticks = /^`+/.exec(source.slice(index))?.[0];
  if (!ticks) return null;
  const close = source.indexOf(ticks, index + ticks.length);
  return close >= 0 ? close + ticks.length : null;
}

function collapseAdjacentSubstitutions(segments: CriticSegment[]): CriticSegment[] {
  const collapsed: CriticSegment[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const next = segments[index + 1];
    if (segment?.kind === 'del' && next?.kind === 'ins') {
      collapsed.push({ kind: 'sub', del: segment.text, ins: next.text });
      index += 1;
      continue;
    }
    if (segment) collapsed.push(segment);
  }
  return collapsed;
}

function pushSegment(segments: CriticSegment[], segment: CriticSegment): void {
  if (segment.kind === 'text') {
    pushText(segments, segment.text);
    return;
  }
  segments.push(segment);
}

function pushText(segments: CriticSegment[], text: string): void {
  if (!text) return;
  const unescaped = unescapeCriticText(text);
  const previous = segments[segments.length - 1];
  if (previous?.kind === 'text') {
    previous.text += unescaped;
    return;
  }
  segments.push({ kind: 'text', text: unescaped });
}

function readCommentedCodeAt(
  source: string,
  index: number,
): { fence: string; content: string; comment: string; end: number } | null {
  if (!source.startsWith('{==', index)) return null;
  const fence = readWrappedFenceAt(source, index + 3);
  if (!fence || !source.startsWith('==}', fence.end)) return null;
  const comment = readCommentAt(source, fence.end + 3);
  if (!comment) return null;
  return { fence: fence.fence, content: fence.content, comment: comment.comment, end: comment.end };
}

function readFenceAt(
  source: string,
  index: number,
  requireLineStart = true,
  consumeClosingNewline = true,
): { fence: string; content: string; end: number } | null {
  if (requireLineStart && !isLineStart(source, index)) return null;
  const opener = /^(`{3,}[^\n\r]*)(?:\r?\n)/.exec(source.slice(index));
  if (!opener) return null;

  const fence = opener[1];
  if (!fence) return null;
  const tickCount = leadingBackticks(fence);
  let lineStart = index + opener[0].length;

  while (lineStart <= source.length) {
    const lineEnd = source.indexOf('\n', lineStart);
    const physicalLineEnd = lineEnd >= 0 ? lineEnd : source.length;
    const line = source.slice(lineStart, physicalLineEnd).replace(/\r$/, '');
    if (isClosingFenceLine(line, tickCount)) {
      let contentEnd = lineStart;
      if (contentEnd > index + opener[0].length && source[contentEnd - 1] === '\n') {
        contentEnd -= 1;
        if (contentEnd > index + opener[0].length && source[contentEnd - 1] === '\r') contentEnd -= 1;
      }
      return {
        fence,
        content: source.slice(index + opener[0].length, contentEnd),
        end: lineEnd >= 0 && consumeClosingNewline ? lineEnd + 1 : physicalLineEnd,
      };
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }

  return null;
}

function readWrappedFenceAt(source: string, index: number): { fence: string; content: string; end: number } | null {
  const opener = /^(`{3,}[^\n\r]*)(?:\r?\n)/.exec(source.slice(index));
  if (!opener) return null;

  const fence = opener[1];
  if (!fence) return null;
  const tickCount = leadingBackticks(fence);
  let lineStart = index + opener[0].length;

  while (lineStart <= source.length) {
    const ticks = /^`+/.exec(source.slice(lineStart))?.[0];
    if (ticks && ticks.length >= tickCount && source.startsWith('==}', lineStart + ticks.length)) {
      let contentEnd = lineStart;
      if (contentEnd > index + opener[0].length && source[contentEnd - 1] === '\n') {
        contentEnd -= 1;
        if (contentEnd > index + opener[0].length && source[contentEnd - 1] === '\r') contentEnd -= 1;
      }
      return { fence, content: source.slice(index + opener[0].length, contentEnd), end: lineStart + ticks.length };
    }

    const lineEnd = source.indexOf('\n', lineStart);
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }

  return null;
}

function readSeparatorAt(source: string, index: number): number | null {
  const lineEnd = source.indexOf('\n', index);
  const end = lineEnd >= 0 ? lineEnd : source.length;
  const line = source.slice(index, end).replace(/\r$/, '');
  if (line !== '⋯') return null;
  return lineEnd >= 0 ? lineEnd + 1 : source.length;
}

function isClosingFenceLine(line: string, tickCount: number): boolean {
  const match = /^(`+)\s*$/.exec(line);
  return Boolean(match?.[1] && match[1].length >= tickCount);
}

function leadingBackticks(value: string): number {
  let count = 0;
  while (value[count] === '`') count += 1;
  return count;
}

function hasSeparatorLine(value: string): boolean {
  return /(?:^|\n)⋯(?:\n|$)/.test(value);
}

function findClose(source: string, close: string, start: number): number {
  for (let index = source.indexOf(close, start); index >= 0; index = source.indexOf(close, index + 1)) {
    if (!isEscaped(source, index + close.length - 1)) return index;
  }
  return -1;
}

function isLineStart(source: string, index: number): boolean {
  return index === 0 || source[index - 1] === '\n';
}

function isEscaped(source: string, index: number): boolean {
  if (index <= 0 || source[index - 1] !== '\\') return false;
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function unescapeCriticText(value: string): string {
  return value.replace(/\\\{(?=(?:\+\+|--|~~|==|>>))/g, '{').replace(/(\+\+|--|~~|==|>>|<<)\\\}/g, '$1}');
}
