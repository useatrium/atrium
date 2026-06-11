import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { looksLikeAgentCommand, parseAgentTask } from '../sessions/spawn';
import type { AttachmentMeta, AttachmentRef, UploadPayload } from '@atrium/surface-client';
import { randomId } from '@atrium/surface-client';
import { FileIcon, PaperclipIcon, XIcon } from './icons';

interface PendingFile {
  key: string;
  uploadKey: string;
  file: File;
  status: 'uploading' | 'ready' | 'failed';
  fileId?: string;
  localUri: string;
  width?: number;
  height?: number;
}

export function Composer({
  placeholder,
  onSend,
  queueUpload,
  onTyping,
  onArrowUpOnEmpty,
  autoFocus,
  agentAware,
  allowAttachments,
  disabled,
  disabledHint,
  footer,
}: {
  placeholder: string;
  onSend: (text: string, attachments?: AttachmentMeta[], attachmentRefs?: AttachmentRef[]) => void;
  queueUpload?: (payload: UploadPayload) => Promise<{ fileId: string }>;
  /** Fired while the user types non-empty text (throttle at the call site). */
  onTyping?: () => void;
  /** ArrowUp in an empty composer — Slack-style "edit my last message". */
  onArrowUpOnEmpty?: () => void;
  autoFocus?: boolean;
  /** Show the "@agent spawns a session" hint chip while the grammar matches. */
  agentAware?: boolean;
  /** Enable paste / drag-drop / file uploads. */
  allowAttachments?: boolean;
  disabled?: boolean;
  disabledHint?: string;
  /** Replaces the default hint line (e.g. seat request controls in the pane). */
  footer?: ReactNode;
}) {
  const [text, setText] = useState('');
  // "@agent" with no task: refuse to post the literal string — show what's
  // missing instead (cleared as soon as the text changes).
  const [agentNeedsTask, setAgentNeedsTask] = useState(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const agentHint = !!agentAware && !disabled && looksLikeAgentCommand(text);
  const uploading = files.some((f) => f.status === 'uploading');
  const readyFiles = files.filter(
    (f): f is PendingFile & { fileId: string } => f.status === 'ready' && !!f.fileId,
  );

  const contentHashFor = async (file: File): Promise<string | undefined> => {
    try {
      if (!globalThis.crypto?.subtle) return undefined;
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return undefined;
    }
  };

  const startUpload = async (file: File) => {
    const key = randomId();
    const uploadKey = randomId();
    const localUri = URL.createObjectURL(file);
    let width: number | undefined;
    let height: number | undefined;
    if (file.type.startsWith('image/')) {
      try {
        const bmp = await createImageBitmap(file);
        width = bmp.width;
        height = bmp.height;
        bmp.close();
      } catch {
        // not decodable as an image — upload without dimensions
      }
    }
    setFiles((prev) => [
      ...prev,
      { key, uploadKey, file, status: 'uploading', localUri, width, height },
    ]);
    try {
      if (!queueUpload) throw new Error('upload queue unavailable');
      const contentHash = await contentHashFor(file);
      const { fileId } = await queueUpload({
        uploadKey,
        localUri,
        filename: file.name || 'pasted-image.png',
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        width,
        height,
        contentHash,
      });
      URL.revokeObjectURL(localUri);
      setFiles((prev) =>
        prev.map((p) => (p.key === key ? { ...p, fileId, status: 'ready' } : p)),
      );
    } catch {
      setFiles((prev) => prev.map((p) => (p.key === key ? { ...p, status: 'failed' } : p)));
    }
  };

  const addFiles = (list: FileList | File[]) => {
    if (!allowAttachments || disabled) return;
    for (const f of Array.from(list).slice(0, Math.max(0, 10 - files.length))) {
      void startUpload(f);
    }
  };

  const removeFile = (key: string) =>
    setFiles((prev) => {
      const file = prev.find((p) => p.key === key);
      if (file && file.status !== 'uploading') URL.revokeObjectURL(file.localUri);
      return prev.filter((p) => p.key !== key);
    });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  };

  const send = () => {
    const trimmed = text.trim();
    if (disabled || uploading) return;
    if (!trimmed && readyFiles.length === 0) return;
    if (agentAware && trimmed && looksLikeAgentCommand(trimmed) && parseAgentTask(trimmed) == null) {
      setAgentNeedsTask(true);
      return;
    }
    onSend(
      trimmed,
      readyFiles.length > 0
        ? readyFiles.map((f) => ({
            id: f.fileId,
            filename: f.file.name || 'pasted-image.png',
            contentType: f.file.type || 'application/octet-stream',
            size: f.file.size,
            ...(f.width ? { width: f.width } : {}),
            ...(f.height ? { height: f.height } : {}),
          }))
        : undefined,
      readyFiles.length > 0 ? readyFiles.map((f) => ({ uploadKey: f.uploadKey })) : undefined,
    );
    setText('');
    setFiles([]);
    if (ref.current) ref.current.style.height = 'auto';
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowUp' && text === '' && onArrowUpOnEmpty) {
      e.preventDefault();
      onArrowUpOnEmpty();
    }
  };

  return (
    <div className="border-t border-edge bg-surface p-3">
      <div
        title={disabled ? disabledHint : undefined}
        onDragOver={(e) => {
          if (!allowAttachments || disabled) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`rounded-lg border px-3 py-2 ${
          disabled
            ? 'border-edge bg-surface-raised/40'
            : dragOver
              ? 'border-accent-hover bg-surface-raised'
              : 'border-edge-strong bg-surface-raised focus-within:border-edge-focus'
        }`}
      >
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {files.map((p) => (
              <span
                key={p.key}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                  p.status === 'failed'
                    ? 'border-danger-border text-danger-text'
                    : 'border-edge-strong text-fg-secondary'
                }`}
              >
                <span aria-hidden>{p.file.type.startsWith('image/') ? '🖼️' : <FileIcon />}</span>
                <span className="max-w-40 truncate">{p.file.name || 'pasted image'}</span>
                {p.status === 'uploading' && <span className="text-fg-muted">uploading…</span>}
                {p.status === 'failed' && (
                  <button
                    onClick={() => {
                      removeFile(p.key);
                      void startUpload(p.file);
                    }}
                    className="font-medium hover:underline"
                  >
                    retry
                  </button>
                )}
                <button
                  onClick={() => removeFile(p.key)}
                  aria-label={`Remove ${p.file.name || 'pasted image'}`}
                  className="text-fg-muted hover:text-fg-body"
                >
                  <XIcon />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
        {allowAttachments && !disabled && (
          <>
            <button
              onClick={() => fileInputRef.current?.click()}
              title="Attach a file"
              aria-label="Attach a file"
              className="rounded-md px-1 py-1 text-sm text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
            >
              <PaperclipIcon />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={disabled ? (disabledHint ?? placeholder) : placeholder}
          aria-label="Message input"
          onChange={(e) => {
            setText(e.target.value);
            setAgentNeedsTask(false);
            if (e.target.value.trim()) onTyping?.();
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (!allowAttachments || disabled) return;
            if (e.clipboardData?.files?.length) {
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }
          }}
          className="max-h-40 flex-1 resize-none bg-transparent text-sm leading-relaxed text-fg placeholder-fg-muted outline-none disabled:cursor-not-allowed disabled:placeholder-fg-faint"
        />
        <button
          onClick={send}
          disabled={(!text.trim() && readyFiles.length === 0) || disabled || uploading}
          title={disabled ? disabledHint : uploading ? 'Waiting for uploads…' : undefined}
          className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-default disabled:bg-surface-overlay disabled:text-fg-muted"
        >
          Send
        </button>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2 px-1 text-3xs text-fg-muted">
        {agentNeedsTask ? (
          <span className="rounded-full bg-warning/15 px-2 py-0.5 font-medium text-warning-text">
            Add a task: @agent &lt;task&gt;
          </span>
        ) : agentHint ? (
          <span className="rounded-full bg-accent-hover/15 px-2 py-0.5 font-medium text-accent-text-strong">
            @agent — spawns an agent session
          </span>
        ) : footer !== undefined ? (
          footer
        ) : (
          <span>
            {disabled
              ? (disabledHint ?? '')
              : agentAware
                ? 'Enter to send · Shift+Enter for a new line · @agent <task> spawns an agent'
                : 'Enter to send · Shift+Enter for a new line'}
          </span>
        )}
      </div>
    </div>
  );
}
