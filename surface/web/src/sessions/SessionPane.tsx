import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SVGProps,
} from 'react';
import {
  artifactCount,
  changedPaths,
  codexInlineFileChanges,
  collectArtifacts,
  collectFileChanges,
  collectSideEffects,
  deriveTurnStatus,
  fileChangeFromToolCall,
  focusTranscriptRows,
  fullTranscriptRows,
  turnStatusLabel,
  isTerminalExecutionStatus,
  sideEffectCount,
  toolDisplay,
  type TextItem,
  type ToolCallItem,
  type UserMessageItem,
} from '@atrium/centaur-client';
import { isMacDesktop } from '../desktop';
import type { SessionSteerContext } from '../useSessionActions';
import {
  ApiError,
  api,
  type AgentProfile,
  type AgentProfileProposal,
  type ConnectionStatus,
  type ProviderCredentialProvider,
  type ProviderCredentialStatus,
} from '../api';
import { SLUG_TAB, TAB_SLUG, WorkDrawer, type ActiveWorkTab, type WorkTab } from './WorkDrawer';
import type { FilesHubDefaultScope, FilesHubSessionScope } from './FilesHub';
import { useConflicts } from './useConflicts';
import { InlineFileChange } from './fileChangeView';
import { PlanPanel } from './PlanPanel';
import { Composer } from '../components/Composer';
import {
  EntryReferencesChip,
  queryEntryReferencesForHandles,
  type EntryReferenceSummary,
} from '../components/EntryReferencesChip';
import { parseAttachments, splitMarkdownFrontmatter } from '@atrium/surface-client';
import { MarkupPane, type MarkupPaneSource } from '../components/MarkupPane';
import { MarkupSteerCard } from '../components/MarkupSteerCard';
import { Tooltip } from '../components/a11y';
import { ChevronDownIcon, ChevronRightIcon, CornerUpLeftIcon, GearIcon, XIcon } from '../components/icons';
import type {
  AttachmentMeta,
  AttachmentRef,
  ChatMessage,
  UploadPayload,
  UserRef,
  WireEvent,
} from '@atrium/surface-client';
import {
  formatExactTimestamp,
  formatTime,
  formatTurnTime,
  matchSteerProvenance,
  normalizeSteerProvenanceText,
  randomId,
  steerProvenanceKey,
  type SteerProvenance,
} from '@atrium/surface-client';
import { sessionsApi } from './api';
import { repoBranchTitle, useNow } from './SessionCard';
import { GlanceChip } from './GlanceChip';
import {
  HARNESS_EFFORT_PICKER_OPTIONS,
  formatCost,
  formatElapsed,
  isPendingSessionId,
  isStalledSessionStatus,
  isTerminalSessionStatus,
  normalizeExecutionStatus,
  sessionAnsweredQuestion,
  sessionDriverId,
  type SeatAuditEntry,
  type Session,
  type SessionStatus,
} from './types';
import { useSessionStream } from './useSessionStream';
import {
  SESSION_PANE_FALLBACK_WIDTH,
  SESSION_PANE_MAX_VW,
  SESSION_PANE_MIN_WIDTH,
  sessionPaneSizing,
  useSessionPaneWidth,
} from './useSessionPaneWidth';
import { Spinner, TurnStatusLine } from './TurnStatus';
import { useArtifactPresentations } from './useArtifactPresentations';
import { AppPresentationCards } from './AppPresentationCard';
import { SessionCapabilitiesPopover } from './SessionCapabilitiesPopover';
import { SessionMarkdown } from './Markdown';
import { ReasoningBlock } from './ReasoningBlock';
import { SeatAuditLine, SessionTypingLine, TurnRail } from './SessionActivity';
import { ProfileChangesBanner, ProviderAuthBanner, QuestionCard, profileProviderLabel } from './SessionBanners';
import { groupQuestionEventsByQuestion, QuestionTranscriptCard } from './SessionQuestionTranscript';
import { SuggestionStrip } from './SessionSuggestions';
import { showErrorToast } from '../components/Toasts';
import { TimestampDisclosure } from '../components/TimestampDisclosure';
import {
  MessageActionMenu,
  type MessageActionMenuAction,
  type MessageActionMenuState,
} from '../components/MessageActionMenu';
import { SelectTextSheet } from '../components/SelectTextSheet';
import { useLongPress } from '../components/useLongPress';
import { entryParamFromSearch, stripEntryParamFromLocation } from '../EntryLinkRoute';
import { entryShareUrl, sessionShareUrl } from '../lib/publicUrl';
import { navigate, URL_PARAMS, useLocation } from '../router';
import { useTranscriptView } from './useTranscriptView';

// Skip offscreen rendering work so 500+ item transcripts scroll smoothly.
const ITEM_VIS: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' };
const ENTRY_REFERENCES_REFETCH_MS = 60_000;
const MOBILE_MEDIA_QUERY = '(max-width: 767px)';
const HOVER_NONE_MEDIA_QUERY = '(hover: none)';

function HiddenWorkChip({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="hidden-work-chip"
      onClick={onClick}
      className="my-1 flex items-center gap-1 pl-3.5 text-2xs text-fg-faint hover:text-fg-muted"
    >
      <GearIcon size={11} />
      {count} work {count === 1 ? 'step' : 'steps'}
    </button>
  );
}

function isMobileViewportNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(MOBILE_MEDIA_QUERY).matches
    : false;
}

function isTextEditingEscapeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, .ProseMirror')) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  const editable = target.closest('[contenteditable]');
  return editable instanceof HTMLElement && editable.isContentEditable;
}

function escapeHasLocalMeaning(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : document.activeElement;
  if (isTextEditingEscapeTarget(target)) return true;
  return Boolean(target?.closest('[role="dialog"], [role="menu"], [role="listbox"], [aria-modal="true"]'));
}

function isPlainEscape(event: KeyboardEvent): boolean {
  return (
    event.key === 'Escape' && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
  );
}

function useIsMobileViewport(): boolean {
  const [isMobileViewport, setIsMobileViewport] = useState(isMobileViewportNow);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(MOBILE_MEDIA_QUERY);
    const sync = () => setIsMobileViewport(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return isMobileViewport;
}

function isHoverNoneNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(HOVER_NONE_MEDIA_QUERY).matches
    : false;
}

