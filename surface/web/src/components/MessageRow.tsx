import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SVGProps,
} from 'react';
import type { ChatMessage, UserRef } from '@atrium/surface-client';
import { encodeEventHandle } from '@atrium/surface-client/handle';
import { SessionCard } from '../sessions/SessionCard';
import type { Session } from '../sessions/types';
import { formatBytes, formatGutterTime, formatTime } from '@atrium/surface-client';
import { Avatar } from './Avatar';
import { Tooltip } from './a11y';
import { CornerUpLeftIcon, FileIcon, SmilePlusIcon } from './icons';
import { Lightbox } from './media';
import type { PreviewFile } from './media';
import { MessageActionMenu, type MessageActionMenuState } from './MessageActionMenu';
import { CompactMarkdownText, MessageText } from './MessageText';
import { ReactionPicker } from './ReactionPicker';
import { TimestampDisclosure } from './TimestampDisclosure';
import { useLongPress } from './useLongPress';
import { VoiceMessage } from '../VoiceMessage';
import { entryShareUrl, fileShareUrl } from '../lib/publicUrl';

export { REACTION_EMOJI } from '@atrium/surface-client/reactions';

type MessageWithHandle = ChatMessage & { handle?: string | null };
type ReactionDisplayUser = {
  id: string;
  name: string;
};

type SwipeState = {
  pointerId: number;
  startX: number;
  startY: number;
  offset: number;
  dragging: boolean;
  cancelled: boolean;
};

const SWIPE_REPLY_THRESHOLD_PX = 64;
const SWIPE_REPLY_MAX_OFFSET_PX = 96;

function reactionUserName(user: UserRef | undefined): string {
  const displayName = user?.displayName.trim();
  if (displayName) return displayName;
  const handle = user?.handle.trim();
  if (handle) return handle;
  return 'Unknown';
}

