import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type SVGProps } from 'react';
import type { ChatMessage } from '@atrium/surface-client';
import { encodeEventHandle } from '@atrium/surface-client/handle';

/** Mirrors the server's REACTION_EMOJI allowlist (server/src/events.ts). */
export const REACTION_EMOJI = [
  '👍',
  '👎',
  '✅',
  '❌',
  '👀',
  '🎉',
  '❤️',
  '😂',
  '😄',
  '😅',
  '😊',
  '😍',
  '🤔',
  '🤯',
  '😱',
  '😢',
  '😭',
  '😡',
  '🙏',
  '👏',
  '🙌',
  '💪',
  '🤝',
  '👋',
  '🫡',
  '🤷',
  '🤦',
  '💀',
  '🔥',
  '✨',
  '⭐',
  '💯',
  '🚀',
  '🐛',
  '🔧',
  '🛠️',
  '⚙️',
  '💡',
  '📌',
  '📎',
  '📝',
  '✏️',
  '🔍',
  '⏳',
  '⏰',
  '📅',
  '☕',
  '🍕',
  '🎯',
  '🏁',
  '🚧',
  '⚠️',
  '🚨',
  '❓',
  '❗',
  '➕',
  '💬',
  '🧵',
  '🤖',
  '🧠',
  '💸',
  '📈',
  '📉',
  '🎂',
];
import { SessionCard } from '../sessions/SessionCard';
import type { Session } from '../sessions/types';
import { formatBytes, formatGutterTime, formatTime } from '@atrium/surface-client';
import { Avatar } from './Avatar';
import { Tooltip } from './a11y';
import { CornerUpLeftIcon, FileIcon, SmilePlusIcon } from './icons';
import { Lightbox } from './media';
import type { PreviewFile } from './media';
import { CompactMarkdownText, MessageText } from './MessageText';
import { TimestampDisclosure } from './TimestampDisclosure';
import { useDialog } from '../useDialog';
import { VoiceMessage } from '../VoiceMessage';
import { entryShareUrl, fileShareUrl } from '../lib/publicUrl';

type MessageWithHandle = ChatMessage & { handle?: string | null };