export function useIsHoverNone(): boolean {
  const [isHoverNone, setIsHoverNone] = useState(isHoverNoneNow);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(HOVER_NONE_MEDIA_QUERY);
    const sync = () => setIsHoverNone(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return isHoverNone;
}

function isTouchContextMenu(event: MouseEvent): boolean {
  return 'pointerType' in event && event.pointerType === 'touch';
}

function isInteractiveTarget(target: EventTarget): boolean {
  return (
    target instanceof Element &&
    target.closest('a,button,[role="button"],input,textarea,select,summary,[contenteditable="true"]') != null
  );
}

export function isTranscriptEntryHandle(handle: string | null): handle is string {
  return typeof handle === 'string' && handle.startsWith('rec_');
}

type OutputSurface = 'conflicts' | 'changes' | 'sideEffects' | 'artifacts';
type OutputCounts = Record<OutputSurface, number>;
type PendingSteer = {
  id: string;
  clientMsgId?: string;
  text: string;
  ts: string;
  delivered?: boolean;
  existingMessageIds?: string[];
  provenance?: SteerProvenance;
  acceptedByMe?: boolean;
  attachments?: AttachmentMeta[];
};
type LinkedSteer = {
  id: number | string;
  clientMsgId: string | null;
  author: string;
  createdAt: string;
  text: string;
  attachments?: AttachmentMeta[];
  status?: ChatMessage['status'];
};
type SteerProvenanceView = {
  provenance: SteerProvenance;
  acceptedByMe: boolean;
};

const STEER_ECHO_WINDOW_MS = 5 * 60 * 1000;

function laterSteerEchoMatches(sentAt: string | undefined, echoedAt: string | undefined): boolean {
  if (!sentAt || !echoedAt) return false;
  const sentMs = Date.parse(sentAt);
  const echoedMs = Date.parse(echoedAt);
  return (
    Number.isFinite(sentMs) &&
    Number.isFinite(echoedMs) &&
    echoedMs >= sentMs &&
    echoedMs - sentMs <= STEER_ECHO_WINDOW_MS
  );
}

function linkedSteerMatchesUserMessage(linked: LinkedSteer, item: UserMessageItem): boolean {
  if (
    linked.clientMsgId != null &&
    (item.id === linked.clientMsgId || item.sourceEventIds.some((id) => String(id) === linked.clientMsgId))
  ) {
    return true;
  }
  return (
    normalizeSteerProvenanceText(linked.text) === normalizeSteerProvenanceText(item.text) &&
    laterSteerEchoMatches(linked.createdAt, item.ts)
  );
}

export function reconcileLinkedSteers(linkedSteers: LinkedSteer[], userMessages: UserMessageItem[]): LinkedSteer[] {
  const consumed = new Set<string>();
  return linkedSteers.filter((linked) => {
    const match = userMessages.find(
      (item) =>
        !consumed.has(item.id) &&
        (linked.status === 'failed'
          ? linked.clientMsgId != null && item.id === linked.clientMsgId
          : linkedSteerMatchesUserMessage(linked, item)),
    );
    if (!match) return true;
    consumed.add(match.id);
    return false;
  });
}

function reconcileOptimisticLinkedSteers(optimistic: LinkedSteer[], durable: LinkedSteer[]): LinkedSteer[] {
  const consumed = new Set<number | string>();
  const remaining = optimistic.filter((pending) => {
    const match = durable.find(
      (confirmed) =>
        !consumed.has(confirmed.id) && pending.clientMsgId != null && pending.clientMsgId === confirmed.clientMsgId,
    );
    const fallback =
      pending.status === 'pending'
        ? durable.find(
            (confirmed) =>
              !consumed.has(confirmed.id) &&
              normalizeSteerProvenanceText(pending.text) === normalizeSteerProvenanceText(confirmed.text) &&
              laterSteerEchoMatches(pending.createdAt, confirmed.createdAt),
          )
        : undefined;
    const echo = match ?? fallback;
    if (!echo) return true;
    consumed.add(echo.id);
    return false;
  });
  return [...durable, ...remaining];
}

function outputsVisibleInTab(tab: WorkTab | null): OutputSurface[] {
  if (tab === 'conflicts') return ['conflicts'];
  if (tab === 'sideEffects') return ['sideEffects'];
  if (tab === 'changes' || tab === 'artifacts') return ['changes', 'artifacts'];
  return [];
}

export function seenOutputCountsAfterOpeningTab(
  seen: OutputCounts,
  counts: OutputCounts,
  tab: WorkTab | null,
): OutputCounts {
  const visible = outputsVisibleInTab(tab);
  if (visible.length === 0) return seen;
  let changed = false;
  const next = { ...seen };
  for (const key of visible) {
    if (next[key] !== counts[key]) {
      next[key] = counts[key];
      changed = true;
    }
  }
  return changed ? next : seen;
}

export function unseenOutputsForCounts(
  seen: OutputCounts,
  counts: OutputCounts,
  openTab: WorkTab | null,
): Record<OutputSurface, boolean> {
  const visible = new Set(outputsVisibleInTab(openTab));
  return {
    conflicts: !visible.has('conflicts') && counts.conflicts > seen.conflicts,
    changes: !visible.has('changes') && counts.changes > seen.changes,
    sideEffects: !visible.has('sideEffects') && counts.sideEffects > seen.sideEffects,
    artifacts: !visible.has('artifacts') && counts.artifacts > seen.artifacts,
  };
}

export function notifyUnseenOutputsChange(
  lastReported: boolean | null,
  next: boolean,
  onUnseenOutputs: (hasUnseen: boolean) => void,
): boolean {
  if (lastReported === next) return lastReported;
  onUnseenOutputs(next);
  return next;
}

function pathWithSearch(pathname: string, searchParams: URLSearchParams, hash = ''): string {
  const search = searchParams.toString();
  return `${pathname}${search ? `?${search}` : ''}${hash}`;
}

function isInPaneSessionRoute(pathname: string, sessionId: string): boolean {
  const encoded = encodeURIComponent(sessionId);
  return pathname === `/s/${encoded}` || new RegExp(`^/c/[^/]+/s/${encoded}$`).test(pathname);
}

export interface TranscriptDiscussPayload {
  handle: string;
  channelId: string;
  threadRootEventId: number;
  draft: string;
}

function outputStripClass({ danger = false, unseen = false }: { danger?: boolean; unseen?: boolean }): string {
  if (danger) {
    return `flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-left text-2xs text-danger-text hover:opacity-90 ${
      unseen
        ? 'border-danger-border-strong bg-danger-surface/90 ring-1 ring-inset ring-danger-border/70'
        : 'border-danger-edge bg-danger-surface'
    }`;
  }
  return `flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-left text-2xs hover:bg-surface-overlay ${
    unseen
      ? 'border-accent-border-muted bg-accent-tint text-fg-body ring-1 ring-inset ring-accent-border-muted'
      : 'border-edge bg-surface-raised text-fg-secondary'
  }`;
}

function OutputLabel({ children, unseen, danger = false }: { children: ReactNode; unseen: boolean; danger?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {unseen && (
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${danger ? 'bg-danger-text-strong' : 'bg-accent-text-strong'}`}
        />
      )}
      <span
        className={`font-semibold ${
          unseen ? (danger ? 'text-danger-text-strong' : 'text-accent-text-strong') : 'text-fg-muted'
        }`}
      >
        {children}
      </span>
    </span>
  );
}

export function SessionPane({
  session,
  me,
  watchers,
  typers = [],
  onComposerTyping,
  onClose,
  onAnswerQuestion,
  onSteer = async () => {},
  queueUpload,
  failedSteer = null,
  onClearFailedSteer = () => {},
  onCancelSession = async () => {},
  onStopTurn = async () => {},
  failedCancel = false,
  onClearFailedCancel = () => {},
  onSetArchived,
  onSetPinned,
  providerCredentials,
  githubConnection,
  onConnectProvider,
  onConnectGitHub,
  agentProfiles = [],
  layout = 'split',
  onToggleFocus,
  initialEntryHandle = null,
  origin,
  liveEvent = null,
  optimisticThreadSteers = [],
  popout = false,
  onUnseenOutputs,
  filesDefaultScope,
  onDiscussEntry,
  onApiError = () => {},
}: {
  session: Session;
  me: UserRef;
  /** Presence list for `session:<id>` — everyone with this pane open. */
  watchers: UserRef[];
  /** Others currently composing a steer/suggestion here (excludes me). */
  typers?: UserRef[];
  /** Throttle at the call site; fired while the composer has text. */
  onComposerTyping?: () => void;
  onClose: () => void;
  onAnswerQuestion: (
    sessionId: string,
    questionId: string,
    answers: Record<string, { answers: string[] }>,
  ) => Promise<void>;
  onSteer?: (
    sessionId: string,
    text: string,
    effort?: string,
    attachments?: AttachmentMeta[],
    attachmentRefs?: AttachmentRef[],
    context?: SessionSteerContext,
  ) => Promise<void>;
  queueUpload?: (payload: UploadPayload) => Promise<{ fileId: string }>;
  failedSteer?: string | null;
  onClearFailedSteer?: () => void;
  onCancelSession?: (sessionId: string) => Promise<void>;
  onStopTurn?: (sessionId: string) => Promise<void>;
  failedCancel?: boolean;
  onClearFailedCancel?: () => void;
  /** Global archive toggle; omit to hide the header control. */
  onSetArchived?: (sessionId: string, archived: boolean, previousArchivedAt: string | null) => void;
  /** Per-user pin toggle; omit to hide the header control. */
  onSetPinned?: (sessionId: string, pinned: boolean, previousPinned: boolean) => void;
  providerCredentials?: Record<string, ProviderCredentialStatus | undefined>;
  githubConnection?: ConnectionStatus;
  onConnectProvider?: (provider: ProviderCredentialProvider) => void;
  onConnectGitHub?: () => void;
  /** The viewer's agent profiles — matched by version id to surface the
   * session's configured reasoning effort (codex `model_reasoning_effort`).
   * Watchers without the spawner's profile simply see no effort. */
  agentProfiles?: AgentProfile[];
  /** 'split' = peek beside the channel; 'focus' = full-width, channel hidden. */
  layout?: 'split' | 'focus';
  /** Toggle between split and focus; omit to hide the expand control. */
  onToggleFocus?: () => void;
  initialEntryHandle?: string | null;
  /** Live wire events from Chat's socket — folds thread replies instantly. */
  liveEvent?: WireEvent | null;
  /** Queue-backed thread steers shown before their durable event arrives. */
  optimisticThreadSteers?: ChatMessage[];
  /**
   * Where this pane was zoomed from — renders the place crumb
   * (#channel ▸ thread ▸ work) so the zoom levels stay legible and
   * reversible. Absent in popouts, which have no host surface.
   */
  origin?: {
    channelLabel: string;
    onOpenChannel: () => void;
    /** Zoom out one level: the session's conversation thread. */
    onOpenThread?: () => void;
  };
  /** Standalone `/s/:id/pane` context; retargets header controls back to the full app. */
  popout?: boolean;
  /** Fired when any output strip has grown since it was last viewed. */
  onUnseenOutputs?: (hasUnseen: boolean) => void;
  /** Initial Files tab scope. Popouts use session scope; in-app panes retain channel scope. */
  filesDefaultScope?: FilesHubDefaultScope;
  /** Opens the owning channel thread with a prefilled composer draft. Hidden in popouts. */
  onDiscussEntry?: (payload: TranscriptDiscussPayload) => void;
  /** Shared API error hook; invalidates auth on 401 in the app shell. */
  onApiError?: (err: unknown) => void;
}) {
  const locationState = useLocation();
  const [transcriptView, setTranscriptView] = useTranscriptView();
  const showAgentWork = transcriptView === 'full';
  // `active` re-opens the SSE the server closes after a terminal session's
  // replay, so a follow-up steer (which flips the session back to running over
  // WS) streams live instead of appearing only on the next pane mount.
  const { stream, connected, lastFrameAt, clockSkewMs } = useSessionStream(
    session.id,
    !isTerminalSessionStatus(session.status),
  );

  // Changes work-surface (Phase 4): Claude/amp edits from the transcript items +
  // codex fileChange edits the reducer captured.
  const fileChanges = useMemo(() => collectFileChanges(stream), [stream.items, stream.fileChanges]);
  const changedFilePaths = useMemo(() => changedPaths(fileChanges), [fileChanges]);
  const changedFileCount = changedFilePaths.length;
  const sideEffects = useMemo(() => collectSideEffects(stream.items), [stream.items]);
  const sideEffectsN = useMemo(() => sideEffectCount(sideEffects), [sideEffects]);
  const sideEffectsDanger = useMemo(() => sideEffects.some((effect) => effect.risk === 'danger'), [sideEffects]);
  const artifacts = useMemo(() => collectArtifacts(stream), [stream.artifacts]);
  const artifactPresentations = useArtifactPresentations(session.id, stream);
  const artifactsN = useMemo(() => artifactCount(artifacts), [artifacts]);
  // Live conflict feed (A3): polls the ledger change-feed for status=conflict
  // versions and hydrates their both-sides detail for the Conflicts tab.
  // Inert under unit tests (which assert exact global-fetch call counts); fully
  // live in dev/prod. The hook itself is covered in useConflicts.test.tsx.
  const { conflicts, resolve: resolveConflict } = useConflicts(session.id, {
    enabled: import.meta.env.MODE !== 'test',
  });
  const conflictsN = conflicts.length;
  const isMobileViewport = useIsMobileViewport();
  const isHoverNone = useIsHoverNone();
  const [activeTranscriptActionHandle, setActiveTranscriptActionHandle] = useState<string | null>(null);

  useEffect(() => {
    if (!isHoverNone) setActiveTranscriptActionHandle(null);
  }, [isHoverNone]);

  useEffect(() => {
    if (!isHoverNone || activeTranscriptActionHandle == null) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-entry-handle]')) return;
      setActiveTranscriptActionHandle(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveTranscriptActionHandle(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activeTranscriptActionHandle, isHoverNone]);

  // Work drawer (Phase 4): one tabbed surface over Changes + Side-effects, with
  // a peek→pin ladder. `workTab` null = closed; `workPinned` docks it beside the
  // transcript. Pinning gives the transcript room by collapsing to focus (the
  // ratified pane-cap rule); we restore split on unpin only if pin caused it.
  const [workTab, setWorkTab] = useState<WorkTab | null>(null);
  const [workPinned, setWorkPinned] = useState(false);
  const canPinWork = !isMobileViewport;
  const workPinnedEffective = workPinned && canPinWork;
  const workAutoFocusedRef = useRef(false);
  const workUrlSyncedRef = useRef(false);
  const restoreSplitIfAuto = () => {
    if (workAutoFocusedRef.current && onToggleFocus) {
      workAutoFocusedRef.current = false;
      onToggleFocus();
    }
  };
  const writeWorkParam = useCallback(
    (tab: ActiveWorkTab | null, options: { replace?: boolean } = {}) => {
      // Read the LIVE location: pin/focus flows write the URL twice in one
      // tick, and the render-captured search would clobber the earlier write.
      if (typeof window === 'undefined') return;
      if (popout || !isInPaneSessionRoute(window.location.pathname, session.id)) return;
      const params = new URLSearchParams(window.location.search);
      if (tab) params.set(URL_PARAMS.work, TAB_SLUG[tab]);
      else params.delete(URL_PARAMS.work);
      workUrlSyncedRef.current = tab != null;
      navigate(pathWithSearch(window.location.pathname, params, window.location.hash), options);
    },
    [popout, session.id],
  );
  const closeWork = useCallback(() => {
    const wasPinned = workPinned;
    setWorkTab(null);
    setWorkPinned(false);
    workUrlSyncedRef.current = false;
    if (wasPinned) writeWorkParam(null);
    restoreSplitIfAuto();
  }, [workPinned, writeWorkParam]);
  const urlWorkTab = useMemo(() => {
    if (popout || !isInPaneSessionRoute(locationState.pathname, session.id)) return null;
    const raw = new URLSearchParams(locationState.search).get(URL_PARAMS.work);
    return raw ? (SLUG_TAB[raw] ?? null) : null;
  }, [locationState.pathname, locationState.search, popout, session.id]);
  useEffect(() => {
    if (urlWorkTab) {
      workUrlSyncedRef.current = true;
      setWorkTab(urlWorkTab);
      setWorkPinned(true);
      return;
    }
    if (!workUrlSyncedRef.current) return;
    workUrlSyncedRef.current = false;
    setWorkPinned(false);
    setWorkTab(null);
    restoreSplitIfAuto();
  }, [urlWorkTab]);
  const outputHubOpen = workTab === 'hubFiles' || workTab === 'apps';
  const onOutputHubStrip = () => {
    if (outputHubOpen && !workPinnedEffective) closeWork();
    else {
      setWorkTab('hubFiles');
      if (workPinned) writeWorkParam('hubFiles', { replace: true });
    }
  };
  const onStrip = (tab: WorkTab) => {
    if (workTab === tab && !workPinnedEffective) closeWork();
    else {
      setWorkTab(tab);
      if (workPinned) writeWorkParam(tab === 'artifacts' ? 'changes' : tab, { replace: true });
    }
  };
  const togglePin = () => {
    if (!canPinWork) {
      setWorkPinned(false);
      return;
    }
    if (workPinned) {
      setWorkPinned(false);
      workUrlSyncedRef.current = false;
      writeWorkParam(null);
      restoreSplitIfAuto();
    } else {
      const nextTab = workTab === 'artifacts' ? 'changes' : workTab;
      if (!nextTab) return;
      setWorkPinned(true);
      writeWorkParam(nextTab);
      if (layout === 'split' && onToggleFocus) {
        workAutoFocusedRef.current = true;
        onToggleFocus();
      }
    }
  };
  const setPinnedWorkTab = useCallback(
    (tab: ActiveWorkTab) => {
      setWorkTab(tab);
      if (workPinned) writeWorkParam(tab, { replace: true });
    },
    [workPinned, writeWorkParam],
  );

  const outputCounts = useMemo<OutputCounts>(
    () => ({
      conflicts: conflictsN,
      changes: changedFileCount,
      sideEffects: sideEffectsN,
      artifacts: artifactsN,
    }),
    [artifactsN, changedFileCount, conflictsN, sideEffectsN],
  );
  const [seenOutputCounts, setSeenOutputCounts] = useState<OutputCounts>(outputCounts);
  const unseenOutputs = useMemo(
    () => unseenOutputsForCounts(seenOutputCounts, outputCounts, workTab),
    [outputCounts, seenOutputCounts, workTab],
  );
  const hasUnseenOutputs = Object.values(unseenOutputs).some(Boolean);
  const lastReportedUnseenRef = useRef<boolean | null>(null);

  useEffect(() => {
    setSeenOutputCounts((seen) => seenOutputCountsAfterOpeningTab(seen, outputCounts, workTab));
  }, [outputCounts, workTab]);

  useEffect(() => {
    if (!onUnseenOutputs || lastReportedUnseenRef.current === hasUnseenOutputs) return;
    lastReportedUnseenRef.current = notifyUnseenOutputsChange(
      lastReportedUnseenRef.current,
      hasUnseenOutputs,
      onUnseenOutputs,
    );
  }, [hasUnseenOutputs, onUnseenOutputs]);

  const filesSessionScope = useMemo<FilesHubSessionScope>(() => {
    const paths = new Set<string>();
    for (const path of changedFilePaths) paths.add(path);
    for (const artifact of artifacts) paths.add(artifact.path);
    return { label: 'This session', paths: [...paths] };
  }, [artifacts, changedFilePaths]);

  const terminal = isTerminalSessionStatus(session.status);
  const displayStatus: SessionStatus = terminal
    ? session.status
    : stream.status !== 'idle'
      ? normalizeExecutionStatus(stream.status)
      : session.status;
  const displayTerminal = isTerminalSessionStatus(displayStatus);
  // "stopped by you" is folded from the durable terminal event (reducer
  // `stoppedByUser`), so every viewer sees it and it survives replay/reload; it
  // clears automatically when a new turn starts.
  const stoppedByUser = stream.stoppedByUser === true;
  // A completed session is idle/resumable (a steer regresses completed→queued),
  // NOT ended — only failed/cancelled are truly read-only.
  const isEnded = displayStatus === 'failed' || (displayStatus === 'cancelled' && !stoppedByUser);
  const now = useNow(!displayTerminal);
  const stalled = !displayTerminal && stream.status === 'idle' && isStalledSessionStatus(session, now);
  const costUsd = Math.max(session.costUsd, stream.costUsd);
  const resultText = stream.resultText || session.resultText || '';
  const isSpawner = session.spawnedBy === me.id;
  const spectators = watchers.length;
  const pendingQuestion = session.pendingQuestion !== undefined ? session.pendingQuestion : stream.pendingQuestion;
  const questionEvents = session.questionEvents ?? [];
  const questionEventsByQuestion = useMemo(() => groupQuestionEventsByQuestion(questionEvents), [questionEvents]);
  const answeredQuestion = useMemo(() => sessionAnsweredQuestion(session), [session]);
  const discussContext =
    !popout && session.threadRootEventId != null
      ? { channelId: session.channelId, threadRootEventId: session.threadRootEventId }
      : null;

  // ── Live activity cue ──────────────────────────────────────────────────────
  // The status line only claims what the stream proves (see TurnStatus.tsx).
  // Clocks are anchored to server-stamped frame times — correct when opening a
  // pane mid-turn, identical for every viewer — and "quiet" is phase-aware:
  // every harness is legitimately silent while a tool runs (start → result,
  // nothing between), but streams token deltas continuously while thinking, so
  // only thinking-phase silence is meaningful. Harness-agnostic.
  const activeTurn = !displayTerminal && !stalled;
  const starting = displayStatus === 'spawning' || displayStatus === 'queued';
  const canStopTurn = activeTurn && !starting;
  // Silence counts from mount when no frame ever arrived; the reconnect grace
  // anchors to the actual disconnect moment (see deriveTurnStatus).
  const mountedAtRef = useRef(Date.now());
  const disconnectedAtRef = useRef<number>(Date.now());
  const prevConnectedRef = useRef<boolean>(connected);
  if (prevConnectedRef.current !== connected) {
    prevConnectedRef.current = connected;
    if (!connected) disconnectedAtRef.current = Date.now();
  }
  // The full phase/liveness/clock derivation is shared with mobile — one
  // implementation, identical states on both platforms (see turnStatus.ts in
  // centaur-client for the honesty rules).
  const turnStatus = useMemo(
    () =>
      deriveTurnStatus({
        stream,
        now,
        connected,
        lastFrameAt,
        clockSkewMs,
        mountedAt: mountedAtRef.current,
        disconnectedAt: disconnectedAtRef.current,
        activeTurn,
        starting,
        completed: displayStatus === 'completed',
        pendingQuestionId: pendingQuestion?.questionId ?? null,
        suppressed: Boolean(session.providerAuthRequired),
      }),
    [
      stream,
      now,
      connected,
      lastFrameAt,
      clockSkewMs,
      activeTurn,
      starting,
      displayStatus,
      pendingQuestion,
      session.providerAuthRequired,
    ],
  );
  const turnPhase = turnStatus.phase;
  const turnLiveness = turnStatus.liveness;
  const openTool = turnStatus.openTool;
  const turnElapsedMs = turnStatus.elapsedMs;
  const quietMs = turnStatus.quietMs;
  const waitingMs = turnStatus.waitingMs;
  const tokensUsed = turnStatus.tokens;
  // The session's reasoning effort, rendered as a suffix on the model chip.
  // The session record is authoritative (seeded from the profile at spawn,
  // updated by per-turn overrides); the client-side profile join covers only
  // pre-migration sessions and requires the version to still be current.
  const modelEffort = useMemo(() => {
    if (session.modelEffort) return session.modelEffort;
    const versionId = session.agentProfileVersionId;
    if (!versionId) return null;
    const profile = agentProfiles.find((p) => p.currentVersionId === versionId);
    const settings = profile?.currentVersion?.manifest.settings;
    const effort = settings?.['model_reasoning_effort'] ?? settings?.['effortLevel'];
    return typeof effort === 'string' ? effort : null;
  }, [agentProfiles, session.agentProfileVersionId, session.modelEffort]);
  // Per-turn effort override. Codex takes it natively per turn; for claude
  // the runtime respawns the harness child with a new --effort (--resume
  // keeps the transcript). Staged by the footer picker; rides the next steer,
  // where the server records it and broadcasts session.effort_changed.
  const [effortChoice, setEffortChoice] = useState<string | null>(null);
  const effortSelection = effortChoice ?? modelEffort ?? '';
  const effortOptions = HARNESS_EFFORT_PICKER_OPTIONS[session.harness];
  // Effort stays pickable on ended sessions — it applies to the revive turn.
  const canPickEffort = sessionDriverId(session) === me.id && effortOptions !== undefined;
  // Seat-aware waiting copy: only the driver can actually answer — telling a
  // spectator "waiting for YOUR reply" would send them hunting for an answer
  // box they don't have.
  const waitingOnMe = sessionDriverId(session) === me.id;
  const waitingDriverName = session.driverName ?? session.spawnerName ?? 'the driver';
  const statusLabel = stoppedByUser
    ? 'stopped by you'
    : turnStatusLabel({
        phase: turnPhase,
        starting,
        headline: turnStatus.headline,
        openTool,
        waitingLabel: waitingOnMe ? 'Waiting for your reply' : `Waiting for ${waitingDriverName}`,
      });

  // ── Optimistic steer ───────────────────────────────────────────────────────
  // The session steer op is not optimistic, so a sent steer would only appear
  // once the harness echoes it back as a user_message. Render it immediately and
  // drop each pending bubble when a matching echoed user_message arrives
  // (consume-once by normalized text). Only Codex echoes user messages — on other
  // harnesses the bubble persists as the steer's transcript row, so once the
  // turn goes active we mark it delivered (sticky) and stop dimming it.
  const [pendingSteers, setPendingSteers] = useState<PendingSteer[]>([]);
  const [optimisticProvenanceByMessageId, setOptimisticProvenanceByMessageId] = useState<
    Map<string, { provenance: SteerProvenance; acceptedByMe: boolean }>
  >(new Map());
  useEffect(() => {
    setPendingSteers([]);
    setOptimisticProvenanceByMessageId(new Map());
  }, [session.id]);
  useEffect(() => {
    if (failedSteer == null) return;
    const failedText = normalizeSteerProvenanceText(failedSteer);
    setPendingSteers((prev) => {
      let index = -1;
      for (let candidateIndex = prev.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
        if (normalizeSteerProvenanceText(prev[candidateIndex]?.text ?? '') === failedText) {
          index = candidateIndex;
          break;
        }
      }
      return index < 0 ? prev : prev.filter((_, candidateIndex) => candidateIndex !== index);
    });
  }, [failedSteer]);
  useEffect(() => {
    if (!activeTurn) return;
    // Same-reference return when nothing is undelivered keeps this loop-free
    // with pendingSteers in the deps (covers steers sent mid-turn too).
    setPendingSteers((prev) => (prev.some((p) => !p.delivered) ? prev.map((p) => ({ ...p, delivered: true })) : prev));
  }, [activeTurn, pendingSteers]);
  useEffect(() => {
    if (pendingSteers.length === 0) return;
    // Compute the surviving set OUTSIDE the state updater: the updater must be
    // pure (StrictMode double-invokes it), and consuming the echo map inside it
    // made the second invocation see spent counts and resurrect the bubble.
    const echoed = stream.items.filter((it): it is UserMessageItem => it.type === 'user_message');
    const consumedEchoes = new Set<string>();
    const carriedProvenance = new Map<string, { provenance: SteerProvenance; acceptedByMe: boolean }>();
    const keep = pendingSteers.filter((p) => {
      const t = normalizeSteerProvenanceText(p.text);
      const exactMatch = p.clientMsgId
        ? echoed.find((it) => !consumedEchoes.has(it.id) && it.id === p.clientMsgId)
        : undefined;
      const match =
        exactMatch ??
        echoed.find(
          (it) =>
            !consumedEchoes.has(it.id) &&
            !p.existingMessageIds?.includes(it.id) &&
            normalizeSteerProvenanceText(it.text) === t &&
            (it.ts == null || laterSteerEchoMatches(p.ts, it.ts)),
        );
      if (match) {
        consumedEchoes.add(match.id);
        if (p.provenance) {
          carriedProvenance.set(match.id, {
            provenance: p.provenance,
            acceptedByMe: p.acceptedByMe === true,
          });
        }
        return false;
      }
      return true;
    });
    if (keep.length !== pendingSteers.length) setPendingSteers(keep);
    if (carriedProvenance.size > 0) {
      setOptimisticProvenanceByMessageId((prev) => {
        const next = new Map(prev);
        for (const [id, provenance] of carriedProvenance) next.set(id, provenance);
        return next;
      });
    }
  }, [stream.items, pendingSteers]);

  // ---- driver seat (Phase 3) ----
  const driverId = sessionDriverId(session);
  const isDriver = driverId === me.id;
  const driverPresent = isDriver || watchers.some((u) => u.id === driverId);

  const nameFor = (userId: string | null): string => {
    if (!userId) return 'someone';
    if (userId === me.id) return me.displayName;
    const watcher = watchers.find((u) => u.id === userId);
    if (watcher) return watcher.displayName;
    if (userId === session.driverId && session.driverName) return session.driverName;
    if (userId === session.spawnedBy && session.spawnerName) return session.spawnerName;
    const req = session.pendingSeatRequests.find((r) => r.userId === userId);
    if (req) return req.displayName;
    return userId;
  };
  const driverName = nameFor(driverId);
  const composerStatusText = isDriver
    ? "You're driving this agent"
    : driverPresent
      ? `You're watching — ${driverName} is driving`
      : "You're watching";
  // The pane composer speaks to the agent by default (it's the workbench),
  // with a one-tap thread mode for talking to PEOPLE about the work — the
  // agent never reads thread replies.
  const [paneSendMode, setPaneSendMode] = useState<'agent' | 'thread'>('agent');
  const [asideRefresh, setAsideRefresh] = useState(0);
  // A note that fails must never vanish — hold the text for an explicit retry.
  const [threadReplyError, setThreadReplyError] = useState<string | null>(null);
  const sendThreadReply = useCallback(
    (text: string) => {
      const root = session.threadRootEventId;
      const trimmed = text.trim();
      if (root == null || !trimmed) return;
      setThreadReplyError(null);
      // Optimistic echo: your note appears the instant you send it. The WS
      // fold or the healing refetch replaces it with the real event row.
      const tempId = -Date.now();
      setAsides((prev) => [
        ...prev,
        { id: tempId, author: me.displayName, createdAt: new Date().toISOString(), text: trimmed, pending: true },
      ]);
      api
        .postMessage({ channelId: session.channelId, text: trimmed, clientMsgId: randomId(), threadRootEventId: root })
        .then(() => {
          setAsides((prev) => prev.filter((a) => a.id !== tempId));
          setAsideRefresh((n) => n + 1);
        })
        .catch(() => {
          setAsides((prev) => prev.filter((a) => a.id !== tempId));
          setThreadReplyError(trimmed);
        });
    },
    [me.displayName, session.channelId, session.threadRootEventId],
  );
  const composerPlaceholder =
    paneSendMode === 'thread'
      ? "Reply in the thread — the agent won't read this…"
      : isDriver
        ? isEnded
          ? 'Steer to retry — starts a new turn…'
          : displayTerminal
            ? 'Steer — starts a new turn…'
            : 'Steer the agent...'
        : `Suggest a message — ${driverName} decides`;
  const providerAuthOwnerName = nameFor(session.providerAuthRequired?.userId ?? null);
  // Steer frames carry no author; attribute to the spawner (Phase-1 approximation —
  // per-steer seat-aware attribution arrives with the session record in Phase 2).
  const steerAuthor = nameFor(session.spawnedBy);
  // Hover timestamps, formatted once per fold — the 1Hz `useNow` tick re-renders
  // the pane, and running Intl per row per second on a long transcript adds up.
  const turnTimes = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of stream.items) if (it.ts) m.set(it.id, formatTurnTime(it.ts));
    return m;
  }, [stream.items]);
  const turnExactTimes = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of stream.items) if (it.ts) m.set(it.id, formatExactTimestamp(it.ts));
    return m;
  }, [stream.items]);
  const steerProvenanceByMessageId = useMemo(
    () =>
      matchSteerProvenance(
        stream.items.filter((it): it is UserMessageItem => it.type === 'user_message'),
        session.suggestions ?? [],
      ),
    [stream.items, session.suggestions],
  );
  const acceptedByMeProvenanceKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const suggestion of session.suggestions ?? []) {
      if (suggestion.status !== 'sent' || suggestion.resolvedBy !== me.id) continue;
      keys.add(
        steerProvenanceKey({
          proposerName: suggestion.authorName ?? suggestion.authorId,
          resolvedByName: suggestion.resolvedByName ?? suggestion.resolvedBy ?? 'someone',
          edited: suggestion.sentText != null,
          resolvedAt: suggestion.resolvedAt ?? suggestion.createdAt,
        }),
      );
    }
    return keys;
  }, [session.suggestions, me.id]);
  const steerProvenanceForMessage = (messageId: string): SteerProvenanceView | null => {
    const matched = steerProvenanceByMessageId.get(messageId);
    const optimistic = optimisticProvenanceByMessageId.get(messageId);
    const provenance = matched ?? optimistic?.provenance;
    if (!provenance) return null;
    return {
      provenance,
      acceptedByMe: optimistic?.acceptedByMe === true || acceptedByMeProvenanceKeys.has(steerProvenanceKey(provenance)),
    };
  };

  // Spectator → driver ask state. 'confirm-take' = take clicked once, waiting
  // for confirmation; 'seat-held' = a take bounced with 409 and we fell back
  // to a request.
  const [seatAsk, setSeatAsk] = useState<'idle' | 'confirm-take' | 'requested' | 'seat-held'>('idle');
  useEffect(() => {
    if (isDriver) setSeatAsk('idle');
  }, [isDriver]);
  // Unconfirmed take reverts on its own — it shouldn't linger as a landmine.
  useEffect(() => {
    if (seatAsk !== 'confirm-take') return;
    const t = setTimeout(() => setSeatAsk('idle'), 5000);
    return () => clearTimeout(t);
  }, [seatAsk]);
  const seatRequested =
    seatAsk === 'requested' || seatAsk === 'seat-held' || session.pendingSeatRequests.some((r) => r.userId === me.id);
  const reportSessionActionError = useCallback(
    (err: unknown, fallback: string, options: { toast?: boolean } = {}) => {
      onApiError(err);
      if (err instanceof ApiError && err.status === 401) return;
      if (options.toast === false) return;
      showErrorToast(err instanceof ApiError && err.message ? err.message : fallback);
    },
    [onApiError],
  );

  const requestSeat = () => {
    setSeatAsk('requested');
    sessionsApi.requestSeat(session.id).catch((err: unknown) => {
      setSeatAsk('idle');
      reportSessionActionError(err, "Couldn't request the seat.");
    });
  };
  const takeSeat = () => {
    setSeatAsk('idle');
    sessionsApi.takeSeat(session.id).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        // Seat actually held (driver is watching after all) — note it and
        // fall back to a polite request.
        setSeatAsk('seat-held');
        sessionsApi.requestSeat(session.id).catch((requestErr: unknown) => {
          setSeatAsk('idle');
          reportSessionActionError(requestErr, "Couldn't request the seat.");
        });
      } else {
        reportSessionActionError(err, "Couldn't take the seat.");
      }
    });
  };

  // Driver steer sends: never swallow a lost instruction — keep the text and
  // surface a retry right where the action happened.
  const [localSteerError, setLocalSteerError] = useState<string | null>(null);
  const steerError = localSteerError ?? failedSteer;
  const sendSteer = (text: string, attachments?: AttachmentMeta[], attachmentRefs?: AttachmentRef[]) => {
    setLocalSteerError(null);
    onClearFailedSteer();
    // Optimistic: show the steer immediately; reconciled away when the harness
    // echoes it back as a user_message (see the pendingSteers effect above).
    const pendingId = randomId();
    const createdAt = new Date().toISOString();
    const context =
      session.threadRootEventId == null
        ? undefined
        : {
            channelId: session.channelId,
            threadRootEventId: session.threadRootEventId,
            clientMsgId: pendingId,
            createdAt,
          };
    setPendingSteers((prev) => [
      ...prev,
      {
        id: pendingId,
        ...(context ? { clientMsgId: context.clientMsgId } : {}),
        text,
        ts: createdAt,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        existingMessageIds: stream.items
          .filter((item): item is UserMessageItem => item.type === 'user_message')
          .map((item) => item.id),
      },
    ]);
    // The server re-attaches the session's recorded effort to every steer
    // (stickiness lives there, so mobile/suggestion steers inherit it too);
    // the client only sends an explicit CHANGE, guarded to the harness's
    // vocabulary so a stale recorded value can never 400 the message.
    const effortOverride =
      canPickEffort &&
      effortSelection &&
      effortSelection !== (modelEffort ?? '') &&
      effortOptions?.includes(effortSelection)
        ? effortSelection
        : undefined;
    const hasAttachments = (attachments?.length ?? 0) > 0 || (attachmentRefs?.length ?? 0) > 0;
    const steer = context
      ? onSteer(session.id, text, effortOverride, attachments, attachmentRefs, context)
      : hasAttachments
        ? onSteer(session.id, text, effortOverride, attachments, attachmentRefs)
        : onSteer(session.id, text, effortOverride);
    steer.catch((err: unknown) => {
      setLocalSteerError(text);
      setPendingSteers((prev) => prev.filter((p) => p.id !== pendingId));
      reportSessionActionError(err, "Couldn't send the message.", { toast: false });
    });
  };

  // Suggestion queue (Phase 2). Spectators compose suggestions; the driver
  // sends / edits-then-sends / dismisses them. Resolved rows persist; only
  // pending ones are actionable, and the queue is visible to everyone so the
  // room can see what's been proposed.
  const pendingSuggestions = useMemo(
    () => (session.suggestions ?? []).filter((s) => s.status === 'pending'),
    [session.suggestions],
  );
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [suggestSending, setSuggestSending] = useState(false);
  const sendSuggestion = (text: string) => {
    setSuggestError(null);
    setSuggestSending(true);
    sessionsApi
      .createSuggestion(session.id, text, randomId())
      .catch((err: unknown) => {
        setSuggestError(text);
        reportSessionActionError(err, "Couldn't send the suggestion.", { toast: false });
      })
      .finally(() => setSuggestSending(false));
  };
  const addOptimisticSuggestionSteer = ({
    suggestion,
    text,
    edited,
  }: {
    suggestion: NonNullable<Session['suggestions']>[number];
    text: string;
    edited: boolean;
  }) => {
    const ts = new Date().toISOString();
    const pendingId = randomId();
    setPendingSteers((prev) => [
      ...prev,
      {
        id: pendingId,
        text,
        ts,
        existingMessageIds: stream.items
          .filter((item): item is UserMessageItem => item.type === 'user_message')
          .map((item) => item.id),
        provenance: {
          proposerName: suggestion.authorName ?? nameFor(suggestion.authorId),
          resolvedByName: me.displayName,
          edited,
          resolvedAt: ts,
        },
        acceptedByMe: true,
      },
    ]);
    return pendingId;
  };
  const removeOptimisticSteer = (pendingId: string) => {
    setPendingSteers((prev) => prev.filter((p) => p.id !== pendingId));
  };

  // Pending HITL answer proposals for the live question (driver decides).
  const questionProposals = useMemo(
    () =>
      (session.answerProposals ?? []).filter(
        (p) => p.status === 'pending' && p.questionId === pendingQuestion?.questionId,
      ),
    [session.answerProposals, pendingQuestion],
  );

  const [profileProposals, setProfileProposals] = useState<AgentProfileProposal[]>([]);
  const [profileActionBusy, setProfileActionBusy] = useState<string | null>(null);
  const [profileActionError, setProfileActionError] = useState<string | null>(null);
  const profileProposalsEnabled = import.meta.env.MODE !== 'test';
  const loadProfileProposals = async () => {
    if (!profileProposalsEnabled) return;
    const { proposals } = await api.sessionProfileProposals(session.id);
    setProfileProposals(proposals);
  };
  useEffect(() => {
    if (!profileProposalsEnabled) return;
    let disposed = false;
    api
      .sessionProfileProposals(session.id)
      .then(({ proposals }) => {
        if (!disposed) setProfileProposals(proposals);
      })
      .catch(() => {
        if (!disposed) setProfileProposals([]);
      });
    return () => {
      disposed = true;
    };
  }, [session.id, profileProposalsEnabled]);
  const pendingProfileProposals = useMemo(
    () => profileProposals.filter((proposal) => proposal.status === 'pending'),
    [profileProposals],
  );
  const runProfileAction = async (
    proposal: AgentProfileProposal,
    action: 'discard' | 'lineage' | 'save-current' | 'save-new',
  ) => {
    const key = `${proposal.id}:${action}`;
    setProfileActionBusy(key);
    setProfileActionError(null);
    try {
      if (action === 'discard') {
        await api.discardSessionProfileProposal(session.id, proposal.id);
      } else if (action === 'lineage') {
        await api.applySessionProfileProposalToLineage(session.id, proposal.id);
      } else if (action === 'save-current') {
        await api.saveSessionProfileProposalToCurrent(session.id, proposal.id, {
          name: `${profileProviderLabel(proposal.provider)} profile`,
        });
      } else {
        await api.saveSessionProfileProposalAsNew(session.id, proposal.id, {
          name: `${profileProviderLabel(proposal.provider)} profile`,
        });
      }
      await loadProfileProposals();
    } catch (err) {
      setProfileActionError((err as Error).message || 'Could not update profile proposal');
    } finally {
      setProfileActionBusy(null);
    }
  };

  // Cancel is destructive and possibly shared — two-step inline confirm.
  const [cancelAsk, setCancelAsk] = useState<'idle' | 'confirm' | 'failed'>('idle');
  const displayCancelAsk = failedCancel ? 'failed' : cancelAsk;
  useEffect(() => {
    if (cancelAsk !== 'confirm') return;
    const t = setTimeout(() => setCancelAsk('idle'), 5000);
    return () => clearTimeout(t);
  }, [cancelAsk]);
  const onCancel = useCallback(() => {
    if (canStopTurn) {
      setCancelAsk('idle');
      onClearFailedCancel();
      onStopTurn(session.id).catch((err: unknown) => {
        setCancelAsk('failed');
        reportSessionActionError(err, "Couldn't stop the turn.", { toast: false });
      });
      return;
    }
    if (displayCancelAsk === 'idle') {
      setCancelAsk('confirm');
      return;
    }
    setCancelAsk('idle');
    onClearFailedCancel();
    onCancelSession(session.id).catch((err: unknown) => {
      setCancelAsk('failed');
      reportSessionActionError(err, "Couldn't cancel the session.", { toast: false });
    });
  }, [
    canStopTurn,
    displayCancelAsk,
    onCancelSession,
    onClearFailedCancel,
    onStopTurn,
    reportSessionActionError,
    session.id,
  ]);

  useEffect(() => {
    if (!canStopTurn || (!isSpawner && !isDriver)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlainEscape(event) || escapeHasLocalMeaning(event)) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canStopTurn, isDriver, isSpawner, onCancel]);

  // Driver-side grant banner; Ignore is a local dismissal only.
  const [ignoredRequests, setIgnoredRequests] = useState<ReadonlySet<string>>(new Set());
  const seatRequest = isDriver
    ? (session.pendingSeatRequests.find((r) => !ignoredRequests.has(r.userId)) ?? null)
    : null;

  // Audit-line anchoring: a seat line renders right after the transcript items
  // that were already visible when it arrived (append-like, chronological).
  // Entries that predate the pane mount (full reload / reopening the pane)
  // have no arrival point — v0 limitation: they render grouped after the
  // transcript content instead of interleaved at their original positions.
  const seatAnchorsRef = useRef<Map<number, number> | null>(null);
  if (seatAnchorsRef.current === null) {
    seatAnchorsRef.current = new Map(session.seatEvents.map((e) => [e.id, Number.MAX_SAFE_INTEGER]));
  }
  const seatAnchors = seatAnchorsRef.current;
  for (const e of session.seatEvents) {
    if (!seatAnchors.has(e.id)) seatAnchors.set(e.id, stream.items.length);
  }
  const seatLinesAt = (i: number): SeatAuditEntry[] =>
    session.seatEvents.filter(
      (e) => Math.min(seatAnchors.get(e.id) ?? Number.MAX_SAFE_INTEGER, stream.items.length) === i,
    );

  // Codex file edits live outside stream.items, so anchor and splice them into
  // the shared transcript row stream alongside seat-audit lines.
  const inlineCodexChanges = useMemo(() => codexInlineFileChanges(stream), [stream.items, stream.fileChanges]);
  const codexChangesAt = useCallback(
    (i: number) => inlineCodexChanges.filter((a) => a.index === i),
    [inlineCodexChanges],
  );
  const rows = useMemo(
    () =>
      showAgentWork
        ? fullTranscriptRows(stream.items, codexChangesAt)
        : focusTranscriptRows(stream.items, codexChangesAt),
    [codexChangesAt, showAgentWork, stream.items],
  );

  // The pane is the thread with the work unfolded: plain chat stays an aside,
  // while linked steers are first-class user turns even when Centaur never
  // echoes a matching user_message.
  const [asides, setAsides] = useState<PaneAside[]>([]);
  const [linkedSteers, setLinkedSteers] = useState<LinkedSteer[]>([]);
  useEffect(() => {
    const root = session.threadRootEventId;
    if (root == null) {
      setAsides([]);
      setLinkedSteers([]);
      return;
    }
    let disposed = false;
    // One catch-up fetch per open/reconnect; live arrivals fold in over the
    // workspace socket below — the thread and the pane are the same
    // conversation, so they get the same transport.
    api
      .thread(root)
      .then(({ events }) => {
        if (disposed) return;
        setAsides(
          events
            .filter(
              (ev) =>
                ev.type === 'message.posted' &&
                typeof ev.payload?.text === 'string' &&
                ev.payload.deleted !== true &&
                typeof ev.payload.steered_session_id !== 'string' &&
                typeof ev.payload.suggested_session_id !== 'string',
            )
            .map((ev) => ({
              id: ev.id,
              author: ev.author?.displayName ?? 'Someone',
              createdAt: ev.createdAt,
              text: String(ev.payload?.text ?? ''),
            })),
        );
        setLinkedSteers(
          events
            .filter(
              (ev) =>
                ev.type === 'message.posted' &&
                typeof ev.payload?.text === 'string' &&
                ev.payload.deleted !== true &&
                ev.payload.steered_session_id === session.id,
            )
            .map((ev) => {
              const attachments = parseAttachments(ev.payload?.attachments);
              return {
                id: ev.id,
                clientMsgId: typeof ev.payload?.client_msg_id === 'string' ? ev.payload.client_msg_id : null,
                author: ev.author?.displayName ?? 'Someone',
                createdAt: ev.createdAt,
                text: String(ev.payload?.text ?? ''),
                ...(attachments ? { attachments } : {}),
                status: 'confirmed' as const,
              };
            }),
        );
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [session.id, session.threadRootEventId, asideRefresh]);
  // Fold live thread replies straight off the workspace socket (instant, like
  // the thread panel) — dedupe by event id against catch-up overlap.
  useEffect(() => {
    const ev = liveEvent;
    const root = session.threadRootEventId;
    if (!ev || root == null) return;
    if (ev.type !== 'message.posted' || ev.threadRootEventId !== root) return;
    const p = ev.payload ?? {};
    if (typeof p.text !== 'string' || p.deleted === true) return;
    if (p.steered_session_id === session.id) {
      const attachments = parseAttachments(p.attachments);
      setLinkedSteers((prev) =>
        prev.some((steer) => steer.id === ev.id)
          ? prev
          : [
              ...prev,
              {
                id: ev.id,
                clientMsgId: typeof p.client_msg_id === 'string' ? p.client_msg_id : null,
                author: ev.author?.displayName ?? 'Someone',
                createdAt: ev.createdAt,
                text: String(p.text),
                ...(attachments ? { attachments } : {}),
                status: 'confirmed' as const,
              },
            ],
      );
      return;
    }
    if (typeof p.steered_session_id === 'string' || typeof p.suggested_session_id === 'string') return;
    setAsides((prev) =>
      prev.some((a) => a.id === ev.id)
        ? prev
        : [
            ...prev,
            { id: ev.id, author: ev.author?.displayName ?? 'Someone', createdAt: ev.createdAt, text: String(p.text) },
          ],
    );
  }, [liveEvent, session.id, session.threadRootEventId]);
  const userMessages = useMemo(
    () => stream.items.filter((item): item is UserMessageItem => item.type === 'user_message'),
    [stream.items],
  );
  const queuedLinkedSteers = useMemo<LinkedSteer[]>(
    () =>
      optimisticThreadSteers
        .filter((message) => message.steeredSessionId === session.id && message.status !== 'confirmed')
        .map((message) => ({
          id: `queued-${message.clientMsgId ?? message.createdAt}`,
          clientMsgId: message.clientMsgId ?? null,
          author: message.author.displayName,
          createdAt: message.createdAt,
          text: message.text,
          ...(message.attachments ? { attachments: message.attachments } : {}),
          status: message.status,
        })),
    [optimisticThreadSteers, session.id],
  );
  const allLinkedSteers = useMemo(
    () => reconcileOptimisticLinkedSteers(queuedLinkedSteers, linkedSteers),
    [linkedSteers, queuedLinkedSteers],
  );
  const visiblePendingSteers = useMemo(() => {
    const linkedClientIds = new Set(
      allLinkedSteers.flatMap((steer) => (steer.clientMsgId == null ? [] : [steer.clientMsgId])),
    );
    return pendingSteers.filter((pending) => pending.clientMsgId == null || !linkedClientIds.has(pending.clientMsgId));
  }, [allLinkedSteers, pendingSteers]);
  const visibleLinkedSteers = useMemo(
    () => reconcileLinkedSteers(allLinkedSteers, userMessages),
    [allLinkedSteers, userMessages],
  );
  // Anchor each aside to the first transcript item that happened after it.
  const asideAnchors = useMemo(() => {
    if (asides.length === 0) return [] as Array<{ anchorIndex: number; aside: PaneAside }>;
    const itemTs = stream.items.map((item) => (item.ts ? Date.parse(item.ts) : null));
    return asides
      .map((aside) => {
        const t = Date.parse(aside.createdAt);
        let anchorIndex = Number.MAX_SAFE_INTEGER;
        for (let i = 0; i < itemTs.length; i += 1) {
          const ts = itemTs[i];
          if (ts != null && ts > t) {
            anchorIndex = i;
            break;
          }
        }
        return { anchorIndex, aside };
      })
      .sort((a, b) => a.anchorIndex - b.anchorIndex || a.aside.id - b.aside.id);
  }, [asides, stream.items]);
  const linkedSteerAnchors = useMemo(() => {
    const itemTs = stream.items.map((item) => (item.ts ? Date.parse(item.ts) : null));
    return visibleLinkedSteers
      .map((steer) => {
        const t = Date.parse(steer.createdAt);
        let anchorIndex = Number.MAX_SAFE_INTEGER;
        for (let i = 0; i < itemTs.length; i += 1) {
          const ts = itemTs[i];
          if (ts != null && ts > t) {
            anchorIndex = i;
            break;
          }
        }
        return { anchorIndex, steer };
      })
      .sort(
        (a, b) =>
          a.anchorIndex - b.anchorIndex ||
          Date.parse(a.steer.createdAt) - Date.parse(b.steer.createdAt) ||
          String(a.steer.id).localeCompare(String(b.steer.id)),
      );
  }, [stream.items, visibleLinkedSteers]);
  const threadAnchors = useMemo(
    () =>
      [
        ...asideAnchors.map(({ anchorIndex, aside }) => ({
          anchorIndex,
          createdAt: aside.createdAt,
          row: { kind: 'aside' as const, aside },
        })),
        ...linkedSteerAnchors.map(({ anchorIndex, steer }) => ({
          anchorIndex,
          createdAt: steer.createdAt,
          row: { kind: 'steer' as const, steer },
        })),
      ].sort(
        (left, right) =>
          left.anchorIndex - right.anchorIndex || Date.parse(left.createdAt) - Date.parse(right.createdAt),
      ),
    [asideAnchors, linkedSteerAnchors],
  );
  // Turn navigation indexes both Centaur echoes and durable linked-thread
  // steers that have no harness echo.
  const turns = useMemo(
    () =>
      [
        ...userMessages.map((item) => ({ id: item.id, text: item.text, ts: item.ts ?? '' })),
        ...visibleLinkedSteers.map((steer) => ({
          id: `thread-steer-${steer.id}`,
          text: steer.text,
          ts: steer.createdAt,
        })),
      ]
        .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts))
        .map(({ id, text }) => ({ id, text })),
    [userMessages, visibleLinkedSteers],
  );

  // Manual expand/collapse overrides; default = open while running. When the
  // result arrives the card auto-collapses only if the view is pinned to the
  // bottom — if the user scrolled up to read it, it stays open under them.
  const [toolOpen, setToolOpen] = useState<Record<string, boolean>>({});
  const toolDefaultsRef = useRef(new Map<string, boolean>());
  const toolDefaultOpen = (item: ToolCallItem): boolean => {
    if (item.result === undefined) return true;
    let d = toolDefaultsRef.current.get(item.id);
    if (d === undefined) {
      d = !stickRef.current;
      toolDefaultsRef.current.set(item.id, d);
    }
    return d;
  };

  // Autoscroll while pinned to the bottom (same pattern as Timeline).
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastEventId = stream.lastEventId;
  const seatEventCount = session.seatEvents.length;
  const questionEventCount = questionEvents.length;
  const [pendingEntryHandle, setPendingEntryHandle] = useState<string | null>(() => {
    if (initialEntryHandle) return initialEntryHandle;
    return typeof window === 'undefined' ? null : entryParamFromSearch(window.location.search);
  });
  const [flashEntryHandle, setFlashEntryHandle] = useState<string | null>(null);
  const transcriptEntryHandles = useMemo(() => {
    const seen = new Set<string>();
    for (const item of stream.items) {
      if (isTranscriptEntryHandle(item.handle ?? null)) seen.add(item.handle!);
    }
    return [...seen];
  }, [stream.items]);
  const transcriptEntryHandleKey = transcriptEntryHandles.join('\n');
  const [entryReferences, setEntryReferences] = useState<Record<string, EntryReferenceSummary | null>>({});
  const entryReferencesFetchedAtRef = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lastEventId, seatEventCount, questionEventCount]);
  useEffect(() => {
    if (!flashEntryHandle) return;
    const timer = setTimeout(() => setFlashEntryHandle(null), 2500);
    return () => clearTimeout(timer);
  }, [flashEntryHandle]);
  useEffect(() => {
    if (transcriptEntryHandles.length === 0) return;
    const now = Date.now();
    const stale = now - entryReferencesFetchedAtRef.current >= ENTRY_REFERENCES_REFETCH_MS;
    const handles = stale
      ? transcriptEntryHandles
      : transcriptEntryHandles.filter((handle) => !(handle in entryReferences));
    if (handles.length === 0) return;
    entryReferencesFetchedAtRef.current = now;
    let disposed = false;
    void queryEntryReferencesForHandles(handles)
      .then((references) => {
        if (disposed) return;
        setEntryReferences((prev) => {
          const next = { ...prev };
          for (const handle of handles) next[handle] = references[handle] ?? null;
          return next;
        });
      })
      .catch((err: unknown) => {
        console.warn('failed to query entry references', err);
      });
    return () => {
      disposed = true;
    };
  }, [entryReferences, transcriptEntryHandleKey, transcriptEntryHandles]);
  useLayoutEffect(() => {
    if (!pendingEntryHandle) return;
    if (!isTranscriptEntryHandle(pendingEntryHandle)) {
      stripEntryParamFromLocation();
      setPendingEntryHandle(null);
      return;
    }
    const root = scrollRef.current;
    const target = root
      ? Array.from(root.querySelectorAll<HTMLElement>('[data-entry-handle]')).find(
          (el) => el.dataset.entryHandle === pendingEntryHandle,
        )
      : null;
    if (target) {
      stickRef.current = false;
      target.scrollIntoView({ block: 'center' });
      setFlashEntryHandle(pendingEntryHandle);
      stripEntryParamFromLocation();
      setPendingEntryHandle(null);
      return;
    }
    if (isTerminalExecutionStatus(stream.status)) {
      stripEntryParamFromLocation();
      setPendingEntryHandle(null);
    }
  }, [pendingEntryHandle, stream.items, stream.status]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setActiveTranscriptActionHandle(null);
  };

  const focused = layout === 'focus';
  const { width: paneWidth, resizing, startResize, resetWidth } = useSessionPaneWidth();
  const paneSizing = sessionPaneSizing(paneWidth);
  const paneMaxWidth =
    typeof window === 'undefined'
      ? SESSION_PANE_FALLBACK_WIDTH
      : Math.max(SESSION_PANE_MIN_WIDTH, Math.round((window.innerWidth * SESSION_PANE_MAX_VW) / 100));
  const canDetach = !isPendingSessionId(session.id);
  const [sessionLinkCopied, setSessionLinkCopied] = useState(false);
  const sessionLinkResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copySessionLink = useCallback(() => {
    if (typeof navigator === 'undefined') return;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    void clipboard
      .writeText(sessionShareUrl(session.id))
      .then(() => {
        setSessionLinkCopied(true);
        if (sessionLinkResetRef.current) clearTimeout(sessionLinkResetRef.current);
        sessionLinkResetRef.current = setTimeout(() => setSessionLinkCopied(false), 1400);
      })
      .catch(() => {});
  }, [session.id]);
  useEffect(() => {
    return () => {
      if (sessionLinkResetRef.current) clearTimeout(sessionLinkResetRef.current);
    };
  }, []);
  const closePane = useCallback(() => {
    if (!popout) {
      onClose();
      return;
    }
    window.close();
    window.setTimeout(() => {
      if (!window.closed) window.location.assign(`/s/${session.id}`);
    }, 100);
  }, [onClose, popout, session.id]);
  const githubIdentityLabel = session.githubIdentityMode ? githubIdentityModeLabel(session.githubIdentityMode) : null;
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const capabilitiesButtonRef = useRef<HTMLButtonElement | null>(null);
  // Maximal-calm header: everything that isn't the kill switch or close lives
  // behind one overflow menu; the metadata line lives in the details popover.
  const [headerMenu, setHeaderMenu] = useState<MessageActionMenuState | null>(null);
  const openHeaderMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHeaderMenu({ mode: 'popover', anchor: { x: rect.right - 240, y: rect.bottom + 4 } });
  }, []);
  const headerMenuActions: MessageActionMenuAction[] = [
    {
      key: 'work',
      label: showAgentWork ? 'Hide agent work' : 'Show agent work',
      onSelect: () => setTranscriptView(showAgentWork ? 'focus' : 'full'),
    },
    ...(onToggleFocus
      ? [
          {
            key: 'focus',
            label: focused ? 'Collapse to split view' : 'Expand to focus view',
            onSelect: onToggleFocus,
          },
        ]
      : []),
    { key: 'details', label: 'Session details & scope', onSelect: () => setCapabilitiesOpen(true) },
    ...(canDetach
      ? [
          {
            key: 'copy-link',
            label: sessionLinkCopied ? 'Copied agent link ✓' : 'Copy link to agent',
            onSelect: copySessionLink,
          },
          {
            key: 'popout',
            label: popout ? 'Open in full app' : 'Open in a new tab',
            onSelect: () => {
              if (popout) window.location.assign(`/s/${session.id}`);
              else window.open(`/s/${session.id}/pane`, '_blank', 'noopener,noreferrer');
            },
          },
        ]
      : []),
    ...(onSetPinned
      ? [
          {
            key: 'pin',
            label: session.pinned ? 'Unpin agent' : 'Pin agent',
            onSelect: () => onSetPinned(session.id, !session.pinned, session.pinned),
          },
        ]
      : []),
    ...(onSetArchived
      ? [
          {
            key: 'archive',
            label: session.archivedAt ? 'Unarchive agent' : 'Archive agent',
            onSelect: () => onSetArchived(session.id, session.archivedAt == null, session.archivedAt),
          },
        ]
      : []),
  ];
  const sessionDetails = [
    { label: 'Spawned by', value: session.spawnerName ?? session.spawnedBy },
    { label: 'Driver', value: driverName },
    ...(spectators > 0 ? [{ label: 'Watching', value: String(spectators) }] : []),
    ...(costUsd > 0 ? [{ label: 'Cost', value: formatCost(costUsd) }] : []),
    ...(session.repo ? [{ label: 'Repo', value: repoBranchTitle(session.repo, session.branch) }] : []),
    ...(githubIdentityLabel ? [{ label: 'GitHub', value: githubIdentityLabel }] : []),
    { label: 'Harness', value: session.harness },
    { label: 'Started', value: formatTime(session.createdAt) },
  ];
  const composerAreaRef = useRef<HTMLDivElement | null>(null);
  const focusSteerComposer = useCallback(() => {
    const composerArea = composerAreaRef.current;
    if (!composerArea) return;
    if (typeof composerArea.scrollIntoView === 'function') {
      composerArea.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    composerArea.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }, []);
  const [markupSource, setMarkupSource] = useState<MarkupPaneSource | null>(null);
  const [markupLoadingHandle, setMarkupLoadingHandle] = useState<string | null>(null);
  const [markupNotice, setMarkupNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const showMarkupNotice = useCallback((message: string) => {
    setMarkupNotice(message);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setMarkupNotice(null), 2600);
  }, []);

  const openMarkupFromEntry = useCallback(
    async (handle: string) => {
      setMarkupLoadingHandle(handle);
      try {
        const extracted = await api.extractEntry(handle);
        const response = await fetch(`/api/files/artifact/${encodeURIComponent(extracted.artifactId)}/content`, {
          credentials: 'same-origin',
        });
        if (!response.ok) throw new Error('Could not load markup source');
        const content = await response.text();
        const { frontmatter, body } = splitMarkdownFrontmatter(content);
        setMarkupSource({
          artifactId: extracted.artifactId,
          path: extracted.path,
          seq: extracted.seq,
          workspaceId: extracted.workspaceId,
          sessionId: session.id,
          frontmatter,
          body,
          sourceText: extracted.sourceText ?? null,
        });
      } catch (err) {
        showErrorToast(err instanceof Error ? err.message : 'Could not open markup pane');
      } finally {
        setMarkupLoadingHandle(null);
      }
    },
    [session.id],
  );

  return (
    <aside
      id={focused && !popout ? 'main-content' : undefined}
      className={`pane-zoom-in relative flex min-w-0 flex-col border-l border-edge bg-surface ${
        focused ? 'flex-1' : `shrink-0 ${paneSizing.className}`
      }`}
      style={focused ? undefined : paneSizing.style}
    >
      {!focused && (
        // biome-ignore lint/a11y/useSemanticElements: resizable pane separator uses a div for pointer capture and custom sizing.
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize agent panel"
          aria-valuemin={SESSION_PANE_MIN_WIDTH}
          aria-valuemax={paneMaxWidth}
          aria-valuenow={paneWidth ?? SESSION_PANE_FALLBACK_WIDTH}
          title="Drag to resize · double-click to reset"
          data-testid="pane-resize-handle"
          onPointerDown={startResize}
          onDoubleClick={resetWidth}
          className={`absolute inset-y-0 -left-0.5 z-raised w-1.5 cursor-col-resize touch-none transition-colors hover:bg-accent/50 ${
            resizing ? 'bg-accent/50' : ''
          }`}
        />
      )}
      {origin && (
        <nav
          aria-label="Zoom level"
          data-testid="pane-crumb"
          className="flex h-6 shrink-0 items-center gap-1 border-b border-edge bg-surface-overlay/60 px-3 text-3xs text-fg-muted"
        >
          <button
            type="button"
            onClick={origin.onOpenChannel}
            className="max-w-40 truncate hover:text-fg-body hover:underline"
          >
            {origin.channelLabel}
          </button>
          {origin.onOpenThread && (
            <>
              <span aria-hidden>▸</span>
              <button type="button" onClick={origin.onOpenThread} className="hover:text-fg-body hover:underline">
                thread
              </button>
            </>
          )}
          <span aria-hidden>▸</span>
          <span className="font-semibold text-fg-secondary">work</span>
        </nav>
      )}
      <header
        className={`flex h-12 shrink-0 items-center gap-2 border-b border-edge px-3 max-md:h-auto max-md:min-h-12 max-md:flex-wrap max-md:gap-1 max-md:px-2 max-md:py-1.5 ${
          isMacDesktop && popout ? 'pl-20 max-md:pl-20' : ''
        }`}
      >
        <GlanceChip session={{ ...session, status: displayStatus }} now={now} stuck={turnLiveness === 'stuck'} />
        {/* One calm row: chip · title · driver · (stop) · overflow · close.
            Everything else lives behind the overflow menu; the metadata line
            moved into the details popover; transport liveness is the turn
            status line's job. */}
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg" title={session.title}>
          {session.title}
        </h2>
        <span
          data-testid="driver-chip"
          className={`shrink-0 truncate rounded-full px-1.5 py-px text-3xs font-medium max-md:hidden ${
            isDriver ? 'bg-accent-hover/15 text-accent-text-strong' : 'bg-surface-overlay/80 text-fg-secondary'
          }`}
        >
          driver: {driverName}
        </span>
        {(isSpawner || isDriver) && !displayTerminal && (
          <Tooltip content={canStopTurn ? 'Stop current turn' : 'Cancel this agent'}>
            <button
              type="button"
              onClick={onCancel}
              className={`rounded-md border px-2 py-1 text-2xs font-medium max-md:max-w-[8rem] max-md:truncate [@media(pointer:coarse)]:min-h-11 ${
                displayCancelAsk === 'failed'
                  ? 'border-danger-border-strong bg-danger-tint/60 text-danger-text-strong hover:bg-danger-surface/60'
                  : canStopTurn
                    ? 'border-warning-border bg-warning-tint/20 text-warning-text hover:bg-warning-tint/40'
                    : displayCancelAsk === 'confirm'
                      ? 'border-danger-border-strong bg-danger-tint/60 text-danger-text-strong hover:bg-danger-surface/60'
                      : 'border-danger-border/60 text-danger hover:bg-danger-tint/40 hover:text-danger-text'
              }`}
            >
              {canStopTurn
                ? displayCancelAsk === 'failed'
                  ? 'Stop failed — retry'
                  : 'Stop turn'
                : displayCancelAsk === 'confirm'
                  ? 'Confirm cancel'
                  : displayCancelAsk === 'failed'
                    ? 'Cancel failed — retry'
                    : 'Cancel'}
            </button>
          </Tooltip>
        )}
        <div className="relative">
          <Tooltip content="Agent actions">
            <button
              ref={capabilitiesButtonRef}
              type="button"
              onClick={openHeaderMenu}
              aria-label="Agent actions"
              aria-haspopup="dialog"
              className="rounded-md px-2 py-1 text-sm font-semibold leading-none text-fg-tertiary hover:bg-surface-overlay hover:text-fg max-md:inline-flex max-md:size-11 max-md:items-center max-md:justify-center max-md:p-0 [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center [@media(pointer:coarse)]:p-0"
            >
              ⋯
            </button>
          </Tooltip>
          <SessionCapabilitiesPopover
            sessionId={session.id}
            open={capabilitiesOpen}
            invokerRef={capabilitiesButtonRef}
            details={sessionDetails}
            onClose={() => setCapabilitiesOpen(false)}
          />
        </div>
        <MessageActionMenu
          state={headerMenu}
          onClose={() => setHeaderMenu(null)}
          actions={headerMenuActions}
          label="Agent actions"
        />
        <Tooltip content="Close session details">
          <button
            type="button"
            onClick={closePane}
            aria-label="Close session details"
            className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg max-md:inline-flex max-md:size-11 max-md:items-center max-md:justify-center max-md:p-0 [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center [@media(pointer:coarse)]:p-0"
          >
            <XIcon />
          </button>
        </Tooltip>
      </header>

      {session.archivedAt != null && (
        <div
          data-testid="archived-banner"
          className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface-raised/70 px-3 py-1.5 text-xs"
        >
          <span className="min-w-0 flex-1 truncate text-fg-muted">Archived — new activity will bring it back.</span>
          {onSetArchived && (
            <button
              type="button"
              onClick={() => onSetArchived(session.id, false, session.archivedAt)}
              className="rounded-md px-2 py-0.5 text-2xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
            >
              Unarchive
            </button>
          )}
        </div>
      )}

      {seatRequest && !displayTerminal && (
        <div
          data-testid="seat-request-banner"
          className="flex shrink-0 items-center gap-2 border-b border-accent-tint/40 bg-accent-tint/30 px-3 py-1.5 text-xs"
        >
          <span className="min-w-0 flex-1 truncate text-fg-body">
            <span className="font-semibold">{seatRequest.displayName}</span> requests the seat
          </span>
          <button
            type="button"
            onClick={() =>
              sessionsApi
                .grantSeat(session.id, seatRequest.userId)
                .catch((err: unknown) => reportSessionActionError(err, "Couldn't grant the seat."))
            }
            className="rounded-md bg-accent px-2 py-0.5 text-2xs font-medium text-on-accent hover:bg-accent-hover"
          >
            Grant
          </button>
          <button
            type="button"
            onClick={() => setIgnoredRequests((prev) => new Set(prev).add(seatRequest.userId))}
            className="rounded-md px-2 py-0.5 text-2xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
          >
            Ignore
          </button>
        </div>
      )}

      {session.providerAuthRequired && (!displayTerminal || session.providerAuthRequired.provider === 'github') && (
        <ProviderAuthBanner
          required={session.providerAuthRequired}
          isOwner={session.providerAuthRequired.userId === me.id}
          ownerName={providerAuthOwnerName}
          connected={
            session.providerAuthRequired.provider === 'github'
              ? githubConnection?.connected === true
              : providerCredentials?.[session.providerAuthRequired.provider]?.connected === true
          }
          onConnect={() => {
            const provider = session.providerAuthRequired!.provider;
            if (provider === 'github') onConnectGitHub?.();
            else onConnectProvider?.(provider);
          }}
          onResume={displayStatus === 'completed' ? focusSteerComposer : undefined}
        />
      )}

      {pendingProfileProposals.length > 0 && (
        <ProfileChangesBanner
          proposals={pendingProfileProposals}
          busyKey={profileActionBusy}
          error={profileActionError}
          onAction={runProfileAction}
        />
      )}

      {/* One component owns the whole arc: the live question, the driver's undo
          window, and the "✓ Answered by …" trace it leaves behind. */}
      {((pendingQuestion && !displayTerminal) || answeredQuestion) && (
        <QuestionCard
          sessionId={session.id}
          pending={displayTerminal ? null : pendingQuestion}
          answered={answeredQuestion}
          isDriver={isDriver}
          driverName={driverName}
          proposals={questionProposals}
          onAnswerQuestion={onAnswerQuestion}
        />
      )}

      {displayTerminal && (
        <section
          data-testid="session-result"
          aria-labelledby="session-results-heading"
          className="shrink-0 border-b border-edge bg-surface-raised px-4 py-3"
        >
          <div className="flex items-baseline gap-2">
            <h3 id="session-results-heading" className="text-xs font-semibold text-fg">
              Results
            </h3>
            <span className={`text-xs ${isEnded ? 'text-danger-text' : 'text-fg-muted'}`}>
              {displayStatus === 'failed'
                ? 'Failed — review the transcript, then retry.'
                : displayStatus === 'cancelled'
                  ? 'Cancelled — review completed work before continuing.'
                  : 'Completed — review the work before continuing.'}
            </span>
            {displayStatus === 'failed' && isDriver && (
              <button
                type="button"
                data-testid="retry-turn"
                onClick={() => sendSteer('Retry the failed turn.')}
                className="ml-auto shrink-0 rounded-md bg-danger px-2 py-0.5 text-2xs font-semibold text-surface hover:bg-danger/85"
              >
                Retry turn
              </button>
            )}
          </div>
          {resultText && (
            <div className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-body">
              {resultText}
            </div>
          )}
          {(changedFileCount > 0 || artifactsN > 0) && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
              {changedFileCount > 0 && (
                <span>
                  {changedFileCount} changed {changedFileCount === 1 ? 'file' : 'files'}
                </span>
              )}
              {artifactsN > 0 && (
                <span>
                  {artifactsN} {artifactsN === 1 ? 'artifact' : 'artifacts'} produced
                </span>
              )}
            </div>
          )}
        </section>
      )}

      <button
        type="button"
        data-testid="output-strip"
        onClick={onOutputHubStrip}
        aria-expanded={outputHubOpen}
        className={outputStripClass({})}
      >
        <OutputLabel unseen={false}>Files</OutputLabel>
        <span className="ml-auto text-fg-tertiary">{outputHubOpen ? 'Hide' : 'Open'}</span>
      </button>
      {conflictsN > 0 && (
        <button
          type="button"
          data-testid="conflicts-strip"
          onClick={() => onStrip('conflicts')}
          aria-expanded={workTab === 'conflicts'}
          className={outputStripClass({ danger: true, unseen: unseenOutputs.conflicts })}
        >
          <OutputLabel unseen={unseenOutputs.conflicts} danger>
            Conflicts
          </OutputLabel>
          <span className="tabular-nums">· {conflictsN}</span>
          <span className="ml-auto opacity-80">{workTab === 'conflicts' ? 'Hide' : 'Resolve'}</span>
        </button>
      )}
      {changedFileCount > 0 && (
        <button
          type="button"
          data-testid="changes-strip"
          onClick={() => onStrip('changes')}
          aria-expanded={workTab === 'changes'}
          className={outputStripClass({ unseen: unseenOutputs.changes })}
        >
          <OutputLabel unseen={unseenOutputs.changes}>Changes</OutputLabel>
          <span className="tabular-nums">· {changedFileCount}</span>
          <span className="ml-auto text-fg-tertiary">{workTab === 'changes' ? 'Hide' : 'View'}</span>
        </button>
      )}
      {sideEffectsN > 0 && (
        <button
          type="button"
          data-testid="sideeffects-strip"
          onClick={() => onStrip('sideEffects')}
          aria-expanded={workTab === 'sideEffects'}
          className={outputStripClass({ unseen: unseenOutputs.sideEffects })}
        >
          <OutputLabel unseen={unseenOutputs.sideEffects}>Actions</OutputLabel>
          <span className={`tabular-nums ${sideEffectsDanger ? 'text-danger-text' : ''}`}>· {sideEffectsN}</span>
          <span className="ml-auto text-fg-tertiary">{workTab === 'sideEffects' ? 'Hide' : 'View'}</span>
        </button>
      )}
      {artifactsN > 0 && (
        <button
          type="button"
          data-testid="artifacts-strip"
          onClick={() => onStrip('artifacts')}
          aria-expanded={workTab === 'artifacts'}
          className={outputStripClass({ unseen: unseenOutputs.artifacts })}
        >
          <OutputLabel unseen={unseenOutputs.artifacts}>Artifacts</OutputLabel>
          <span className="tabular-nums">· {artifactsN}</span>
          <span className="ml-auto text-fg-tertiary">{workTab === 'artifacts' ? 'Hide' : 'View'}</span>
        </button>
      )}

      <div className={`flex min-h-0 flex-1 ${workTab && workPinnedEffective ? 'flex-row' : 'flex-col'}`}>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {workTab && !workPinnedEffective && (
            <WorkDrawer
              changes={fileChanges}
              changedFileCount={changedFileCount}
              effects={sideEffects}
              sideEffectCount={sideEffectsN}
              hasDanger={sideEffectsDanger}
              artifacts={artifacts}
              artifactPresentations={artifactPresentations}
              artifactCount={artifactsN}
              conflicts={conflicts}
              conflictCount={conflictsN}
              onResolveConflict={resolveConflict}
              sessionId={session.id}
              workspaceId={session.workspaceId}
              channelId={session.channelId}
              filesSessionScope={filesSessionScope}
              filesDefaultScope={filesDefaultScope}
              tab={workTab}
              onTab={setPinnedWorkTab}
              pinned={false}
              onTogglePin={togglePin}
              canPin={canPinWork}
              canDetach={canDetach}
              onClose={closeWork}
            />
          )}
          <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-3 py-2">
            <PlanPanel todos={stream.todos} plan={stream.plan} />
            {stream.items.length === 0 && visibleLinkedSteers.length === 0 && !activeTurn && (
              <div className="flex h-full items-center justify-center text-xs text-fg-muted">
                {!displayTerminal ? (
                  <span className="animate-pulse">Waiting for agent output…</span>
                ) : isTerminalExecutionStatus(stream.status) ? (
                  'No transcript.'
                ) : (
                  'Loading transcript…'
                )}
              </div>
            )}
            {(() => {
              let seatCursor = 0;
              const flushSeatLinesThrough = (index: number) => {
                const lines: ReactNode[] = [];
                while (seatCursor <= index) {
                  lines.push(
                    ...seatLinesAt(seatCursor).map((e) => <SeatAuditLine key={e.id} entry={e} nameFor={nameFor} />),
                  );
                  seatCursor += 1;
                }
                return lines;
              };
              let threadCursor = 0;
              const flushThreadRowsThrough = (index: number) => {
                const lines: ReactNode[] = [];
                while (threadCursor < threadAnchors.length && threadAnchors[threadCursor]!.anchorIndex <= index) {
                  const row = threadAnchors[threadCursor]!.row;
                  lines.push(
                    row.kind === 'aside' ? (
                      <PaneAsideRow key={`aside-${row.aside.id}`} aside={row.aside} />
                    ) : (
                      <LinkedSteerRow key={`linked-steer-${row.steer.id}`} steer={row.steer} />
                    ),
                  );
                  threadCursor += 1;
                }
                return lines;
              };

              return (
                <>
                  {rows.map((row) => {
                    const rowStartIndex = row.kind === 'hidden' ? row.startIndex : row.index;
                    const seatLinesBefore = flushSeatLinesThrough(rowStartIndex);
                    const threadRowsBefore = flushThreadRowsThrough(rowStartIndex);

                    if (row.kind === 'change') {
                      return (
                        <Fragment key={`change-${row.change.change.id}`}>
                          {seatLinesBefore}
                          {threadRowsBefore}
                          <div className="pl-3.5">
                            <InlineFileChange change={row.change.change} />
                          </div>
                        </Fragment>
                      );
                    }

                    if (row.kind === 'hidden') {
                      return (
                        <Fragment key={row.key}>
                          {seatLinesBefore}
                          {threadRowsBefore}
                          <HiddenWorkChip count={row.count} onClick={() => setTranscriptView('full')} />
                          {flushSeatLinesThrough(row.endIndex)}
                          {flushThreadRowsThrough(row.endIndex)}
                        </Fragment>
                      );
                    }

                    const item = row.item;
                    return (
                      <Fragment key={item.id}>
                        {seatLinesBefore}
                        {threadRowsBefore}
                        <AnnotatedTranscriptRow
                          handle={item.handle ?? null}
                          onMarkupEntry={item.type === 'text' ? openMarkupFromEntry : undefined}
                          markupLoading={markupLoadingHandle === item.handle}
                          highlighted={item.handle != null && item.handle === flashEntryHandle}
                          references={item.handle != null ? entryReferences[item.handle] : null}
                          discussContext={discussContext}
                          onDiscussEntry={onDiscussEntry}
                          touchActionsEnabled={isHoverNone}
                          touchActionsActive={item.handle != null && item.handle === activeTranscriptActionHandle}
                          onActivateTouchActions={setActiveTranscriptActionHandle}
                        >
                          {/* `group` + title: every row gets a native mouseover timestamp;
                  steer rows also reveal an inline one (their hover target is
                  obvious and they anchor turn navigation). */}
                          <div className="group" title={turnExactTimes.get(item.id) || undefined}>
                            {item.type === 'text' ? (
                              <div className="pl-3.5">
                                <TextBlock item={item} />
                              </div>
                            ) : item.type === 'user_message' ? (
                              <div data-testid="user-steer" data-turn={item.id} className="pt-2 pb-0.5">
                                <SteerAuthorLine
                                  author={steerAuthor}
                                  iso={item.ts}
                                  time={turnTimes.get(item.id)}
                                  provenance={steerProvenanceForMessage(item.id)}
                                />
                                <MarkupSteerCard text={item.text} />
                              </div>
                            ) : item.type === 'question' ? (
                              <div className="pl-3.5">
                                <QuestionTranscriptCard
                                  item={item}
                                  events={questionEventsByQuestion.get(item.questionId) ?? []}
                                />
                              </div>
                            ) : item.type === 'reasoning' ? (
                              <div className="pl-3.5">
                                <ReasoningBlock item={item} />
                              </div>
                            ) : item.type === 'tool_call' ? (
                              <div className="pl-3.5">
                                <TranscriptTool
                                  item={item}
                                  expanded={toolOpen[item.id] ?? toolDefaultOpen(item)}
                                  onToggle={() =>
                                    setToolOpen((prev) => ({
                                      ...prev,
                                      [item.id]: !(prev[item.id] ?? toolDefaultOpen(item)),
                                    }))
                                  }
                                  clockSkewMs={clockSkewMs}
                                />
                              </div>
                            ) : null}
                          </div>
                        </AnnotatedTranscriptRow>
                      </Fragment>
                    );
                  })}
                  {flushSeatLinesThrough(stream.items.length)}
                  {flushThreadRowsThrough(Number.MAX_SAFE_INTEGER)}
                </>
              );
            })()}
            {visiblePendingSteers.map((p) => (
              <div
                key={p.id}
                data-testid="user-steer-pending"
                title={formatExactTimestamp(p.ts) || undefined}
                className={`group pt-2 pb-0.5${p.delivered ? '' : ' opacity-60'}`}
              >
                <SteerAuthorLine
                  author={steerAuthor}
                  iso={p.ts}
                  time={formatTurnTime(p.ts)}
                  provenance={p.provenance ? { provenance: p.provenance, acceptedByMe: p.acceptedByMe === true } : null}
                />
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-fg-body">{p.text}</div>
                <SteerAttachments attachments={p.attachments} />
              </div>
            ))}
            {artifactPresentations.length > 0 && (
              <div className="pl-3.5">
                <AppPresentationCards sessionId={session.id} presentations={artifactPresentations} />
              </div>
            )}
          </div>
          <TurnRail
            turns={turns}
            onJump={(id) =>
              scrollRef.current
                ?.querySelector(`[data-turn="${id}"]`)
                ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
            }
          />
        </div>
        {workTab && workPinnedEffective && (
          <div className="flex min-h-0 w-[min(440px,46%)] shrink-0 flex-col border-l border-edge">
            <WorkDrawer
              changes={fileChanges}
              changedFileCount={changedFileCount}
              effects={sideEffects}
              sideEffectCount={sideEffectsN}
              hasDanger={sideEffectsDanger}
              artifacts={artifacts}
              artifactPresentations={artifactPresentations}
              artifactCount={artifactsN}
              conflicts={conflicts}
              conflictCount={conflictsN}
              onResolveConflict={resolveConflict}
              sessionId={session.id}
              workspaceId={session.workspaceId}
              channelId={session.channelId}
              filesSessionScope={filesSessionScope}
              filesDefaultScope={filesDefaultScope}
              tab={workTab}
              onTab={setPinnedWorkTab}
              pinned
              onTogglePin={togglePin}
              canPin={canPinWork}
              canDetach={canDetach}
              onClose={closeWork}
            />
          </div>
        )}
      </div>

      {markupNotice && (
        <div className="pointer-events-none absolute bottom-24 left-1/2 z-toast -translate-x-1/2 rounded-md border border-accent-border/60 bg-surface-overlay px-3 py-2 text-xs font-medium text-accent-text-strong shadow-lg">
          {markupNotice}
        </div>
      )}
      {markupSource && (
        <MarkupPane
          source={markupSource}
          onClose={() => setMarkupSource(null)}
          onSent={() => showMarkupNotice('Markup sent to agent')}
        />
      )}

      {!isEnded && turnPhase && (
        <TurnStatusLine
          phase={turnPhase}
          liveness={turnLiveness}
          label={statusLabel}
          elapsedMs={turnElapsedMs}
          quietMs={turnPhase === 'waiting' ? waitingMs : quietMs}
          pulse={stream.frameSeq}
          tokens={tokensUsed}
          costUsd={costUsd}
          models={stream.models}
          effort={modelEffort}
          cancelLabel={canStopTurn ? 'Stop turn' : displayCancelAsk === 'confirm' ? 'Confirm cancel' : 'Cancel'}
          onCancel={isSpawner || isDriver ? onCancel : undefined}
        />
      )}

      {/* No dead ends: the composer stays in every terminal state. A steer on
          a failed/cancelled session revives it as a new turn — the same
          mechanism completed sessions already use. */}
      {
        <>
          {pendingSuggestions.length > 0 && (
            <SuggestionStrip
              sessionId={session.id}
              suggestions={pendingSuggestions}
              isDriver={isDriver}
              nameFor={nameFor}
              onOptimisticSend={addOptimisticSuggestionSteer}
              onOptimisticSendFailed={removeOptimisticSteer}
              onActionError={onApiError}
            />
          )}
          {isDriver && steerError && (
            <div
              role="alert"
              data-testid="steer-error"
              className="flex shrink-0 items-center gap-2 border-t border-danger-border/40 bg-danger-tint/20 px-3 py-1.5 text-xs"
            >
              <span className="min-w-0 flex-1 truncate text-danger-text">Message didn't send: "{steerError}"</span>
              <button
                type="button"
                onClick={() => sendSteer(steerError)}
                className="rounded-md bg-danger-surface/50 px-2 py-0.5 text-2xs font-medium text-danger-text-strong hover:bg-danger-surface/80"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => {
                  setLocalSteerError(null);
                  onClearFailedSteer();
                }}
                className="rounded-md px-2 py-0.5 text-2xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
              >
                Dismiss
              </button>
            </div>
          )}
          {!isDriver && suggestError && (
            <div
              role="alert"
              data-testid="suggestion-error"
              className="flex shrink-0 items-center gap-2 border-t border-danger-border/40 bg-danger-tint/20 px-3 py-1.5 text-xs"
            >
              <span className="min-w-0 flex-1 truncate text-danger-text">Suggestion didn't send: "{suggestError}"</span>
              <button
                type="button"
                onClick={() => sendSuggestion(suggestError)}
                className="rounded-md bg-danger-surface/50 px-2 py-0.5 text-2xs font-medium text-danger-text-strong hover:bg-danger-surface/80"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => setSuggestError(null)}
                className="rounded-md px-2 py-0.5 text-2xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
              >
                Dismiss
              </button>
            </div>
          )}
          {suggestSending && (
            <div
              data-testid="suggestion-sending"
              className="flex shrink-0 items-center gap-2 border-t border-edge bg-surface-overlay px-3 py-1 text-2xs text-fg-muted"
            >
              Suggestion sending… the driver will see it in the queue.
            </div>
          )}
          {threadReplyError != null && (
            <div
              role="alert"
              data-testid="thread-reply-error"
              className="flex shrink-0 items-center gap-2 border-t border-danger-border/40 bg-danger-tint/20 px-3 py-1.5 text-xs"
            >
              <span className="min-w-0 flex-1 truncate text-danger-text">Note didn't send: "{threadReplyError}"</span>
              <button
                type="button"
                onClick={() => sendThreadReply(threadReplyError)}
                className="rounded-md bg-danger-surface/50 px-2 py-0.5 text-2xs font-medium text-danger-text-strong hover:bg-danger-surface/80"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => setThreadReplyError(null)}
                className="rounded-md px-2 py-0.5 text-2xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
              >
                Dismiss
              </button>
            </div>
          )}
          <SessionTypingLine typers={typers} />
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-edge bg-surface-overlay px-4 py-1 text-2xs font-medium text-fg-muted">
            <span className="truncate py-0.5">{composerStatusText}</span>
          </div>
          <div ref={composerAreaRef} className="shrink-0">
            <Composer
              placeholder={composerPlaceholder}
              onSend={
                paneSendMode === 'thread' && session.threadRootEventId != null
                  ? sendThreadReply
                  : isDriver
                    ? sendSteer
                    : (text) => sendSuggestion(text)
              }
              queueUpload={isDriver ? queueUpload : undefined}
              onTyping={onComposerTyping}
              allowAttachments={isDriver}
              allowVoice={false}
              previewEntryLinks
              audiencePill={
                session.threadRootEventId != null
                  ? {
                      mode: paneSendMode,
                      // Same grammar as the channel and thread composers: the pill
                      // names the real target, not just the mode.
                      agentLabel: `${isDriver ? 'Steer' : 'Suggest'} · “${session.title}”`,
                      threadLabel: 'this thread',
                      onModeChange: setPaneSendMode,
                      agentSendLabel: isDriver ? 'Steer' : 'Suggest',
                      threadSendLabel: 'Reply',
                    }
                  : undefined
              }
              footer={
                isDriver ? (
                  canPickEffort ? (
                    <label
                      data-testid="effort-picker"
                      className="flex items-center gap-1.5 text-fg-faint"
                      title="Reasoning effort for the next turn"
                    >
                      <span>effort</span>
                      <select
                        value={effortSelection}
                        onChange={(e) => setEffortChoice(e.target.value)}
                        className="rounded border border-edge bg-surface-raised px-1 py-0.5 text-2xs text-fg-secondary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                      >
                        {/* Once an effort is recorded there's no way back to
                            "default" (per-turn semantics would silently revert
                            while the chip kept the old value) — only levels. */}
                        {modelEffort == null && <option value="">default</option>}
                        {(effortOptions ?? []).map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : undefined
                ) : (
                  <span data-testid="seat-footer" className="flex items-center gap-2">
                    {seatRequested ? (
                      <span>
                        {seatAsk === 'seat-held' && <span className="text-warning/80">seat held · </span>}
                        requested — waiting for {driverName}
                      </span>
                    ) : seatAsk === 'confirm-take' ? (
                      <>
                        <span className="text-fg-tertiary">take the seat from {driverName}?</span>
                        <button
                          type="button"
                          onClick={takeSeat}
                          className="rounded border border-accent-border-muted/60 px-2 py-0.5 font-medium text-accent-text-strong hover:bg-accent-tint/40 hover:text-accent-text-strong"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => setSeatAsk('idle')}
                          className="rounded px-2 py-0.5 font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
                        >
                          Keep watching
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={driverPresent ? requestSeat : () => setSeatAsk('confirm-take')}
                        className="rounded border border-accent-border-muted/60 px-2 py-0.5 font-medium text-accent-text-strong hover:bg-accent-tint/40 hover:text-accent-text-strong"
                      >
                        {driverPresent ? 'Request seat' : 'Take seat'}
                      </button>
                    )}
                  </span>
                )
              }
            />
          </div>
        </>
      }
    </aside>
  );
}

