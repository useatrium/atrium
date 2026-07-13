import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { looksLikeSummonSigil, parseSummonSigil } from '../sessions/spawn';
import type { AttachmentMeta, AttachmentRef, UploadPayload, VoiceMeta } from '@atrium/surface-client';
import { createDraftChangeDebouncer, formatBytes, randomId } from '@atrium/surface-client';
import { FileIcon, PaperclipIcon, XIcon } from './icons';
import { Tooltip } from './a11y';
import { VoiceRecorder, type RecordedVoice } from '../VoiceRecorder';
import { SHORTCUTS, matchesChord } from '../lib/shortcuts';
import { extractEntryHandles } from '../lib/entryLinks';
import { EntryInlineChip } from './EntryQuoteCard';
import { MentionSuggestions } from './MentionSuggestions';
import { type MentionContext, useMentionTypeahead } from './useMentionTypeahead';

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

interface PendingFile {
  key: string;
  uploadKey: string;
  file: File;
  status: 'uploading' | 'ready' | 'failed';
  fileId?: string;
  localUri: string;
  width?: number;
  height?: number;
}

export interface ComposerHandle {
  captureForConfigure: () => string;
  restoreDraft: (text: string) => void;
  /** Enter agent mode (optionally pre-anchored) — the message-action "Delegate to agent…" door. */
  activateAgentMode: (anchor?: { eventId: number; label: string }) => void;
}

export type AgentComposerRequest = {
  target: 'spawn-channel' | 'spawn-thread' | 'steer' | 'suggest';
  sessionId?: string;
  threadRootEventId?: number;
  anchorEventId?: number;
  effort?: string;
};

/** Context for the first-class agent mode. Kept local to web so server contracts stay explicit. */
export type AgentComposerMode = {
  scope: 'channel' | 'thread';
  channelLabel: string;
  threadRootEventId?: number;
  attachedSession?: { id: string; title: string; driverId: string | null; modelEffort?: string | null };
  meId?: string;
  initialAnchor?: { eventId: number; label: string };
};

