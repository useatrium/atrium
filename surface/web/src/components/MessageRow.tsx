import { useEffect, useState, type KeyboardEvent } from 'react';
import type { ChatMessage } from '@atrium/surface-client';

/** Mirrors the server's REACTION_EMOJI allowlist (server/src/events.ts). */
export const REACTION_EMOJI = [
  '👍', '👎', '✅', '❌', '👀', '🎉', '❤️', '😂',
  '😄', '😅', '😊', '😍', '🤔', '🤯', '😱', '😢',
  '😭', '😡', '🙏', '👏', '🙌', '💪', '🤝', '👋',
  '🫡', '🤷', '🤦', '💀', '🔥', '✨', '⭐', '💯',
  '🚀', '🐛', '🔧', '🛠️', '⚙️', '💡', '📌', '📎',
  '📝', '✏️', '🔍', '⏳', '⏰', '📅', '☕', '🍕',
  '🎯', '🏁', '🚧', '⚠️', '🚨', '❓', '❗', '➕',
  '💬', '🧵', '🤖', '🧠', '💸', '📈', '📉', '🎂',
];
import { SessionCard } from '../sessions/SessionCard';
import type { Session } from '../sessions/types';
import { formatBytes, formatGutterTime, formatTime } from '@atrium/surface-client';
import { Avatar } from './Avatar';
import { MessageText } from './MessageText';