function githubIdentityModeLabel(mode: string): string {
  switch (mode) {
    case 'automatic':
      return 'Automatic';
    case 'app_installation':
      return 'App installation';
    case 'app_user':
      return 'GitHub user';
    case 'pat':
      return 'PAT';
    default:
      return mode;
  }
}

/** Hover-revealed wall-clock time beside a steer's author name. */
function TurnTimeLabel({ iso, time }: { iso: string | undefined; time: string | undefined }) {
  if (!iso || !time) return null;
  return (
    <TimestampDisclosure
      iso={iso}
      label={time}
      align="right"
      testId="turn-time"
      className="ml-2 align-middle text-3xs font-normal tabular-nums text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
    >
      {time}
    </TimestampDisclosure>
  );
}

function SteerAuthorLine({
  author,
  iso,
  time,
  provenance,
}: {
  author: string;
  iso: string | undefined;
  time: string | undefined;
  provenance: SteerProvenanceView | null;
}) {
  return (
    <div className="flex items-center text-sm font-semibold text-fg">
      <span>{author}</span>
      <TurnTimeLabel iso={iso} time={time} />
      {provenance ? (
        <SteerProvenanceIndicator provenance={provenance.provenance} acceptedByMe={provenance.acceptedByMe} />
      ) : null}
    </div>
  );
}

