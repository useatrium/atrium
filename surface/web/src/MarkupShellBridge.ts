import type { HubFileVersion } from '@atrium/surface-client';

/** Version-history operations the webview relays to native (which owns the auth token). */
export type MarkupVersionOp = 'list' | 'content' | 'revert' | 'restore';

export type MarkupShellInbound =
  // native -> webview: seed the editor. `sourceText` is the live source-message text (null
  // when there is no source message, e.g. an artifact file) so the shell can detect divergence.
  | { type: 'markup-init'; markdown: string; commentAuthor?: string; sourceText?: string | null }
  | { type: 'markup-request-serialize' }
  // native -> webview: result of a markup-vh-request, correlated by reqId.
  | {
      type: 'markup-vh-response';
      reqId: string;
      ok: boolean;
      versions?: HubFileVersion[];
      content?: string;
      seq?: number;
      error?: string;
    };

export type MarkupShellOutbound =
  | { type: 'markup-shell-ready' }
  | { type: 'markup-dirty'; dirty: boolean }
  | { type: 'markup-serialized'; markdown: string }
  // webview -> native: run a version-history op with the native auth token; reply by reqId.
  | { type: 'markup-vh-request'; reqId: string; op: MarkupVersionOp; seq?: number };

export interface ReactNativeWebViewBridge {
  postMessage(message: string): void;
}

export function parseMarkupShellMessage(data: unknown): MarkupShellInbound | null {
  const value = typeof data === 'string' ? parseJson(data) : data;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.type === 'markup-init' && typeof raw.markdown === 'string') {
    return {
      type: 'markup-init',
      markdown: raw.markdown,
      ...(typeof raw.commentAuthor === 'string' ? { commentAuthor: raw.commentAuthor } : {}),
      ...(typeof raw.sourceText === 'string' || raw.sourceText === null ? { sourceText: raw.sourceText } : {}),
    };
  }
  if (raw.type === 'markup-request-serialize') {
    return { type: 'markup-request-serialize' };
  }
  if (raw.type === 'markup-vh-response' && typeof raw.reqId === 'string' && typeof raw.ok === 'boolean') {
    return {
      type: 'markup-vh-response',
      reqId: raw.reqId,
      ok: raw.ok,
      ...(Array.isArray(raw.versions) ? { versions: raw.versions as HubFileVersion[] } : {}),
      ...(typeof raw.content === 'string' ? { content: raw.content } : {}),
      ...(typeof raw.seq === 'number' ? { seq: raw.seq } : {}),
      ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    };
  }
  return null;
}

export function postMarkupShellMessage(
  bridge: ReactNativeWebViewBridge | undefined,
  message: MarkupShellOutbound,
): void {
  bridge?.postMessage(JSON.stringify(message));
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
