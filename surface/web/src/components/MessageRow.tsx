import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SVGProps,
} from 'react';
import {
  isStructuredTextForMarkup,
  randomId,
  questionAnswerSummaryText,
  questionPayloadAnswers,
  questionPayloadPrompts,
  sessionDriverId,
  sessionQuestionEventLabel,
  type ChatMessage,
  type UserRef,
  decodeWireToDisplay,
  mentionsUser,
} from '@atrium/surface-client';
import { encodeEventHandle } from '@atrium/surface-client/handle';
import { SessionCard } from '../sessions/SessionCard';
import type { Session } from '../sessions/types';
import { formatBytes, formatGutterTime, formatTime } from '@atrium/surface-client';
import { Avatar } from './Avatar';
import { Tooltip } from './a11y';
import { CornerUpLeftIcon, FileIcon, SmilePlusIcon } from './icons';
import { Lightbox } from './media';
import type { PreviewFile } from './media';
import { MessageActionMenu, type MessageActionMenuAction, type MessageActionMenuState } from './MessageActionMenu';
import { SelectTextSheet } from './SelectTextSheet';
import { CompactMarkdownText, MessageText } from './MessageText';
import { ReactionPicker } from './ReactionPicker';
import { TimestampDisclosure } from './TimestampDisclosure';
import { TimelineImage } from './TimelineImage';
import { useLongPress } from './useLongPress';
import { VoiceMessage } from '../VoiceMessage';
import { entryShareUrl, fileShareUrl } from '../lib/publicUrl';
import { sessionsApi } from '../sessions/api';
import { useUserDirectory } from '../userDirectory';
import { MentionSuggestions } from './MentionSuggestions';
import { type MentionContext, useMentionTypeahead } from './useMentionTypeahead';

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

