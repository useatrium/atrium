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
  turnStatusLabel,
  isTerminalExecutionStatus,
  sideEffectCount,
  toolDisplay,
  type TextItem,
  type ToolCallItem,
  type UserMessageItem,
} from '@atrium/centaur-client';
import {
  ApiError,
  api,
  type AgentProfile,
  type AgentProfileProposal,
  type ConnectionStatus,
  type ProviderCredentialProvider,
  type ProviderCredentialStatus,
} from '../api';
import { WorkDrawer, type WorkTab } from './WorkDrawer';
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
import { MarkupPane, splitMarkdownFrontmatter, type MarkupPaneSource } from '../components/MarkupPane';
import { MarkupSteerCard } from '../components/MarkupSteerCard';
import { Tooltip } from '../components/a11y';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CornerUpLeftIcon,
  ExpandIcon,
  ExternalLinkIcon,
  SearchIcon,
  ShrinkIcon,
  XIcon,
} from '../components/icons';
import type { AttachmentMeta, AttachmentRef, UploadPayload, UserRef } from '@atrium/surface-client';
import {
  formatExactTimestamp,
  formatTime,
  formatTurnTime,
  matchSteerProvenance,
  randomId,
  type SteerProvenance,
} from '@atrium/surface-client';
import { sessionsApi } from './api';
import { StatusChip, repoBranchLabel, repoBranchTitle, sessionElapsedMs, useNow } from './SessionCard';
import {
  HARNESS_EFFORT_PICKER_OPTIONS,
  formatCost,
  formatElapsed,
  isPendingSessionId,
  isStalledSessionStatus,
  isTerminalSessionStatus,
  normalizeExecutionStatus,
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
import { ProfileChangesBanner, ProviderAuthBanner, QuestionBanner, profileProviderLabel } from './SessionBanners';
import { groupQuestionEventsByQuestion, QuestionTranscriptCard } from './SessionQuestionTranscript';
import { SuggestionStrip } from './SessionSuggestions';
import { showErrorToast } from '../components/Toasts';
import { TimestampDisclosure } from '../components/TimestampDisclosure';
import { entryParamFromSearch, stripEntryParamFromLocation } from '../EntryLinkRoute';
import { entryShareUrl, sessionShareUrl } from '../lib/publicUrl';

// Skip offscreen rendering work so 500+ item transcripts scroll smoothly.
const ITEM_VIS: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' };
const ENTRY_REFERENCES_REFETCH_MS = 60_000;
const MOBILE_MEDIA_QUERY = '(max-width: 767px)';

function isMobileViewportNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(MOBILE_MEDIA_QUERY).matches
    : false;
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

export function isTranscriptEntryHandle(handle: string | null): handle is string {
  return typeof handle === 'string' && handle.startsWith('rec_');
}

function normalizeSteerEchoText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function steerProvenanceKey(provenance: SteerProvenance): string {
  return [
    String(provenance.resolvedAt),
    provenance.proposerName,
    provenance.resolvedByName,
    provenance.edited ? 'edited' : 'sent',
  ].join('\u0000');
}

type OutputSurface = 'conflicts' | 'changes' | 'sideEffects' | 'artifacts';
type OutputCounts = Record<OutputSurface, number>;
type PendingSteer = {
  id: string;
  text: string;
  ts: string;
  delivered?: boolean;
  provenance?: SteerProvenance;
  acceptedByMe?: boolean;
};
type SteerProvenanceView = {
  provenance: SteerProvenance;
  acceptedByMe: boolean;
};

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
        className={`font-semibold uppercase tracking-wider ${
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
  providerCredentials,
  githubConnection,
  onConnectProvider,
  onConnectGitHub,
  agentProfiles = [],
  layout = 'split',
  onToggleFocus,
  initialEntryHandle = null,
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
  ) => Promise<void>;
  queueUpload?: (payload: UploadPayload) => Promise<{ fileId: string }>;
  failedSteer?: string | null;
  onClearFailedSteer?: () => void;
  onCancelSession?: (sessionId: string) => Promise<void>;
  onStopTurn?: (sessionId: string) => Promise<void>;
  failedCancel?: boolean;
  onClearFailedCancel?: () => void;
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

  // Work drawer (Phase 4): one tabbed surface over Changes + Side-effects, with
  // a peek→pin ladder. `workTab` null = closed; `workPinned` docks it beside the
  // transcript. Pinning gives the transcript room by collapsing to focus (the
  // ratified pane-cap rule); we restore split on unpin only if pin caused it.
  const [workTab, setWorkTab] = useState<WorkTab | null>(null);
  const [workPinned, setWorkPinned] = useState(false);
  const canPinWork = !isMobileViewport;
  const workPinnedEffective = workPinned && canPinWork;
  const workAutoFocusedRef = useRef(false);
  const restoreSplitIfAuto = () => {
    if (workAutoFocusedRef.current && onToggleFocus) {
      workAutoFocusedRef.current = false;
      onToggleFocus();
    }
  };
  const closeWork = () => {
    setWorkTab(null);
    setWorkPinned(false);
    restoreSplitIfAuto();
  };
  const onStrip = (tab: WorkTab) => {
    if (workTab === tab && !workPinnedEffective) closeWork();
    else setWorkTab(tab);
  };
  const togglePin = () => {
    if (!canPinWork) {
      setWorkPinned(false);
      return;
    }
    if (workPinned) {
      setWorkPinned(false);
      restoreSplitIfAuto();
    } else {
      setWorkPinned(true);
      if (layout === 'split' && onToggleFocus) {
        workAutoFocusedRef.current = true;
        onToggleFocus();
      }
    }
  };

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
  // A completed session is idle/resumable (a steer regresses completed→queued),
  // NOT ended — only failed/cancelled are truly read-only.
  const isEnded = displayStatus === 'failed' || displayStatus === 'cancelled';
  const now = useNow(!displayTerminal);
  const stalled = !displayTerminal && stream.status === 'idle' && isStalledSessionStatus(session, now);
  const costUsd = Math.max(session.costUsd, stream.costUsd);
  const resultText = stream.resultText || session.resultText || '';
  const isSpawner = session.spawnedBy === me.id;
  const spectators = watchers.length;
  const pendingQuestion = session.pendingQuestion !== undefined ? session.pendingQuestion : stream.pendingQuestion;
  const questionEvents = session.questionEvents ?? [];
  const questionEventsByQuestion = useMemo(() => groupQuestionEventsByQuestion(questionEvents), [questionEvents]);
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
  // "stopped by you" is folded from the durable terminal event (reducer
  // `stoppedByUser`), so every viewer sees it and it survives replay/reload; it
  // clears automatically when a new turn starts.
  const stoppedByUser = stream.stoppedByUser === true;
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
  const canPickEffort = sessionDriverId(session) === me.id && effortOptions !== undefined && !isEnded;
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
    const echoed = new Map<string, UserMessageItem[]>();
    for (const it of stream.items) {
      if (it.type === 'user_message') {
        const t = normalizeSteerEchoText(it.text);
        const matches = echoed.get(t);
        if (matches) matches.push(it);
        else echoed.set(t, [it]);
      }
    }
    const consumedEchoes = new Set<string>();
    const carriedProvenance = new Map<string, { provenance: SteerProvenance; acceptedByMe: boolean }>();
    const keep = pendingSteers.filter((p) => {
      const t = normalizeSteerEchoText(p.text);
      const match = echoed.get(t)?.find((it) => !consumedEchoes.has(it.id));
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
    ? "You're driving this session"
    : driverPresent
      ? `You're watching — ${driverName} is driving`
      : "You're watching";
  const composerPlaceholder = isDriver ? 'Steer the agent...' : `Suggest a message — ${driverName} decides`;
  const providerAuthOwnerName = nameFor(session.providerAuthRequired?.userId ?? null);
  // Steer frames carry no author; attribute to the spawner (Phase-1 approximation —
  // per-steer seat-aware attribution arrives with the session record in Phase 2).
  const steerAuthor = nameFor(session.spawnedBy);
  // Turn navigation skeleton: index the steers (the user's turns), not agent replies.
  const turns = useMemo(
    () =>
      stream.items
        .filter((it): it is UserMessageItem => it.type === 'user_message')
        .map((it) => ({ id: it.id, text: it.text })),
    [stream.items],
  );
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
      acceptedByMe:
        optimistic?.acceptedByMe === true || acceptedByMeProvenanceKeys.has(steerProvenanceKey(provenance)),
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
    setPendingSteers((prev) => [...prev, { id: pendingId, text, ts: new Date().toISOString() }]);
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
    const steer = hasAttachments
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
  const sendSuggestion = (text: string) => {
    setSuggestError(null);
    sessionsApi.createSuggestion(session.id, text, randomId()).catch((err: unknown) => {
      setSuggestError(text);
      reportSessionActionError(err, "Couldn't send the suggestion.", { toast: false });
    });
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
  const onCancel = () => {
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
  };

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

  // Codex file edits render inline as diff cards (parity with Claude/amp edits,
  // which are already transcript tool_call items). They live in stream.fileChanges
  // rather than stream.items, so anchor each to the point in the transcript where
  // it happened and splice it in at render time — same interleave-by-index shape
  // as the seat-audit lines above.
  const inlineCodexChanges = useMemo(() => codexInlineFileChanges(stream), [stream.items, stream.fileChanges]);
  const codexChangesAt = (i: number) => inlineCodexChanges.filter((a) => a.index === i);

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
        const response = await fetch(`/api/files/artifact/${extracted.artifactId}/content`, {
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
      className={`relative flex min-w-0 flex-col border-l border-edge bg-surface ${
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
          aria-label="Resize session panel"
          aria-valuemin={SESSION_PANE_MIN_WIDTH}
          aria-valuemax={paneMaxWidth}
          aria-valuenow={paneWidth ?? SESSION_PANE_FALLBACK_WIDTH}
          title="Drag to resize · double-click to reset"
          data-testid="pane-resize-handle"
          onPointerDown={startResize}
          onDoubleClick={resetWidth}
          className={`absolute inset-y-0 -left-0.5 z-20 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-accent/50 ${
            resizing ? 'bg-accent/50' : ''
          }`}
        />
      )}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge px-3 max-md:h-auto max-md:min-h-12 max-md:flex-wrap max-md:gap-1 max-md:px-2 max-md:py-1.5">
        <StatusChip status={displayStatus} stalled={stalled} />
        {/* On a phone the title+metadata drop to their own full-width row below the
            compact status/actions row, so the title stays readable instead of being
            squeezed to a couple of characters. Desktop keeps the inline flex-1 block. */}
        <div className="min-w-0 flex-1 max-md:order-last max-md:mt-1 max-md:basis-full">
          <h2 className="truncate text-sm font-semibold text-fg" title={session.title}>
            {session.title}
          </h2>
          <div className="flex items-center gap-1.5 text-3xs text-fg-muted max-md:min-w-0 max-md:flex-wrap max-md:gap-y-0.5">
            {driverId !== session.spawnedBy && (
              <span className="truncate max-md:min-w-0">{session.spawnerName ?? session.spawnedBy}</span>
            )}
            <span
              data-testid="driver-chip"
              className={`shrink-0 truncate rounded-full px-1.5 py-px font-medium max-md:min-w-0 max-md:shrink ${
                isDriver ? 'bg-accent-hover/15 text-accent-text-strong' : 'bg-surface-overlay/80 text-fg-secondary'
              }`}
            >
              driver: {driverName}
            </span>
            {spectators > 0 && (
              <>
                <span className="text-fg-faint">·</span>
                <span className="tabular-nums">{spectators} watching</span>
              </>
            )}
            {costUsd > 0 && (
              <>
                <span className="text-fg-faint">·</span>
                <span className="tabular-nums">{formatCost(costUsd)}</span>
              </>
            )}
            {session.repo && (
              <>
                <span className="text-fg-faint">·</span>
                <span className="truncate max-md:min-w-0" title={repoBranchTitle(session.repo, session.branch)}>
                  {repoBranchLabel(session.repo, session.branch)}
                </span>
              </>
            )}
            {githubIdentityLabel && (
              <>
                <span className="text-fg-faint">·</span>
                <span
                  className="shrink-0 truncate max-md:min-w-0 max-md:shrink"
                  title={`GitHub identity: ${githubIdentityLabel}`}
                >
                  GitHub: {githubIdentityLabel}
                </span>
              </>
            )}
            <span className="text-fg-faint">·</span>
            {stalled ? (
              <TimestampDisclosure
                iso={session.createdAt}
                label={`started ${formatTime(session.createdAt)}`}
                className="tabular-nums"
              >
                started {formatTime(session.createdAt)}
              </TimestampDisclosure>
            ) : (
              <span className="tabular-nums">{formatElapsed(sessionElapsedMs(session, now))}</span>
            )}
            {!connected && !displayTerminal && (
              <span role="status" className="text-warning/80">
                · reconnecting…
              </span>
            )}
          </div>
        </div>
        {(isSpawner || isDriver) && !displayTerminal && (
          <Tooltip content={canStopTurn ? 'Cancel the current turn' : 'Cancel this session'}>
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
                  ? 'Cancel turn failed — retry'
                  : 'Cancel turn'
                : displayCancelAsk === 'confirm'
                  ? 'Confirm cancel'
                  : displayCancelAsk === 'failed'
                    ? 'Cancel failed — retry'
                    : 'Cancel'}
            </button>
          </Tooltip>
        )}
        <div className="relative max-md:shrink-0">
          <Tooltip content="Inspect session capabilities">
            <button
              ref={capabilitiesButtonRef}
              type="button"
              onClick={() => setCapabilitiesOpen((value) => !value)}
              aria-label="Inspect session capabilities"
              aria-expanded={capabilitiesOpen}
              aria-haspopup="dialog"
              className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg max-md:inline-flex max-md:size-11 max-md:items-center max-md:justify-center max-md:p-0 [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center [@media(pointer:coarse)]:p-0"
            >
              <SearchIcon size={15} />
            </button>
          </Tooltip>
          <SessionCapabilitiesPopover
            sessionId={session.id}
            open={capabilitiesOpen}
            invokerRef={capabilitiesButtonRef}
            onClose={() => setCapabilitiesOpen(false)}
          />
        </div>
        {canDetach && (
          <Tooltip content={sessionLinkCopied ? 'Copied session link' : 'Copy link to this session'}>
            <button
              type="button"
              onClick={copySessionLink}
              aria-label={sessionLinkCopied ? 'Copied session link' : 'Copy link to this session'}
              className={`rounded-md px-2 py-1 hover:bg-surface-overlay hover:text-fg max-md:inline-flex max-md:size-11 max-md:items-center max-md:justify-center max-md:p-0 [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center [@media(pointer:coarse)]:p-0 ${
                sessionLinkCopied ? 'text-accent-text-strong' : 'text-fg-tertiary'
              }`}
            >
              {sessionLinkCopied ? <CheckIcon /> : <LinkIcon />}
            </button>
          </Tooltip>
        )}
        {canDetach && (
          <Tooltip content={popout ? 'Open in full app' : 'Open session in a new tab'}>
            <a
              href={popout ? `/s/${session.id}` : `/s/${session.id}/pane`}
              target={popout ? undefined : '_blank'}
              rel={popout ? undefined : 'noopener noreferrer'}
              aria-label={popout ? 'Open in full app' : 'Open session in a new tab'}
              className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg max-md:inline-flex max-md:size-11 max-md:items-center max-md:justify-center max-md:p-0 [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center [@media(pointer:coarse)]:p-0"
            >
              <ExternalLinkIcon size={15} />
            </a>
          </Tooltip>
        )}
        {onToggleFocus && (
          <Tooltip content={focused ? 'Collapse to split view' : 'Expand to focus view'}>
            <button
              type="button"
              onClick={onToggleFocus}
              aria-label={focused ? 'Collapse to split view' : 'Expand to focus view'}
              aria-pressed={focused}
              className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg max-md:inline-flex max-md:size-11 max-md:items-center max-md:justify-center max-md:p-0 [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center [@media(pointer:coarse)]:p-0"
            >
              {focused ? <ShrinkIcon size={15} /> : <ExpandIcon size={15} />}
            </button>
          </Tooltip>
        )}
        <Tooltip content="Close session pane">
          <button
            type="button"
            onClick={closePane}
            aria-label="Close session pane"
            className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg max-md:inline-flex max-md:size-11 max-md:items-center max-md:justify-center max-md:p-0 [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:justify-center [@media(pointer:coarse)]:p-0"
          >
            <XIcon />
          </button>
        </Tooltip>
      </header>

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

      {pendingQuestion && !displayTerminal && (
        <QuestionBanner
          sessionId={session.id}
          pending={pendingQuestion}
          isDriver={isDriver}
          driverName={driverName}
          proposals={questionProposals}
          onAnswerQuestion={onAnswerQuestion}
        />
      )}

      {isEnded && resultText && (
        <div data-testid="session-result" className="shrink-0 border-b border-edge bg-surface-raised px-4 py-2">
          <div className="text-3xs font-semibold uppercase tracking-wider text-fg-muted">Result</div>
          <div className="mt-0.5 max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-body">
            {resultText}
          </div>
        </div>
      )}

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
          <OutputLabel unseen={unseenOutputs.sideEffects}>Side-effects</OutputLabel>
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
              onTab={setWorkTab}
              pinned={false}
              onTogglePin={togglePin}
              canPin={canPinWork}
              canDetach={canDetach}
              onClose={closeWork}
            />
          )}
          <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-3 py-2">
            <PlanPanel todos={stream.todos} plan={stream.plan} />
            {stream.items.length === 0 && !activeTurn && (
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
            {stream.items.map((item, i) => (
              <Fragment key={i}>
                {seatLinesAt(i).map((e) => (
                  <SeatAuditLine key={e.id} entry={e} nameFor={nameFor} />
                ))}
                {codexChangesAt(i).map((a) => (
                  <div key={a.change.id} className="pl-3.5">
                    <InlineFileChange change={a.change} />
                  </div>
                ))}
                <AnnotatedTranscriptRow
                  handle={item.handle ?? null}
                  onMarkupEntry={item.type === 'text' ? openMarkupFromEntry : undefined}
                  markupLoading={markupLoadingHandle === item.handle}
                  highlighted={item.handle != null && item.handle === flashEntryHandle}
                  references={item.handle != null ? entryReferences[item.handle] : null}
                  discussContext={discussContext}
                  onDiscussEntry={onDiscussEntry}
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
            ))}
            {seatLinesAt(stream.items.length).map((e) => (
              <SeatAuditLine key={e.id} entry={e} nameFor={nameFor} />
            ))}
            {codexChangesAt(stream.items.length).map((a) => (
              <div key={a.change.id} className="pl-3.5">
                <InlineFileChange change={a.change} />
              </div>
            ))}
            {pendingSteers.map((p) => (
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
                  provenance={
                    p.provenance ? { provenance: p.provenance, acceptedByMe: p.acceptedByMe === true } : null
                  }
                />
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-fg-body">{p.text}</div>
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
              onTab={setWorkTab}
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
        <div className="pointer-events-none absolute bottom-24 left-1/2 z-[75] -translate-x-1/2 rounded-md border border-accent-border/60 bg-surface-overlay px-3 py-2 text-xs font-medium text-accent-text-strong shadow-lg">
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
          cancelLabel={canStopTurn ? 'Cancel turn' : displayCancelAsk === 'confirm' ? 'Confirm cancel' : 'Cancel'}
          onCancel={isSpawner || isDriver ? onCancel : undefined}
        />
      )}

      {isEnded ? (
        <div className="shrink-0 border-t border-edge px-4 py-2.5 text-2xs text-fg-muted">
          Session ended — transcript is read-only.
        </div>
      ) : (
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
          <SessionTypingLine typers={typers} />
          <div className="shrink-0 border-t border-edge bg-surface-overlay px-4 py-1.5 text-2xs font-medium text-fg-muted">
            {composerStatusText}
          </div>
          <Composer
            placeholder={composerPlaceholder}
            onSend={isDriver ? sendSteer : (text) => sendSuggestion(text)}
            queueUpload={isDriver ? queueUpload : undefined}
            onTyping={onComposerTyping}
            allowAttachments={isDriver}
            allowVoice={false}
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
        </>
      )}
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
  children,
}: {
  handle: string | null;
  onMarkupEntry?: (handle: string) => void;
  markupLoading?: boolean;
  highlighted?: boolean;
  references?: EntryReferenceSummary | null;
  discussContext?: { channelId: string; threadRootEventId: number } | null;
  onDiscussEntry?: (payload: TranscriptDiscussPayload) => void;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const linkCopyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textCopyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [textCopied, setTextCopied] = useState(false);
  const [hasCopyableText, setHasCopyableText] = useState(false);

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

  if (!handle) return <>{children}</>;
  const canMarkup = handle.startsWith('rec_') && onMarkupEntry != null;
  const canDiscuss = handle.startsWith('rec_') && discussContext != null && onDiscussEntry != null;

  const copyEntryLink = () => {
    if (typeof navigator === 'undefined') return;
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
  };

  const copyBlockText = () => {
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
  };

  return (
    <div
      data-entry-handle={handle}
      className={`group relative ${highlighted ? 'entry-flash bg-accent-hover/10' : ''}`}
    >
      <div ref={contentRef} className="contents">
        {children}
      </div>
      <div className="pointer-events-none absolute -top-1 right-0 z-10 flex items-start gap-1 max-md:static max-md:mt-1 max-md:justify-end [@media(hover:none)]:static [@media(hover:none)]:mt-1 [@media(hover:none)]:justify-end">
        <div className="pointer-events-auto">
          <EntryReferencesChip summary={references} />
        </div>
        <div className="pointer-events-none flex gap-1 opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 max-md:pointer-events-auto max-md:flex-wrap max-md:justify-end max-md:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:flex-wrap [@media(hover:none)]:justify-end [@media(hover:none)]:opacity-100">
          <Tooltip content={linkCopied ? 'Copied entry link' : 'Copy entry link'}>
            <button
              type="button"
              onClick={copyEntryLink}
              aria-label={linkCopied ? 'Copied entry link' : 'Copy entry link'}
              className={`inline-flex h-7 w-8 items-center justify-center rounded-md border border-edge-strong bg-surface-overlay text-xs shadow-sm transition-colors hover:bg-edge-strong hover:text-fg max-md:size-11 [@media(pointer:coarse)]:size-11 ${
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
                className={`inline-flex h-7 w-8 items-center justify-center rounded-md border border-edge-strong bg-surface-overlay text-xs shadow-sm transition-colors hover:bg-edge-strong hover:text-fg max-md:size-11 [@media(pointer:coarse)]:size-11 ${
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
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-edge-strong bg-surface-overlay px-2 py-1 text-xs text-fg-secondary shadow-sm hover:bg-edge-strong hover:text-fg max-md:min-h-11 max-md:px-2.5 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-2.5"
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
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-edge-strong bg-surface-overlay px-2 py-1 text-xs text-fg-secondary shadow-sm hover:bg-edge-strong hover:text-fg aria-disabled:cursor-default aria-disabled:text-fg-faint max-md:min-h-11 max-md:px-2.5 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-2.5"
              >
                <PenLineIcon />
                {markupLoading ? 'Opening...' : 'Mark up'}
              </button>
            </Tooltip>
          )}
        </div>
      </div>
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
