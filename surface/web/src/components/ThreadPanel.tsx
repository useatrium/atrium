import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AttachmentMeta,
  AttachmentRef,
  ChatMessage,
  UploadPayload,
  UserRef,
  VoiceMeta,
} from '@atrium/surface-client';
import {
  artifactCount,
  changedPaths,
  collectArtifacts,
  collectFileChanges,
  collectSideEffects,
  foldedTurnRows,
  sideEffectCount,
} from '@atrium/centaur-client';
import { isTerminalSessionStatus, type Session } from '../sessions/types';
import {
  attachedSessionForRoot,
  sessionDriverId,
  buildTimelineItems,
  formatTime,
  normalizeSteerProvenanceText,
} from '@atrium/surface-client';
import { encodeEventHandle } from '@atrium/surface-client/handle';
import { Composer } from './Composer';
import type { AgentComposerRequest, ComposerHandle } from './Composer';
import { XIcon } from './icons';
import { MessageRow } from './MessageRow';
import { buildSpineRows } from './threadSpine';
import type { MentionContext } from './useMentionTypeahead';
import { ConversationHeader } from '../sessions/ConversationHeader';
import { useNow } from '../sessions/SessionCard';
import type { SessionStream } from '../sessions/useSessionStream';
import { useConflicts } from '../sessions/useConflicts';
import { WorkFold } from '../sessions/WorkFold';
import type { ActiveWorkTab } from '../sessions/WorkDrawer';
import { Avatar } from './Avatar';
import {
  THREAD_PANE_FALLBACK_WIDTH,
  THREAD_PANE_MAX_VW,
  THREAD_PANE_MIN_WIDTH,
  threadPaneSizing,
  useThreadPaneWidth,
} from '../sessions/useSessionPaneWidth';

const STEER_ECHO_WINDOW_MS = 5 * 60 * 1000;

export interface SpineOpenSessionOptions {
  workTab: ActiveWorkTab;
}

function steerFallbackMatches(pending: ChatMessage, confirmed: ChatMessage): boolean {
  if (pending.steeredSessionId == null || pending.steeredSessionId !== confirmed.steeredSessionId) return false;
  if (pending.author.id !== confirmed.author.id) return false;
  if (normalizeSteerProvenanceText(pending.text) !== normalizeSteerProvenanceText(confirmed.text)) return false;
  const pendingAt = Date.parse(pending.createdAt);
  const confirmedAt = Date.parse(confirmed.createdAt);
  return (
    Number.isFinite(pendingAt) &&
    Number.isFinite(confirmedAt) &&
    confirmedAt >= pendingAt &&
    confirmedAt - pendingAt <= STEER_ECHO_WINDOW_MS
  );
}

/** Hide each optimistic steer only when one durable thread echo can consume it. */
export function reconcileThreadSteerReplies(replies: ChatMessage[]): ChatMessage[] {
  const confirmed = replies.filter((message) => message.status === 'confirmed' && message.steeredSessionId != null);
  if (confirmed.length === 0) return replies;
  const consumed = new Set<ChatMessage>();
  const hidden = new Set<ChatMessage>();
  for (const pending of replies) {
    if (pending.status === 'confirmed' || pending.steeredSessionId == null) continue;
    const match = confirmed.find(
      (candidate) =>
        !consumed.has(candidate) && pending.clientMsgId != null && pending.clientMsgId === candidate.clientMsgId,
    );
    const fallback =
      pending.status === 'pending'
        ? confirmed.find((candidate) => !consumed.has(candidate) && steerFallbackMatches(pending, candidate))
        : undefined;
    const echo = match ?? fallback;
    if (!echo) continue;
    consumed.add(echo);
    hidden.add(pending);
  }
  return hidden.size === 0 ? replies : replies.filter((message) => !hidden.has(message));
}

const THREAD_SNIPPET_MAX = 140;

/** A human thread's name is the message that started it — one line of it. */
export function threadSnippet(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return 'Thread';
  return oneLine.length > THREAD_SNIPPET_MAX ? `${oneLine.slice(0, THREAD_SNIPPET_MAX - 1)}…` : oneLine;
}

