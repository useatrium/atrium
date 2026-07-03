export type FeedbackIntent = 'response' | 'revise';

export interface ComposeFeedbackSteerArgs {
  markedUpContent: string;
  baseContent: string;
  path: string;
  seq: number;
  baseSeq: number;
  intent: FeedbackIntent;
  title: string;
  sourceEntryHandle?: string | null;
  note?: string;
  status?: 'normal' | 'conflict';
}

const INLINE_THRESHOLD_BYTES = 6000;
const CONTEXT_LINES = 2;

const MARKUP_PAIRS = [
  { open: '{--', close: '--}' },
  { open: '{++', close: '++}' },
  { open: '{~~', close: '~~}' },
  { open: '{==', close: '==}' },
  { open: '{>>', close: '<<}' },
] as const;

export function composeFeedbackSteer(args: ComposeFeedbackSteerArgs): string {
  const markedBody = stripYamlFrontmatter(args.markedUpContent);
  const preamble =
    args.intent === 'response'
      ? responsePreamble(args.title, args.sourceEntryHandle)
      : revisePreamble(args.path, args.seq, args.baseSeq);
  const body =
    Buffer.byteLength(markedBody, 'utf8') <= INLINE_THRESHOLD_BYTES
      ? fencedMarkdown(markedBody)
      : `${fencedMarkdown(markedHunks(markedBody))}\n\nFull document: ${args.path} (already synced into your workspace; my markup is v${args.seq}, diff against v${args.baseSeq}).`;
  const parts = [preamble, body];
  if (args.note?.trim()) {
    parts.push(`Note from me: ${args.note.trim()}`);
  }
  if (args.status === 'conflict') {
    parts.push(
      "The save recorded a conflict against a newer version; please inspect the file's conflict state before producing the clean revision.",
    );
  }
  return parts.join('\n\n');
}

export function deriveFeedbackIntent(baseContent: string): FeedbackIntent {
  return readYamlFrontmatterField(baseContent, 'source_entry') ? 'response' : 'revise';
}

export function sourceEntryHandleFromContent(content: string): string | null {
  return readYamlFrontmatterField(content, 'source_entry');
}

export function titleFromContent(content: string, fallback: string): string {
  return readYamlFrontmatterField(content, 'title') ?? fallback;
}

export function stripYamlFrontmatter(content: string): string {
  const parsed = splitYamlFrontmatter(content);
  return parsed ? parsed.body : content;
}

function responsePreamble(title: string, sourceEntryHandle?: string | null): string {
  const entry = sourceEntryHandle ? `, entry ${sourceEntryHandle}` : '';
  return `I marked up your message ("${title}"${entry}) instead of replying in prose. The markup uses CriticMarkup: {--deletion--}, {++insertion++}, {~~old~>new~~}, {>>comment<<}, {==highlight==} (a highlight binds the following comment to that span). Treat edits as requested changes and comments as my reactions/questions. This is my response to what you wrote - not a request to edit a file.`;
}

function revisePreamble(path: string, seq: number, baseSeq: number): string {
  return `I marked up \`${path}\` (my v${seq}, on top of your v${baseSeq}) with changes and comments in CriticMarkup: {--deletion--}, {++insertion++}, {~~old~>new~~}, {>>comment<<}, {==highlight==}. The file in your workspace already has my markup. Please apply the edits, address the comments, and produce a clean next revision of \`${path}\` (remove all CriticMarkup syntax in your revision).`;
}

function fencedMarkdown(content: string): string {
  const ticks = longestBacktickRun(content);
  const fence = '`'.repeat(Math.max(3, ticks + 1));
  return `${fence}markdown\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}`;
}

function longestBacktickRun(content: string): number {
  let longest = 0;
  let current = 0;
  for (const char of content) {
    if (char === '`') {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function markedHunks(content: string): string {
  const lines = content.split(/\n/);
  const marked = markedLineIndexes(lines);
  if (marked.length === 0) return '';

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of marked) {
    const next = {
      start: Math.max(0, index - CONTEXT_LINES),
      end: Math.min(lines.length - 1, index + CONTEXT_LINES),
    };
    const prev = ranges.at(-1);
    if (prev && next.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, next.end);
    } else {
      ranges.push(next);
    }
  }

  return ranges.map((range) => lines.slice(range.start, range.end + 1).join('\n')).join('\n⋯\n');
}

function markedLineIndexes(lines: string[]): number[] {
  const marked: number[] = [];
  const openClosers: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const activeAtStart = openClosers.length > 0;
    const sawToken = scanMarkupLine(line, openClosers);
    if (activeAtStart || sawToken || openClosers.length > 0) marked.push(i);
  }
  return marked;
}

function scanMarkupLine(line: string, openClosers: string[]): boolean {
  let sawToken = false;
  for (let index = 0; index < line.length; ) {
    const opener = MARKUP_PAIRS.find((pair) => line.startsWith(pair.open, index));
    if (opener) {
      sawToken = true;
      openClosers.push(opener.close);
      index += opener.open.length;
      continue;
    }

    const closeIndex = openClosers.findLastIndex((close) => line.startsWith(close, index));
    if (closeIndex >= 0) {
      sawToken = true;
      openClosers.splice(closeIndex, 1);
      index += 3;
      continue;
    }

    const strayCloser = MARKUP_PAIRS.find((pair) => line.startsWith(pair.close, index));
    if (strayCloser) {
      sawToken = true;
      index += strayCloser.close.length;
      continue;
    }

    index += 1;
  }
  return sawToken;
}

function readYamlFrontmatterField(content: string, field: string): string | null {
  const parsed = splitYamlFrontmatter(content);
  if (!parsed) return null;
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escaped}\\s*:\\s*(.*?)\\s*$`, 'm').exec(parsed.yaml);
  if (!match) return null;
  const raw = match[1]?.trim() ?? '';
  if (!raw) return null;
  return raw.replace(/^['"]|['"]$/g, '') || null;
}

function splitYamlFrontmatter(content: string): { yaml: string; body: string } | null {
  if (!content.startsWith('---')) return null;
  const firstLineEnd = content.indexOf('\n');
  if (firstLineEnd < 0 || content.slice(0, firstLineEnd).trim() !== '---') return null;
  const lines = content.slice(firstLineEnd + 1).split(/\n/);
  let offset = firstLineEnd + 1;
  for (const line of lines) {
    const trimmed = line.trim();
    const lineWithNewlineLength = line.length + 1;
    if (trimmed === '---' || trimmed === '...') {
      const yaml = content.slice(firstLineEnd + 1, offset);
      const bodyStart = Math.min(content.length, offset + line.length + 1);
      return { yaml, body: content.slice(bodyStart) };
    }
    offset += lineWithNewlineLength;
  }
  return null;
}
