export type MarkupShellInbound =
  | { type: 'markup-init'; markdown: string; commentAuthor?: string }
  | { type: 'markup-request-serialize' };

export type MarkupShellOutbound =
  | { type: 'markup-shell-ready' }
  | { type: 'markup-dirty'; dirty: boolean }
  | { type: 'markup-serialized'; markdown: string };

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
    };
  }
  if (raw.type === 'markup-request-serialize') {
    return { type: 'markup-request-serialize' };
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