export interface ThreadPanelProps {
  root: ChatMessage;
  replies: ChatMessage[];
  /** The thread fetch resolved — gates the empty state vs. the loading hint. */
  loaded: boolean;
  sessions: Record<string, Session>;
  spectators: Record<string, number>;
  meId?: string;
  meHandle?: string;
  mentionContext?: MentionContext;
  /** Owning channel, for the zoom crumb (`#eng ▸ thread`). */
  channelLabel?: string;
  onClose: () => void;
  onSend: (
    text: string,
    attachments?: AttachmentMeta[],
    attachmentRefs?: AttachmentRef[],
    voice?: Pick<VoiceMeta, 'fileId' | 'durationMs' | 'waveform'>,
    broadcast?: boolean,
  ) => void;
  queueUpload?: (payload: UploadPayload) => Promise<{ fileId: string }>;
  onOpenSession: (sessionId: string, options?: SpineOpenSessionOptions) => void;
  onRetry: (message: ChatMessage) => void;
  onEdit?: (message: ChatMessage, text: string) => Promise<void>;
  onDelete?: (message: ChatMessage) => Promise<void>;
  onReact?: (message: ChatMessage, emoji: string) => Promise<void>;
  resolveUser?: (id: string) => UserRef | undefined;
  onMarkupEntry?: (handle: string, message: ChatMessage) => void;
  draftKey?: string;
  initialDraft?: string;
  initialDraftAgentIntent?: boolean;
  onDraftChange?: (key: string, text: string, agentIntent: boolean) => void | Promise<void>;
  onDraftPersisted?: (key: string, text: string, agentIntent: boolean) => void | Promise<void>;
  onDraftTouched?: (key: string) => void;
  previewEntryLinks?: boolean;
  onAgentSend?: (
    request: AgentComposerRequest,
    text: string,
    attachments?: AttachmentMeta[],
    attachmentRefs?: AttachmentRef[],
  ) => void;
}

