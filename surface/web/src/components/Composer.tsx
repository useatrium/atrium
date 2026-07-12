import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { looksLikeAgentCommand, parseAgentTask } from '../sessions/spawn';
import type { AttachmentMeta, AttachmentRef, UploadPayload, VoiceMeta } from '@atrium/surface-client';
import { createDraftChangeDebouncer, formatBytes, randomId } from '@atrium/surface-client';
import { FileIcon, PaperclipIcon, XIcon } from './icons';
import { Tooltip } from './a11y';
import { VoiceRecorder, type RecordedVoice } from '../VoiceRecorder';
import { SHORTCUTS } from '../lib/shortcuts';
import { extractEntryHandles } from '../lib/entryLinks';
import { EntryInlineChip } from './EntryQuoteCard';
import { MentionSuggestions } from './MentionSuggestions';
import { type MentionContext, useMentionTypeahead } from './useMentionTypeahead';

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

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

export interface ComposerHandle {
  captureForConfigure: () => string;
  restoreDraft: (text: string) => void;
}

type ComposerProps = {
  placeholder: string;
  onSend: (
    text: string,
    attachments?: AttachmentMeta[],
    attachmentRefs?: AttachmentRef[],
    voice?: Pick<VoiceMeta, 'fileId' | 'durationMs' | 'waveform'>,
  ) => void;
  queueUpload?: (payload: UploadPayload) => Promise<{ fileId: string }>;
  /** Fired while the user types non-empty text (throttle at the call site). */
  onTyping?: () => void;
  /** ArrowUp in an empty composer — Slack-style "edit my last message". */
  onArrowUpOnEmpty?: () => void;
  autoFocus?: boolean;
  /** Show the "@agent spawns a session" hint chip while the grammar matches. */
  agentAware?: boolean;
  /** Open the configured spawn dialog from the current @agent draft. */
  onConfigureAgent?: (fullText: string) => void;
  /** Enable paste / drag-drop / file uploads. */
  allowAttachments?: boolean;
  /** Enable the voice recorder. Defaults to the attachment setting. */
  allowVoice?: boolean;
  disabled?: boolean;
  disabledHint?: string;
  /** Replaces the default hint line (e.g. seat request controls in the pane). */
  footer?: ReactNode;
  draftKey?: string;
  initialDraft?: string;
  onDraftChange?: (key: string, text: string) => void | Promise<void>;
  onDraftPersisted?: (key: string, text: string) => void | Promise<void>;
  onDraftTouched?: (key: string) => void;
  previewEntryLinks?: boolean;
  /** Enables channel mention suggestions. Omit for agent-session composers. */
  mentionContext?: MentionContext;
};

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    placeholder,
    onSend,
    queueUpload,
    onTyping,
    onArrowUpOnEmpty,
    autoFocus,
    agentAware,
    onConfigureAgent,
    allowAttachments,
    allowVoice = allowAttachments,
    disabled,
    disabledHint,
    footer,
    draftKey,
    initialDraft,
    onDraftChange,
    onDraftPersisted,
    onDraftTouched,
    previewEntryLinks,
    mentionContext,
  },
  imperativeRef,
) {
  const [text, setText] = useState('');
  // "@agent" with no task: refuse to post the literal string — show what's
  // missing instead (cleared as soon as the text changes).
  const [agentNeedsTask, setAgentNeedsTask] = useState(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<PendingFile[]>([]);
  const draftWriter = useMemo(
    () =>
      createDraftChangeDebouncer(
        (key, value) => onDraftChange?.(key, value),
        400,
        (key, value) => onDraftPersisted?.(key, value),
      ),
    [onDraftChange, onDraftPersisted],
  );
  const agentHint = !!agentAware && !disabled && looksLikeAgentCommand(text);
  const agentTask = agentHint ? parseAgentTask(text) : null;
  const configureAgentHint = !!onConfigureAgent && agentHint && agentTask != null;
  const agentNeedsTaskHint = agentNeedsTask || (!!onConfigureAgent && agentHint && agentTask == null);
  const entryLinkHandles = useMemo(
    () => (previewEntryLinks ? extractEntryHandles(text) : []),
    [previewEntryLinks, text],
  );
  const uploading = files.some((f) => f.status === 'uploading');
  const readyFiles = files.filter((f): f is PendingFile & { fileId: string } => f.status === 'ready' && !!f.fileId);
  const sendDisabled = (!text.trim() && readyFiles.length === 0) || !!disabled || uploading;
  const sendTooltip = disabled
    ? (disabledHint ?? 'Message composer unavailable')
    : uploading
      ? 'Waiting for uploads…'
      : !text.trim() && readyFiles.length === 0
        ? 'Enter a message or attach a file'
        : 'Send message';
  const mentions = useMentionTypeahead({ value: text, setValue: setText, textareaRef: ref, context: mentionContext });

  useEffect(() => () => draftWriter.cancel(), [draftWriter]);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(
    () => () => {
      for (const file of filesRef.current) URL.revokeObjectURL(file.localUri);
    },
    [],
  );

  useEffect(() => {
    if (!attachmentNotice) return;
    const timer = window.setTimeout(() => setAttachmentNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [attachmentNotice]);

  useEffect(() => {
    setText('');
    mentions.clear();
    setFiles((prev) => {
      for (const file of prev) URL.revokeObjectURL(file.localUri);
      return [];
    });
    if (ref.current) ref.current.style.height = 'auto';
  }, [draftKey, mentions.clear]);

  useEffect(() => {
    if (!initialDraft) return;
    setText((prev) => (prev === '' ? initialDraft : prev));
  }, [initialDraft]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const persistDraftValue = useCallback(
    (value: string) => {
      if (!draftKey) return;
      onDraftTouched?.(draftKey);
      draftWriter.saveNow(draftKey, value);
    },
    [draftKey, draftWriter, onDraftTouched],
  );

  useImperativeHandle(
    imperativeRef,
    () => ({
      captureForConfigure() {
        const captured = text;
        setText('');
        mentions.clear();
        setAgentNeedsTask(false);
        persistDraftValue('');
        if (ref.current) ref.current.style.height = 'auto';
        return captured;
      },
      restoreDraft(value: string) {
        setText(value);
        mentions.clear();
        setAgentNeedsTask(false);
        persistDraftValue(value);
        requestAnimationFrame(() => {
          const el = ref.current;
          if (!el) return;
          el.style.height = 'auto';
          if (value) el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          el.focus();
          el.setSelectionRange(value.length, value.length);
        });
      },
    }),
    [imperativeRef, mentions.clear, persistDraftValue, text],
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
    setFiles((prev) => [...prev, { key, uploadKey, file, status: 'uploading', localUri, width, height }]);
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
      setFiles((prev) => prev.map((p) => (p.key === key ? { ...p, fileId, status: 'ready' } : p)));
    } catch {
      setFiles((prev) => prev.map((p) => (p.key === key ? { ...p, status: 'failed' } : p)));
    }
  };

  const addFiles = (list: FileList | File[]) => {
    if (!allowAttachments || disabled) return;
    for (const f of Array.from(list).slice(0, Math.max(0, MAX_ATTACHMENTS - files.length))) {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        setAttachmentNotice(`${f.name || 'File'} is larger than 100 MB`);
        continue;
      }
      void startUpload(f);
    }
  };

  const removeFile = (key: string) =>
    setFiles((prev) => {
      const file = prev.find((p) => p.key === key);
      if (file) URL.revokeObjectURL(file.localUri);
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
      mentions.serialize(text).trim(),
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
    if (draftKey) {
      onDraftTouched?.(draftKey);
      draftWriter.saveNow(draftKey, '');
    }
    setText('');
    mentions.clear();
    setFiles((prev) => {
      for (const file of prev) URL.revokeObjectURL(file.localUri);
      return [];
    });
    if (ref.current) ref.current.style.height = 'auto';
  };

  const sendVoice = async (recorded: RecordedVoice) => {
    if (disabled || !queueUpload) throw new Error('upload queue unavailable');
    const uploadKey = randomId();
    const localUri = URL.createObjectURL(recorded.blob);
    // Strip codec params (e.g. "audio/webm;codecs=opus") — /api/uploads only
    // accepts bare type/subtype and otherwise stores octet-stream.
    const contentType = recorded.blob.type.split(';')[0] || 'audio/webm';
    try {
      const { fileId } = await queueUpload({
        uploadKey,
        localUri,
        filename: recorded.filename,
        contentType,
        size: recorded.blob.size,
      });
      onSend(
        '',
        [
          {
            id: fileId,
            filename: recorded.filename,
            contentType,
            size: recorded.blob.size,
          },
        ],
        [{ uploadKey }],
        { fileId, durationMs: recorded.durationMs, waveform: recorded.waveform },
      );
    } finally {
      URL.revokeObjectURL(localUri);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.onKeyDown(e)) return;
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
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone handles drag/drop events; keyboard file attachment uses the adjacent Attach button. */}
      <div
        title={disabled ? disabledHint : undefined}
        onDragOver={(e) => {
          if (!allowAttachments || disabled) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`relative rounded-lg border px-3 py-2 ${
          disabled
            ? 'border-edge bg-surface-raised/40'
            : dragOver
              ? 'border-accent-hover bg-surface-raised'
              : 'border-edge-strong bg-surface-raised focus-within:border-edge-focus'
        }`}
      >
        {mentions.open && (
          <MentionSuggestions
            activeIndex={mentions.activeIndex}
            candidates={mentions.candidates}
            listboxId={mentions.listboxId}
            optionId={mentions.optionId}
            onActiveIndexChange={mentions.setActiveIndex}
            onInsert={mentions.insert}
          />
        )}
        {mentions.nonMembers.length > 0 && (
          <div className="mb-1.5 flex flex-col gap-1 rounded border border-warning-border/50 bg-warning-tint/20 px-2 py-1.5 text-xs text-warning-text">
            {mentions.nonMembers.map((user) => (
              <span key={user.id} className="flex items-center gap-2">
                <span className="min-w-0 truncate">@{user.handle} isn’t in this channel and won’t be notified</span>
                <button
                  type="button"
                  className="shrink-0 rounded border border-warning-border/60 px-1.5 py-0.5 font-medium hover:bg-warning-tint/40"
                  onClick={() => void mentions.invite(user.id).catch(() => {})}
                >
                  Invite
                </button>
              </span>
            ))}
          </div>
        )}
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
                {p.file.type.startsWith('image/') ? (
                  <img src={p.localUri} alt="" className="h-7 w-7 rounded object-cover" draggable={false} />
                ) : (
                  <span aria-hidden>
                    <FileIcon />
                  </span>
                )}
                <span className="max-w-40 truncate">{p.file.name || 'pasted image'}</span>
                <span className="text-fg-muted">{formatBytes(p.file.size)}</span>
                {p.status === 'uploading' && <span className="text-fg-muted">uploading…</span>}
                {p.status === 'failed' && (
                  <button
                    type="button"
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
                  type="button"
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
        {attachmentNotice && <div className="mb-2 px-1 text-xs font-medium text-danger-text">{attachmentNotice}</div>}
        <div className="flex items-end gap-2">
          {allowAttachments && !disabled && (
            <>
              <Tooltip content="Attach a file">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach a file"
                  className="rounded-md px-1 py-1 text-sm text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
                >
                  <PaperclipIcon />
                </button>
              </Tooltip>
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
          {allowAttachments && allowVoice && !disabled && (
            <VoiceRecorder
              disabled={disabled || uploading || files.length > 0 || text.trim().length > 0}
              onSend={sendVoice}
              onActiveChange={setVoiceActive}
            />
          )}
          {!voiceActive && (
            <>
              <textarea
                ref={ref}
                rows={1}
                value={text}
                disabled={disabled}
                placeholder={disabled ? (disabledHint ?? placeholder) : placeholder}
                aria-label="Message input"
                aria-expanded={mentions.open}
                aria-controls={mentions.open ? mentions.listboxId : undefined}
                aria-activedescendant={mentions.open ? mentions.optionId(mentions.activeIndex) : undefined}
                role="combobox"
                aria-autocomplete="list"
                onChange={(e) => {
                  mentions.onValueChange(e.target.value, e.target.selectionStart ?? e.target.value.length);
                  if (draftKey) {
                    onDraftTouched?.(draftKey);
                    draftWriter.schedule(draftKey, e.target.value);
                  }
                  setAgentNeedsTask(false);
                  if (e.target.value.trim()) onTyping?.();
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                }}
                onKeyDown={onKeyDown}
                onSelect={(e) => mentions.trackSelection(e.currentTarget)}
                onKeyUp={(e) => mentions.trackSelection(e.currentTarget)}
                onPaste={(e) => {
                  if (!allowAttachments || disabled) return;
                  if (e.clipboardData?.files?.length) {
                    e.preventDefault();
                    addFiles(e.clipboardData.files);
                  }
                }}
                className="max-h-40 flex-1 resize-none bg-transparent text-sm leading-relaxed text-fg placeholder-fg-muted outline-none disabled:cursor-not-allowed disabled:placeholder-fg-faint"
              />
              <Tooltip content={sendTooltip} shortcut={SHORTCUTS.sendMessage.keys}>
                <button
                  type="button"
                  onClick={(e) => {
                    if (sendDisabled) {
                      e.preventDefault();
                      return;
                    }
                    send();
                  }}
                  aria-disabled={sendDisabled || undefined}
                  className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover aria-disabled:cursor-default aria-disabled:bg-surface-overlay aria-disabled:text-fg-muted"
                >
                  Send
                </button>
              </Tooltip>
            </>
          )}
        </div>
      </div>
      {entryLinkHandles.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 px-1 text-3xs text-fg-muted">
          <span className="font-medium">referencing:</span>
          {entryLinkHandles.map((handle) => (
            <EntryInlineChip key={handle} handle={handle} />
          ))}
        </div>
      )}
      <div className="mt-1 flex items-center gap-2 px-1 text-3xs text-fg-muted">
        {agentNeedsTaskHint ? (
          <span className="rounded-full bg-warning/15 px-2 py-0.5 font-medium text-warning-text">
            Add a task: @agent &lt;task&gt;
          </span>
        ) : configureAgentHint ? (
          <Tooltip content="Configure and start an agent">
            <button
              type="button"
              onClick={() => onConfigureAgent(text)}
              aria-label="Configure and start an agent"
              className="rounded-full bg-accent-hover/15 px-2 py-0.5 font-medium text-accent-text-strong transition-colors hover:bg-accent-hover/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span aria-hidden>✦</span> Start an agent · Configure ▸
            </button>
          </Tooltip>
        ) : agentHint ? (
          <span className="rounded-full bg-accent-hover/15 px-2 py-0.5 font-medium text-accent-text-strong">
            @agent — spawns an agent
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
});