export const MessageRow = memo(function MessageRow({
  message,
  grouped,
  inThread,
  session,
  spectators = 0,
  meId,
  meHandle,
  highlighted,
  editRequested,
  onEditRequestHandled,
  onOpenThread,
  onOpenSession,
  onRetry,
  onEdit,
  onDelete,
  onReact,
  onMarkupEntry,
}: {
  message: ChatMessage;
  grouped: boolean;
  inThread?: boolean;
  /** Session entity when this row is a session card (message.sessionId set). */
  session?: Session;
  spectators?: number;
  /** Current user id — enables Edit/Delete on own messages. */
  meId?: string;
  /** Current user handle — highlights @me mentions. */
  meHandle?: string;
  /** Briefly tinted after a search jump lands on this row. */
  highlighted?: boolean;
  /** External edit trigger (up-arrow in the composer targets this row). */
  editRequested?: boolean;
  onEditRequestHandled?: () => void;
  onOpenThread?: (rootEventId: number) => void;
  onOpenSession?: (sessionId: string) => void;
  onRetry?: (message: ChatMessage) => void;
  /** Resolves when the edit is accepted; the folded event updates the row. */
  onEdit?: (message: ChatMessage, text: string) => Promise<void>;
  onDelete?: (message: ChatMessage) => Promise<void>;
  /** Toggle an emoji reaction in the UI; caller sends explicit add/remove. */
  onReact?: (message: ChatMessage, emoji: string) => Promise<void>;
  onMarkupEntry?: (handle: string, message: ChatMessage) => void;
}) {
  const m = message;
  const dim = m.status === 'pending';
  const failed = m.status === 'failed';
  const deleted = m.deleted === true;
  const canThread = !inThread && m.id != null && onOpenThread && !deleted;
  const isSessionRow = m.sessionId != null && session != null;
  const isSessionEventRow = m.sessionEventType != null;
  const explicitHandle = (m as MessageWithHandle).handle ?? null;
  const entryHandle = explicitHandle ?? (m.status === 'confirmed' && m.id != null ? encodeEventHandle(m.id) : null);
  const canEdit =
    !isSessionRow &&
    !isSessionEventRow &&
    !deleted &&
    m.status === 'confirmed' &&
    m.id != null &&
    meId === m.author.id &&
    !m.voice &&
    !!onEdit;
  const canDelete =
    !isSessionRow &&
    !isSessionEventRow &&
    !deleted &&
    m.status === 'confirmed' &&
    m.id != null &&
    meId === m.author.id &&
    !!onDelete;
  const canReact =
    !isSessionRow && !isSessionEventRow && !deleted && m.status === 'confirmed' && m.id != null && !!onReact;
  const canAnnotate =
    !isSessionRow && !isSessionEventRow && !deleted && m.status === 'confirmed' && entryHandle != null;
  const canMarkupReply =
    !isSessionRow &&
    !isSessionEventRow &&
    !deleted &&
    !m.voice &&
    m.status === 'confirmed' &&
    entryHandle != null &&
    isStructuredTextForMarkup(m.text) &&
    !!onMarkupEntry;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerIndex, setPickerIndex] = useState(0);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const reactionButtonRef = useRef<HTMLButtonElement | null>(null);
  const emojiRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const mouseOpenedPickerRef = useRef(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [textCopied, setTextCopied] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [removedAttachmentIds, setRemovedAttachmentIds] = useState<Set<string>>(() => new Set());
  const linkCopyResetRef = useRef<number | null>(null);
  const textCopyResetRef = useRef<number | null>(null);
  const copyableMessageText = m.text.trim();
  const canCopyMessageText = !m.voice && copyableMessageText.length > 0;
  const react = (emoji: string) => {
    setPickerOpen(false);
    onReact?.(m, emoji).catch(() => {});
  };

  const closePicker = useCallback(() => setPickerOpen(false), []);
  useDialog({
    open: pickerOpen,
    containerRef: pickerRef,
    invokerRef: reactionButtonRef,
    closeOnOutsidePointer: true,
    onClose: closePicker,
  });
  useEffect(() => {
    if (!pickerOpen) return;
    emojiRefs.current[pickerIndex]?.focus();
  }, [pickerOpen, pickerIndex]);
  const movePicker = (next: number) => {
    const clamped = Math.max(0, Math.min(REACTION_EMOJI.length - 1, next));
    setPickerIndex(clamped);
    window.setTimeout(() => emojiRefs.current[clamped]?.focus());
  };
  const copyEntryLink = useCallback(() => {
    if (!entryHandle || typeof navigator === 'undefined') return;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    void clipboard
      .writeText(entryShareUrl(entryHandle))
      .then(() => {
        setLinkCopied(true);
        if (linkCopyResetRef.current) window.clearTimeout(linkCopyResetRef.current);
        linkCopyResetRef.current = window.setTimeout(() => setLinkCopied(false), 1400);
      })
      .catch(() => {});
  }, [entryHandle]);
  const copyBlockText = useCallback(() => {
    if (!copyableMessageText || typeof navigator === 'undefined') return;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    void clipboard
      .writeText(copyableMessageText)
      .then(() => {
        setTextCopied(true);
        if (textCopyResetRef.current) window.clearTimeout(textCopyResetRef.current);
        textCopyResetRef.current = window.setTimeout(() => setTextCopied(false), 1400);
      })
      .catch(() => {});
  }, [copyableMessageText]);
  useEffect(() => {
    return () => {
      if (linkCopyResetRef.current) window.clearTimeout(linkCopyResetRef.current);
      if (textCopyResetRef.current) window.clearTimeout(textCopyResetRef.current);
    };
  }, []);
  const attachments = m.attachments ?? [];
  const previewFiles: PreviewFile[] = attachments.map((a) => ({
    id: a.id,
    name: a.filename,
    mime: a.contentType,
    mediaKind: mediaKindForContentType(a.contentType),
    sizeBytes: a.size,
    width: a.width,
    height: a.height,
    contentUrl: `/api/files/${a.id}`,
    ...(m.id != null ? { source: { kind: 'message' as const, id: String(m.id) } } : {}),
  }));
  const openAttachment = (index: number) => {
    setLightboxIndex(index);
  };
  const closeLightbox = useCallback(() => setLightboxIndex(null), []);
  const downloadPreviewFile = useCallback((file: PreviewFile) => {
    window.open(`/api/files/${file.id}`, '_blank', 'noopener,noreferrer');
  }, []);
  const copyPreviewFileLink = useCallback((file: PreviewFile) => {
    if (typeof navigator === 'undefined') return;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    void clipboard.writeText(fileShareUrl(file.id)).catch(() => {});
  }, []);
  const markAttachmentRemoved = useCallback((id: string) => {
    setRemovedAttachmentIds((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  }, []);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [editFailed, setEditFailed] = useState(false);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  const startEdit = () => {
    setDraft(m.text);
    setEditFailed(false);
    setEditing(true);
  };
  const saveEdit = () => {
    const text = draft.trim();
    if (!text || saving) return;
    if (text === m.text) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setEditFailed(false);
    onEdit!(m, text)
      .then(() => setEditing(false))
      .catch(() => setEditFailed(true))
      .finally(() => setSaving(false));
  };
  const onEditKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // cancel the edit without also closing side panels
      setEditing(false);
    }
  };

  useEffect(() => {
    if (editing) editTextareaRef.current?.focus();
  }, [editing]);

  // Up-arrow in the composer targets this row for editing.
  useEffect(() => {
    if (!editRequested) return;
    if (canEdit && !editing) startEdit();
    onEditRequestHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequested]);

  // Delete is destructive — two-step inline confirm, auto-reverting.
  const [deleteAsk, setDeleteAsk] = useState(false);
  useEffect(() => {
    if (!deleteAsk) return;
    const t = setTimeout(() => setDeleteAsk(false), 5000);
    return () => clearTimeout(t);
  }, [deleteAsk]);
  const onDeleteClick = () => {
    if (!deleteAsk) {
      setDeleteAsk(true);
      return;
    }
    setDeleteAsk(false);
    onDelete!(m).catch(() => {});
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer hover cleanup only closes a mouse-opened reaction picker; keyboard focus is unaffected.
    <div
      data-eid={m.id ?? undefined}
      data-entry-handle={entryHandle ?? undefined}
      onMouseLeave={() => {
        if (mouseOpenedPickerRef.current) setPickerOpen(false);
      }}
      className={`group relative flex gap-3 px-4 hover:bg-surface-raised/60 ${
        grouped ? 'py-0.5' : 'mt-2 py-0.5'
      } ${dim ? 'opacity-50' : ''} ${highlighted ? 'entry-flash bg-accent-hover/10' : ''}`}
    >
      <div className="w-8 shrink-0">
        {!grouped && <Avatar name={m.author.displayName} seed={m.author.id} />}
        {grouped && (
          <TimestampDisclosure
            iso={m.createdAt}
            label={formatGutterTime(m.createdAt)}
            className="invisible whitespace-nowrap pt-0.5 text-3xs tabular-nums text-fg-muted group-hover:visible focus-visible:visible"
          >
            {formatGutterTime(m.createdAt)}
          </TimestampDisclosure>
        )}
      </div>
      <div className="relative min-w-0 max-w-3xl flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-fg">{m.author.displayName}</span>
            <TimestampDisclosure
              iso={m.createdAt}
              label={formatTime(m.createdAt)}
              className="text-2xs tabular-nums text-fg-muted"
            >
              {formatTime(m.createdAt)}
            </TimestampDisclosure>
          </div>
        )}
        {isSessionEventRow ? (
          <SessionEventCard message={m} onOpenSession={onOpenSession} />
        ) : isSessionRow ? (
          <SessionCard
            session={session}
            spectators={spectators}
            spawnFailed={failed}
            onOpenPane={(id) => onOpenSession?.(id)}
          />
        ) : editing ? (
          <div className="py-0.5">
            <textarea
              ref={editTextareaRef}
              value={draft}
              rows={Math.min(8, draft.split('\n').length)}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEditKeyDown}
              aria-label="Edit message text"
              className="w-full resize-none rounded-md border border-edge-strong bg-surface-raised px-2 py-1.5 text-sm leading-relaxed text-fg outline-none focus:border-accent-hover"
            />
            <div className="mt-0.5 text-3xs text-fg-muted">
              {editFailed && <span className="text-danger">Couldn't save — Enter to retry · </span>}
              Enter to save · Esc to cancel
            </div>
          </div>
        ) : deleted ? (
          <div className="text-sm italic leading-relaxed text-fg-muted">Message deleted</div>
        ) : m.voice ? (
          <VoiceMessage voice={m.voice} />
        ) : (
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg-body">
            <MessageText text={m.text} meHandle={meHandle} />
            {m.pendingEdit ? (
              <span className="ml-1 text-2xs text-warning-text">(saving edit)</span>
            ) : m.edited ? (
              <span className="ml-1 text-2xs text-fg-muted">(edited)</span>
            ) : null}
          </div>
        )}
        {!deleted && !m.voice && !isSessionRow && !isSessionEventRow && attachments.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">
            {attachments.map((a, index) =>
              removedAttachmentIds.has(a.id) ? (
                <RemovedAttachmentPlaceholder key={a.id} filename={a.filename} />
              ) : a.contentType.startsWith('image/') ? (
                <Tooltip key={a.id} content={a.filename}>
                  <button
                    type="button"
                    onClick={() => openAttachment(index)}
                    className="block text-left"
                  >
                    <img
                      src={`/api/files/${a.id}`}
                      alt={a.filename}
                      width={a.width}
                      height={a.height}
                      loading="lazy"
                      onError={() => markAttachmentRemoved(a.id)}
                      className="max-h-72 w-auto max-w-sm rounded-md border border-edge object-contain"
                      style={a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : undefined}
                    />
                  </button>
                </Tooltip>
              ) : (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => openAttachment(index)}
                  className="flex items-center gap-2 rounded-md border border-edge bg-surface-raised/70 px-3 py-2 text-sm text-fg-body hover:border-edge-strong"
                >
                  <FileIcon />
                  <span className="max-w-56 truncate">{a.filename}</span>
                  <span className="text-xs text-fg-muted">{formatBytes(a.size)}</span>
                </button>
              ),
            )}
          </div>
        )}
        {lightboxIndex != null && previewFiles.length > 0 && (
          <Lightbox
            files={previewFiles}
            index={Math.min(lightboxIndex, previewFiles.length - 1)}
            onIndexChange={setLightboxIndex}
            onClose={closeLightbox}
            onDownload={downloadPreviewFile}
            onCopyLink={copyPreviewFileLink}
          />
        )}
        {!deleted && !isSessionRow && !isSessionEventRow && (m.reactions?.length ?? 0) > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {m.reactions!.map((r) => {
              const mine = meId != null && r.userIds.includes(meId);
              return (
                <Tooltip
                  key={r.emoji}
                  content={`${r.userIds.length} reacted with ${r.emoji}${mine ? ', including you' : ''}`}
                >
                  <button
                    type="button"
                    onClick={() => canReact && react(r.emoji)}
                    aria-label={`${r.emoji} ${r.userIds.length}${mine ? ', including you' : ''}`}
                    className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs tabular-nums ${
                      mine
                        ? 'border-accent-border/70 bg-accent-hover/15 text-accent-text-strong'
                        : 'border-edge-strong bg-surface-raised text-fg-secondary hover:border-edge-hover'
                    }`}
                  >
                    <span>{r.emoji}</span>
                    <span>{r.userIds.length}</span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        )}
        {failed && (
          <button type="button" onClick={() => onRetry?.(m)} className="mt-0.5 text-xs font-medium text-danger hover:underline">
            {isSessionRow ? 'Failed to spawn — click to retry' : 'Failed to send — click to retry'}
          </button>
        )}
        {!inThread && m.replyCount > 0 && m.id != null && (
          <button
            type="button"
            onClick={() => onOpenThread?.(m.id!)}
            className="mt-0.5 text-xs font-medium text-accent-text hover:underline"
          >
            {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'} →
          </button>
        )}
        {pickerOpen && (
          <div
            ref={pickerRef}
            role="dialog"
            aria-label="Add reaction"
            onKeyDown={(e) => {
              const colCount = 8;
              if (e.key === 'ArrowRight') {
                e.preventDefault();
                movePicker(pickerIndex + 1);
              } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                movePicker(pickerIndex - 1);
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                movePicker(pickerIndex + colCount);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                movePicker(pickerIndex - colCount);
              } else if (e.key === 'Home') {
                e.preventDefault();
                movePicker(0);
              } else if (e.key === 'End') {
                e.preventDefault();
                movePicker(REACTION_EMOJI.length - 1);
              }
            }}
            className="absolute bottom-full right-0 z-10 mb-1 grid max-h-40 w-64 grid-cols-8 gap-0.5 overflow-y-auto rounded-md border border-edge-strong bg-surface-overlay p-1 shadow-lg"
          >
            {/* biome-ignore lint/a11y/useSemanticElements: emoji picker uses ARIA grid navigation over buttons; a table would misrepresent the control. */}
            <div role="grid" aria-label="Reaction choices" className="contents">
              {REACTION_EMOJI.map((e2, i) => (
                <button
                  type="button"
                  key={e2}
                  ref={(el) => {
                    emojiRefs.current[i] = el;
                  }}
                  tabIndex={i === pickerIndex ? 0 : -1}
                  onFocus={() => setPickerIndex(i)}
                  onClick={() => react(e2)}
                  aria-label={`React with ${e2}`}
                  className="rounded px-1 py-1 text-base leading-none hover:bg-edge-strong focus:bg-edge-strong"
                >
                  {e2}
                </button>
              ))}
            </div>
          </div>
        )}
        {(canThread || canEdit || canDelete || canReact || canAnnotate || canMarkupReply) && !editing && (
          <div className="pointer-events-none absolute -top-3 right-0 flex gap-1 opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
            {canReact && (
              <Tooltip content="Add reaction">
                <button
                  type="button"
                  ref={reactionButtonRef}
                  onPointerDown={() => {
                    mouseOpenedPickerRef.current = true;
                  }}
                  onKeyDown={() => {
                    mouseOpenedPickerRef.current = false;
                  }}
                  onClick={() => {
                    setPickerIndex(0);
                    setPickerOpen((v) => !v);
                  }}
                  aria-label="Add reaction"
                  aria-expanded={pickerOpen}
                  aria-haspopup="dialog"
                  className="rounded-md border border-edge-strong bg-surface-overlay px-2 py-1 text-xs text-fg-secondary shadow-sm hover:bg-edge-strong hover:text-fg"
                >
                  <SmilePlusIcon />
                </button>
              </Tooltip>
            )}
            {canAnnotate && (
              <Tooltip content={linkCopied ? 'Copied entry link' : 'Copy entry link'}>
                <button
                  type="button"
                  onClick={() => {
                    setPickerOpen(false);
                    copyEntryLink();
                  }}
                  aria-label={linkCopied ? 'Copied entry link' : 'Copy entry link'}
                  className={`inline-flex h-7 w-8 items-center justify-center rounded-md border border-edge-strong bg-surface-overlay text-xs shadow-sm transition-colors hover:bg-edge-strong hover:text-fg ${
                    linkCopied ? 'text-accent-text-strong' : 'text-fg-secondary'
                  }`}
                >
                  {linkCopied ? <CheckIcon /> : <LinkIcon />}
                </button>
              </Tooltip>
            )}
            {canAnnotate && canCopyMessageText && (
              <Tooltip content={textCopied ? 'Copied block text' : 'Copy block text'}>
                <button
                  type="button"
                  onClick={() => {
                    setPickerOpen(false);
                    copyBlockText();
                  }}
                  aria-label={textCopied ? 'Copied block text' : 'Copy block text'}
                  className={`inline-flex h-7 w-8 items-center justify-center rounded-md border border-edge-strong bg-surface-overlay text-xs shadow-sm transition-colors hover:bg-edge-strong hover:text-fg ${
                    textCopied ? 'text-accent-text-strong' : 'text-fg-secondary'
                  }`}
                >
                  {textCopied ? <CheckIcon /> : <CopyIcon />}
                </button>
              </Tooltip>
            )}
            {canMarkupReply && entryHandle && (
              <Tooltip content="Mark up & reply">
                <button
                  type="button"
                  onClick={() => {
                    setPickerOpen(false);
                    onMarkupEntry(entryHandle, m);
                  }}
                  data-testid="markup-reply"
                  aria-label="Mark up & reply"
                  className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-edge-strong bg-surface-overlay px-2 py-1 text-xs text-fg-secondary shadow-sm hover:bg-edge-strong hover:text-fg"
                >
                  <PenLineIcon /> Mark up
                </button>
              </Tooltip>
            )}
            {canEdit && (
              <Tooltip content="Edit message">
                <button
                  type="button"
                  onClick={startEdit}
                  aria-label="Edit message"
                  className="rounded-md border border-edge-strong bg-surface-overlay px-2 py-1 text-xs text-fg-secondary shadow-sm hover:bg-edge-strong hover:text-fg"
                >
                  Edit
                </button>
              </Tooltip>
            )}
            {canDelete && (
              <Tooltip content={deleteAsk ? 'Confirm delete message' : 'Delete message'}>
                <button
                  type="button"
                  onClick={onDeleteClick}
                  aria-label={deleteAsk ? 'Confirm delete message' : 'Delete message'}
                  className={`rounded-md border px-2 py-1 text-xs shadow-sm ${
                    deleteAsk
                      ? 'border-danger-border-strong bg-danger-tint/70 font-medium text-danger-text-strong hover:bg-danger-surface/70'
                      : 'border-edge-strong bg-surface-overlay text-fg-secondary hover:bg-edge-strong hover:text-danger-text'
                  }`}
                >
                  {deleteAsk ? 'Confirm delete' : 'Delete'}
                </button>
              </Tooltip>
            )}
            {canThread && (
              <Tooltip content="Reply in thread">
                <button
                  type="button"
                  onClick={() => onOpenThread!(m.id!)}
                  aria-label="Reply in thread"
                  className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-edge-strong bg-surface-overlay px-2 py-1 text-xs text-fg-secondary shadow-sm hover:bg-edge-strong hover:text-fg"
                >
                  <CornerUpLeftIcon /> Reply
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

const MARKDOWN_BLOCK_RE = /(^|\n)\s{0,3}(#{1,6}\s+\S|([-*+]|\d+[.)])\s+\S|>\s+\S|```)/;

export function isStructuredTextForMarkup(text: string): boolean {
  const nonEmptyLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return nonEmptyLines.length >= 2 || MARKDOWN_BLOCK_RE.test(text);
}

function mediaKindForContentType(contentType: string): PreviewFile['mediaKind'] {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType === 'application/pdf') return 'document';
  if (contentType.startsWith('text/')) return 'text';
  return 'opaque';
}

function RemovedAttachmentPlaceholder({ filename }: { filename: string }) {
  return (
    <div
      role="status"
      aria-label={`${filename} file removed`}
      className="flex min-h-12 items-center gap-2 rounded-md border border-dashed border-edge bg-surface-raised/35 px-3 py-2 text-sm text-fg-muted"
    >
      <FileIcon />
      <span className="max-w-56 truncate">File removed</span>
    </div>
  );
}

function CopyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect width="13" height="13" x="9" y="9" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function LinkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
      <path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" />
    </svg>
  );
}

function PenLineIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function SessionEventCard({
  message,
  onOpenSession,
}: {
  message: ChatMessage;
  onOpenSession?: (sessionId: string) => void;
}) {
  const payload = message.sessionEventPayload ?? {};
  const questions = questionPayloadPrompts(payload);
  const answers = questionPayloadAnswers(payload);
  const questionText = questions[0]?.question ?? 'Agent asked a question';
  const label = sessionQuestionEventLabel(message.sessionEventType, payload.reason);
  const openLabel =
    message.sessionEventType === 'question_requested'
      ? 'Open session pane for this question'
      : 'Open session pane for this question event';
  return (
    <div className="mt-1 rounded-md border border-edge bg-surface-raised/35 px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-fg-secondary">{label}</span>
        <TimestampDisclosure
          iso={message.createdAt}
          label={formatTime(message.createdAt)}
          className="tabular-nums text-2xs text-fg-muted"
        >
          {formatTime(message.createdAt)}
        </TimestampDisclosure>
      </div>
      {message.sessionEventType === 'question_requested' && (
        <div className="mt-1 whitespace-pre-wrap break-words text-fg-body">
          <CompactMarkdownText text={questionText} />
        </div>
      )}
      {answers.length > 0 && (
        <div className="mt-1 space-y-1">
          {answers.map((answer) => (
            <div key={answer.id} className="rounded border border-accent-border-muted/35 bg-accent-tint/10 px-2 py-1">
              <div className="text-3xs font-semibold uppercase tracking-wide text-accent-text-strong">
                {answer.header}
              </div>
              <div className="mt-0.5 whitespace-pre-wrap break-words text-fg-body">
                <CompactMarkdownText
                  text={
                    answer.answers.length > 0
                      ? answer.answers.join('\n')
                      : answer.count === 1
                        ? '1 answer recorded'
                        : `${answer.count} answers recorded`
                  }
                />
              </div>
            </div>
          ))}
        </div>
      )}
      {message.sessionId && (
        <button
          type="button"
          onClick={() => onOpenSession?.(message.sessionId!)}
          aria-label={openLabel}
          className="mt-1 font-medium text-fg-tertiary hover:text-fg-body hover:underline"
        >
          Open pane
        </button>
      )}
    </div>
  );
}

function questionPayloadPrompts(payload: Record<string, unknown>): Array<{ question: string }> {
  if (!Array.isArray(payload.questions)) return [];
  return payload.questions
    .map((item): { question: string } | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const raw = item as Record<string, unknown>;
      return typeof raw.question === 'string' && raw.question.trim() ? { question: raw.question } : null;
    })
    .filter((item): item is { question: string } => item !== null);
}

function questionPayloadAnswers(
  payload: Record<string, unknown>,
): Array<{ id: string; header: string; answers: string[]; count: number }> {
  if (!Array.isArray(payload.answers)) return [];
  return payload.answers
    .map((item): { id: string; header: string; answers: string[]; count: number } | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const raw = item as Record<string, unknown>;
      if (typeof raw.id !== 'string') return null;
      const answers = Array.isArray(raw.answers)
        ? raw.answers.filter((answer): answer is string => typeof answer === 'string')
        : [];
      return {
        id: raw.id,
        header: typeof raw.header === 'string' ? raw.header : raw.id,
        answers,
        count: typeof raw.count === 'number' && Number.isFinite(raw.count) ? raw.count : answers.length,
      };
    })
    .filter((item): item is { id: string; header: string; answers: string[]; count: number } => item !== null);
}

function sessionQuestionEventLabel(type: ChatMessage['sessionEventType'], reason: unknown): string {
  if (type === 'question_requested') return 'Question asked';
  if (type === 'question_answered') return 'Question answered';
  if (reason === 'empty') return 'Question expired without an answer';
  if (reason === 'cancelled') return 'Question cancelled';
  return 'Question resolved';
}
