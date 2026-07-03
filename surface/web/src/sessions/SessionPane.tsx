import {
  Fragment,
  memo,
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
import { useConflicts } from './useConflicts';
import { InlineFileChange } from './fileChangeView';
import { PlanPanel } from './PlanPanel';
import { Composer } from '../components/Composer';
import { EntryComments } from '../components/EntryComments';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExpandIcon,
  ExternalLinkIcon,
  SearchIcon,
  ShrinkIcon,
  XIcon,
} from '../components/icons';
import type { AttachmentMeta, AttachmentRef, UploadPayload, UserRef } from '@atrium/surface-client';
import { formatTime, formatTurnTime, randomId } from '@atrium/surface-client';
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
import { sessionPaneSizing, useSessionPaneWidth } from './useSessionPaneWidth';
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

// Skip offscreen rendering work so 500+ item transcripts scroll smoothly.
const ITEM_VIS: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' };

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
  failedCancel = false,
  onClearFailedCancel = () => {},
  providerCredentials,
  githubConnection,
  onConnectProvider,
  onConnectGitHub,
  agentProfiles = [],
  layout = 'split',
  onToggleFocus,
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
  const changedFileCount = useMemo(() => changedPaths(fileChanges).length, [fileChanges]);
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

  // Work drawer (Phase 4): one tabbed surface over Changes + Side-effects, with
  // a peek→pin ladder. `workTab` null = closed; `workPinned` docks it beside the
  // transcript. Pinning gives the transcript room by collapsing to focus (the
  // ratified pane-cap rule); we restore split on unpin only if pin caused it.
  const [workTab, setWorkTab] = useState<WorkTab | null>(null);
  const [workPinned, setWorkPinned] = useState(false);
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
    if (workTab === tab && !workPinned) closeWork();
    else setWorkTab(tab);
  };
  const togglePin = () => {
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

  // ── Live activity cue ──────────────────────────────────────────────────────
  // The status line only claims what the stream proves (see TurnStatus.tsx).
  // Clocks are anchored to server-stamped frame times — correct when opening a
  // pane mid-turn, identical for every viewer — and "quiet" is phase-aware:
  // every harness is legitimately silent while a tool runs (start → result,
  // nothing between), but streams token deltas continuously while thinking, so
  // only thinking-phase silence is meaningful. Harness-agnostic.
  const activeTurn = !displayTerminal && !stalled;
  const starting = displayStatus === 'spawning' || displayStatus === 'queued';
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
  const statusLabel = turnStatusLabel({
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
  // (consume-once by trimmed text). Only Codex echoes user messages — on other
  // harnesses the bubble persists as the steer's transcript row, so once the
  // turn goes active we mark it delivered (sticky) and stop dimming it.
  const [pendingSteers, setPendingSteers] = useState<{ id: string; text: string; ts: string; delivered?: boolean }[]>(
    [],
  );
  useEffect(() => {
    setPendingSteers([]);
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
    const echoed = new Map<string, number>();
    for (const it of stream.items) {
      if (it.type === 'user_message') {
        const t = it.text.trim();
        echoed.set(t, (echoed.get(t) ?? 0) + 1);
      }
    }
    const keep = pendingSteers.filter((p) => {
      const t = p.text.trim();
      const n = echoed.get(t) ?? 0;
      if (n > 0) {
        echoed.set(t, n - 1);
        return false;
      }
      return true;
    });
    if (keep.length !== pendingSteers.length) setPendingSteers(keep);
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

  const requestSeat = () => {
    setSeatAsk('requested');
    sessionsApi.requestSeat(session.id).catch(() => setSeatAsk('idle'));
  };
  const takeSeat = () => {
    setSeatAsk('idle');
    sessionsApi.takeSeat(session.id).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        // Seat actually held (driver is watching after all) — note it and
        // fall back to a polite request.
        setSeatAsk('seat-held');
        sessionsApi.requestSeat(session.id).catch(() => {});
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
    steer.catch(() => {
      setLocalSteerError(text);
      setPendingSteers((prev) => prev.filter((p) => p.id !== pendingId));
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
    sessionsApi.createSuggestion(session.id, text, randomId()).catch(() => setSuggestError(text));
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
    if (displayCancelAsk === 'idle') {
      setCancelAsk('confirm');
      return;
    }
    setCancelAsk('idle');
    onClearFailedCancel();
    onCancelSession(session.id).catch(() => setCancelAsk('failed'));
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
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lastEventId, seatEventCount, questionEventCount]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const focused = layout === 'focus';
  const { width: paneWidth, resizing, startResize, resetWidth } = useSessionPaneWidth();
  const paneSizing = sessionPaneSizing(paneWidth);
  const canDetach = !isPendingSessionId(session.id);
  const githubIdentityLabel = session.githubIdentityMode ? githubIdentityModeLabel(session.githubIdentityMode) : null;
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const capabilitiesButtonRef = useRef<HTMLButtonElement | null>(null);

  return (
    <aside
      className={`relative flex min-w-0 flex-col border-l border-edge bg-surface/60 ${
        focused ? 'flex-1' : `shrink-0 ${paneSizing.className}`
      }`}
      style={focused ? undefined : paneSizing.style}
    >
      {!focused && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize session panel"
          title="Drag to resize · double-click to reset"
          data-testid="pane-resize-handle"
          onPointerDown={startResize}
          onDoubleClick={resetWidth}
          className={`absolute inset-y-0 -left-0.5 z-20 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-accent/50 ${
            resizing ? 'bg-accent/50' : ''
          }`}
        />
      )}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-edge px-3">
        <StatusChip status={displayStatus} stalled={stalled} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-fg" title={session.title}>
            {session.title}
          </h2>
          <div className="flex items-center gap-1.5 text-3xs text-fg-muted">
            {driverId !== session.spawnedBy && (
              <span className="truncate">{session.spawnerName ?? session.spawnedBy}</span>
            )}
            <span
              data-testid="driver-chip"
              className={`shrink-0 truncate rounded-full px-1.5 py-px font-medium ${
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
                <span className="truncate" title={repoBranchTitle(session.repo, session.branch)}>
                  {repoBranchLabel(session.repo, session.branch)}
                </span>
              </>
            )}
            {githubIdentityLabel && (
              <>
                <span className="text-fg-faint">·</span>
                <span className="shrink-0 truncate" title={`GitHub identity: ${githubIdentityLabel}`}>
                  GitHub: {githubIdentityLabel}
                </span>
              </>
            )}
            <span className="text-fg-faint">·</span>
            {stalled ? (
              <span className="tabular-nums">started {formatTime(session.createdAt)}</span>
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
          <button
            onClick={onCancel}
            title="Cancel this session"
            className={`rounded-md border px-2 py-1 text-2xs font-medium ${
              displayCancelAsk === 'confirm'
                ? 'border-danger-border-strong bg-danger-tint/60 text-danger-text-strong hover:bg-danger-surface/60'
                : 'border-danger-border/60 text-danger hover:bg-danger-tint/40 hover:text-danger-text'
            }`}
          >
            {displayCancelAsk === 'confirm'
              ? 'Confirm cancel'
              : displayCancelAsk === 'failed'
                ? 'Cancel failed — retry'
                : 'Cancel'}
          </button>
        )}
        <div className="relative">
          <button
            ref={capabilitiesButtonRef}
            type="button"
            onClick={() => setCapabilitiesOpen((value) => !value)}
            title="Inspect session capabilities"
            aria-label="Inspect session capabilities"
            aria-expanded={capabilitiesOpen}
            aria-haspopup="dialog"
            className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
          >
            <SearchIcon size={15} />
          </button>
          <SessionCapabilitiesPopover
            sessionId={session.id}
            open={capabilitiesOpen}
            invokerRef={capabilitiesButtonRef}
            onClose={() => setCapabilitiesOpen(false)}
          />
        </div>
        {canDetach && (
          <a
            href={`/s/${session.id}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in a new tab"
            aria-label="Open session in a new tab"
            className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
          >
            <ExternalLinkIcon size={15} />
          </a>
        )}
        {onToggleFocus && (
          <button
            onClick={onToggleFocus}
            title={focused ? 'Collapse to split view' : 'Expand to focus view'}
            aria-label={focused ? 'Collapse to split view' : 'Expand to focus view'}
            aria-pressed={focused}
            className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
          >
            {focused ? <ShrinkIcon size={15} /> : <ExpandIcon size={15} />}
          </button>
        )}
        <button
          onClick={onClose}
          title="Close session pane"
          aria-label="Close session pane"
          className="rounded-md px-2 py-1 text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
        >
          <XIcon />
        </button>
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
            onClick={() => sessionsApi.grantSeat(session.id, seatRequest.userId).catch(() => {})}
            className="rounded-md bg-accent px-2 py-0.5 text-2xs font-medium text-on-accent hover:bg-accent-hover"
          >
            Grant
          </button>
          <button
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
        <div data-testid="session-result" className="shrink-0 border-b border-edge bg-surface-raised/60 px-4 py-2">
          <div className="text-3xs font-semibold uppercase tracking-wider text-fg-muted">Result</div>
          <div className="mt-0.5 max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-fg-body">
            {resultText}
          </div>
        </div>
      )}

      {conflictsN > 0 && (
        <button
          data-testid="conflicts-strip"
          onClick={() => onStrip('conflicts')}
          aria-expanded={workTab === 'conflicts'}
          className="flex shrink-0 items-center gap-2 border-b border-danger-edge bg-danger-surface px-3 py-1.5 text-left text-2xs text-danger-text hover:opacity-90"
        >
          <span className="font-semibold uppercase tracking-wider">Conflicts</span>
          <span className="tabular-nums">· {conflictsN}</span>
          <span className="ml-auto opacity-80">{workTab === 'conflicts' ? 'Hide' : 'Resolve'}</span>
        </button>
      )}
      {changedFileCount > 0 && (
        <button
          data-testid="changes-strip"
          onClick={() => onStrip('changes')}
          aria-expanded={workTab === 'changes'}
          className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface-raised/40 px-3 py-1.5 text-left text-2xs text-fg-secondary hover:bg-surface-overlay/60"
        >
          <span className="font-semibold uppercase tracking-wider text-fg-muted">Changes</span>
          <span className="tabular-nums">· {changedFileCount}</span>
          <span className="ml-auto text-fg-tertiary">{workTab === 'changes' ? 'Hide' : 'View'}</span>
        </button>
      )}
      {sideEffectsN > 0 && (
        <button
          data-testid="sideeffects-strip"
          onClick={() => onStrip('sideEffects')}
          aria-expanded={workTab === 'sideEffects'}
          className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface-raised/40 px-3 py-1.5 text-left text-2xs text-fg-secondary hover:bg-surface-overlay/60"
        >
          <span className="font-semibold uppercase tracking-wider text-fg-muted">Side-effects</span>
          <span className={`tabular-nums ${sideEffectsDanger ? 'text-danger-text' : ''}`}>· {sideEffectsN}</span>
          <span className="ml-auto text-fg-tertiary">{workTab === 'sideEffects' ? 'Hide' : 'View'}</span>
        </button>
      )}
      {artifactsN > 0 && (
        <button
          data-testid="artifacts-strip"
          onClick={() => onStrip('artifacts')}
          aria-expanded={workTab === 'artifacts'}
          className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface-raised/40 px-3 py-1.5 text-left text-2xs text-fg-secondary hover:bg-surface-overlay/60"
        >
          <span className="font-semibold uppercase tracking-wider text-fg-muted">Artifacts</span>
          <span className="tabular-nums">· {artifactsN}</span>
          <span className="ml-auto text-fg-tertiary">{workTab === 'artifacts' ? 'Hide' : 'View'}</span>
        </button>
      )}

      <div className={`flex min-h-0 flex-1 ${workTab && workPinned ? 'flex-row' : 'flex-col'}`}>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {workTab && !workPinned && (
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
              tab={workTab}
              onTab={setWorkTab}
              pinned={false}
              onTogglePin={togglePin}
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
                <AnnotatedTranscriptRow handle={item.handle ?? null}>
                  {/* `group` + title: every row gets a native mouseover timestamp;
                  steer rows also reveal an inline one (their hover target is
                  obvious and they anchor turn navigation). */}
                  <div className="group" title={turnTimes.get(item.id)}>
                    {item.type === 'text' ? (
                      <div className="pl-3.5">
                        <TextBlock item={item} />
                      </div>
                    ) : item.type === 'user_message' ? (
                      <div data-testid="user-steer" data-turn={item.id} className="pt-2 pb-0.5">
                        <div className="text-sm font-semibold text-fg">
                          {steerAuthor}
                          <TurnTimeLabel time={turnTimes.get(item.id)} />
                        </div>
                        <div className="whitespace-pre-wrap text-sm leading-relaxed text-fg-body">{item.text}</div>
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
                title={formatTurnTime(p.ts)}
                className={`group pt-2 pb-0.5${p.delivered ? '' : ' opacity-60'}`}
              >
                <div className="text-sm font-semibold text-fg">
                  {steerAuthor}
                  <TurnTimeLabel time={formatTurnTime(p.ts)} />
                </div>
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
        {workTab && workPinned && (
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
              tab={workTab}
              onTab={setWorkTab}
              pinned
              onTogglePin={togglePin}
              canDetach={canDetach}
              onClose={closeWork}
            />
          </div>
        )}
      </div>

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
          cancelLabel={displayCancelAsk === 'confirm' ? 'Confirm cancel' : 'Cancel'}
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
                onClick={() => sendSteer(steerError)}
                className="rounded-md bg-danger-surface/50 px-2 py-0.5 text-2xs font-medium text-danger-text-strong hover:bg-danger-surface/80"
              >
                Retry
              </button>
              <button
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
                onClick={() => sendSuggestion(suggestError)}
                className="rounded-md bg-danger-surface/50 px-2 py-0.5 text-2xs font-medium text-danger-text-strong hover:bg-danger-surface/80"
              >
                Retry
              </button>
              <button
                onClick={() => setSuggestError(null)}
                className="rounded-md px-2 py-0.5 text-2xs font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
              >
                Dismiss
              </button>
            </div>
          )}
          <SessionTypingLine typers={typers} />
          <div className="shrink-0 border-t border-edge bg-surface-overlay/30 px-4 py-1.5 text-2xs font-medium text-fg-muted">
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
                        onClick={takeSeat}
                        className="rounded border border-accent-border-muted/60 px-2 py-0.5 font-medium text-accent-text-strong hover:bg-accent-tint/40 hover:text-accent-text-strong"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setSeatAsk('idle')}
                        className="rounded px-2 py-0.5 font-medium text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
                      >
                        Keep watching
                      </button>
                    </>
                  ) : (
                    <button
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
function TurnTimeLabel({ time }: { time: string | undefined }) {
  if (!time) return null;
  return (
    <span
      data-testid="turn-time"
      className="ml-2 align-middle text-3xs font-normal tabular-nums text-fg-faint opacity-0 transition-opacity group-hover:opacity-100"
    >
      {time}
    </span>
  );
}

function AnnotatedTranscriptRow({ handle, children }: { handle: string | null; children: ReactNode }) {
  const commentButtonRef = useRef<HTMLButtonElement | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    return () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
    };
  }, []);

  if (!handle) return <>{children}</>;

  const copyEntryLink = () => {
    if (typeof navigator === 'undefined') return;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    const origin = typeof window === 'undefined' ? '' : window.location.origin;
    void clipboard
      .writeText(`${origin}/e/${handle}`)
      .then(() => {
        setLinkCopied(true);
        if (copyResetRef.current) clearTimeout(copyResetRef.current);
        copyResetRef.current = setTimeout(() => setLinkCopied(false), 1400);
      })
      .catch(() => {});
  };

  return (
    <div className="group relative">
      {children}
      <div className="pointer-events-none absolute -top-1 right-0 z-10 flex gap-1 opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
        <button
          type="button"
          onClick={copyEntryLink}
          title={linkCopied ? 'Copied entry link' : 'Copy entry link'}
          aria-label={linkCopied ? 'Copied entry link' : 'Copy entry link'}
          className={`rounded-md border border-edge-strong bg-surface-overlay px-2 py-1 text-xs shadow-sm hover:bg-edge-strong hover:text-fg ${
            linkCopied ? 'text-accent-text-strong' : 'text-fg-secondary'
          }`}
        >
          <LinkIcon />
        </button>
        <button
          ref={commentButtonRef}
          type="button"
          onClick={() => setCommentsOpen((v) => !v)}
          title="Comment"
          aria-label="Comment on entry"
          aria-expanded={commentsOpen}
          aria-haspopup="dialog"
          className="rounded-md border border-edge-strong bg-surface-overlay px-2 py-1 text-xs text-fg-secondary shadow-sm hover:bg-edge-strong hover:text-fg"
        >
          <MessageCircleIcon />
        </button>
      </div>
      <EntryComments
        handle={handle}
        open={commentsOpen}
        onClose={() => setCommentsOpen(false)}
        invokerRef={commentButtonRef}
      />
    </div>
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

function MessageCircleIcon(props: SVGProps<SVGSVGElement>) {
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
      <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" />
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
          isError ? 'border-danger-border/60 bg-danger-tint/20' : 'border-edge bg-surface-raised/50'
        }`}
      >
        <button
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-overlay/40"
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
                    ? 'border-danger-border/60 bg-danger-tint/30 text-danger-text-strong'
                    : 'border-edge bg-surface/70 text-fg-secondary'
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
