import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AttachmentMeta,
  AttachmentRef,
  ChatMessage,
  UploadPayload,
  UserRef,
  VoiceMeta,
} from '@atrium/surface-client';
import type { Session } from '../sessions/types';
import { buildTimelineItems } from '@atrium/surface-client';
import { Composer } from './Composer';
import { XIcon } from './icons';
import { MessageRow } from './MessageRow';
import {
  THREAD_PANE_FALLBACK_WIDTH,
  THREAD_PANE_MAX_VW,
  THREAD_PANE_MIN_WIDTH,
  threadPaneSizing,
  useThreadPaneWidth,
} from '../sessions/useSessionPaneWidth';

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
  resolveUser,
  onMarkupEntry,
  draftKey,
  initialDraft,
  onDraftChange,
  onDraftPersisted,
  onDraftTouched,
  previewEntryLinks,
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
    broadcast?: boolean,
  ) => void;
  queueUpload?: (payload: UploadPayload) => Promise<{ fileId: string }>;
  onOpenSession: (sessionId: string) => void;
  onRetry: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage, text: string) => Promise<void>;
  onDelete?: (message: ChatMessage) => Promise<void>;
  onReact?: (message: ChatMessage, emoji: string) => Promise<void>;
  resolveUser?: (id: string) => UserRef | undefined;
  onMarkupEntry?: (handle: string, message: ChatMessage) => void;
  draftKey?: string;
  initialDraft?: string;
  onDraftChange?: (key: string, text: string) => void | Promise<void>;
  onDraftPersisted?: (key: string, text: string) => void | Promise<void>;
  onDraftTouched?: (key: string) => void;
  previewEntryLinks?: boolean;
}) {
  const { width: paneWidth, resizing, startResize, resetWidth } = useThreadPaneWidth();
  const alsoSendToChannelId = useId();
  const [alsoSendToChannel, setAlsoSendToChannel] = useState(false);
  const paneSizing = threadPaneSizing(paneWidth);
  const paneMaxWidth =
    typeof window === 'undefined'
      ? THREAD_PANE_FALLBACK_WIDTH
      : Math.max(THREAD_PANE_MIN_WIDTH, Math.round((window.innerWidth * THREAD_PANE_MAX_VW) / 100));
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
    <aside
      className={`relative flex shrink-0 flex-col border-l border-edge bg-surface max-md:!w-full max-md:shrink ${paneSizing.className}`}
      style={paneSizing.style}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: resizable pane separator uses a div for pointer capture and custom sizing. */}
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize thread panel"
        aria-valuemin={THREAD_PANE_MIN_WIDTH}
        aria-valuemax={paneMaxWidth}
        aria-valuenow={paneWidth ?? THREAD_PANE_FALLBACK_WIDTH}
        title="Drag to resize · double-click to reset"
        data-testid="thread-resize-handle"
        onPointerDown={startResize}
        onDoubleClick={resetWidth}
        className={`absolute inset-y-0 -left-0.5 z-20 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-accent/50 max-md:hidden ${
          resizing ? 'bg-accent/50' : ''
        }`}
      />
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-edge px-4">
        <h2 className="text-sm font-semibold text-fg">
          Thread
          <span className="ml-2 text-xs font-normal text-fg-muted">
            {root.replyCount} {root.replyCount === 1 ? 'reply' : 'replies'}
          </span>
        </h2>
        <button
          type="button"
          onClick={onClose}
          title="Close thread"
          aria-label="Close thread"
          className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg max-md:size-11 max-md:p-0"
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
          resolveUser={resolveUser}
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
              resolveUser={resolveUser}
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
      <div className="border-t border-edge bg-surface px-3 pt-2">
        <label htmlFor={alsoSendToChannelId} className="flex items-center gap-2 text-xs text-fg-secondary">
          <input
            id={alsoSendToChannelId}
            type="checkbox"
            checked={alsoSendToChannel}
            onChange={(e) => setAlsoSendToChannel(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-edge-strong bg-surface-raised text-accent focus:ring-accent"
          />
          <span className="font-medium">Also send to channel</span>
          <span className="text-fg-muted">Visible in the channel too</span>
        </label>
      </div>
      <Composer
        placeholder="Reply…"
        onSend={(text, attachments, attachmentRefs, voice) => {
          onSend(text, attachments, attachmentRefs, voice, alsoSendToChannel);
          setAlsoSendToChannel(false);
        }}
        queueUpload={queueUpload}
        autoFocus
        agentAware
        allowAttachments
        draftKey={draftKey}
        initialDraft={initialDraft}
        onDraftChange={onDraftChange}
        onDraftPersisted={onDraftPersisted}
        onDraftTouched={onDraftTouched}
        previewEntryLinks={previewEntryLinks}
      />
    </aside>
  );
}