function ReactionUsersPopover({ id, emoji, users }: { id: string; emoji: string; users: ReactionDisplayUser[] }) {
  return (
    <div
      id={id}
      role="tooltip"
      aria-label={`${users.length} ${users.length === 1 ? 'person' : 'people'} reacted with ${emoji}`}
      className="absolute bottom-full left-0 z-tooltip mb-1 w-56 rounded-md border border-edge-strong bg-surface-overlay p-1 shadow-lg"
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
  mentionContext,
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
  onDelegateToAgent,
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
  mentionContext?: MentionContext;
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
  /** Opens the composer in agent mode anchored to this message. */
  onDelegateToAgent?: (message: ChatMessage) => void;
}) {
  const m = message;
  const selfMentioned =
    (meId != null || meHandle != null) && mentionsUser(m.text, { id: meId ?? null, handle: meHandle ?? null });
  const dim = m.status === 'pending';
  const failed = m.status === 'failed';
  const deleted = m.deleted === true;
  const isBroadcastReplyInMain = !inThread && m.threadRootEventId != null;
  const threadTargetEventId = isBroadcastReplyInMain ? m.threadRootEventId : m.id;
  const canThread = !inThread && threadTargetEventId != null && onOpenThread && !deleted;
  const isAgentReply = m.sessionEventType === 'replied';
  // Utterances the SESSION itself makes (turn recaps, questions) wear the
  // session's persona — title, session-seeded avatar, AGENT chip — never a
  // human's name and never "Unknown". Humans keep their own rows.
  const isAgentVoice = isAgentReply || m.sessionEventType === 'question_requested';
  const isSessionRow = m.sessionId != null && session != null && !isAgentReply;
  const isSessionEventRow = m.sessionEventType != null && !isAgentReply;
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
  const authorName = isAgentVoice ? (session?.title ?? m.author.displayName) : m.author.displayName;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [openReactionEmoji, setOpenReactionEmoji] = useState<string | null>(null);
  const reactionPopoverBaseId = useId();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const reactionButtonRef = useRef<HTMLButtonElement | null>(null);
  const mouseOpenedPickerRef = useRef(false);
  const [actionMenu, setActionMenu] = useState<MessageActionMenuState | null>(null);
  const [selectTextOpen, setSelectTextOpen] = useState(false);
  const closeSelectText = useCallback(() => setSelectTextOpen(false), []);
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
  const directory = useUserDirectory(m.text);
  const editMentions = useMentionTypeahead({
    value: draft,
    setValue: setDraft,
    textareaRef: editTextareaRef,
    context: mentionContext,
  });

  const startEdit = () => {
    const decoded = decodeWireToDisplay(m.text, (id) => directory.resolve(id)?.handle ?? null);
    setDraft(decoded.text);
    editMentions.initialize(decoded.ranges, decoded.text.length);
    setEditFailed(false);
    setEditing(true);
  };
  const saveEdit = () => {
    const text = editMentions.serialize(draft).trim();
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
    if (editMentions.onKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // cancel the edit without also closing side panels
      editMentions.clear();
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
  const actionMenuActions = useMemo<MessageActionMenuAction[]>(() => {
    const actions: MessageActionMenuAction[] = [];
    if (canThread) {
      actions.push({
        key: 'reply-thread',
        label: 'Reply in thread',
        onSelect: () => onOpenThread!(threadTargetEventId!),
      });
    }
    if (onDelegateToAgent && m.id != null && m.sessionId == null && m.sessionEventType == null) {
      actions.push({
        key: 'delegate-agent',
        label: 'Delegate to agent…',
        onSelect: () => {
          setPickerOpen(false);
          onDelegateToAgent(m);
        },
      });
    }
    if (canMarkupReply && entryHandle != null) {
      actions.push({
        key: 'markup-reply',
        label: 'Mark up & reply',
        onSelect: () => onMarkupEntry?.(entryHandle, m),
      });
    }
    if (canAnnotate) {
      actions.push({
        key: 'copy-link',
        label: 'Copy link',
        onSelect: () => {
          setPickerOpen(false);
          copyEntryLink();
        },
      });
    }
    if (canAnnotate && canCopyMessageText) {
      actions.push({
        key: 'copy-text',
        label: 'Copy text',
        onSelect: () => {
          setPickerOpen(false);
          copyBlockText();
        },
      });
      actions.push({
        key: 'select-text',
        label: 'Select text…',
        sheetOnly: true,
        onSelect: () => {
          setPickerOpen(false);
          setSelectTextOpen(true);
        },
      });
    }
    if (canEdit) {
      actions.push({
        key: 'edit',
        label: 'Edit',
        onSelect: startEdit,
      });
    }
    if (canDelete) {
      actions.push({
        key: 'delete',
        label: deleteAsk ? 'Confirm delete' : 'Delete',
        onSelect: onDeleteClick,
        variant: 'danger',
        closeOnSelect: deleteAsk,
      });
    }
    return actions;
  }, [
    onDelegateToAgent,
    canAnnotate,
    canCopyMessageText,
    canDelete,
    canEdit,
    canMarkupReply,
    canThread,
    copyBlockText,
    copyEntryLink,
    deleteAsk,
    entryHandle,
    m,
    onDeleteClick,
    onMarkupEntry,
    onOpenThread,
    startEdit,
    threadTargetEventId,
  ]);

  const actionMenuAllowed =
    (canThread || canEdit || canDelete || canReact || canAnnotate || canMarkupReply) && !editing;
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
      // No setPointerCapture here: touch pointers are already implicitly
      // captured to their pointerdown target, and transferring the capture to
      // this container fires a bubbling lostpointercapture that our own
      // onLostPointerCapture handler treats as a cancel — killing the swipe.
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
      className={`group relative flex gap-3 px-4 ${
        selfMentioned
          ? 'border-l-2 border-warning-border bg-warning-tint/20 hover:bg-warning-tint/35'
          : 'hover:bg-surface-raised/60'
      } ${
        grouped ? 'py-0.5' : 'mt-2 py-0.5'
      } ${dim ? 'opacity-50' : ''} ${highlighted ? 'entry-flash bg-accent-hover/10' : ''}`}
    >
      <div className="w-8 shrink-0">
        {(!grouped || isAgentVoice) && (
          <Avatar name={authorName} seed={isAgentVoice ? (m.sessionId ?? m.author.id) : m.author.id} />
        )}
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
        {(!grouped || isAgentVoice) && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-fg">{authorName}</span>
            {isAgentVoice && (
              <span className="rounded-full bg-accent-hover/15 px-1.5 py-px text-3xs font-semibold text-accent-text-strong">
                AGENT
              </span>
            )}
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
          <SessionEventCard message={m} session={session} onOpenSession={onOpenSession} />
        ) : isSessionRow ? (
          <SessionCard
            session={session}
            spectators={spectators}
            spawnFailed={failed}
            meId={meId}
            onOpen={
              // Primary click lands on the conversation: the card's thread
              // (turns, questions, steers). The pane is "Under the hood".
              !inThread && onOpenThread && m.id != null ? () => onOpenThread(m.id!) : undefined
            }
            onOpenPane={(id) => onOpenSession?.(id)}
          />
        ) : editing ? (
          <div className="relative py-0.5">
            {editMentions.open && (
              <MentionSuggestions
                activeIndex={editMentions.activeIndex}
                candidates={editMentions.candidates}
                listboxId={editMentions.listboxId}
                optionId={editMentions.optionId}
                onActiveIndexChange={editMentions.setActiveIndex}
                onInsert={editMentions.insert}
              />
            )}
            <textarea
              ref={editTextareaRef}
              value={draft}
              rows={Math.min(8, draft.split('\n').length)}
              disabled={saving}
              onChange={(e) =>
                editMentions.onValueChange(e.target.value, e.target.selectionStart ?? e.target.value.length)
              }
              onKeyDown={onEditKeyDown}
              onSelect={(e) => editMentions.trackSelection(e.currentTarget)}
              onKeyUp={(e) => editMentions.trackSelection(e.currentTarget)}
              aria-label="Edit message text"
              aria-expanded={editMentions.open}
              aria-controls={editMentions.open ? editMentions.listboxId : undefined}
              aria-activedescendant={editMentions.open ? editMentions.optionId(editMentions.activeIndex) : undefined}
              role="combobox"
              aria-autocomplete="list"
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
            <MessageText text={m.text} meId={meId} meHandle={meHandle} />
            {m.pendingEdit ? (
              <span className="ml-1 text-2xs text-warning-text">(saving edit)</span>
            ) : m.edited ? (
              <span className="ml-1 text-2xs text-fg-muted">(edited)</span>
            ) : null}
          </div>
        )}
        {!deleted && !isSessionRow && !isSessionEventRow && !isAgentReply && (
          <MessageProvenance message={m} session={session} meId={meId} />
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
                    <TimelineImage
                      src={`/api/files/${a.id}`}
                      alt={a.filename}
                      width={a.width}
                      height={a.height}
                      loading="lazy"
                      onError={() => markAttachmentRemoved(a.id)}
                      className="max-h-72 rounded-md border border-edge object-contain"
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
          <button
            type="button"
            onClick={() => onRetry?.(m)}
            className="mt-0.5 text-xs font-medium text-danger hover:underline"
          >
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
          className="absolute bottom-full right-0 z-dropdown mb-1 w-72"
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
        actions={actionMenuActions}
        reactions={canReact ? { onSelect: react } : undefined}
      />
      <SelectTextSheet open={selectTextOpen} onClose={closeSelectText} restoreFocusRef={rowRef}>
        <MessageText text={m.text} meId={meId} meHandle={meHandle} />
      </SelectTextSheet>
    </div>
  );
});

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
  return (
    target instanceof Element &&
    target.closest('button,a,input,textarea,select,[role="button"],[contenteditable="true"]') != null
  );
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
  session,
  onOpenSession,
}: {
  message: ChatMessage;
  session?: Session;
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
      {/* While the question is live, the ANSWER form lives once per screen —
          on the session card at the thread root. This row marks when it was
          asked and points up instead of rendering a second live form. */}
      {message.sessionEventType === 'question_requested' &&
        session?.pendingQuestion &&
        payload.questionId === session.pendingQuestion.questionId && (
          <div data-testid="question-pointer-row" className="mt-1 text-2xs font-medium text-warning-text-strong">
            answer on the session card ↑
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
                <CompactMarkdownText text={questionAnswerSummaryText(answer)} />
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

function MessageProvenance({ message, session, meId }: { message: ChatMessage; session?: Session; meId?: string }) {
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggested = message.suggestedSessionId && message.suggestionId;
  // Canonical seat resolution — feed-folded entities can carry null driverId.
  const isDriver = session != null && meId != null && sessionDriverId(session) === meId;
  if (!message.steeredSessionId && !suggested) return null;
  const resolve = (action: 'send' | 'dismiss') => {
    if (!suggested || busy) return;
    setBusy(true);
    setError(null);
    sessionsApi
      .resolveSuggestion(message.suggestedSessionId!, message.suggestionId!, action, {}, randomId())
      .then(() => setDismissed(true))
      .catch(() => setError(action === 'send' ? "Couldn't send to agent." : "Couldn't dismiss suggestion."))
      .finally(() => setBusy(false));
  };
  return (
    <div data-testid="message-provenance" className="mt-1 flex flex-wrap items-center gap-1.5 text-3xs">
      {message.steeredSessionId && (
        <span className="rounded-full border border-edge bg-surface-raised px-1.5 py-0.5 font-medium text-fg-tertiary">
          → agent
        </span>
      )}
      {suggested && !dismissed && (
        <>
          <span className="rounded-full border border-accent-border-muted/50 bg-accent-tint/10 px-1.5 py-0.5 font-medium text-accent-text-strong">
            suggestion
          </span>
          {isDriver && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => resolve('send')}
                className="rounded px-1.5 py-0.5 font-medium text-accent-text-strong hover:bg-accent-tint/35 disabled:opacity-50"
              >
                Send to agent
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => resolve('dismiss')}
                className="rounded px-1.5 py-0.5 font-medium text-fg-tertiary hover:bg-surface-overlay disabled:opacity-50"
              >
                Dismiss
              </button>
            </>
          )}
        </>
      )}
      {dismissed && <span className="text-fg-muted">{busy ? 'Updating…' : 'Suggestion handled.'}</span>}
      {error && (
        <span role="alert" className="text-danger-text">
          {error}
        </span>
      )}
    </div>
  );
}