export function ThreadPanelContent({
  root,
  replies,
  loaded,
  sessions,
  spectators,
  meId,
  meHandle,
  mentionContext,
  channelLabel,
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
  initialDraftAgentIntent,
  onDraftChange,
  onDraftPersisted,
  onDraftTouched,
  previewEntryLinks,
  onAgentSend,
  sessionStream,
  visible = true,
}: ThreadPanelProps & { sessionStream: SessionStream; visible?: boolean }) {
  const { width: paneWidth, resizing, startResize, resetWidth } = useThreadPaneWidth();
  const alsoSendToChannelId = useId();
  const [alsoSendToChannel, setAlsoSendToChannel] = useState(false);
  const [composerAgentMode, setComposerAgentMode] = useState(false);
  const paneSizing = threadPaneSizing(paneWidth);
  const paneMaxWidth =
    typeof window === 'undefined'
      ? THREAD_PANE_FALLBACK_WIDTH
      : Math.max(THREAD_PANE_MIN_WIDTH, Math.round((window.innerWidth * THREAD_PANE_MAX_VW) / 100));
  const sessionFor = (m: ChatMessage) =>
    m.sessionId != null
      ? sessions[m.sessionId]
      : m.suggestedSessionId
        ? sessions[m.suggestedSessionId]
        : m.steeredSessionId
          ? sessions[m.steeredSessionId]
          : undefined;
  const attachedSession = useMemo(
    () => attachedSessionForRoot(sessions, root, root.channelId),
    [root.channelId, root.id, root.sessionId, sessions],
  );
  const sessionLive = attachedSession != null && !isTerminalSessionStatus(attachedSession.status);
  const { stream } = sessionStream;
  // Belt to the hook's own null-reset: a thread with no attached session must
  // never render work folds, whatever state the stream is carrying.
  const workFolds = useMemo(
    () => (attachedSession != null ? foldedTurnRows(stream.items) : []),
    [attachedSession, stream.items],
  );
  const fileChanges = useMemo(() => collectFileChanges(stream), [stream.items, stream.fileChanges]);
  const changedFileCount = useMemo(() => changedPaths(fileChanges).length, [fileChanges]);
  const sideEffects = useMemo(() => collectSideEffects(stream.items), [stream.items]);
  const sideEffectsN = useMemo(() => sideEffectCount(sideEffects), [sideEffects]);
  const artifacts = useMemo(() => collectArtifacts(stream), [stream.artifacts]);
  const artifactsN = useMemo(() => artifactCount(artifacts), [artifacts]);
  const { conflicts } = useConflicts(attachedSession?.id ?? null, {
    enabled: visible && import.meta.env.MODE !== 'test',
  });
  const conflictsN = conflicts.length;
  const hasWorkStrips = conflictsN + changedFileCount + sideEffectsN + artifactsN > 0;
  // The header's glance chip carries a live clock; tick it here (as the card
  // does) so the thread's identity is as alive as the card's.
  const now = useNow(visible && sessionLive);
  const spectatorsFor = (m: ChatMessage) => (m.sessionId != null ? (spectators[m.sessionId] ?? 0) : 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const reconciledReplies = useMemo(() => reconcileThreadSteerReplies(replies), [replies]);
  const count = reconciledReplies.length;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, stream.lastEventId]);

  const items = useMemo(() => buildTimelineItems(reconciledReplies), [reconciledReplies]);
  const spineRows = useMemo(
    () => buildSpineRows({ items, workFolds, attachedSessionId: attachedSession?.id ?? null, sessionLive }),
    [attachedSession, items, sessionLive, workFolds],
  );

  return (
    <aside
      className={`pane-zoom-in relative flex shrink-0 flex-col border-l border-edge bg-surface max-md:!w-full max-md:shrink ${paneSizing.className}`}
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
        className={`absolute inset-y-0 -left-0.5 z-raised w-1.5 cursor-col-resize touch-none transition-colors hover:bg-accent/50 max-md:hidden ${
          resizing ? 'bg-accent/50' : ''
        }`}
      />
      {/* The middle zoom says its own name. When a session is attached, this is
          the SAME header component the card and the pane render — same chip,
          same title, same place — so zooming in reads as a zoom, not a
          teleport. A human thread has no session identity, so it gets its own:
          the root message's author and snippet. Either way the generic
          "Thread · 1 reply" chrome is gone — the reply count demotes to the
          crumb line, which speaks the pane's `#channel ▸ thread ▸ work`
          vocabulary. */}
      <ConversationHeader
        identity={
          attachedSession
            ? { kind: 'session', session: attachedSession, now }
            : {
                kind: 'thread',
                authorId: root.author.id,
                authorName: root.author.displayName,
                snippet: threadSnippet(root.text),
              }
        }
        onOpenTitle={attachedSession ? () => onOpenSession(attachedSession.id) : undefined}
        crumbs={[...(channelLabel ? [{ label: channelLabel, onClick: onClose }] : []), { label: 'thread' }]}
        crumbNote={`${root.replyCount} ${root.replyCount === 1 ? 'reply' : 'replies'}`}
        actions={
          <button
            type="button"
            onClick={onClose}
            title="Close thread"
            aria-label="Close thread"
            className="shrink-0 rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg max-md:size-11 max-md:p-0"
          >
            <XIcon />
          </button>
        }
      />
      {attachedSession && hasWorkStrips && (
        <div data-testid="spine-work-strips" className="flex shrink-0 flex-wrap gap-1 border-b border-edge px-3 py-1.5">
          {conflictsN > 0 && (
            <button
              type="button"
              onClick={() => onOpenSession(attachedSession.id, { workTab: 'conflicts' })}
              className="rounded-full border border-danger-border/60 bg-danger-tint/25 px-2 py-0.5 text-xs text-danger-text hover:border-danger-border"
            >
              ⚠ Conflicts · {conflictsN}
            </button>
          )}
          {changedFileCount > 0 && (
            <button
              type="button"
              onClick={() => onOpenSession(attachedSession.id, { workTab: 'changes' })}
              className="rounded-full border border-edge px-2 py-0.5 text-xs text-fg-muted hover:border-edge-strong hover:text-fg-secondary"
            >
              ≡ What changed · {changedFileCount}
            </button>
          )}
          {sideEffectsN > 0 && (
            <button
              type="button"
              onClick={() => onOpenSession(attachedSession.id, { workTab: 'sideEffects' })}
              className="rounded-full border border-edge px-2 py-0.5 text-xs text-fg-muted hover:border-edge-strong hover:text-fg-secondary"
            >
              ⚙ What it ran · {sideEffectsN}
            </button>
          )}
          <button
            type="button"
            onClick={() => onOpenSession(attachedSession.id, { workTab: 'hubFiles' })}
            className="rounded-full border border-edge px-2 py-0.5 text-xs text-fg-muted hover:border-edge-strong hover:text-fg-secondary"
          >
            ▣ Files
          </button>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-2">
        <MessageRow
          message={root}
          grouped={false}
          inThread
          session={sessionFor(root)}
          spectators={spectatorsFor(root)}
          meId={meId}
          meHandle={meHandle}
          mentionContext={mentionContext}
          onOpenSession={onOpenSession}
          onRetry={onRetry}
          onEdit={onEdit}
          onDelete={onDelete}
          onReact={onReact}
          resolveUser={resolveUser}
          onMarkupEntry={onMarkupEntry}
          onDelegateToAgent={(m) =>
            m.id != null &&
            composerRef.current?.activateAgentMode({
              eventId: m.id,
              label: `/e/${encodeEventHandle(m.id)}`,
            })
          }
        />
        {spineRows.map((row) => {
          if (row.kind === 'fold') {
            return (
              <WorkFold
                key={row.key}
                fold={row.fold}
                live={row.live}
                onOpenWork={
                  attachedSession ? () => onOpenSession(attachedSession.id, { workTab: 'sideEffects' }) : undefined
                }
              />
            );
          }
          const messageRow = (
            <MessageRow
              message={row.message}
              grouped={row.aside ? true : row.grouped}
              inThread
              session={sessionFor(row.message)}
              spectators={spectatorsFor(row.message)}
              workFold={
                row.fold ? (
                  <WorkFold
                    fold={row.fold}
                    live={row.foldLive ?? false}
                    nested
                    onOpenWork={
                      attachedSession ? () => onOpenSession(attachedSession.id, { workTab: 'sideEffects' }) : undefined
                    }
                  />
                ) : undefined
              }
              meId={meId}
              meHandle={meHandle}
              mentionContext={mentionContext}
              onOpenSession={onOpenSession}
              onRetry={onRetry}
              onEdit={onEdit}
              onDelete={onDelete}
              onReact={onReact}
              resolveUser={resolveUser}
              onMarkupEntry={onMarkupEntry}
              onDelegateToAgent={(m) =>
                m.id != null &&
                composerRef.current?.activateAgentMode({
                  eventId: m.id,
                  label: `/e/${encodeEventHandle(m.id)}`,
                })
              }
            />
          );
          if (!row.aside) return <div key={row.key}>{messageRow}</div>;
          return (
            <div key={row.key} data-testid="aside-row" className="opacity-75">
              <div className="mt-2 flex items-center gap-3 px-4 py-0.5">
                <div className="w-8 shrink-0">
                  <Avatar name={row.message.author.displayName} seed={row.message.author.id} />
                </div>
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-sm font-semibold text-fg">{row.message.author.displayName}</span>
                  <span className="rounded border border-edge-strong px-1 py-px text-3xs font-semibold uppercase tracking-wide text-fg-muted">
                    Aside
                  </span>
                  <span className="shrink-0 text-2xs tabular-nums text-fg-muted">
                    {formatTime(row.message.createdAt)}
                  </span>
                </div>
              </div>
              <div className="-mt-1">{messageRow}</div>
            </div>
          );
        })}
        {reconciledReplies.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-fg-muted">
            {loaded ? 'No replies yet. Start the thread.' : 'Loading replies…'}
          </div>
        )}
      </div>
      <div className="border-t border-edge bg-surface px-3 pt-2">
        {attachedSession ? (
          <p className="flex items-center gap-2 text-xs text-fg-muted">
            {composerAgentMode
              ? 'Goes to the agent · Esc for an aside'
              : 'Aside — visible to people, never sent to the agent'}
          </p>
        ) : composerAgentMode ? (
          <p className="flex items-center gap-2 text-xs text-fg-muted">
            Goes to the agent — its card already shows this session in the channel.
          </p>
        ) : (
          <label htmlFor={alsoSendToChannelId} className="flex items-center gap-2 text-xs text-fg-secondary">
            <input
              id={alsoSendToChannelId}
              type="checkbox"
              checked={alsoSendToChannel}
              onChange={(e) => setAlsoSendToChannel(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-edge-strong bg-surface-raised text-accent focus:ring-accent"
            />
            <span className="font-medium">Also send to {channelLabel ?? 'channel'}</span>
          </label>
        )}
      </div>
      <Composer
        ref={composerRef}
        placeholder={attachedSession ? 'Write an aside…' : 'Reply…'}
        onSend={(text, attachments, attachmentRefs, voice) => {
          onSend(text, attachments, attachmentRefs, voice, alsoSendToChannel);
          setAlsoSendToChannel(false);
        }}
        onAgentModeChange={(active) => {
          setComposerAgentMode(active);
          if (active) setAlsoSendToChannel(false);
        }}
        queueUpload={queueUpload}
        autoFocus
        agentMode={{
          scope: 'thread',
          channelLabel: 'this thread',
          threadRootEventId: root.id ?? undefined,
          ...(attachedSession
            ? {
                attachedSession: {
                  id: attachedSession.id,
                  title: attachedSession.title,
                  // Canonical seat resolution: null driverId falls back to the spawner.
                  driverId: sessionDriverId(attachedSession),
                  modelEffort: attachedSession.modelEffort,
                },
              }
            : {}),
          meId,
        }}
        onAgentSend={onAgentSend}
        allowAttachments
        draftKey={draftKey}
        initialDraft={initialDraft}
        initialDraftAgentIntent={initialDraftAgentIntent}
        onDraftChange={onDraftChange}
        onDraftPersisted={onDraftPersisted}
        onDraftTouched={onDraftTouched}
        previewEntryLinks={previewEntryLinks}
        mentionContext={mentionContext}
      />
    </aside>
  );
}
