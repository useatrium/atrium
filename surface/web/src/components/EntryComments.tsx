import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { WireEvent } from '@atrium/surface-client';
import { api } from '../api';
import { useDialog } from '../useDialog';
import { SendIcon, XIcon } from './icons';

export function EntryComments({
  handle,
  open,
  onClose,
  invokerRef,
}: {
  handle: string;
  open: boolean;
  onClose: () => void;
  invokerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [comments, setComments] = useState<WireEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);

  useDialog({
    open,
    containerRef: panelRef,
    initialFocusRef: textareaRef,
    invokerRef,
    closeOnOutsidePointer: true,
    onClose,
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setComments([]);
    setLoading(true);
    setLoadFailed(false);
    void api
      .getEntryAnnotations(handle)
      .then(({ comments: nextComments }) => {
        if (!cancelled) setComments(nextComments);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [handle, open]);

  const send = () => {
    const text = draft.trim();
    if (!text || sending) return;
    const optimistic: WireEvent = {
      id: -Date.now(),
      workspaceId: '',
      channelId: null,
      threadRootEventId: null,
      type: 'comment.posted',
      actorId: null,
      payload: { target: handle, text },
      createdAt: new Date().toISOString(),
      author: null,
    };
    setComments((prev) => [...prev, optimistic]);
    setDraft('');
    setSending(true);
    setSendFailed(false);
    void api
      .postEntryComment(handle, text)
      .then(({ event }) => {
        setComments((prev) =>
          prev.map((comment) => (comment.id === optimistic.id ? event : comment)),
        );
      })
      .catch(() => {
        setComments((prev) => prev.filter((comment) => comment.id !== optimistic.id));
        setDraft(text);
        setSendFailed(true);
      })
      .finally(() => setSending(false));
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Entry comments"
      className="absolute right-0 top-6 z-20 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-edge-strong bg-surface-overlay shadow-lg shadow-black/20"
    >
      <header className="flex h-10 items-center justify-between border-b border-edge px-3">
        <div className="text-xs font-semibold text-fg">Comments</div>
        <button
          type="button"
          onClick={onClose}
          title="Close comments"
          aria-label="Close comments"
          className="rounded-md px-1.5 py-1 text-fg-tertiary hover:bg-edge-strong hover:text-fg"
        >
          <XIcon />
        </button>
      </header>
      <div className="max-h-56 space-y-2 overflow-y-auto px-3 py-2">
        {loading && comments.length === 0 ? (
          <div className="py-5 text-center text-xs text-fg-muted">Loading comments...</div>
        ) : comments.length === 0 ? (
          <div className="py-5 text-center text-xs text-fg-muted">No comments yet.</div>
        ) : (
          comments.map((comment) => <CommentRow key={comment.id} comment={comment} />)
        )}
        {loadFailed && (
          <div className="rounded border border-warning-border/40 bg-warning-tint/20 px-2 py-1 text-xs text-warning-text">
            Couldn't load comments.
          </div>
        )}
      </div>
      <div className="border-t border-edge px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            disabled={sending}
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder="Add a comment"
            aria-label="Comment text"
            className="min-h-16 flex-1 resize-none rounded-md border border-edge-strong bg-surface-raised px-2 py-1.5 text-sm leading-relaxed text-fg outline-none placeholder:text-fg-faint focus:border-accent-hover disabled:text-fg-muted"
          />
          <button
            type="button"
            onClick={send}
            disabled={sending || draft.trim().length === 0}
            title="Send comment"
            aria-label="Send comment"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-edge-strong bg-surface-raised text-fg-secondary shadow-sm hover:bg-edge-strong hover:text-fg disabled:cursor-default disabled:text-fg-faint"
          >
            <SendIcon />
          </button>
        </div>
        {sendFailed && (
          <div role="status" className="mt-1 text-xs text-warning-text">
            Couldn't send comment.
          </div>
        )}
      </div>
    </div>
  );
}

function CommentRow({ comment }: { comment: WireEvent }) {
  const { text, deleted } = commentPayload(comment);
  const author = comment.author;
  const displayName = author?.displayName ?? author?.handle ?? 'Unknown';
  const showHandle = author?.handle && author.handle !== displayName;
  return (
    <div className="rounded-md border border-edge bg-surface-raised/60 px-2 py-1.5 text-xs">
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate font-semibold text-fg-secondary">{displayName}</span>
        {showHandle && <span className="truncate text-fg-muted">@{author.handle}</span>}
        <span
          className="ml-auto shrink-0 tabular-nums text-2xs text-fg-muted"
          title={new Date(comment.createdAt).toLocaleString()}
        >
          {relativeTime(comment.createdAt)}
        </span>
      </div>
      {deleted ? (
        <div className="mt-1 italic text-fg-muted">Comment deleted</div>
      ) : (
        <div className="mt-1 whitespace-pre-wrap break-words text-fg-body">{text}</div>
      )}
    </div>
  );
}

function commentPayload(comment: WireEvent): { text: string; deleted: boolean } {
  const payload = comment.payload ?? {};
  const raw = comment as WireEvent & { text?: unknown; deleted?: unknown };
  return {
    text:
      typeof payload.text === 'string'
        ? payload.text
        : typeof raw.text === 'string'
          ? raw.text
          : '',
    deleted: payload.deleted === true || raw.deleted === true,
  };
}

function relativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const elapsed = Date.now() - ts;
  if (elapsed < 45_000) return 'just now';
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < hour) return `${Math.round(elapsed / minute)}m ago`;
  if (elapsed < day) return `${Math.round(elapsed / hour)}h ago`;
  if (elapsed < 7 * day) return `${Math.round(elapsed / day)}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
