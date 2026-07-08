export const ATRIUM_CONTEXT_MARKER = '[atrium context]';

const CONTEXT_OPEN = '<context>';
const CONTEXT_CLOSE = '</context>';
const ACTOR_SEAT_SEPARATOR = ' · ';
const SUGGESTION_SEPARATOR = ' — ';

export type SteerContextActorKind = 'human' | 'agent';

export interface SteerContextActor {
  name: string;
  kind: SteerContextActorKind;
  seat?: string | null;
}

export interface SteerContextSuggestionAttribution {
  suggestedBy: Pick<SteerContextActor, 'name' | 'kind'>;
  acceptedBy: Pick<SteerContextActor, 'name'> & { seat?: string | null };
}

export interface SteerContextProvenance {
  from: SteerContextActor;
  channel: string;
  sent: Date | string;
  suggestion?: SteerContextSuggestionAttribution;
}

export interface ParsedSteerContextBlock {
  name: string;
  kind: SteerContextActorKind;
  seat: string | null;
  channel: string | null;
  sent: string | null;
  suggestedBy?: {
    name: string;
    kind: SteerContextActorKind;
  };
  acceptedBy?: {
    name: string;
    seat: string | null;
  };
}

export interface SteerContextPrefix {
  context: ParsedSteerContextBlock;
  text: string;
}

export function buildSteerContextBlock(provenance: SteerContextProvenance): string {
  const from = provenance.from;
  const lines = [
    ATRIUM_CONTEXT_MARKER,
    `from: ${oneLine(from.name)} (${actorLabel(from.kind, from.seat)})`,
    `channel: #${channelLabel(provenance.channel)}`,
    `sent: ${sentIso(provenance.sent)}`,
  ];

  if (provenance.suggestion) {
    const { suggestedBy, acceptedBy } = provenance.suggestion;
    lines.push(
      [
        `suggested by: ${oneLine(suggestedBy.name)} (${suggestedBy.kind})`,
        `accepted and sent by: ${oneLine(acceptedBy.name)} (${oneLine(acceptedBy.seat ?? '') || 'driver'})`,
      ].join(SUGGESTION_SEPARATOR),
    );
  }

  return lines.join('\n');
}

export function parseSteerContextBlock(text: string): ParsedSteerContextBlock | null {
  const normalized = unwrapContextTags(text).replace(/\r\n/g, '\n').trim();
  if (!normalized.startsWith(ATRIUM_CONTEXT_MARKER)) return null;
  const lines = normalized.split('\n').map((line) => line.trimEnd());
  if (lines[0] !== ATRIUM_CONTEXT_MARKER) return null;

  const from = parseActorLine(lines.find((line) => line.startsWith('from: ')) ?? '', 'from: ');
  if (!from) return null;

  const channelLine = lines.find((line) => line.startsWith('channel: '));
  const sentLine = lines.find((line) => line.startsWith('sent: '));
  const suggestionLine = lines.find((line) => line.startsWith('suggested by: '));
  const suggestion = suggestionLine ? parseSuggestionLine(suggestionLine) : null;

  return {
    name: from.name,
    kind: from.kind,
    seat: from.seat,
    channel: channelLine ? channelLine.slice('channel: '.length).trim().replace(/^#/, '') || null : null,
    sent: sentLine ? sentLine.slice('sent: '.length).trim() || null : null,
    ...(suggestion ? suggestion : {}),
  };
}

export function stripSteerContextPrefix(raw: string): SteerContextPrefix | null {
  const wrapped = stripWrappedContextPrefix(raw);
  if (wrapped) return wrapped;
  if (!raw.startsWith(ATRIUM_CONTEXT_MARKER)) return null;

  const separator = firstBlankLineIndex(raw);
  if (separator !== null) {
    const contextText = raw.slice(0, separator.index);
    const context = parseSteerContextBlock(contextText);
    if (!context) return null;
    return { context, text: raw.slice(separator.end) };
  }

  const context = parseSteerContextBlock(raw);
  return context ? { context, text: '' } : null;
}

function stripWrappedContextPrefix(raw: string): SteerContextPrefix | null {
  if (!raw.startsWith(CONTEXT_OPEN)) return null;
  const closeIndex = raw.indexOf(CONTEXT_CLOSE, CONTEXT_OPEN.length);
  if (closeIndex === -1) return null;
  const contextText = raw.slice(CONTEXT_OPEN.length, closeIndex);
  const context = parseSteerContextBlock(contextText);
  if (!context) return null;
  return {
    context,
    text: stripOneBlankSeparator(raw.slice(closeIndex + CONTEXT_CLOSE.length)),
  };
}

function unwrapContextTags(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith(CONTEXT_OPEN) || !trimmed.endsWith(CONTEXT_CLOSE)) return text;
  return trimmed.slice(CONTEXT_OPEN.length, -CONTEXT_CLOSE.length);
}

function firstBlankLineIndex(text: string): { index: number; end: number } | null {
  const lf = text.indexOf('\n\n');
  const crlf = text.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { index: crlf, end: crlf + 4 };
  return { index: lf, end: lf + 2 };
}

function stripOneBlankSeparator(text: string): string {
  if (text.startsWith('\r\n\r\n')) return text.slice(4);
  if (text.startsWith('\n\n')) return text.slice(2);
  return text;
}

function parseActorLine(
  line: string,
  prefix: string,
): { name: string; kind: SteerContextActorKind; seat: string | null } | null {
  if (!line.startsWith(prefix)) return null;
  const body = line.slice(prefix.length);
  const match = /^(.+?) \(([^()]+)\)$/.exec(body);
  if (!match) return null;
  const labelParts = match[2]!.split(ACTOR_SEAT_SEPARATOR).map((part) => part.trim());
  const kind = parseActorKind(labelParts[0]);
  if (!kind) return null;
  return {
    name: match[1]!.trim(),
    kind,
    seat: labelParts.slice(1).join(ACTOR_SEAT_SEPARATOR).trim() || null,
  };
}

function parseSuggestionLine(
  line: string,
): Pick<ParsedSteerContextBlock, 'suggestedBy' | 'acceptedBy'> | null {
  const parts = line.split(SUGGESTION_SEPARATOR);
  if (parts.length !== 2) return null;
  const suggestedBy = parseActorLine(parts[0]!, 'suggested by: ');
  if (!suggestedBy) return null;

  const acceptedBody = parts[1]!.startsWith('accepted and sent by: ')
    ? parts[1]!.slice('accepted and sent by: '.length)
    : '';
  const accepted = /^(.+?) \(([^()]+)\)$/.exec(acceptedBody);
  if (!accepted) return null;
  return {
    suggestedBy: { name: suggestedBy.name, kind: suggestedBy.kind },
    acceptedBy: { name: accepted[1]!.trim(), seat: accepted[2]!.trim() || null },
  };
}

function parseActorKind(value: string | undefined): SteerContextActorKind | null {
  return value === 'human' || value === 'agent' ? value : null;
}

function actorLabel(kind: SteerContextActorKind, seat?: string | null): string {
  const cleanSeat = oneLine(seat ?? '');
  return cleanSeat ? `${kind}${ACTOR_SEAT_SEPARATOR}${cleanSeat}` : kind;
}

function channelLabel(channel: string): string {
  return oneLine(channel).replace(/^#+/, '') || 'unknown';
}

function sentIso(sent: Date | string): string {
  if (sent instanceof Date) return sent.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const parsed = new Date(sent);
  return Number.isNaN(parsed.getTime()) ? oneLine(sent) : parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}