function provenanceTimeLabel(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return formatTime(date.toISOString());
}

function steerProvenanceLabel(provenance: SteerProvenance, acceptedByMe: boolean): string {
  const acceptedBy = acceptedByMe ? 'you' : provenance.resolvedByName;
  const parts = [
    `Proposed by ${provenance.proposerName}`,
    `Accepted & sent by ${acceptedBy}`,
    provenanceTimeLabel(provenance.resolvedAt),
  ].filter(Boolean);
  if (provenance.edited) parts.push('edited before sending');
  return parts.join(' · ');
}

function SteerProvenanceIndicator({
  provenance,
  acceptedByMe,
}: {
  provenance: SteerProvenance;
  acceptedByMe: boolean;
}) {
  const label = steerProvenanceLabel(provenance, acceptedByMe);
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        className="ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-surface-overlay hover:text-fg-secondary focus-visible:outline focus-visible:outline-1 focus-visible:outline-edge-strong"
      >
        <CornerUpLeftIcon size={14} />
      </button>
    </Tooltip>
  );
}

export function AnnotatedTranscriptRow({
  handle,
  onMarkupEntry,
  markupLoading = false,
  highlighted = false,
  references,
  discussContext,
  onDiscussEntry,
  touchActionsEnabled = false,
  touchActionsActive = false,
  onActivateTouchActions,
  children,
}: {
  handle: string | null;
  onMarkupEntry?: (handle: string) => void;
  markupLoading?: boolean;
  highlighted?: boolean;
  references?: EntryReferenceSummary | null;
  discussContext?: { channelId: string; threadRootEventId: number } | null;
  onDiscussEntry?: (payload: TranscriptDiscussPayload) => void;
  touchActionsEnabled?: boolean;
  touchActionsActive?: boolean;
  onActivateTouchActions?: (handle: string) => void;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const linkCopyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textCopyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [textCopied, setTextCopied] = useState(false);
  const [hasCopyableText, setHasCopyableText] = useState(false);
  const [actionMenu, setActionMenu] = useState<MessageActionMenuState | null>(null);
  const [selectTextContent, setSelectTextContent] = useState<string | null>(null);
  const suppressTapRevealUntilRef = useRef(0);

  const rowText = useCallback(() => {
    const node = contentRef.current;
    if (!node) return '';
    const raw = typeof node.innerText === 'string' ? node.innerText : (node.textContent ?? '');
    return raw.trim();
  }, []);

  useLayoutEffect(() => {
    if (!handle) return;
    const next = rowText().length > 0;
    setHasCopyableText((current) => (current === next ? current : next));
  }, [children, handle, rowText]);

  useEffect(() => {
    return () => {
      if (linkCopyResetRef.current) clearTimeout(linkCopyResetRef.current);
      if (textCopyResetRef.current) clearTimeout(textCopyResetRef.current);
    };
  }, []);

  const canMarkup = handle != null && handle.startsWith('rec_') && onMarkupEntry != null;
  const canDiscuss = handle != null && handle.startsWith('rec_') && discussContext != null && onDiscussEntry != null;

  const closeActionMenu = useCallback(() => setActionMenu(null), []);
  const copyEntryLink = useCallback(() => {
    if (!handle || typeof navigator === 'undefined') return;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    void clipboard
      .writeText(entryShareUrl(handle))
      .then(() => {
        setLinkCopied(true);
        if (linkCopyResetRef.current) clearTimeout(linkCopyResetRef.current);
        linkCopyResetRef.current = setTimeout(() => setLinkCopied(false), 1400);
      })
      .catch(() => {});
  }, [handle]);

  const copyBlockText = useCallback(() => {
    if (typeof navigator === 'undefined') return;
    const text = rowText();
    if (!text) {
      setHasCopyableText(false);
      return;
    }
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    void clipboard
      .writeText(text)
      .then(() => {
        setTextCopied(true);
        if (textCopyResetRef.current) clearTimeout(textCopyResetRef.current);
        textCopyResetRef.current = setTimeout(() => setTextCopied(false), 1400);
      })
      .catch(() => {});
  }, [rowText]);

  // Transcript rows have no raw-markdown string — capture the rendered DOM's
  // innerText at open time (same source Copy block text uses) so the sheet
  // stays stable even if the row re-renders underneath it.
  const openSelectText = useCallback(() => {
    const text = rowText();
    if (!text) return;
    setSelectTextContent(text);
  }, [rowText]);
  const closeSelectText = useCallback(() => setSelectTextContent(null), []);

  const discussEntry = useCallback(() => {
    if (!handle || !discussContext || !onDiscussEntry) return;
    onDiscussEntry({
      handle,
      channelId: discussContext.channelId,
      threadRootEventId: discussContext.threadRootEventId,
      draft: `/e/${handle} `,
    });
  }, [discussContext, handle, onDiscussEntry]);

  const markupEntry = useCallback(() => {
    if (!handle || !onMarkupEntry || markupLoading) return;
    onMarkupEntry(handle);
  }, [handle, markupLoading, onMarkupEntry]);

  const transcriptActions = useMemo<MessageActionMenuAction[]>(() => {
    if (!handle) return [];
    const actions: MessageActionMenuAction[] = [
      {
        key: 'copy-entry-link',
        label: 'Copy entry link',
        onSelect: copyEntryLink,
      },
    ];
    if (hasCopyableText) {
      actions.push({
        key: 'copy-block-text',
        label: 'Copy block text',
        onSelect: copyBlockText,
      });
      actions.push({
        key: 'select-text',
        label: 'Select text…',
        sheetOnly: true,
        onSelect: openSelectText,
      });
    }
    if (canDiscuss) {
      actions.push({
        key: 'discuss-thread',
        label: 'Discuss in thread',
        onSelect: discussEntry,
      });
    }
    if (canMarkup) {
      actions.push({
        key: 'markup-reply',
        label: markupLoading ? 'Opening...' : 'Mark up & reply',
        onSelect: markupEntry,
        closeOnSelect: !markupLoading,
      });
    }
    return actions;
  }, [
    canDiscuss,
    canMarkup,
    copyBlockText,
    copyEntryLink,
    discussEntry,
    handle,
    hasCopyableText,
    markupEntry,
    markupLoading,
    openSelectText,
  ]);
  const actionMenuAllowed = transcriptActions.length > 0;
  const openSheetMenu = useCallback(() => {
    if (!actionMenuAllowed) return;
    setActionMenu({ mode: 'sheet' });
  }, [actionMenuAllowed]);
  const onContentContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;
      if (!actionMenuAllowed) return;
      if (isTouchContextMenu(event.nativeEvent)) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      setActionMenu({ mode: 'popover', anchor: { x: event.clientX, y: event.clientY } });
    },
    [actionMenuAllowed],
  );
  const longPress = useLongPress({
    disabled: !actionMenuAllowed,
    onLongPress: () => {
      suppressTapRevealUntilRef.current = Date.now() + 1000;
      openSheetMenu();
    },
  });
  const onContentClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!handle || !touchActionsEnabled || !actionMenuAllowed || event.defaultPrevented) return;
      if (Date.now() <= suppressTapRevealUntilRef.current) return;
      if (isInteractiveTarget(event.target)) return;
      onActivateTouchActions?.(handle);
    },
    [actionMenuAllowed, handle, onActivateTouchActions, touchActionsEnabled],
  );

  if (!handle) return <>{children}</>;

  return (
    <div data-entry-handle={handle} className={`group relative ${highlighted ? 'entry-flash bg-accent-hover/10' : ''}`}>
      {/* biome-ignore lint/a11y: touch/context handlers expose the existing transcript actions without changing keyboard access. */}
      <div
        ref={contentRef}
        onPointerDown={(event) => {
          if (isInteractiveTarget(event.target)) return;
          longPress.onPointerDown(event);
        }}
        onPointerMove={longPress.onPointerMove}
        onPointerUp={longPress.onPointerUp}
        onPointerCancel={longPress.onPointerCancel}
        onLostPointerCapture={longPress.onLostPointerCapture}
        onContextMenu={(event) => {
          longPress.onContextMenu(event);
          onContentContextMenu(event);
        }}
        onClick={onContentClick}
        style={{ touchAction: 'pan-y pinch-zoom' }}
        className="min-w-0"
      >
        {children}
      </div>
      <div className="pointer-events-none absolute -top-1 right-0 z-raised flex items-start gap-1">
        <div className="pointer-events-auto">
          <EntryReferencesChip summary={references} />
        </div>
        {touchActionsEnabled && touchActionsActive && actionMenuAllowed && (
          <Tooltip content="More transcript actions">
            <button
              type="button"
              onClick={openSheetMenu}
              aria-label="More transcript actions"
              className="pointer-events-auto inline-flex size-11 items-center justify-center rounded-md border border-edge-strong bg-surface-overlay text-lg leading-none text-fg-secondary shadow-sm transition-colors hover:bg-edge-strong hover:text-fg"
            >
              ⋯
            </button>
          </Tooltip>
        )}
        {/* No-hover devices never render the inline bar: even at opacity-0 it
        reserves flex space, which would push the ⋯ (and the references chip)
        into the middle of the entry text. Touch gets the ⋯ + sheet instead. */}
        {!touchActionsEnabled && (
          <div
            data-testid="transcript-entry-action-bar"
            className="pointer-events-none flex gap-1 opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
          >
            <Tooltip content={linkCopied ? 'Copied entry link' : 'Copy entry link'}>
              <button
                type="button"
                onClick={copyEntryLink}
                aria-label={linkCopied ? 'Copied entry link' : 'Copy entry link'}
                className={`inline-flex h-7 w-8 items-center justify-center rounded-md border border-edge-strong bg-surface-overlay text-xs shadow-sm transition-colors hover:bg-edge-strong hover:text-fg ${
                  linkCopied ? 'text-accent-text-strong' : 'text-fg-secondary'
                }`}
              >
                {linkCopied ? <CheckIcon /> : <LinkIcon />}
              </button>
            </Tooltip>
            {hasCopyableText && (
              <Tooltip content={textCopied ? 'Copied block text' : 'Copy block text'}>
                <button
                  type="button"
                  onClick={copyBlockText}
                  aria-label={textCopied ? 'Copied block text' : 'Copy block text'}
                  className={`inline-flex h-7 w-8 items-center justify-center rounded-md border border-edge-strong bg-surface-overlay text-xs shadow-sm transition-colors hover:bg-edge-strong hover:text-fg ${
                    textCopied ? 'text-accent-text-strong' : 'text-fg-secondary'
                  }`}
                >
                  {textCopied ? <CheckIcon /> : <CopyIcon />}
                </button>
              </Tooltip>
            )}
            {canDiscuss && (
              <Tooltip content="Discuss in thread">
                <button
                  type="button"
                  onClick={() => {
                    onDiscussEntry({
                      handle,
                      channelId: discussContext.channelId,
                      threadRootEventId: discussContext.threadRootEventId,
                      draft: `/e/${handle} `,
                    });
                  }}
                  aria-label="Discuss in thread"
                  className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-edge-strong bg-surface-overlay px-2 py-1 text-xs text-fg-secondary shadow-sm hover:bg-edge-strong hover:text-fg"
                >
                  <MessageSquarePlusIcon />
                  Discuss
                </button>
              </Tooltip>
            )}
            {canMarkup && (
              <Tooltip content={markupLoading ? 'Opening markup…' : 'Mark up & reply'}>
                <button
                  type="button"
                  onClick={(e) => {
                    if (markupLoading) {
                      e.preventDefault();
                      return;
                    }
                    onMarkupEntry(handle);
                  }}
                  aria-disabled={markupLoading || undefined}
                  aria-label="Mark up & reply"
                  className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-edge-strong bg-surface-overlay px-2 py-1 text-xs text-fg-secondary shadow-sm hover:bg-edge-strong hover:text-fg aria-disabled:cursor-default aria-disabled:text-fg-faint"
                >
                  <PenLineIcon />
                  {markupLoading ? 'Opening...' : 'Mark up'}
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>
      <MessageActionMenu
        state={actionMenu}
        onClose={closeActionMenu}
        restoreFocusRef={contentRef}
        actions={transcriptActions}
      />
      <SelectTextSheet open={selectTextContent != null} onClose={closeSelectText} restoreFocusRef={contentRef}>
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg-body">{selectTextContent}</div>
      </SelectTextSheet>
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

function MessageSquarePlusIcon(props: SVGProps<SVGSVGElement>) {
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
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h7" />
      <path d="M19 3v6" />
      <path d="M16 6h6" />
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

// ---- transcript items -------------------------------------------------------

const TextBlock = memo(
  function TextBlock({ item }: { item: TextItem }) {
    return (
      <div style={ITEM_VIS}>
        <SessionMarkdown text={item.text} />
      </div>
    );
  },
  (prev, next) => prev.item.text === next.item.text,
);

/** A transcript tool call: file edits (Edit/Write/MultiEdit/NotebookEdit) render
 * as an inline diff card — the actual change where it happened, not raw JSON —
 * and everything else as the generic tool card. Codex edits arrive as state, not
 * positioned items, so they stay drawer-only. */
function TranscriptTool({
  item,
  expanded,
  onToggle,
  clockSkewMs,
}: {
  item: ToolCallItem;
  expanded: boolean;
  onToggle: () => void;
  clockSkewMs?: number | null;
}) {
  const fileChange = fileChangeFromToolCall(item);
  if (fileChange) {
    const status = item.result === undefined ? 'running' : item.result.is_error ? 'error' : 'done';
    return <InlineFileChange change={fileChange} status={status} />;
  }
  return <ToolCard item={item} expanded={expanded} onToggle={onToggle} clockSkewMs={clockSkewMs} />;
}

const ToolCard = memo(
  function ToolCard({
    item,
    expanded,
    onToggle,
    clockSkewMs = null,
  }: {
    item: ToolCallItem;
    expanded: boolean;
    onToggle: () => void;
    clockSkewMs?: number | null;
  }) {
    const running = item.result === undefined;
    // Live "running" clock, anchored to the tool's server-stamped start when we
    // have one (correct for a pane opened mid-run) — first render otherwise.
    const startedRef = useRef<number>(Date.now());
    const stampedStart = item.ts !== undefined ? Date.parse(item.ts) : NaN;
    const startedAt =
      !Number.isNaN(stampedStart) && clockSkewMs !== null ? stampedStart + clockSkewMs : startedRef.current;
    const now = useNow(running);
    const elapsedMs = running ? Math.max(0, now - startedAt) : 0;
    const isError = item.result?.is_error === true;
    const command = typeof item.input['command'] === 'string' ? (item.input['command'] as string) : null;
    const rest = Object.fromEntries(Object.entries(item.input).filter(([k]) => k !== 'command'));
    const restJson = Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : null;
    const descriptor = toolDisplay(item);

    return (
      <div
        style={ITEM_VIS}
        data-testid="tool-card"
        className={`my-1 rounded-md border text-xs ${
          isError ? 'border-danger-border bg-danger-tint' : 'border-edge bg-surface-raised'
        }`}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-overlay"
        >
          <span className="text-fg-muted">
            {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          </span>
          <span className="sr-only">{item.name}</span>
          <span className="min-w-0 shrink truncate font-mono font-semibold text-fg-body">{descriptor.title}</span>
          {!expanded && descriptor.subtitle && (
            <span className="min-w-0 flex-1 truncate font-mono text-fg-muted">{descriptor.subtitle}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {running ? (
              <>
                {elapsedMs >= 1000 && (
                  <span className="tabular-nums text-2xs text-fg-faint">{formatElapsed(elapsedMs)}</span>
                )}
                <Spinner className="text-accent-text-strong" />
              </>
            ) : isError ? (
              <span className="font-semibold text-danger">error</span>
            ) : (
              <span className="text-fg-muted">done</span>
            )}
          </span>
        </button>
        {expanded && (
          <div className="border-t border-edge/80 px-2 py-1.5">
            {command !== null && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-fg-secondary">
                {command}
              </pre>
            )}
            {restJson && (
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-fg-muted">
                {restJson}
              </pre>
            )}
            {item.result && (
              <pre
                className={`mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded border px-2 py-1.5 font-mono text-2xs leading-relaxed ${
                  isError
                    ? 'border-danger-border bg-danger-tint text-danger-text-strong'
                    : 'border-edge bg-surface text-fg-secondary'
                }`}
              >
                {item.result.content}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  },
  // onToggle is intentionally excluded: it is a fresh closure every render but
  // only reads stable fields (item.id) plus state via a functional update.
  (prev, next) =>
    prev.expanded === next.expanded &&
    prev.item.name === next.item.name &&
    prev.item.input === next.item.input &&
    prev.item.result?.content === next.item.result?.content &&
    prev.item.result?.is_error === next.item.result?.is_error,
);

/** A durable linked-thread steer promoted to the same chrome as harness turns. */
function LinkedSteerRow({ steer }: { steer: LinkedSteer }) {
  return (
    <div
      data-testid="user-steer"
      data-turn={`thread-steer-${steer.id}`}
      title={formatExactTimestamp(steer.createdAt) || undefined}
      className="group pt-2 pb-0.5"
    >
      <SteerAuthorLine
        author={steer.author}
        iso={steer.createdAt}
        time={formatTurnTime(steer.createdAt)}
        provenance={null}
      />
      <MarkupSteerCard text={steer.text} />
      <SteerAttachments attachments={steer.attachments} />
      {steer.status === 'failed' ? <div className="mt-1 text-2xs text-danger-text">Not sent</div> : null}
    </div>
  );
}

function SteerAttachments({ attachments }: { attachments?: AttachmentMeta[] }) {
  if (!attachments?.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {attachments.map((attachment) => (
        <span
          key={attachment.id}
          className="max-w-56 truncate rounded-md border border-edge bg-surface-raised/70 px-2 py-1 text-xs text-fg-secondary"
        >
          {attachment.filename}
        </span>
      ))}
    </div>
  );
}

/** A thread chat message (not a steer) interleaved into the pane transcript. */
type PaneAside = { id: number; author: string; createdAt: string; text: string; pending?: boolean };

function PaneAsideRow({ aside }: { aside: PaneAside }) {
  return (
    <div
      data-testid="pane-aside"
      className={`my-1.5 ml-3.5 max-w-xl rounded-md border border-edge bg-surface-raised/50 px-2.5 py-1.5 text-xs ${
        aside.pending ? 'opacity-70' : ''
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-fg">{aside.author}</span>
        <span className="tabular-nums text-2xs text-fg-muted">{formatTime(aside.createdAt)}</span>
        <span className="text-3xs uppercase tracking-wide text-fg-faint">thread</span>
        {aside.pending && (
          <span data-testid="aside-sending" className="text-3xs text-fg-muted">
            sending…
          </span>
        )}
      </div>
      <div className="mt-0.5 whitespace-pre-wrap break-words leading-relaxed text-fg-body">
        <SessionMarkdown text={aside.text} />
      </div>
    </div>
  );
}
