import { useLayoutEffect, useMemo, useRef } from 'react';
import type {
  AttachmentMeta,
  AttachmentRef,
  ChatMessage,
  UploadPayload,
  VoiceMeta,
} from '@atrium/surface-client';
import type { Session } from '../sessions/types';
import { buildTimelineItems } from '@atrium/surface-client';
import { Composer } from './Composer';
import { XIcon } from './icons';
import { MessageRow } from './MessageRow';

export function ThreadPanel({
  root,
  replies,
  loaded,
  sessions,
  spectators,
  meId,
  meHandle,
  onClose,
  onSend,
  queueUpload,
  onOpenSession,
  onRetry,
  onEdit,
  onDelete,
  onReact,
  onMarkupEntry,
  draftKey,
  initialDraft,
  onDraftChange,
  onDraftPersisted,
  onDraftTouched,
}: {
  root: ChatMessage;
  replies: ChatMessage[];
  /** The thread fetch resolved — gates the empty state vs. the loading hint. */
  loaded: boolean;
  sessions: Record<string, Session>;
  spectators: Record<string, number>;
  meId?: string;
  meHandle?: string;
  onClose: () => void;
  onSend: (
    text: string,
    attachments?: AttachmentMeta[],
    attachmentRefs?: AttachmentRef[],
    voice?: Pick<VoiceMeta, 'fileId' | 'durationMs' | 'waveform'>,
  ) => void;
  queueUpload?: (payload: UploadPayload) => Promise<{ fileId: string }>;
  onOpenSession: (sessionId: string) => void;
  onRetry: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage, text: string) => Promise<void>;
  onDelete?: (message: ChatMessage) => Promise<void>;
  onReact?: (message: ChatMessage, emoji: string) => Promise<void>;
  onMarkupEntry?: (handle: string, message: ChatMessage) => void;
  draftKey?: string;
  initialDraft?: string;
  onDraftChange?: (key: string, text: string) => void | Promise<void>;
  onDraftPersisted?: (key: string, text: string) => void | Promise<void>;
  onDraftTouched?: (key: string) => void;
}) {
  const sessionFor = (m: ChatMessage) =>
    m.sessionId != null ? sessions[m.sessionId] : undefined;
  const spectatorsFor = (m: ChatMessage) =>
    m.sessionId != null ? (spectators[m.sessionId] ?? 0) : 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = replies.length;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  const items = useMemo(() => buildTimelineItems(replies), [replies]);

  return (
    <aside className="flex w-[min(380px,38vw)] shrink-0 flex-col border-l border-edge bg-surface">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-4">
        <h2 className="text-sm font-semibold text-fg">
          Thread
          <span className="ml-2 text-xs font-normal text-fg-muted">
            {root.replyCount} {root.replyCount === 1 ? 'reply' : 'replies'}
          </span>
        </h2>
        <button
          onClick={onClose}
          title="Close thread"
          aria-label="Close thread"
          className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          <XIcon />
        </button>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-2">
        <MessageRow
          message={root}
          grouped={false}
          inThread
          session={sessionFor(root)}
          spectators={spectatorsFor(root)}
          meId={meId}
          meHandle={meHandle}
          onOpenSession={onOpenSession}
          onRetry={onRetry}
          onEdit={onEdit}
          onDelete={onDelete}
          onReact={onReact}
          onMarkupEntry={onMarkupEntry}
        />
        <div className="my-2 flex items-center gap-2 px-4">
          <div className="h-px flex-1 bg-surface-overlay" />
          <span className="text-3xs uppercase tracking-wide text-fg-muted">replies</span>
          <div className="h-px flex-1 bg-surface-overlay" />
        </div>
        {items.map((item) =>
          item.kind === 'day' ? null : (
            <MessageRow
              key={item.key}
              message={item.message!}
              grouped={item.grouped ?? false}
              inThread
              session={sessionFor(item.message!)}
              spectators={spectatorsFor(item.message!)}
              meId={meId}
              meHandle={meHandle}
              onOpenSession={onOpenSession}
              onRetry={onRetry}
              onEdit={onEdit}
              onDelete={onDelete}
              onReact={onReact}
              onMarkupEntry={onMarkupEntry}
            />
          ),
        )}
        {replies.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-fg-muted">
            {loaded ? 'No replies yet. Start the thread.' : 'Loading replies…'}
          </div>
        )}
      </div>
      <Composer
        placeholder="Reply…"
        onSend={onSend}
        queueUpload={queueUpload}
        autoFocus
        agentAware
        allowAttachments
        draftKey={draftKey}
        initialDraft={initialDraft}
        onDraftChange={onDraftChange}
        onDraftPersisted={onDraftPersisted}
        onDraftTouched={onDraftTouched}
      />
    </aside>
  );
}