function ReactionUsersPopover({
  id,
  emoji,
  users,
}: {
  id: string;
  emoji: string;
  users: ReactionDisplayUser[];
}) {
  return (
    <div
      id={id}
      role="tooltip"
      aria-label={`${users.length} ${users.length === 1 ? 'person' : 'people'} reacted with ${emoji}`}
      className="absolute bottom-full left-0 z-20 mb-1 w-56 rounded-md border border-edge-strong bg-surface-overlay p-1 shadow-lg"
    >
      <ul className="max-h-48 overflow-y-auto">
        {users.map((user) => (
          <li key={user.id} className="flex min-w-0 items-center gap-2 rounded px-2 py-1 text-xs text-fg-secondary">
            <Avatar name={user.name} seed={user.id} size={20} />
            <span className="truncate">{user.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  resolveUser,
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
  resolveUser?: (id: string) => UserRef | undefined;
  onMarkupEntry?: (handle: string, message: ChatMessage) => void;
}) {
  const m = message;
  const dim = m.status === 'pending';
  const failed = m.status === 'failed';
  const deleted = m.deleted === true;
  const isBroadcastReplyInMain = !inThread && m.threadRootEventId != null;
  const threadTargetEventId = isBroadcastReplyInMain ? m.threadRootEventId : m.id;
  const canThread = !inThread && threadTargetEventId != null && onOpenThread && !deleted;
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
  const [openReactionEmoji, setOpenReactionEmoji] = useState<string | null>(null);
  const reactionPopoverBaseId = useId();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const reactionButtonRef = useRef<HTMLButtonElement | null>(null);
  const mouseOpenedPickerRef = useRef(false);
  const [actionMenu, setActionMenu] = useState<MessageActionMenuState | null>(null);
  const swipeRef = useRef<SwipeState | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
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

  const actionMenuAllowed = (canThread || canEdit || canDelete || canReact || canAnnotate || canMarkupReply) && !editing;
  const closeActionMenu = useCallback(() => setActionMenu(null), []);
  const openSheetMenu = useCallback(() => {
    if (!actionMenuAllowed) return;
    setPickerOpen(false);
    setActionMenu({ mode: 'sheet' });
  }, [actionMenuAllowed]);
  const onRowContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;
      if (!actionMenuAllowed) return;
      if (isTouchContextMenu(event.nativeEvent)) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      setPickerOpen(false);
      setActionMenu({ mode: 'popover', anchor: { x: event.clientX, y: event.clientY } });
    },
    [actionMenuAllowed],
  );
  const longPress = useLongPress({
    disabled: !actionMenuAllowed,
    onLongPress: openSheetMenu,
  });
  const resetSwipe = useCallback(() => {
    swipeRef.current = null;
    setSwiping(false);
    setSwipeOffset(0);
  }, []);
  const onSwipePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!canThread || event.pointerType !== 'touch' || isInteractiveTarget(event.target)) return;
      swipeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offset: 0,
        dragging: false,
        cancelled: false,
      };
      setSwiping(false);
      setSwipeOffset(0);
    },
    [canThread],
  );
  const onSwipePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const swipe = swipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId || swipe.cancelled) return;
    const dx = event.clientX - swipe.startX;
    const dy = event.clientY - swipe.startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (!swipe.dragging) {
      if (absDy > 10 && absDy > absDx) {
        swipe.cancelled = true;
        setSwipeOffset(0);
        return;
      }
      if (dx < -8) {
        swipe.cancelled = true;
        return;
      }
      if (dx < 8 || dx < absDy * 1.2) return;
      swipe.dragging = true;
      setSwiping(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    event.preventDefault();
    const nextOffset = Math.min(SWIPE_REPLY_MAX_OFFSET_PX, Math.max(0, dx));
    swipe.offset = nextOffset;
    setSwipeOffset(nextOffset);
  }, []);
  const finishSwipe = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, openThread: boolean) => {
      const swipe = swipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;
      const shouldReply = openThread && swipe.dragging && swipe.offset >= SWIPE_REPLY_THRESHOLD_PX && !!canThread;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      resetSwipe();
      if (shouldReply) onOpenThread!(threadTargetEventId!);
    },
    [canThread, onOpenThread, resetSwipe, threadTargetEventId],
  );
  const onMessagePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      longPress.onPointerDown(event);
      onSwipePointerDown(event);
    },
    [longPress.onPointerDown, onSwipePointerDown],
  );
  const onMessagePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      longPress.onPointerMove(event);
      onSwipePointerMove(event);
    },
    [longPress.onPointerMove, onSwipePointerMove],
  );
  const onMessagePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      longPress.onPointerUp();
      finishSwipe(event, true);
    },
    [finishSwipe, longPress.onPointerUp],
  );
  const onMessagePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      longPress.onPointerCancel();
      finishSwipe(event, false);
    },
    [finishSwipe, longPress.onPointerCancel],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer/context handlers expose existing message actions without changing keyboard access.
    <div
      ref={rowRef}
      data-eid={m.id ?? undefined}
      data-entry-handle={entryHandle ?? undefined}
      tabIndex={-1}
      onContextMenu={onRowContextMenu}
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
      {canThread && (swiping || swipeOffset > 0) && (
        <div
          aria-hidden="true"
          style={{
            opacity: Math.min(1, swipeOffset / SWIPE_REPLY_THRESHOLD_PX),
            transform: `translateY(-50%) scale(${0.85 + Math.min(0.25, swipeOffset / 256)})`,
          }}
          className="pointer-events-none absolute left-14 top-1/2 flex h-7 w-7 items-center justify-center rounded-full border border-accent-border/60 bg-accent-hover/15 text-accent-text"
        >
          <CornerUpLeftIcon size={15} />
        </div>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: touch handlers expose the same message actions on phones; keyboard users keep the toolbar path. */}
      <div
        onPointerDown={onMessagePointerDown}
        onPointerMove={onMessagePointerMove}
        onPointerUp={onMessagePointerUp}
        onPointerCancel={onMessagePointerCancel}
        onLostPointerCapture={onMessagePointerCancel}
        onContextMenu={longPress.onContextMenu}
        style={{
          // pan-y keeps vertical scroll native while pointermove still sees the
          // horizontal swipe-to-reply drag; pinch-zoom stays available (the
          // viewport meta allows scaling and messages cover most of the screen).
          touchAction: 'pan-y pinch-zoom',
          ...(swipeOffset > 0 ? { transform: `translateX(${swipeOffset}px)` } : {}),
        }}
        className={`relative min-w-0 max-w-3xl flex-1 ${swiping ? 'transition-none' : 'transition-transform duration-150 ease-out'}`}
      >
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
        {isBroadcastReplyInMain && (
          <button
            type="button"
            onClick={() => onOpenThread?.(m.threadRootEventId!)}
            className="mb-0.5 text-xs text-fg-muted hover:underline"
          >
            ↳ replied to a thread
          </button>
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
                    className="block max-w-full min-w-0 text-left"
                  >
                    <img
                      src={`/api/files/${a.id}`}
                      alt={a.filename}
                      width={a.width}
                      height={a.height}
                      loading="lazy"
                      onError={() => markAttachmentRemoved(a.id)}
                      className="max-h-72 w-auto max-w-[min(24rem,100%)] rounded-md border border-edge object-contain"
                      style={a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : undefined}
                    />
                  </button>
                </Tooltip>
              ) : (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => openAttachment(index)}
                  className="flex max-w-full min-w-0 items-center gap-2 rounded-md border border-edge bg-surface-raised/70 px-3 py-2 text-sm text-fg-body hover:border-edge-strong"
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
            {m.reactions!.map((r, reactionIndex) => {
              const mine = meId != null && r.userIds.includes(meId);
              const users = resolveUser
                ? r.userIds.map((id) => ({
                    id,
                    name: reactionUserName(resolveUser(id)),
                  }))
                : null;
              const hasUserPopover = users != null && users.length > 0;
              const popoverOpen = hasUserPopover && openReactionEmoji === r.emoji;
              const popoverId = `${reactionPopoverBaseId}-reaction-${reactionIndex}`;
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: hover reveals the reactor popover; keyboard users reach it via the inner button's onFocus/onBlur/Escape handlers.
                <div
                  key={r.emoji}
                  onMouseEnter={() => {
                    if (hasUserPopover) setOpenReactionEmoji(r.emoji);
                  }}
                  onMouseLeave={() => {
                    if (openReactionEmoji === r.emoji) setOpenReactionEmoji(null);
                  }}
                  className="relative inline-flex"
                >
                  <button
                    type="button"
                    onClick={() => canReact && react(r.emoji)}
                    onFocus={() => {
                      if (hasUserPopover) setOpenReactionEmoji(r.emoji);
                    }}
                    onBlur={() => {
                      if (openReactionEmoji === r.emoji) setOpenReactionEmoji(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Escape' || !popoverOpen) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setOpenReactionEmoji(null);
                    }}
                    title={resolveUser ? undefined : `${r.userIds.length} reacted with ${r.emoji}`}
                    aria-label={`${r.emoji} ${r.userIds.length}${mine ? ', including you' : ''}`}
                    aria-describedby={popoverOpen ? popoverId : undefined}
                    className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs tabular-nums ${
                      mine
                        ? 'border-accent-border/70 bg-accent-hover/15 text-accent-text-strong'
                        : 'border-edge-strong bg-surface-raised text-fg-secondary hover:border-edge-hover'
                    }`}
                  >
                    <span>{r.emoji}</span>
                    <span>{r.userIds.length}</span>
                  </button>
                  {popoverOpen && users && <ReactionUsersPopover id={popoverId} emoji={r.emoji} users={users} />}
                </div>
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
        <ReactionPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={react}
          invokerRef={reactionButtonRef}
          className="absolute bottom-full right-0 z-10 mb-1 w-72"
        />
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
                  onClick={() => onOpenThread!(threadTargetEventId!)}
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
      <MessageActionMenu
        state={actionMenu}
        onClose={closeActionMenu}
        restoreFocusRef={rowRef}
        canThread={!!canThread}
        canEdit={canEdit}
        canDelete={canDelete}
        canReact={canReact}
        canAnnotate={canAnnotate}
        canCopyMessageText={canCopyMessageText}
        canMarkupReply={canMarkupReply && entryHandle != null}
        deleteConfirming={deleteAsk}
        onReact={react}
        onReplyThread={() => onOpenThread!(threadTargetEventId!)}
        onMarkupReply={() => {
          if (entryHandle) onMarkupEntry?.(entryHandle, m);
        }}
        onCopyLink={() => {
          setPickerOpen(false);
          copyEntryLink();
        }}
        onCopyText={() => {
          setPickerOpen(false);
          copyBlockText();
        }}
        onEdit={startEdit}
        onDelete={onDeleteClick}
      />
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

function isTouchContextMenu(event: MouseEvent): boolean {
  return 'pointerType' in event && event.pointerType === 'touch';
}

function isInteractiveTarget(target: EventTarget): boolean {
  return target instanceof Element && target.closest('button,a,input,textarea,select,[role="button"],[contenteditable="true"]') != null;
}

function RemovedAttachmentPlaceholder({ filename }: { filename: string }) {
  return (
    <div
      role="status"
      aria-label={`${filename} file removed`}
      className="flex min-h-12 max-w-full min-w-0 items-center gap-2 rounded-md border border-dashed border-edge bg-surface-raised/35 px-3 py-2 text-sm text-fg-muted"
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
