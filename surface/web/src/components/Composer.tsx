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
  /** The restored draft was written for an agent — re-show the "draft kept" strip. */
  initialDraftAgentIntent?: boolean;
  onDraftChange?: (key: string, text: string, agentIntent: boolean) => void | Promise<void>;
  onDraftPersisted?: (key: string, text: string, agentIntent: boolean) => void | Promise<void>;
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
  /**
   * Session-pane audience control: the pane owns the send mode, so it drives
   * the in-input pill from outside. Channel and thread composers get the same
   * pill for free from `agentMode` — they just own the state internally.
   */
  audiencePill?: {
    mode: 'agent' | 'thread';
    /** Pill text in agent mode (e.g. "Steer · “Fix tests”"). */
    agentLabel: string;
    /** Pill text in thread mode (e.g. "this thread"). */
    threadLabel: string;
    onModeChange: (mode: 'agent' | 'thread') => void;
    /** Send-button verb per mode (e.g. "Steer"/"Suggest" and "Reply"). */
    agentSendLabel: string;
    threadSendLabel: string;
  };
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
    initialDraftAgentIntent,
    onDraftChange,
    onDraftPersisted,
    onDraftTouched,
    previewEntryLinks,
    agentMode: agentModeContext,
    onAgentSend,
    mentionContext,
    onAgentModeChange,
    audiencePill,
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
  // The draft was typed for an agent. Survives leaving agent mode (and a
  // cross-device restore) so an agent command can never quietly become chat.
  const [draftAgentIntent, setDraftAgentIntent] = useState(false);
  const [agentIntentSeen, setAgentIntentSeen] = useState(false);
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
        (key, value, agentIntent) => onDraftChange?.(key, value, agentIntent),
        400,
        (key, value, agentIntent) => onDraftPersisted?.(key, value, agentIntent),
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
  // One audience grammar for every composer. The pane hands its mode in from
  // outside (it owns the send route); channel and thread composers own it here.
  // Either way the pill below is the single place the audience is named or changed.
  const audienceAvailable = !!agentModeContext || !!audiencePill;
  const agentAudience = audiencePill ? audiencePill.mode === 'agent' : agentMode;
  const pillAgentLabel = audiencePill ? audiencePill.agentLabel : targetLabel;
  const pillChatLabel = audiencePill ? audiencePill.threadLabel : (agentModeContext?.channelLabel ?? 'this thread');
  const setAgentAudience = useCallback(
    (next: boolean) => {
      if (audiencePill) audiencePill.onModeChange(next ? 'agent' : 'thread');
      else setAgentMode(next);
    },
    [audiencePill],
  );
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
    onAgentModeChange?.(agentAudience);
  }, [agentAudience, onAgentModeChange]);

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
    setDraftAgentIntent(false);
    setAgentIntentSeen(false);
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

  // A restored draft brings its audience with it: an agent-intent draft comes
  // back wearing the "draft kept" strip, never as an innocent chat draft.
  useEffect(() => {
    if (!initialDraftAgentIntent || !initialDraft) return;
    setDraftAgentIntent(true);
    setAgentIntentSeen(false);
  }, [initialDraft, initialDraftAgentIntent]);

  useEffect(() => {
    setAgentTarget('session');
    setAgentAnchor(agentModeContext?.initialAnchor);
    setAgentEffort(attachedSession?.modelEffort ?? '');
  }, [agentModeContext?.initialAnchor, attachedSession?.id, attachedSession?.modelEffort]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const persistDraftValue = useCallback(
    (value: string, agentIntent = false) => {
      if (!draftKey) return;
      onDraftTouched?.(draftKey);
      draftWriter.saveNow(draftKey, value, agentIntent);
    },
    [draftKey, draftWriter, onDraftTouched],
  );

  /** Leaving agent mode with text still in the input: the draft keeps its
   *  audience and says so, rather than silently becoming an ordinary message. */
  const leaveAgentAudience = useCallback(() => {
    setAgentAudience(false);
    const kept = text.trim().length > 0;
    setDraftAgentIntent(kept);
    setAgentIntentSeen(false);
    persistDraftValue(text, kept);
  }, [persistDraftValue, setAgentAudience, text]);

  const clearAgentIntentDraft = useCallback(() => {
    setText('');
    mentions.clear();
    setDraftAgentIntent(false);
    setAgentIntentSeen(false);
    setAgentNeedsTask(false);
    persistDraftValue('');
    if (ref.current) ref.current.style.height = 'auto';
    requestAnimationFrame(() => ref.current?.focus());
  }, [mentions.clear, persistDraftValue]);

  const resumeAgentAudience = useCallback(() => {
    setAgentAudience(true);
    persistDraftValue(text, true);
    requestAnimationFrame(() => ref.current?.focus());
  }, [persistDraftValue, setAgentAudience, text]);

  const showAgentIntentStrip = draftAgentIntent && !agentAudience && text.trim().length > 0 && !disabled;

  useEffect(() => {
    if (showAgentIntentStrip) setAgentIntentSeen(true);
  }, [showAgentIntentStrip]);

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
        setDraftAgentIntent(false);
        setAgentIntentSeen(false);
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
    // An agent-intent draft cannot be Enter'd into chat before its strip has
    // been on screen — that strip is the whole point of remembering the audience.
    if (!agentAudience && draftAgentIntent && !agentIntentSeen) {
      setAgentIntentSeen(true);
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
    if (agentAudience && agentModeContext && onAgentSend) {
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
        setAgentAudience(false);
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
    setDraftAgentIntent(false);
    setAgentIntentSeen(false);
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
    if (audienceAvailable && matchesChord(e.nativeEvent, SHORTCUTS.toggleAgentMode.keys)) {
      e.preventDefault();
      if (agentAudience) leaveAgentAudience();
      else setAgentAudience(true);
    } else if (e.key === 'Escape' && agentAudience) {
      // stopPropagation too: the window-level Escape handler closes the
      // thread/pane, and exiting a composer mode must not also close the room.
      e.preventDefault();
      e.stopPropagation();
      setAgentOptionsOpen(false);
      setAgentTargetOpen(false);
      leaveAgentAudience();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'ArrowUp' && text === '' && onArrowUpOnEmpty) {
      e.preventDefault();
      onArrowUpOnEmpty();
    }
  };

  const agentTinted = agentAudience;
  return (
    <div className={`border-t bg-surface p-3 ${agentTinted ? 'border-accent/60 bg-accent/5' : 'border-edge'}`}>
      {agentAudience && agentModeContext && (
        <div className="mb-2 hidden min-w-0 flex-wrap items-center gap-1.5 px-1 min-[431px]:flex">
          {/* The pill in the input frame already names the target — this row is
              only the options that change it. */}
          {canTargetSession && (
            <div className="relative min-w-0">
              <button
                type="button"
                onClick={() => setAgentTargetOpen((value) => !value)}
                aria-expanded={agentTargetOpen}
                aria-haspopup="menu"
                className="flex min-w-0 items-center gap-1 rounded-full border border-accent/35 bg-accent/10 px-2 py-1 text-xs font-medium text-accent-text-strong hover:bg-accent/15"
              >
                <span className="truncate">Change target</span>
                <span aria-hidden>▾</span>
              </button>
              {agentTargetOpen && (
                <div
                  role="menu"
                  className="absolute bottom-full left-0 z-dropdown mb-1 w-64 rounded-md border border-edge-strong bg-surface-overlay p-1 shadow-lg"
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
          )}
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
      {agentAudience && agentModeContext && (
        <div className="mb-2 flex min-w-0 items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-xs text-accent-text-strong min-[431px]:hidden">
          <button
            type="button"
            onClick={() => setAgentOptionsOpen(true)}
            aria-label="Agent mode options"
            className="min-w-0 flex-1 truncate text-left font-medium"
          >
            <span aria-hidden>⚓ </span>
            {anchorLabel} · Options ▾
          </button>
        </div>
      )}
      {showAgentIntentStrip && (
        <div
          data-testid="composer-agent-intent-strip"
          role="status"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-xs text-accent-text-strong"
        >
          <span className="min-w-0 flex-1">
            <span aria-hidden>⚡ </span>Agent mode off — draft kept
          </span>
          <button
            type="button"
            onClick={resumeAgentAudience}
            className="shrink-0 rounded-full bg-accent px-2 py-0.5 font-semibold text-on-accent hover:bg-accent-hover"
          >
            Resume ⚡
          </button>
          <button
            type="button"
            onClick={clearAgentIntentDraft}
            className="shrink-0 rounded-full border border-edge-strong px-2 py-0.5 font-medium text-fg-secondary hover:bg-surface-overlay hover:text-fg"
          >
            Clear draft
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
              : agentTinted
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
        {/* flex-wrap + a real min-width on the textarea is the contract that keeps the
            pill from starving the input: in a narrow frame (a dragged-in thread pane)
            the textarea drops to its own line under the pill instead of being squeezed
            to zero width. A flex child with flex-basis:0 will happily shrink to nothing. */}
        <div className="flex flex-wrap items-end gap-2">
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
          {/* One audience grammar, every composer: a persistent pill inside the
              input frame that names who the message is for. Tap flips it; !!
              flips it to the agent; Esc flips it back. There is no other door. */}
          {!voiceActive && audienceAvailable && !disabled && (
            <Tooltip
              content={
                agentAudience
                  ? 'Talking to the agent — tap to reply to people instead (Esc)'
                  : 'Talking to people — tap to address the agent (or type !!)'
              }
              shortcut={SHORTCUTS.toggleAgentMode.keys}
            >
              <button
                type="button"
                data-testid="composer-audience-pill"
                aria-pressed={agentAudience}
                // Named explicitly, not by its own text: the chat label is literally
                // "#channel", which would give this button the same accessible name as
                // the channel's sidebar button.
                aria-label={
                  agentAudience
                    ? `Sending to the agent: ${pillAgentLabel}. Switch to the conversation`
                    : `Sending to people: ${pillChatLabel}. Switch to the agent`
                }
                onClick={() => {
                  if (agentAudience) leaveAgentAudience();
                  else setAgentAudience(true);
                }}
                className={`inline-flex min-w-0 max-w-[45%] shrink basis-auto items-center gap-1 self-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold transition-colors [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3 ${
                  agentAudience
                    ? 'bg-accent text-on-accent hover:bg-accent-hover'
                    : 'border border-edge-strong bg-surface-overlay text-fg-secondary hover:bg-surface-raised hover:text-fg'
                }`}
              >
                <span aria-hidden>{agentAudience ? '⚡' : '💬'}</span>
                <span aria-hidden className="truncate">
                  {agentAudience ? pillAgentLabel : pillChatLabel}
                </span>
              </button>
            </Tooltip>
          )}
          {!voiceActive && (
            <>
              <textarea
                ref={ref}
                rows={1}
                value={text}
                disabled={disabled}
                placeholder={
                  disabled
                    ? (disabledHint ?? placeholder)
                    : // The pane supplies its own audience-aware placeholder ("Steer the
                      // agent…" / "Reply in the thread…"); only the composers that own
                      // agent mode internally get the generic task prompt.
                      agentAudience && agentModeContext
                      ? 'Describe the task…'
                      : placeholder
                }
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
                    audienceAvailable && !agentAudience && looksLikeSummonSigil(summonSource)
                      ? parseSummonSigil(summonSource)
                      : null;
                  const entering = audienceAvailable && !agentAudience && (summonSource === '!!' || summon != null);
                  let value = next;
                  if (entering) {
                    setAgentAudience(true);
                    value = summon?.task ?? '';
                    e.target.value = value;
                    mentions.onValueChange(value, value.length);
                  } else if ((entering || agentAudience) && text === '' && value !== value.trimStart()) {
                    // Typing "!!" swallows the sigil and empties the input, so the space
                    // in "!! task" lands as a leading space on an empty agent draft.
                    value = value.trimStart();
                    e.target.value = value;
                    mentions.onValueChange(value, value.length);
                  } else {
                    mentions.onValueChange(next, e.target.selectionStart ?? next.length);
                  }
                  // The draft carries its audience from the first keystroke, so a
                  // reload (or another device) restores it as an agent draft.
                  const nextAgentAudience = entering || agentAudience;
                  const nextIntent = value.trim().length > 0 && (nextAgentAudience || draftAgentIntent);
                  setDraftAgentIntent(nextIntent);
                  if (draftKey) {
                    onDraftTouched?.(draftKey);
                    draftWriter.schedule(draftKey, value, nextIntent);
                  }
                  setAgentNeedsTask(false);
                  if (value.trim()) onTyping?.();
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
                className="max-h-40 min-w-40 flex-1 resize-none bg-transparent text-sm leading-relaxed text-fg placeholder-fg-muted outline-none disabled:cursor-not-allowed disabled:placeholder-fg-faint"
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
                  {audiencePill
                    ? audiencePill.mode === 'agent'
                      ? audiencePill.agentSendLabel
                      : audiencePill.threadSendLabel
                    : 'Send'}
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
              : audienceAvailable
                ? 'Enter to send · Shift+Enter for a new line · !! or the ⚡ pill for an agent'
                : agentAware
                  ? 'Enter to send · Shift+Enter for a new line · !!<task> spawns an agent'
                  : 'Enter to send · Shift+Enter for a new line'}
          </span>
        )}
      </div>
      {agentOptionsOpen && agentModeContext && (
        <div className="fixed inset-0 z-overlay flex items-end min-[431px]:hidden">
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
