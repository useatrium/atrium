import type { ChatMessage } from '../state';
import { SessionCard } from '../sessions/SessionCard';
import type { Session } from '../sessions/types';
import { formatTime } from '../util';
import { Avatar } from './Avatar';

export function MessageRow({
  message,
  grouped,
  inThread,
  session,
  spectators = 0,
  onOpenThread,
  onOpenSession,
  onRetry,
}: {
  message: ChatMessage;
  grouped: boolean;
  inThread?: boolean;
  /** Session entity when this row is a session card (message.sessionId set). */
  session?: Session;
  spectators?: number;
  onOpenThread?: (rootEventId: number) => void;
  onOpenSession?: (sessionId: string) => void;
  onRetry?: (message: ChatMessage) => void;
}) {
  const m = message;
  const dim = m.status === 'pending';
  const failed = m.status === 'failed';
  const canThread = !inThread && m.id != null && onOpenThread;
  const isSessionRow = m.sessionId != null && session != null;

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
      <div className="min-w-0 flex-1">
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
        ) : (
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-200">
            {m.text}
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
      </div>
      {canThread && (
        <button
          onClick={() => onOpenThread!(m.id!)}
          title="Reply in thread"
          className="invisible absolute -top-3 right-3 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 shadow-sm hover:bg-zinc-700 hover:text-zinc-100 group-hover:visible"
        >
          ↩ Reply
        </button>
      )}
    </div>
  );
}
