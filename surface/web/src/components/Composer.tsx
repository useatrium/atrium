import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api } from '../api';
import { looksLikeAgentCommand, parseAgentTask } from '../sessions/spawn';
import type { AttachmentMeta } from '@atrium/surface-client';
import { randomId } from '@atrium/surface-client';

interface PendingFile {
  key: string;
  file: File;
  status: 'uploading' | 'ready' | 'failed';
  fileId?: string;
  width?: number;
  height?: number;
}

export function Composer({
  placeholder,
  onSend,
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
  onSend: (text: string, attachments?: AttachmentMeta[]) => void;
  /** Fired while the user types non-empty text (throttle at the call site). */
  onTyping?: () => void;
  /** ArrowUp in an empty composer — Slack-style "edit my last message". */
  onArrowUpOnEmpty?: () => void;
  autoFocus?: boolean;
  /** Show the "@agent spawns a session" hint chip while the grammar matches. */
  agentAware?: boolean;
  /** Enable paste / drag-drop / 📎 file uploads. */
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

  const startUpload = async (file: File) => {
    const key = randomId();
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
    setFiles((prev) => [...prev, { key, file, status: 'uploading', width, height }]);
    try {
      const { fileId, uploadUrl } = await api.createUpload({
        filename: file.name || 'pasted-image.png',
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        width,
        height,
      });
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': file.type || 'application/octet-stream' },
      });
      if (!res.ok) throw new Error(`upload ${res.status}`);
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

  const removeFile = (key: string) => setFiles((prev) => prev.filter((p) => p.key !== key));

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
    <div className="border-t border-zinc-800 bg-zinc-950 p-3">
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
            ? 'border-zinc-800 bg-zinc-900/40'
            : dragOver
              ? 'border-indigo-500 bg-zinc-900'
              : 'border-zinc-700 bg-zinc-900 focus-within:border-zinc-500'
        }`}
      >
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {files.map((p) => (
              <span
                key={p.key}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                  p.status === 'failed'
                    ? 'border-red-800 text-red-300'
                    : 'border-zinc-700 text-zinc-300'
                }`}
              >
                <span aria-hidden>{p.file.type.startsWith('image/') ? '🖼️' : '📄'}</span>
                <span className="max-w-40 truncate">{p.file.name || 'pasted image'}</span>
                {p.status === 'uploading' && <span className="text-zinc-500">uploading…</span>}
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
                  className="text-zinc-500 hover:text-zinc-200"
                >
                  ✕
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
              className="rounded-md px-1 py-1 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              📎
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
          className="max-h-40 flex-1 resize-none bg-transparent text-sm leading-relaxed text-zinc-100 placeholder-zinc-500 outline-none disabled:cursor-not-allowed disabled:placeholder-zinc-600"
        />
        <button
          onClick={send}
          disabled={(!text.trim() && readyFiles.length === 0) || disabled || uploading}
          title={disabled ? disabledHint : uploading ? 'Waiting for uploads…' : undefined}
          className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-default disabled:bg-zinc-800 disabled:text-zinc-500"
        >
          Send
        </button>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2 px-1 text-[10px] text-zinc-500">
        {agentNeedsTask ? (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-300">
            Add a task: @agent &lt;task&gt;
          </span>
        ) : agentHint ? (
          <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 font-medium text-indigo-300">
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
