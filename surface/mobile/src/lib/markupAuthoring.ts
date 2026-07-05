import {
  ApiError,
  randomId,
  type Api,
  type ChatMessage,
} from '@atrium/surface-client';
import { encodeEventHandle } from '@atrium/surface-client/handle';

export type MarkupAuthoringMode =
  | { kind: 'reply'; channelId: string; threadRootEventId: number }
  | { kind: 'steer'; sessionId: string };

export interface MarkupAuthoringDraft {
  artifactId: string;
  path: string;
  seq: number;
  workspaceId: string;
  frontmatter: string;
  body: string;
  mode: MarkupAuthoringMode;
}

export type MarkupWebViewMessage =
  | { type: 'markup-shell-ready' }
  | { type: 'markup-dirty'; dirty: boolean }
  | { type: 'markup-serialized'; markdown: string };

const pendingDrafts = new Map<string, MarkupAuthoringDraft>();
const MARKDOWN_BLOCK_RE = /(^|\n)\s{0,3}(#{1,6}\s+\S|([-*+]|\d+[.)])\s+\S|>\s+\S|```)/;

export function isStructuredTextForMarkup(text: string): boolean {
  const nonEmptyLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return nonEmptyLines.length >= 2 || MARKDOWN_BLOCK_RE.test(text);
}

export function messageEntryHandleForMarkup(message: ChatMessage): string | null {
  if (
    message.deleted === true ||
    message.status !== 'confirmed' ||
    message.id == null ||
    message.sessionId != null ||
    message.sessionEventType != null ||
    message.voice != null ||
    !isStructuredTextForMarkup(message.text)
  ) {
    return null;
  }
  return encodeEventHandle(message.id);
}

export function splitMarkdownFrontmatter(content: string): { frontmatter: string; body: string } {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: '', body: content };
  }
  const newline = content.startsWith('---\r\n') ? '\r\n' : '\n';
  const closeMarker = `${newline}---${newline}`;
  const closeIndex = content.indexOf(closeMarker, 3);
  if (closeIndex === -1) return { frontmatter: '', body: content };
  const frontmatterEnd = closeIndex + closeMarker.length;
  const body =
    content.slice(frontmatterEnd, frontmatterEnd + newline.length) === newline
      ? content.slice(frontmatterEnd + newline.length)
      : content.slice(frontmatterEnd);
  return { frontmatter: content.slice(0, frontmatterEnd), body };
}

export function composeMarkupContent(frontmatter: string, markdown: string): string {
  return frontmatter ? `${frontmatter}\n${markdown}` : markdown;
}

export function buildMarkupShellUrl(serverUrl: string, theme: 'light' | 'dark'): string {
  return `${serverUrl.replace(/\/+$/, '')}/markup/shell?theme=${theme}`;
}

export function parseMarkupWebViewMessage(data: unknown): MarkupWebViewMessage | null {
  const value = typeof data === 'string' ? parseJson(data) : data;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.type === 'markup-shell-ready') return { type: 'markup-shell-ready' };
  if (raw.type === 'markup-dirty' && typeof raw.dirty === 'boolean') {
    return { type: 'markup-dirty', dirty: raw.dirty };
  }
  if (raw.type === 'markup-serialized' && typeof raw.markdown === 'string') {
    return { type: 'markup-serialized', markdown: raw.markdown };
  }
  return null;
}

export function putPendingMarkupDraft(draft: MarkupAuthoringDraft): string {
  const id = randomId();
  pendingDrafts.set(id, draft);
  return id;
}

export function getPendingMarkupDraft(id: string): MarkupAuthoringDraft | null {
  return pendingDrafts.get(id) ?? null;
}

export function clearPendingMarkupDraft(id: string): void {
  pendingDrafts.delete(id);
}

export async function loadMarkupDraftFromEntry(args: {
  api: Pick<Api, 'extractEntry'>;
  serverUrl: string;
  fileHeaders?: Record<string, string>;
  handle: string;
  mode: MarkupAuthoringMode;
}): Promise<MarkupAuthoringDraft> {
  const extracted = await args.api.extractEntry(args.handle);
  const response = await fetch(
    `${args.serverUrl.replace(/\/+$/, '')}/api/files/artifact/${encodeURIComponent(extracted.artifactId)}/content`,
    { headers: args.fileHeaders },
  );
  if (!response.ok) {
    throw new Error('Could not load markup source');
  }
  const { frontmatter, body } = splitMarkdownFrontmatter(await response.text());
  return {
    artifactId: extracted.artifactId,
    path: extracted.path,
    seq: extracted.seq,
    workspaceId: extracted.workspaceId,
    frontmatter,
    body,
    mode: args.mode,
  };
}

export async function submitMarkupDraft(args: {
  api: Pick<Api, 'postMessage' | 'saveTextFile' | 'sendArtifactFeedback'>;
  serverUrl: string;
  draft: MarkupAuthoringDraft;
  markdown: string;
  note: string;
}): Promise<'reply' | 'steer'> {
  const content = composeMarkupContent(args.draft.frontmatter, args.markdown);
  const note = args.note.trim();
  if (args.draft.mode.kind === 'reply') {
    await args.api.saveTextFile(args.draft.artifactId, content, args.draft.seq, 'text/markdown; charset=utf-8');
    const link = `/e/art_${args.draft.artifactId}`;
    await args.api.postMessage({
      channelId: args.draft.mode.channelId,
      threadRootEventId: args.draft.mode.threadRootEventId,
      text: note ? `${note}\n${link}` : link,
      clientMsgId: randomId(),
    });
    return 'reply';
  }

  await args.api.sendArtifactFeedback(args.draft.artifactId, {
    content,
    baseSeq: args.draft.seq,
    sessionId: args.draft.mode.sessionId,
    ...(note ? { note } : {}),
    opId: randomId(),
  });
  return 'steer';
}

export function markupErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return 'This document changed since you started. Reopen it to retry.';
  }
  return error instanceof Error ? error.message : 'Could not send markup';
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
