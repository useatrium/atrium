import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import type { MarkupEditorHandle } from './markupPaneTypes';

// Static specifier so Vite bundles the editor as a lazy chunk.
const MarkupEditor = lazy(async () => {
  const mod = await import('../markup/MarkupEditor');
  return { default: mod.MarkupEditor };
});

export interface MarkupPaneSource {
  artifactId: string;
  path: string;
  seq: number;
  workspaceId?: string;
  sessionId: string;
  frontmatter: string;
  body: string;
}

export type MarkupPaneMode =
  | { kind: 'steer'; sessionId: string }
  | { kind: 'reply'; channelId: string; threadRootEventId: number };

export function splitMarkdownFrontmatter(content: string): { frontmatter: string; body: string } {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: '', body: content };
  }
  const newline = content.startsWith('---\r\n') ? '\r\n' : '\n';
  const closeMarker = `${newline}---${newline}`;
  const closeIndex = content.indexOf(closeMarker, 3);
  if (closeIndex === -1) return { frontmatter: '', body: content };
  const frontmatterEnd = closeIndex + closeMarker.length;
  const frontmatter = content.slice(0, frontmatterEnd);
  const body =
    content.slice(frontmatterEnd, frontmatterEnd + newline.length) === newline
      ? content.slice(frontmatterEnd + newline.length)
      : content.slice(frontmatterEnd);
  return { frontmatter, body };
}

function titleFromFrontmatter(frontmatter: string): string | null {
  const match = frontmatter.match(/(?:^|\r?\n)title:\s*(.+?)(?:\r?\n|$)/);
  if (!match) return null;
  return match[1]!.trim().replace(/^['"]|['"]$/g, '') || null;
}

function composeFeedbackContent(frontmatter: string, body: string): string {
  return frontmatter ? `${frontmatter}\n${body}` : body;
}

async function writeArtifactContent(artifactId: string, content: string, baseSeq: number): Promise<void> {
  const response = await fetch(`/api/files/${encodeURIComponent(artifactId)}/content`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      'X-Artifact-Base-Seq': String(baseSeq),
      'Content-Type': 'text/markdown; charset=utf-8',
    },
    body: content,
  });
  if (response.ok) return;
  if (response.status === 409) throw new ApiError(409, 'stale_base', 'stale');
  let message = response.statusText || 'Could not save markup';
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    message = body.message ?? body.error ?? message;
  } catch {
    /* non-JSON error body */
  }
  throw new Error(message);
}

function randomOpId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `markup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function MarkupPane({
  source,
  mode,
  onClose,
  onSent,
  onSendThreadReply,
}: {
  source: MarkupPaneSource;
  mode?: MarkupPaneMode;
  onClose: () => void;
  onSent?: () => void;
  onSendThreadReply?: (input: { channelId: string; threadRootEventId: number; text: string }) => void;
}) {
  const editorRef = useRef<MarkupEditorHandle | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = useMemo(
    () => titleFromFrontmatter(source.frontmatter) ?? source.path,
    [source.frontmatter, source.path],
  );
  const effectiveMode = mode ?? { kind: 'steer' as const, sessionId: source.sessionId };
  const isReplyMode = effectiveMode.kind === 'reply';
  const noteFilled = note.trim().length > 0;
  const canSend = (dirty || noteFilled) && !sending;

  const hasUnsavedWork = useCallback(() => {
    return dirty || note.trim().length > 0 || editorRef.current?.hasMarkup() === true;
  }, [dirty, note]);

  const requestClose = useCallback(() => {
    if (hasUnsavedWork() && !window.confirm('Discard your markup?')) return;
    onClose();
  }, [hasUnsavedWork, onClose]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') requestClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [requestClose]);

  const send = async () => {
    if (!canSend || !editorRef.current) return;
    setSending(true);
    setError(null);
    try {
      const content = composeFeedbackContent(source.frontmatter, editorRef.current.serialize());
      if (effectiveMode.kind === 'reply') {
        await writeArtifactContent(source.artifactId, content, source.seq);
        if (!onSendThreadReply) throw new Error('Reply target is not available');
        const link = `/e/art_${source.artifactId}`;
        const trimmedNote = note.trim();
        onSendThreadReply({
          channelId: effectiveMode.channelId,
          threadRootEventId: effectiveMode.threadRootEventId,
          text: trimmedNote ? `${trimmedNote}\n${link}` : link,
        });
      } else {
        await api.sendArtifactFeedback(source.artifactId, {
          content,
          baseSeq: source.seq,
          sessionId: effectiveMode.sessionId,
          note: note.trim() || undefined,
          opId: randomOpId(),
        });
      }
      onSent?.();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('This document changed since you started — reopen to retry.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not send markup');
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex bg-black/55 p-4 text-fg"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="markup-pane-title"
        className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-md border border-edge-strong bg-surface shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-edge bg-surface-raised px-3">
          <div className="min-w-0 flex-1">
            <h2 id="markup-pane-title" className="truncate text-sm font-semibold text-fg">
              {title}
            </h2>
            <div className="truncate text-2xs text-fg-muted">
              {isReplyMode ? 'Mark up and reply in thread' : 'Mark up and send to agent'}
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={requestClose}
            className="rounded-md border border-edge-strong px-2.5 py-1 text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSend}
            onClick={() => void send()}
            className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-default disabled:bg-surface-overlay disabled:text-fg-muted"
          >
            {sending ? 'Sending...' : isReplyMode ? 'Reply in thread' : 'Send to agent'}
          </button>
        </header>
        {error && (
          <div role="alert" className="border-b border-danger-border bg-danger-tint px-3 py-2 text-xs text-danger-text">
            {error}
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <Suspense fallback={<div className="flex flex-1 items-center justify-center text-xs text-fg-muted">Loading editor...</div>}>
            <MarkupEditor
              ref={editorRef}
              initialMarkdown={source.body}
              onDirtyChange={setDirty}
              className="min-h-0 flex-1"
            />
          </Suspense>
          <input
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={isReplyMode ? 'Say something about your changes…' : 'Add a note...'}
            aria-label={isReplyMode ? 'Say something about your changes' : 'Add a note'}
            className="h-9 shrink-0 rounded-md border border-edge-strong bg-surface-raised px-3 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-accent-hover"
          />
        </div>
      </section>
    </div>
  );
}
