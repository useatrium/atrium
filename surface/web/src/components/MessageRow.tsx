import { useState, type KeyboardEvent } from 'react';
import type { ChatMessage } from '../state';
import { SessionCard } from '../sessions/SessionCard';
import type { Session } from '../sessions/types';
import { formatTime } from '../util';
import { Avatar } from './Avatar';
import { MessageText } from './MessageText';

export function MessageRow({
  message,
  grouped,
  inThread,
  session,
  spectators = 0,
  meId,
  onOpenThread,
  onOpenSession,
  onRetry,
  onEdit,
}: {
  message: ChatMessage;
  grouped: boolean;
  inThread?: boolean;
  /** Session entity when this row is a session card (message.sessionId set). */
  session?: Session;
  spectators?: number;
  /** Current user id — enables Edit on own messages. */
  meId?: string;
  onOpenThread?: (rootEventId: number) => void;
  onOpenSession?: (sessionId: string) => void;
  onRetry?: (message: ChatMessage) => void;
  /** Resolves when the edit is accepted; the folded event updates the row. */
  onEdit?: (message: ChatMessage, text: string) => Promise<void>;
}) {
  const m = message;
  const dim = m.status === 'pending';
  const failed = m.status === 'failed';
  const canThread = !inThread && m.id != null && onOpenThread;
  const isSessionRow = m.sessionId != null && session != null;
  const canEdit =
    !isSessionRow && m.status === 'confirmed' && m.id != null && meId === m.author.id && !!onEdit;

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

  return (
    <div
      className={`group relative flex gap-3 px-4 hover:bg-zinc-900/60 ${
        grouped ? 'py-0.5' : 'mt-2 py-0.5'
      } ${dim ? 'opacity-50' : ''}`}
    >
      <div className="w-8 shrink-0">
        {!grouped && <Avatar name={m.author.displayName} seed={m.author.id} />}
        {grouped && (
          <span className="invisible pt-0.5 text-[10px] tabular-nums text-zinc-500 group-hover:visible">
            {formatTime(m.createdAt)}
          </span>
        )}
      </div>
      <div className="relative min-w-0 max-w-3xl flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-zinc-100">{m.author.displayName}</span>
            <span className="text-[11px] tabular-nums text-zinc-500">
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
        ) : (
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-200">
            <MessageText text={m.text} />
            {m.edited && <span className="ml-1 text-[11px] text-zinc-500">(edited)</span>}
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
        {(canThread || canEdit) && !editing && (
          <div className="pointer-events-none absolute -top-3 right-0 flex gap-1 opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
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