type ComposerProps = {
  placeholder: string;
  onSend: (
    text: string,
    attachments?: AttachmentMeta[],
    attachmentRefs?: AttachmentRef[],
    voice?: Pick<VoiceMeta, 'fileId' | 'durationMs' | 'waveform'>,
  ) => void;
  queueUpload?: (payload: UploadPayload) => Promise<{ fileId: string }>;
  /** Fired while the user types non-empty text (throttle at the call site). */
  onTyping?: () => void;
  /** ArrowUp in an empty composer — Slack-style "edit my last message". */
  onArrowUpOnEmpty?: () => void;
  autoFocus?: boolean;
  /** Show the summon-sigil hint chip while the grammar matches. */
  agentAware?: boolean;
  /** Open the configured spawn dialog from the current summon-sigil draft. */
  onConfigureAgent?: (fullText: string) => void;
  /** Enable paste / drag-drop / file uploads. */
  allowAttachments?: boolean;
  /** Enable the voice recorder. Defaults to the attachment setting. */
  allowVoice?: boolean;
  disabled?: boolean;
  disabledHint?: string;
  /** Replaces the default hint line (e.g. seat request controls in the pane). */
  footer?: ReactNode;
  draftKey?: string;
  initialDraft?: string;
  onDraftChange?: (key: string, text: string) => void | Promise<void>;
  onDraftPersisted?: (key: string, text: string) => void | Promise<void>;
  onDraftTouched?: (key: string) => void;
  previewEntryLinks?: boolean;
  /** Enables the first-class summon/steer UI for channel and thread composers. */
  agentMode?: AgentComposerMode;
  onAgentSend?: (
    request: AgentComposerRequest,
    text: string,
    attachments?: AttachmentMeta[],
    attachmentRefs?: AttachmentRef[],
  ) => void;
  /** Enables channel mention suggestions. Omit for agent-session composers. */
  mentionContext?: MentionContext;
  /** Observes agent-mode entry/exit (e.g. the thread panel hides its broadcast checkbox). */
  onAgentModeChange?: (active: boolean) => void;
};

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    placeholder,
    onSend,
    queueUpload,
    onTyping,
    onArrowUpOnEmpty,
    autoFocus,
    agentAware,
    onConfigureAgent,
    allowAttachments,
    allowVoice = allowAttachments,
    disabled,
    disabledHint,
    footer,
    draftKey,
    initialDraft,
    onDraftChange,
    onDraftPersisted,
    onDraftTouched,
    previewEntryLinks,
    agentMode: agentModeContext,
    onAgentSend,
    mentionContext,
    onAgentModeChange,
  },
  imperativeRef,
) {
  const [text, setText] = useState('');
  // "!!" with no task: refuse to post the literal string — show what's
  // missing instead (cleared as soon as the text changes).
  const [agentNeedsTask, setAgentNeedsTask] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [agentTarget, setAgentTarget] = useState<'session' | 'thread'>('session');
  const [agentAnchor, setAgentAnchor] = useState<AgentComposerMode['initialAnchor']>();
  const [agentEffort, setAgentEffort] = useState<string>('');
  const [agentOptionsOpen, setAgentOptionsOpen] = useState(false);
  // One-time coach mark on first agent-mode entry; device-local like the theme pref.
  const [agentCoachSeen, setAgentCoachSeen] = useState(() => {
    try {
      return localStorage.getItem('atrium.agentCoachSeen') === '1';
    } catch {
      return true;
    }
  });
  const dismissAgentCoach = () => {
    setAgentCoachSeen(true);
    try {
      localStorage.setItem('atrium.agentCoachSeen', '1');
    } catch {
      // storage unavailable — session-only dismissal
    }
  };
  const [agentTargetOpen, setAgentTargetOpen] = useState(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<PendingFile[]>([]);
  const draftWriter = useMemo(
    () =>
      createDraftChangeDebouncer(
        (key, value) => onDraftChange?.(key, value),
        400,
        (key, value) => onDraftPersisted?.(key, value),
      ),
    [onDraftChange, onDraftPersisted],
  );
  const agentHint = !!agentAware && !disabled && looksLikeSummonSigil(text);
  const agentTask = agentHint ? parseSummonSigil(text) : null;
  const configureAgentHint = !!onConfigureAgent && agentHint && agentTask != null;
  const agentNeedsTaskHint = agentNeedsTask || (!!onConfigureAgent && agentHint && agentTask == null);
  const entryLinkHandles = useMemo(
    () => (previewEntryLinks ? extractEntryHandles(text) : []),
    [previewEntryLinks, text],
  );
  const uploading = files.some((f) => f.status === 'uploading');
  const readyFiles = files.filter((f): f is PendingFile & { fileId: string } => f.status === 'ready' && !!f.fileId);
  const sendDisabled = (!text.trim() && readyFiles.length === 0) || !!disabled || uploading;
  const attachedSession = agentModeContext?.attachedSession;
  const isDriver = attachedSession?.driverId != null && attachedSession.driverId === agentModeContext?.meId;
  const canTargetSession = agentModeContext?.scope === 'thread' && attachedSession != null;
  const effectiveAgentTarget =
    agentModeContext?.scope === 'channel'
      ? 'spawn-channel'
      : agentTarget === 'thread' || !attachedSession
        ? 'spawn-thread'
        : isDriver
          ? 'steer'
          : 'suggest';
  const targetLabel =
    agentModeContext?.scope === 'channel'
      ? `New agent · ${agentModeContext.channelLabel}`
      : effectiveAgentTarget === 'spawn-thread'
        ? 'New agent · this thread'
        : `${effectiveAgentTarget === 'steer' ? 'Steer' : 'Suggest'} · “${attachedSession?.title ?? 'agent'}”`;
  const anchorLabel = agentAnchor?.label ?? (agentModeContext?.scope === 'thread' ? 'this thread' : 'latest message');
  const sendTooltip = disabled
    ? (disabledHint ?? 'Message composer unavailable')
    : uploading
      ? 'Waiting for uploads…'
      : !text.trim() && readyFiles.length === 0
        ? 'Enter a message or attach a file'
        : 'Send message';
  const mentions = useMentionTypeahead({ value: text, setValue: setText, textareaRef: ref, context: mentionContext });

  useEffect(() => () => draftWriter.cancel(), [draftWriter]);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    onAgentModeChange?.(agentMode);
  }, [agentMode, onAgentModeChange]);

  useEffect(
    () => () => {
      for (const file of filesRef.current) URL.revokeObjectURL(file.localUri);
    },
    [],
  );

  useEffect(() => {
    if (!attachmentNotice) return;
    const timer = window.setTimeout(() => setAttachmentNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [attachmentNotice]);

  useEffect(() => {
    setText('');
    mentions.clear();
    setFiles((prev) => {
      for (const file of prev) URL.revokeObjectURL(file.localUri);
      return [];
    });
    if (ref.current) ref.current.style.height = 'auto';
  }, [draftKey, mentions.clear]);

  useEffect(() => {
    if (!initialDraft) return;
    setText((prev) => (prev === '' ? initialDraft : prev));
  }, [initialDraft]);

  useEffect(() => {
    setAgentTarget('session');
    setAgentAnchor(agentModeContext?.initialAnchor);
    setAgentEffort(attachedSession?.modelEffort ?? '');
  }, [agentModeContext?.initialAnchor, attachedSession?.id, attachedSession?.modelEffort]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const persistDraftValue = useCallback(
    (value: string) => {
      if (!draftKey) return;
      onDraftTouched?.(draftKey);
      draftWriter.saveNow(draftKey, value);
    },
    [draftKey, draftWriter, onDraftTouched],
  );

  useImperativeHandle(
    imperativeRef,
    () => ({
      activateAgentMode(anchor) {
        if (!agentModeContext || disabled) return;
        if (anchor) setAgentAnchor(anchor);
        setAgentMode(true);
        setAgentNeedsTask(false);
        requestAnimationFrame(() => ref.current?.focus());
      },
      captureForConfigure() {
        const captured = text;
        setText('');
        mentions.clear();
        setAgentNeedsTask(false);
        persistDraftValue('');
        if (ref.current) ref.current.style.height = 'auto';
        return captured;
      },
      restoreDraft(value: string) {
        setText(value);
        mentions.clear();
        setAgentNeedsTask(false);
        persistDraftValue(value);
        requestAnimationFrame(() => {
          const el = ref.current;
          if (!el) return;
          el.style.height = 'auto';
          if (value) el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          el.focus();
          el.setSelectionRange(value.length, value.length);
        });
      },
    }),
    [imperativeRef, mentions.clear, persistDraftValue, text],
  );

  const contentHashFor = async (file: File): Promise<string | undefined> => {
    try {
      if (!globalThis.crypto?.subtle) return undefined;
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return undefined;
    }
  };

  const startUpload = async (file: File) => {
    const key = randomId();
    const uploadKey = randomId();
    const localUri = URL.createObjectURL(file);
    let width: number | undefined;
    let height: number | undefined;
    if (file.type.startsWith('image/')) {
      try {
        const bmp = await createImageBitmap(file);
        width = bmp.width;
        height = bmp.height;
        bmp.close();
      } catch {
        // not decodable as an image — upload without dimensions
      }
    }
    setFiles((prev) => [...prev, { key, uploadKey, file, status: 'uploading', localUri, width, height }]);
    try {
      if (!queueUpload) throw new Error('upload queue unavailable');
      const contentHash = await contentHashFor(file);
      const { fileId } = await queueUpload({
        uploadKey,
        localUri,
        filename: file.name || 'pasted-image.png',
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        width,
        height,
        contentHash,
      });
      setFiles((prev) => prev.map((p) => (p.key === key ? { ...p, fileId, status: 'ready' } : p)));
    } catch {
      setFiles((prev) => prev.map((p) => (p.key === key ? { ...p, status: 'failed' } : p)));
    }
  };

  const addFiles = (list: FileList | File[]) => {
    if (!allowAttachments || disabled) return;
    for (const f of Array.from(list).slice(0, Math.max(0, MAX_ATTACHMENTS - files.length))) {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        setAttachmentNotice(`${f.name || 'File'} is larger than 100 MB`);
        continue;
      }
      void startUpload(f);
    }
  };

  const removeFile = (key: string) =>
    setFiles((prev) => {
      const file = prev.find((p) => p.key === key);
      if (file) URL.revokeObjectURL(file.localUri);
      return prev.filter((p) => p.key !== key);
    });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  };

  const send = () => {
    const trimmed = text.trim();
    if (disabled || uploading) return;
    if (!trimmed && readyFiles.length === 0) return;
    if (agentAware && trimmed && looksLikeSummonSigil(trimmed) && parseSummonSigil(trimmed) == null) {
      setAgentNeedsTask(true);
      return;
    }
    const attachments =
      readyFiles.length > 0
        ? readyFiles.map((f) => ({
            id: f.fileId,
            filename: f.file.name || 'pasted-image.png',
            contentType: f.file.type || 'application/octet-stream',
            size: f.file.size,
            ...(f.width ? { width: f.width } : {}),
            ...(f.height ? { height: f.height } : {}),
          }))
        : undefined;
    const attachmentRefs = readyFiles.length > 0 ? readyFiles.map((f) => ({ uploadKey: f.uploadKey })) : undefined;
    if (agentMode && agentModeContext && onAgentSend) {
      onAgentSend(
        {
          target: effectiveAgentTarget,
          ...(attachedSession && effectiveAgentTarget !== 'spawn-thread' ? { sessionId: attachedSession.id } : {}),
          ...(agentModeContext.threadRootEventId ? { threadRootEventId: agentModeContext.threadRootEventId } : {}),
          ...(agentAnchor?.eventId ? { anchorEventId: agentAnchor.eventId } : {}),
          ...(agentEffort ? { effort: agentEffort } : {}),
        },
        trimmed,
        attachments,
        attachmentRefs,
      );
      // Sticky steer: once you're driving a session, stay in agent mode for
      // the follow-ups (Esc exits). Spawn targets still exit — the message
      // after "start an agent" is normally chat, not another spawn.
      if (effectiveAgentTarget !== 'steer' && effectiveAgentTarget !== 'suggest') {
        setAgentMode(false);
      }
    } else {
      onSend(mentions.serialize(text).trim(), attachments, attachmentRefs);
    }
    if (draftKey) {
      onDraftTouched?.(draftKey);
      draftWriter.saveNow(draftKey, '');
    }
    setText('');
    mentions.clear();
    setFiles((prev) => {
      for (const file of prev) URL.revokeObjectURL(file.localUri);
      return [];
    });
    if (ref.current) ref.current.style.height = 'auto';
  };

  const sendVoice = async (recorded: RecordedVoice) => {
    if (disabled || !queueUpload) throw new Error('upload queue unavailable');
    const uploadKey = randomId();
    const localUri = URL.createObjectURL(recorded.blob);
    // Strip codec params (e.g. "audio/webm;codecs=opus") — /api/uploads only
    // accepts bare type/subtype and otherwise stores octet-stream.
    const contentType = recorded.blob.type.split(';')[0] || 'audio/webm';
    try {
      const { fileId } = await queueUpload({
        uploadKey,
        localUri,
        filename: recorded.filename,
        contentType,
        size: recorded.blob.size,
      });
      onSend(
        '',
        [
          {
            id: fileId,
            filename: recorded.filename,
            contentType,
            size: recorded.blob.size,
          },
        ],
        [{ uploadKey }],
        { fileId, durationMs: recorded.durationMs, waveform: recorded.waveform },
      );
    } finally {
      URL.revokeObjectURL(localUri);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.onKeyDown(e)) return;
    if (agentModeContext && matchesChord(e.nativeEvent, SHORTCUTS.toggleAgentMode.keys)) {
      e.preventDefault();
      setAgentMode((value) => !value);
    } else if (e.key === 'Escape' && agentMode) {
      e.preventDefault();
      setAgentOptionsOpen(false);
      setAgentTargetOpen(false);
      setAgentMode(false);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowUp' && text === '' && onArrowUpOnEmpty) {
      e.preventDefault();
      onArrowUpOnEmpty();
    }
  };

  return (
    <div className={`border-t bg-surface p-3 ${agentMode ? 'border-accent/60 bg-accent/5' : 'border-edge'}`}>
      {agentMode && agentModeContext && (
        <div className="mb-2 hidden min-w-0 flex-wrap items-center gap-1.5 px-1 min-[431px]:flex">
          <div className="relative min-w-0">
            <button
              type="button"
              onClick={() => setAgentTargetOpen((value) => !value)}
              aria-expanded={agentTargetOpen}
              aria-haspopup="menu"
              className="flex min-w-0 max-w-[22rem] items-center gap-1 rounded-full border border-accent/35 bg-accent/10 px-2 py-1 text-xs font-medium text-accent-text-strong hover:bg-accent/15"
            >
              <span aria-hidden>⚡</span>
              <span className="truncate">{targetLabel}</span>
              <span aria-hidden>▾</span>
            </button>
            {agentTargetOpen && canTargetSession && (
              <div
                role="menu"
                className="absolute bottom-full left-0 z-30 mb-1 w-64 rounded-md border border-edge-strong bg-surface-overlay p-1 shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAgentTarget('session');
                    setAgentTargetOpen(false);
                  }}
                  className="flex w-full rounded px-2 py-1.5 text-left text-xs text-fg-secondary hover:bg-edge-strong hover:text-fg"
                >
                  {isDriver ? 'Steer this session' : 'Suggest to this session'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAgentTarget('thread');
                    setAgentTargetOpen(false);
                  }}
                  className="flex w-full rounded px-2 py-1.5 text-left text-xs text-fg-secondary hover:bg-edge-strong hover:text-fg"
                >
                  New session in this thread
                </button>
                <div className="px-2 pb-1 pt-1.5 text-3xs leading-4 text-fg-muted">
                  The agent reads this conversation before starting (⚓ anchor).
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setAgentAnchor(undefined)}
            className="max-w-40 shrink-0 truncate rounded-full border border-edge-strong px-2 py-1 text-xs text-fg-secondary hover:bg-surface-overlay"
            title={agentAnchor ? 'Clear anchor' : undefined}
          >
            <span aria-hidden>⚓ </span>
            {anchorLabel}
          </button>
          <label
            className={`flex shrink-0 items-center gap-1 rounded-full border border-edge-strong px-2 py-1 text-xs text-fg-secondary ${
              effectiveAgentTarget === 'suggest' ? 'hidden' : ''
            }`}
          >
            <span>effort</span>
            <select
              value={agentEffort}
              onChange={(e) => setAgentEffort(e.target.value)}
              aria-label="Agent effort"
              className="max-w-16 bg-transparent text-xs text-fg outline-none"
            >
              <option value="">default</option>
              <option value="low">low</option>
              <option value="medium">med</option>
              <option value="high">high</option>
              <option value="max">max</option>
            </select>
          </label>
        </div>
      )}
      {agentMode && agentModeContext && (
        <div className="mb-2 flex min-w-0 items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-xs text-accent-text-strong min-[431px]:hidden">
          <button
            type="button"
            onClick={() => setAgentOptionsOpen(true)}
            className="min-w-0 flex-1 truncate text-left font-medium"
          >
            <span aria-hidden>⚡ </span>
            {targetLabel} · <span aria-hidden>⚓ </span>
            {anchorLabel}
          </button>
          <button
            type="button"
            onClick={() => setAgentMode(false)}
            aria-label="Exit agent mode"
            className="shrink-0 rounded px-1 hover:bg-accent/15"
          >
            ✕
          </button>
        </div>
      )}
      {agentMode && agentModeContext && !agentCoachSeen && (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-edge-strong bg-surface-overlay px-2 py-1.5 text-xs text-fg-secondary">
          <span className="min-w-0 flex-1">
            Summon an agent with <span className="font-semibold">!!</span>, the ⚡ button, or right-click a message →
            “Delegate to agent…”. It reads this conversation before starting. Esc exits.
          </span>
          <button
            type="button"
            onClick={dismissAgentCoach}
            aria-label="Dismiss agent mode tip"
            className="shrink-0 rounded px-1 text-fg-muted hover:bg-surface-raised hover:text-fg"
          >
            ✕
          </button>
        </div>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone handles drag/drop events; keyboard file attachment uses the adjacent Attach button. */}
      <div
        title={disabled ? disabledHint : undefined}
        onDragOver={(e) => {
          if (!allowAttachments || disabled) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`relative rounded-lg border px-3 py-2 ${
          disabled
            ? 'border-edge bg-surface-raised/40'
            : dragOver
              ? 'border-accent-hover bg-surface-raised'
              : agentMode
                ? 'border-accent/60 bg-surface-raised focus-within:border-accent'
                : 'border-edge-strong bg-surface-raised focus-within:border-edge-focus'
        }`}
      >
        {mentions.open && (
          <MentionSuggestions
            activeIndex={mentions.activeIndex}
            candidates={mentions.candidates}
            listboxId={mentions.listboxId}
            optionId={mentions.optionId}
            onActiveIndexChange={mentions.setActiveIndex}
            onInsert={mentions.insert}
          />
        )}
        {mentions.nonMembers.length > 0 && (
          <div className="mb-1.5 flex flex-col gap-1 rounded border border-warning-border/50 bg-warning-tint/20 px-2 py-1.5 text-xs text-warning-text">
            {mentions.nonMembers.map((user) => (
              <span key={user.id} className="flex items-center gap-2">
                <span className="min-w-0 truncate">@{user.handle} isn’t in this channel and won’t be notified</span>
                <button
                  type="button"
                  className="shrink-0 rounded border border-warning-border/60 px-1.5 py-0.5 font-medium hover:bg-warning-tint/40"
                  onClick={() => void mentions.invite(user.id).catch(() => {})}
                >
                  Invite
                </button>
              </span>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {files.map((p) => (
              <span
                key={p.key}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                  p.status === 'failed'
                    ? 'border-danger-border text-danger-text'
                    : 'border-edge-strong text-fg-secondary'
                }`}
              >
                {p.file.type.startsWith('image/') ? (
                  <img src={p.localUri} alt="" className="h-7 w-7 rounded object-cover" draggable={false} />
                ) : (
                  <span aria-hidden>
                    <FileIcon />
                  </span>
                )}
                <span className="max-w-40 truncate">{p.file.name || 'pasted image'}</span>
                <span className="text-fg-muted">{formatBytes(p.file.size)}</span>
                {p.status === 'uploading' && <span className="text-fg-muted">uploading…</span>}
                {p.status === 'failed' && (
                  <button
                    type="button"
                    onClick={() => {
                      removeFile(p.key);
                      void startUpload(p.file);
                    }}
                    className="font-medium hover:underline"
                  >
                    retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => removeFile(p.key)}
                  aria-label={`Remove ${p.file.name || 'pasted image'}`}
                  className="text-fg-muted hover:text-fg-body"
                >
                  <XIcon />
                </button>
              </span>
            ))}
          </div>
        )}
        {attachmentNotice && <div className="mb-2 px-1 text-xs font-medium text-danger-text">{attachmentNotice}</div>}
        <div className="flex items-end gap-2">
          {allowAttachments && !disabled && (
            <>
              <Tooltip content="Attach a file">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach a file"
                  className="rounded-md px-1 py-1 text-sm text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
                >
                  <PaperclipIcon />
                </button>
              </Tooltip>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </>
          )}
          {allowAttachments && allowVoice && !disabled && (
            <VoiceRecorder
              disabled={disabled || uploading || files.length > 0 || text.trim().length > 0}
              onSend={sendVoice}
              onActiveChange={setVoiceActive}
            />
          )}
          {!voiceActive && (
            <>
              {agentModeContext && !disabled && (
                <Tooltip
                  content={agentMode ? 'Exit agent mode' : 'Agent mode'}
                  shortcut={SHORTCUTS.toggleAgentMode.keys}
                >
                  <button
                    type="button"
                    onClick={() => setAgentMode((value) => !value)}
                    aria-label={agentMode ? 'Exit agent mode' : 'Enter agent mode'}
                    aria-pressed={agentMode}
                    className={`rounded-md px-1.5 py-1 text-sm ${agentMode ? 'bg-accent/15 text-accent-text-strong' : 'text-fg-muted hover:bg-surface-overlay hover:text-fg-body'}`}
                  >
                    ⚡
                  </button>
                </Tooltip>
              )}
              <textarea
                ref={ref}
                rows={1}
                value={text}
                disabled={disabled}
                placeholder={disabled ? (disabledHint ?? placeholder) : agentMode ? 'Describe the task…' : placeholder}
                aria-label="Message input"
                aria-expanded={mentions.open}
                aria-controls={mentions.open ? mentions.listboxId : undefined}
                aria-activedescendant={mentions.open ? mentions.optionId(mentions.activeIndex) : undefined}
                role="combobox"
                aria-autocomplete="list"
                onChange={(e) => {
                  const next = e.target.value;
                  const summonSource = next.trimStart();
                  const summon =
                    agentModeContext && !agentMode && looksLikeSummonSigil(summonSource)
                      ? parseSummonSigil(summonSource)
                      : null;
                  if (agentModeContext && !agentMode && (summonSource === '!!' || summon != null)) {
                    setAgentMode(true);
                    const task = summon?.task ?? '';
                    e.target.value = task;
                    mentions.onValueChange(task, task.length);
                  } else {
                    mentions.onValueChange(next, e.target.selectionStart ?? next.length);
                  }
                  if (draftKey) {
                    onDraftTouched?.(draftKey);
                    draftWriter.schedule(draftKey, summon?.task ?? (summonSource === '!!' ? '' : next));
                  }
                  setAgentNeedsTask(false);
                  if (e.target.value.trim()) onTyping?.();
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                }}
                onKeyDown={onKeyDown}
                onSelect={(e) => mentions.trackSelection(e.currentTarget)}
                onKeyUp={(e) => mentions.trackSelection(e.currentTarget)}
                onPaste={(e) => {
                  if (!allowAttachments || disabled) return;
                  if (e.clipboardData?.files?.length) {
                    e.preventDefault();
                    addFiles(e.clipboardData.files);
                  }
                }}
                className="max-h-40 flex-1 resize-none bg-transparent text-sm leading-relaxed text-fg placeholder-fg-muted outline-none disabled:cursor-not-allowed disabled:placeholder-fg-faint"
              />
              <Tooltip content={sendTooltip} shortcut={SHORTCUTS.sendMessage.keys}>
                <button
                  type="button"
                  onClick={(e) => {
                    if (sendDisabled) {
                      e.preventDefault();
                      return;
                    }
                    send();
                  }}
                  aria-disabled={sendDisabled || undefined}
                  className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover aria-disabled:cursor-default aria-disabled:bg-surface-overlay aria-disabled:text-fg-muted"
                >
                  Send
                </button>
              </Tooltip>
            </>
          )}
        </div>
      </div>
      {entryLinkHandles.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 px-1 text-3xs text-fg-muted">
          <span className="font-medium">referencing:</span>
          {entryLinkHandles.map((handle) => (
            <EntryInlineChip key={handle} handle={handle} />
          ))}
        </div>
      )}
      <div className="mt-1 flex items-center gap-2 px-1 text-3xs text-fg-muted">
        {text.startsWith('@agent ') ? (
          <span className="rounded-full bg-warning/15 px-2 py-0.5 font-medium text-warning-text">
            Summon agents with !! or ⚡ — mentions are for people now.
          </span>
        ) : agentNeedsTaskHint ? (
          <span className="rounded-full bg-warning/15 px-2 py-0.5 font-medium text-warning-text">
            Add a task: !!&lt;task&gt;
          </span>
        ) : configureAgentHint ? (
          <Tooltip content="Configure and start an agent">
            <button
              type="button"
              onClick={() => onConfigureAgent(text)}
              aria-label="Configure and start an agent"
              className="rounded-full bg-accent-hover/15 px-2 py-0.5 font-medium text-accent-text-strong transition-colors hover:bg-accent-hover/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span aria-hidden>✦</span> Start an agent · Configure ▸
            </button>
          </Tooltip>
        ) : agentHint ? (
          <span className="rounded-full bg-accent-hover/15 px-2 py-0.5 font-medium text-accent-text-strong">
            !! — spawns an agent
          </span>
        ) : footer !== undefined ? (
          footer
        ) : (
          <span>
            {disabled
              ? (disabledHint ?? '')
              : agentModeContext
                ? 'Enter to send · Shift+Enter for a new line · !! or ⚡ for an agent'
                : agentAware
                  ? 'Enter to send · Shift+Enter for a new line · !!<task> spawns an agent'
                  : 'Enter to send · Shift+Enter for a new line'}
          </span>
        )}
      </div>
      {agentOptionsOpen && agentModeContext && (
        <div className="fixed inset-0 z-50 flex items-end min-[431px]:hidden">
          <button
            type="button"
            aria-label="Close agent mode options"
            onClick={() => setAgentOptionsOpen(false)}
            className="absolute inset-0 bg-black/30"
          />
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Agent mode options"
            className="relative w-full rounded-t-xl border border-edge-strong bg-surface-overlay p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-xl"
          >
            <div className="mb-3 text-sm font-semibold text-fg">Agent mode</div>
            {canTargetSession && (
              <div className="mb-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setAgentTarget('session')}
                  className={`rounded-md border px-2 py-2 text-xs ${agentTarget === 'session' ? 'border-accent bg-accent/10 text-accent-text-strong' : 'border-edge-strong text-fg-secondary'}`}
                >
                  {isDriver ? 'Steer session' : 'Suggest'}
                </button>
                <button
                  type="button"
                  onClick={() => setAgentTarget('thread')}
                  className={`rounded-md border px-2 py-2 text-xs ${agentTarget === 'thread' ? 'border-accent bg-accent/10 text-accent-text-strong' : 'border-edge-strong text-fg-secondary'}`}
                >
                  New session
                </button>
              </div>
            )}
            <label className="mb-3 flex items-center justify-between text-sm text-fg-secondary">
              <span>Effort</span>
              <select
                value={agentEffort}
                onChange={(e) => setAgentEffort(e.target.value)}
                aria-label="Agent effort"
                className="rounded border border-edge-strong bg-surface-raised px-2 py-1 text-sm text-fg"
              >
                <option value="">Default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="max">Max</option>
              </select>
            </label>
            <div className="mb-2 text-xs leading-5 text-fg-muted">
              The agent reads this conversation before starting (⚓ anchor).
            </div>
            <div className="flex items-center justify-between text-sm text-fg-secondary">
              <span>
                <span aria-hidden>⚓ </span>
                {anchorLabel}
              </span>
              {agentAnchor && (
                <button
                  type="button"
                  onClick={() => setAgentAnchor(undefined)}
                  className="rounded px-2 py-1 text-xs text-accent-text-strong hover:bg-accent/10"
                >
                  Clear
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
});