export function MessageRow({
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
  /** Toggle an emoji reaction (server decides add vs remove). */
  onReact?: (message: ChatMessage, emoji: string) => Promise<void>;
}) {
  const m = message;
  const dim = m.status === 'pending';
  const failed = m.status === 'failed';
  const deleted = m.deleted === true;
  const canThread = !inThread && m.id != null && onOpenThread && !deleted;
  const isSessionRow = m.sessionId != null && session != null;
  const canEdit =
    !isSessionRow &&
    !deleted &&
    m.status === 'confirmed' &&
    m.id != null &&
    meId === m.author.id &&
    !!onEdit;
  const canDelete =
    !isSessionRow &&
    !deleted &&
    m.status === 'confirmed' &&
    m.id != null &&
    meId === m.author.id &&
    !!onDelete;
  const canReact = !isSessionRow && !deleted && m.status === 'confirmed' && m.id != null && !!onReact;
  const [pickerOpen, setPickerOpen] = useState(false);
  const react = (emoji: string) => {
    setPickerOpen(false);
    onReact?.(m, emoji).catch(() => {});
  };

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [editFailed, setEditFailed] = useState(false);

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
    <div
      data-eid={m.id ?? undefined}
      onMouseLeave={() => setPickerOpen(false)}
      className={`group relative flex gap-3 px-4 hover:bg-zinc-900/60 ${
        grouped ? 'py-0.5' : 'mt-2 py-0.5'
      } ${dim ? 'opacity-50' : ''} ${highlighted ? 'bg-indigo-500/10' : ''}`}
    >
      <div className="w-8 shrink-0">
        {!grouped && <Avatar name={m.author.displayName} seed={m.author.id} />}
        {grouped && (
          <span
            className="invisible whitespace-nowrap pt-0.5 text-[10px] tabular-nums text-zinc-500 group-hover:visible"
            title={new Date(m.createdAt).toLocaleString()}
          >
            {formatGutterTime(m.createdAt)}
          </span>
        )}
      </div>
      <div className="relative min-w-0 max-w-3xl flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-zinc-100">{m.author.displayName}</span>
            <span
              className="text-[11px] tabular-nums text-zinc-500"
              title={new Date(m.createdAt).toLocaleString()}
            >
              {formatTime(m.createdAt)}
            </span>
          </div>
        )}
        {isSessionRow ? (
          <SessionCard
            session={session}
            spectators={spectators}
            spawnFailed={failed}
            onOpenPane={(id) => onOpenSession?.(id)}
          />
        ) : editing ? (
          <div className="py-0.5">
            <textarea
              autoFocus
              value={draft}
              rows={Math.min(8, draft.split('\n').length)}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEditKeyDown}
              aria-label="Edit message text"
              className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm leading-relaxed text-zinc-100 outline-none focus:border-indigo-500"
            />
            <div className="mt-0.5 text-[10px] text-zinc-500">
              {editFailed && <span className="text-red-400">Couldn't save — Enter to retry · </span>}
              Enter to save · Esc to cancel
            </div>
          </div>
        ) : deleted ? (
          <div className="text-sm italic leading-relaxed text-zinc-600">Message deleted</div>
        ) : (
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-200">
            <MessageText text={m.text} meHandle={meHandle} />
            {m.edited && <span className="ml-1 text-[11px] text-zinc-500">(edited)</span>}
          </div>
        )}
        {!deleted && !isSessionRow && (m.attachments?.length ?? 0) > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">
            {m.attachments!.map((a) =>
              a.contentType.startsWith('image/') ? (
                <a
                  key={a.id}
                  href={`/api/files/${a.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={a.filename}
                  className="block"
                >
                  <img
                    src={`/api/files/${a.id}`}
                    alt={a.filename}
                    width={a.width}
                    height={a.height}
                    loading="lazy"
                    className="max-h-72 w-auto max-w-sm rounded-md border border-zinc-800 object-contain"
                    style={
                      a.width && a.height
                        ? { aspectRatio: `${a.width} / ${a.height}` }
                        : undefined
                    }
                  />
                </a>
              ) : (
                <a
                  key={a.id}
                  href={`/api/files/${a.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-700"
                >
                  <span aria-hidden>📄</span>
                  <span className="max-w-56 truncate">{a.filename}</span>
                  <span className="text-xs text-zinc-500">{formatBytes(a.size)}</span>
                </a>
              ),
            )}
          </div>
        )}
        {!deleted && !isSessionRow && (m.reactions?.length ?? 0) > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {m.reactions!.map((r) => {
              const mine = meId != null && r.userIds.includes(meId);
              return (
                <button
                  key={r.emoji}
                  onClick={() => canReact && react(r.emoji)}
                  title={`${r.userIds.length} reacted with ${r.emoji}`}
                  aria-label={`${r.emoji} ${r.userIds.length}${mine ? ', including you' : ''}`}
                  className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs tabular-nums ${
                    mine
                      ? 'border-indigo-700/70 bg-indigo-500/15 text-indigo-200'
                      : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600'
                  }`}
                >
                  <span>{r.emoji}</span>
                  <span>{r.userIds.length}</span>
                </button>
              );
            })}
          </div>
        )}
        {failed && (
          <button
            onClick={() => onRetry?.(m)}
            className="mt-0.5 text-xs font-medium text-red-400 hover:underline"
          >
            {isSessionRow ? 'Failed to spawn — click to retry' : 'Failed to send — click to retry'}
          </button>
        )}
        {!inThread && m.replyCount > 0 && m.id != null && (
          <button
            onClick={() => onOpenThread?.(m.id!)}
            className="mt-0.5 text-xs font-medium text-indigo-400 hover:underline"
          >
            {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'} →
          </button>
        )}
        {pickerOpen && (
          <div
            role="menu"
            aria-label="Pick a reaction"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setPickerOpen(false);
              }
            }}
            className="absolute bottom-full right-0 z-10 mb-1 grid max-h-40 w-64 grid-cols-8 gap-0.5 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-800 p-1 shadow-lg"
          >
            {REACTION_EMOJI.map((e2) => (
              <button
                key={e2}
                onClick={() => react(e2)}
                aria-label={`React with ${e2}`}
                className="rounded px-1 py-1 text-base leading-none hover:bg-zinc-700"
              >
                {e2}
              </button>
            ))}
          </div>
        )}
        {(canThread || canEdit || canDelete || canReact) && !editing && (
          <div className="pointer-events-none absolute -top-3 right-0 flex gap-1 opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
            {canReact && (
              <button
                onClick={() => setPickerOpen((v) => !v)}
                title="Add reaction"
                aria-label="Add reaction"
                className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 shadow-sm hover:bg-zinc-700 hover:text-zinc-100"
              >
                🙂+
              </button>
            )}
            {canEdit && (
              <button
                onClick={startEdit}
                title="Edit message"
                aria-label="Edit message"
                className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 shadow-sm hover:bg-zinc-700 hover:text-zinc-100"
              >
                Edit
              </button>
            )}
            {canDelete && (
              <button
                onClick={onDeleteClick}
                title="Delete message"
                aria-label={deleteAsk ? 'Confirm delete message' : 'Delete message'}
                className={`rounded-md border px-2 py-1 text-xs shadow-sm ${
                  deleteAsk
                    ? 'border-red-700 bg-red-950/70 font-medium text-red-200 hover:bg-red-900/70'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-red-300'
                }`}
              >
                {deleteAsk ? 'Confirm delete' : 'Delete'}
              </button>
            )}
            {canThread && (
              <button
                onClick={() => onOpenThread!(m.id!)}
                title="Reply in thread"
                aria-label="Reply in thread"
                className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 shadow-sm hover:bg-zinc-700 hover:text-zinc-100"
              >
                ↩ Reply
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
