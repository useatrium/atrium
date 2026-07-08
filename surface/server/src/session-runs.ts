import { randomUUID } from 'node:crypto';
import { recordFrameObservation } from './frame-gap.js';
import type { ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { Effect } from 'effect';
import { encodeRecordHandle } from '@atrium/surface-client/handle';
import { HARNESS_EFFORT_LEVELS, isSessionEffortLevel } from '@atrium/surface-client/effort';
import {
  CentaurApiError,
  CentaurClient,
  collectArtifacts,
  collectFileChanges,
  collectSideEffects,
  initialSessionState,
  isTerminalExecutionStatus,
  reduceSession,
  type Artifact,
  type CentaurEventFrame,
  type ExecuteResponse,
  type FileChange,
  type QuestionPrompt,
  type SessionItem,
  type SideEffect,
} from '@atrium/centaur-client';
import { config } from './config.js';
import type { Db, DbClient } from './db.js';
import { withTx } from './db.js';
import { projectSessionIncremental, releaseSessionProjectionState } from './session-records.js';
import { projectIncrementalAndEmit } from './session-record-changefeed.js';
import { ArtifactLedger, type VersionRef } from './artifact-ledger.js';
import { InvalidArtifactPathError } from './artifact-path.js';
import { presignGet as s3PresignGet } from './s3.js';
import { appendEvent, canAccessChannel, DomainError, type UserRef, type WireEvent } from './events.js';
import type { WsHub } from './hub.js';
import { sendQuestionPush, sendSessionCompletedPush } from './push.js';
import {
  CLAUDE_CODE_PROVIDER,
  ProviderCredentials,
  claudeExecutionEnvironment,
  codexExecutionEnvironment,
  isProviderAuthFailureText,
  providerAuthRequired,
  providerDisplayName,
  providerForHarness,
  type ProviderCredentialProvider,
  type ProviderAuthRequiredJson,
} from './provider-credentials.js';
import { Connections } from './connections.js';
import { convergeGitHubPublicReadFallback } from './github-iron-control.js';
import type { IronControlAdminClient } from './iron-control.js';
import { AgentProfiles } from './agent-profiles.js';
import { agentTurnInputLine, agentTurnMessageParts, type AgentTurnAttachmentRef } from './session-attachments.js';
import { appendReferencedEntriesAppendix } from './referenced-entries.js';
import { buildSteerContextBlock, type SteerContextSuggestionAttribution } from './steer-context.js';

export type SessionStatus = 'spawning' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SessionJson {
  id: string;
  workspaceId: string;
  channelId: string;
  threadRootEventId: number | null;
  title: string;
  status: SessionStatus;
  harness: string;
  repo: string | null;
  branch: string | null;
  repos: SessionRepoSpec[] | null;
  spawnedBy: string;
  driverId: string | null;
  driver: SessionUserJson | null;
  pendingSeatRequests: SessionUserJson[];
  suggestions: SessionSuggestionJson[];
  answerProposals: SessionAnswerProposalJson[];
  pendingQuestion: SessionPendingQuestionJson | null;
  providerAuthRequired: ProviderAuthRequiredJson | null;
  githubIdentityMode: string | null;
  providerConnectionId: string | null;
  agentProfileVersionId: string | null;
  /** Current reasoning effort — seeded from the profile at spawn, updated by
   * per-turn steer overrides (codex only). Null = harness default. */
  modelEffort: string | null;
  viewerCount: number;
  costUsd: number;
  resultText: string | null;
  createdAt: string;
  completedAt: string | null;
  lastEventId: number;
  permalink: string;
}

interface SessionFrameRecordHandle {
  handle: string;
  kind: string;
  actor: string;
  meta: Record<string, unknown>;
}

export interface SessionUserJson {
  userId: string;
  displayName: string;
}

export type SuggestionStatus = 'pending' | 'sent' | 'dismissed';

export interface SessionSuggestionJson {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  status: SuggestionStatus;
  resolvedBy: string | null;
  resolvedByName: string | null;
  sentText: string | null;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export type AnswerProposalStatus = 'pending' | 'submitted' | 'dismissed';

export interface SessionAnswerProposalJson {
  id: string;
  questionId: string;
  authorId: string;
  authorName: string;
  answers: QuestionAnswerBody;
  status: AnswerProposalStatus;
  resolvedBy: string | null;
  resolvedByName: string | null;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface SessionPendingQuestionJson {
  questionId: string;
  turnId: string;
  questions: QuestionPrompt[];
  eventId: number;
}

export interface SessionSeatHistoryEntry {
  eventId: number;
  from: string | null;
  to: string;
  reason: string;
  at: string;
}

export interface SessionQuestionAnswerJson {
  id: string;
  header: string;
  answers: string[];
  count: number;
}

export interface SessionQuestionHistoryEntry {
  eventId: number;
  questionId: string;
  kind: 'requested' | 'answered' | 'resolved';
  actorId: string | null;
  at: string;
  questions: QuestionPrompt[] | null;
  answers: SessionQuestionAnswerJson[] | null;
  reason: string | null;
}

/**
 * The durable session record (for agents + async humans): the mirrored
 * transcript plus the human-side overlay — attributed steers (in the
 * transcript), suggestion dispositions with rationale, answer proposals, seat
 * handoffs, and question answers. `answerProposals` is the FULL list (all
 * statuses); `session.answerProposals` is only the live pending subset.
 */
export interface SessionRecordJson {
  session: SessionJson;
  transcript: SessionItem[];
  /** Work products: the file edits the session made (Phase 4 Changes surface). */
  changes: FileChange[];
  /** Work products: the shell ops the session ran, classified by category +
   * risk (Phase 4 Side-effects surface). */
  sideEffects: SideEffect[];
  /** Work products: the files the capture sidecar surfaced (Phase 4 Artifacts
   * surface). Metadata only — bytes are served from atrium's store on demand. */
  artifacts: Artifact[];
  answerProposals: SessionAnswerProposalJson[];
  seatHistory: SessionSeatHistoryEntry[];
  questionHistory: SessionQuestionHistoryEntry[];
  participants: SessionUserJson[];
}

export interface QuestionAnswerBody {
  [questionId: string]: {
    answers: string[];
  };
}

export type ArtifactServePlan = { kind: 'redirect'; url: string; s3Key?: string };

function ledgerServePathCandidates(path: string): string[] {
  if (path.startsWith('/')) return [path];
  return [path, `/home/agent/workspace/${path}`];
}

export interface SessionListItem {
  id: string;
  channelId: string;
  channelName: string;
  title: string;
  status: SessionStatus;
  harness: string;
  spawnedBy: string;
  spawnerName: string;
  costUsd: number;
  createdAt: string;
  completedAt: string | null;
}

/** The S3 surface the artifact serve path needs. Injectable in tests
 * (the real impl is s3.ts; defaults to it). */
export interface ArtifactStorage {
  presignGet: typeof s3PresignGet;
}

export interface SessionRunsOptions {
  centaur?: CentaurClient;
  baseUrl?: string;
  apiKey?: string;
  /** Object store for artifact serve. Defaults to the real s3.ts. */
  artifactStorage?: ArtifactStorage;
  harness?: string;
  autoResume?: boolean;
  questionRenotifyMinutes?: number;
  questionPushFetchImpl?: typeof fetch;
  providerCredentials?: ProviderCredentials;
  agentProfiles?: AgentProfiles;
  ironControl?: IronControlAdminClient;
}

export interface SessionCreateResult {
  session: SessionJson;
  created: boolean;
  event: WireEvent | null;
  row: SessionRow | null;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  thread_root_event_id: number | null;
  centaur_thread_key: string;
  harness: string;
  repo: string | null;
  branch: string | null;
  session_repos: unknown | null;
  title: string;
  status: SessionStatus;
  spawned_by: string;
  driver_id: string | null;
  current_execution_id: string | null;
  assignment_generation: number | null;
  centaur_spawn_attempt: number;
  centaur_spawn_id: string | null;
  client_spawn_id: string | null;
  centaur_execute_attempt: number;
  centaur_execute_id: string | null;
  centaur_message_attempt: number;
  centaur_message_id: string | null;
  pending_question: unknown | null;
  provider_credential_user_id: string | null;
  provider_auth_required: unknown | null;
  provider_connection_id: string | null;
  github_identity_mode: string | null;
  agent_profile_version_id: string | null;
  model_effort: string | null;
  last_event_id: number;
  result_text: string | null;
  cost_usd: string | number;
  created_at: Date;
  completed_at: Date | null;
}

interface SessionRepoSpec {
  repo: string;
  ref?: string;
  subdir?: string;
  private?: boolean;
}

interface ChannelRow {
  workspace_id: string;
}

interface SessionUserRow {
  user_id: string;
  display_name: string;
}

interface SessionSuggestionRow {
  id: string;
  author_id: string;
  author_name: string;
  text: string;
  status: SuggestionStatus;
  resolved_by: string | null;
  resolved_by_name: string | null;
  sent_text: string | null;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface SessionAnswerProposalRow {
  id: string;
  question_id: string;
  author_id: string;
  author_name: string;
  answers: QuestionAnswerBody;
  status: AnswerProposalStatus;
  resolved_by: string | null;
  resolved_by_name: string | null;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface SessionLifecycleEventRow {
  id: number;
  type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

type SessionListStatus = 'running' | 'recent' | 'all';

interface SessionListRow extends SessionRow {
  channel_name: string;
  spawner_name: string;
}

interface SteerContextRow {
  display_name: string;
  handle: string;
  channel_name: string;
  sent_at: Date;
}

const TERMINAL_STATUSES = new Set<SessionStatus>(['completed', 'failed', 'cancelled']);
const DEMO_HARNESS = 'demo';
const DEMO_TITLE = 'Demo — watch an agent work';

// Idle window before a terminal session's sandbox assignment is released.
const releaseIdleMs = () => Number(process.env.SESSION_RELEASE_IDLE_MS ?? 60_000);

export class SessionRuns {
  private readonly centaur: CentaurClient;
  private readonly artifactStorage: ArtifactStorage;
  /** Durable CAS-ledger (docs/archive/notes/cas-ledger-build-plan.md). Shared by the
   * capture-bridge, serve, write-back, and GC paths. */
  private readonly artifactLedger: ArtifactLedger;
  private readonly harness: string;
  private readonly autoResume: boolean;
  private readonly questionRenotifyMinutes: number;
  private readonly questionPushFetchImpl?: typeof fetch;
  private readonly providerCredentials: ProviderCredentials;
  private readonly connections: Connections;
  private readonly ironControl?: IronControlAdminClient;
  private readonly agentProfiles: AgentProfiles;
  private readonly tailers = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly questionRenotifyTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly pool: Db,
    private readonly hub: WsHub,
    options: SessionRunsOptions = {},
  ) {
    this.centaur =
      options.centaur ??
      new CentaurClient({
        baseUrl: options.baseUrl ?? config.centaurBaseUrl,
        apiKey: options.apiKey ?? config.centaurApiKey,
      });
    this.artifactStorage = options.artifactStorage ?? { presignGet: s3PresignGet };
    this.artifactLedger = new ArtifactLedger(this.pool);
    this.harness = options.harness ?? config.centaurHarness;
    this.autoResume = options.autoResume ?? true;
    this.questionRenotifyMinutes = options.questionRenotifyMinutes ?? config.questionRenotifyMinutes;
    this.questionPushFetchImpl = options.questionPushFetchImpl;
    this.providerCredentials =
      options.providerCredentials ?? new ProviderCredentials(this.pool, config.providerCredentialSecret);
    this.connections = new Connections(this.pool);
    this.ironControl = options.ironControl;
    this.agentProfiles = options.agentProfiles ?? new AgentProfiles(this.pool);
  }

  async createSession(args: {
    channelId: string;
    threadRootEventId: number | null;
    task: string;
    harness?: string;
    repo?: string | null;
    branch?: string | null;
    repos?: unknown;
    githubIdentityMode?: string | null;
    providerConnectionId?: string | null;
    providerCredentialUserId?: string | null;
    agentProfileId?: string | null;
    agentProfileVersionId?: string | null;
    /** Client's optimistic id, echoed on session.spawned so a spawn whose
     * POST response was lost still reconciles instead of duplicating. */
    clientSpawnId?: string;
    initialAttachments?: AgentTurnAttachmentRef[];
    user: UserRef;
  }): Promise<SessionJson> {
    const result = await withTx(this.pool, (client) => this.createSessionInTx(client, args));
    this.afterCreateSession(result, args.task, args.initialAttachments);
    return result.session;
  }

  async createSessionInTx(
    client: DbClient,
    args: {
      channelId: string;
      threadRootEventId: number | null;
      task: string;
      harness?: string;
      repo?: string | null;
      branch?: string | null;
      repos?: unknown;
      githubIdentityMode?: string | null;
      providerConnectionId?: string | null;
      providerCredentialUserId?: string | null;
      agentProfileId?: string | null;
      agentProfileVersionId?: string | null;
      clientSpawnId?: string;
      initialAttachments?: AgentTurnAttachmentRef[];
      user: UserRef;
    },
  ): Promise<SessionCreateResult> {
    const existing = await this.findByClientSpawnId(client, args.user.id, args.clientSpawnId);
    if (existing) {
      return { session: toJson(existing), created: false, event: null, row: existing };
    }

    const harness = args.harness ?? this.harness;
    const demo = isDemoHarness(harness);
    const title = demo ? DEMO_TITLE : args.task.trim().slice(0, 80);
    const repos = normalizeSessionRepos(args.repos, args.repo, args.branch);
    const repo = repos[0]?.repo ?? normalizeGitMeta(args.repo);
    const branch = repos[0]?.ref ?? normalizeGitMeta(args.branch);
    const provider = providerForHarness(harness);
    const selectedProfileVersion = await this.agentProfiles.resolveVersionForSpawn(client, {
      userId: args.user.id,
      provider,
      profileId: args.agentProfileId,
      profileVersionId: args.agentProfileVersionId,
    });
    const providerCredentialUserId = args.providerCredentialUserId ?? (provider ? args.user.id : null);
    const channel = await getChannel(client, args.channelId);
    if (!channel) {
      throw new DomainError(404, 'channel_not_found', 'channel not found');
    }
    if (args.threadRootEventId != null) {
      await assertThreadRoot(client, args.channelId, args.threadRootEventId);
    }
    const conflictClause = args.clientSpawnId
      ? `ON CONFLICT (spawned_by, client_spawn_id) WHERE client_spawn_id IS NOT NULL DO NOTHING`
      : '';
    // Seed the session's effort from the spawning profile so the UI can show
    // it without re-resolving (possibly superseded) profile versions later.
    // Validated against the harness's vocabulary — an off-vocabulary manifest
    // value (a typo, or a codex level in a claude profile) must not be seeded,
    // or steers carrying the sticky selection would all fail 400.
    const profileSettings = selectedProfileVersion?.manifest.settings;
    const spawnEffortRaw = profileSettings?.['model_reasoning_effort'] ?? profileSettings?.['effortLevel'];
    const spawnEffort =
      typeof spawnEffortRaw === 'string' && (HARNESS_EFFORT_LEVELS[harness] ?? []).includes(spawnEffortRaw)
        ? spawnEffortRaw
        : null;
    const inserted = await client.query<SessionRow>(
      `INSERT INTO sessions (
         workspace_id, channel_id, thread_root_event_id, centaur_thread_key, harness, repo, branch, session_repos,
         title, status, spawned_by, driver_id, client_spawn_id, provider_credential_user_id,
         provider_connection_id, github_identity_mode, agent_profile_version_id, model_effort
       )
       -- driver_id starts as the spawner ($10 used for both spawned_by + driver_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'spawning', $10, $10, $11, $12, $13, $14, $15, $16)
       ${conflictClause}
       RETURNING *`,
      [
        channel.workspace_id,
        args.channelId,
        args.threadRootEventId,
        `${demo ? 'demo' : 'surface'}:${randomUUID()}`,
        harness,
        repo,
        branch,
        repos.length ? JSON.stringify(repos) : null,
        title,
        args.user.id,
        args.clientSpawnId ?? null,
        providerCredentialUserId,
        args.providerConnectionId ??
          (args.githubIdentityMode && args.githubIdentityMode !== 'automatic' ? 'github' : null),
        args.githubIdentityMode ?? 'automatic',
        selectedProfileVersion?.id ?? null,
        spawnEffort,
      ],
    );
    let row = inserted.rows[0];
    if (!row) {
      const existing = await this.findByClientSpawnId(client, args.user.id, args.clientSpawnId);
      if (!existing) throw new DomainError(500, 'session_create_failed', 'could not create session');
      return { session: toJson(existing), created: false, event: null, row: existing };
    }
    const event = await appendEvent(client, {
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      threadRootEventId: args.threadRootEventId,
      type: 'session.spawned',
      actorId: args.user.id,
      payload: {
        sessionId: row.id,
        title: row.title,
        harness: row.harness,
        by: args.user.id,
        ...(row.repo ? { repo: row.repo } : {}),
        ...(row.branch ? { branch: row.branch } : {}),
        ...(repos.length ? { repos } : {}),
        github_identity_mode: row.github_identity_mode ?? 'automatic',
        ...(row.provider_connection_id ? { provider_connection_id: row.provider_connection_id } : {}),
        ...(row.agent_profile_version_id ? { agent_profile_version_id: row.agent_profile_version_id } : {}),
        ...(args.clientSpawnId ? { client_spawn_id: args.clientSpawnId } : {}),
      },
    });
    if (args.threadRootEventId == null) {
      const updated = await client.query<SessionRow>(
        'UPDATE sessions SET thread_root_event_id = $1 WHERE id = $2 RETURNING *',
        [event.id, row.id],
      );
      row = updated.rows[0]!;
    }
    await this.agentProfiles.bindSessionProfileSnapshot(client, row.id, selectedProfileVersion);
    return { session: toJson(row), created: true, event, row };
  }

  afterCreateSession(
    result: SessionCreateResult,
    task: string,
    attachments: readonly AgentTurnAttachmentRef[] = [],
  ): void {
    if (!result.created || !result.event || !result.row) return;
    this.hub.publishEvent(result.event);
    queueMicrotask(() => {
      void this.startSession(result.row!.id, task, attachments).catch(() => {});
    });
  }

  // TODO(memberships): when multi-workspace membership lands, gate by
  // workspace membership too. Channel access already gates DM-spawned
  // sessions: 404 (not 403) so foreign session ids don't leak existence.
  async getSessionForUser(id: string, userId: string): Promise<SessionJson> {
    const row = await this.getSessionRow(id);
    if (!row || !(await canAccessChannel(this.pool, userId, row.channel_id))) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    return this.toJsonWithSeatInfo(row);
  }

  /**
   * The durable session record: the mirrored transcript + the human-side
   * overlay (suggestion dispositions, answer proposals, seat handoffs, question
   * answers) assembled from the durable tables. Channel access is gated by the
   * route. The transcript is replayed from the `session_events` mirror, so it
   * survives Centaur retention.
   */
  async getSessionRecord(id: string): Promise<SessionRecordJson> {
    const row = await this.getSessionRow(id);
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    const [session, mirrored, proposals, sessionEvents] = await Promise.all([
      this.toJsonWithSeatInfo(row),
      this.readMirroredState(id),
      this.pool.query<SessionAnswerProposalRow>(
        `SELECT p.id, p.question_id, p.author_id, a.display_name AS author_name,
                p.answers, p.status, p.resolved_by, r.display_name AS resolved_by_name,
                p.note, p.created_at, p.resolved_at
         FROM session_answer_proposals p
         JOIN users a ON a.id = p.author_id
         LEFT JOIN users r ON r.id = p.resolved_by
         WHERE p.session_id = $1
         ORDER BY p.created_at ASC`,
        [id],
      ),
      this.pool.query<SessionLifecycleEventRow>(
        `SELECT id, type, actor_id, payload, created_at
         FROM events
         WHERE type LIKE 'session.%' AND payload->>'sessionId' = $1
         ORDER BY id ASC`,
        [id],
      ),
    ]);
    const answerProposals = proposals.rows.map(toSessionAnswerProposalJson);
    const seatHistory = buildSeatHistory(sessionEvents.rows);
    const questionHistory = buildQuestionHistory(sessionEvents.rows);
    const participants = await this.resolveParticipants(
      row,
      session.suggestions,
      answerProposals,
      seatHistory,
      questionHistory,
    );
    return {
      session,
      transcript: mirrored.items,
      changes: collectFileChanges(mirrored),
      sideEffects: collectSideEffects(mirrored.items),
      artifacts: collectArtifacts(mirrored),
      answerProposals,
      seatHistory,
      questionHistory,
      participants,
    };
  }

  async getLedgerServePlan(
    sessionId: string,
    path: string,
    ref: VersionRef,
    options: { readableChannelIds?: readonly string[] } = {},
  ): Promise<ArtifactServePlan> {
    let v: Awaited<ReturnType<ArtifactLedger['resolveVersion']>> = null;
    let resolvedPath = path;
    for (const candidate of ledgerServePathCandidates(path)) {
      try {
        v = await this.artifactLedger.resolveVersion(sessionId, candidate, ref, options);
      } catch (err) {
        if (candidate !== path && err instanceof InvalidArtifactPathError) continue;
        throw err;
      }
      if (v) {
        resolvedPath = candidate;
        break;
      }
    }
    if (!v) {
      throw new DomainError(404, 'artifact_not_found', 'artifact not found');
    }
    if (v.kind === 'deleted' || v.tombstoned) {
      throw new DomainError(410, 'artifact_deleted', 'artifact was deleted');
    }
    if (!v.blobSha || !v.s3Key) {
      throw new DomainError(503, 'blob_unavailable', 'artifact bytes are not durable in CAS');
    }
    const filename = basename(resolvedPath) || 'artifact';
    const inline = (v.mime || '').startsWith('image/');
    const url = await this.artifactStorage.presignGet(v.s3Key, filename, inline);
    return { kind: 'redirect', url, s3Key: v.s3Key };
  }

  /** Replay the durable mirror into a reduced session state (transcript items +
   * derived work products). Survives Centaur retention. */
  private async readMirroredState(id: string): Promise<ReturnType<typeof initialSessionState>> {
    const res = await this.readMirroredFrames(id, 0);
    let state = initialSessionState();
    for (const r of res.rows) state = reduceSession(state, { ...r.frame, ts: r.created_at.toISOString() });
    return state;
  }

  private readMirroredFrames(
    id: string,
    afterEventId: number,
  ): Promise<{ rows: { frame: CentaurEventFrame; created_at: Date }[] }> {
    return this.pool.query<{ frame: CentaurEventFrame; created_at: Date }>(
      `SELECT frame, created_at
       FROM session_events
       WHERE session_id = $1 AND centaur_event_id > $2
       ORDER BY centaur_event_id ASC`,
      [id, afterEventId],
    );
  }

  private async resolveParticipants(
    row: SessionRow,
    suggestions: SessionSuggestionJson[],
    proposals: SessionAnswerProposalJson[],
    seatHistory: SessionSeatHistoryEntry[],
    questionHistory: SessionQuestionHistoryEntry[],
  ): Promise<SessionUserJson[]> {
    const ids = new Set<string>();
    ids.add(row.spawned_by);
    if (row.driver_id) ids.add(row.driver_id);
    for (const s of suggestions) {
      ids.add(s.authorId);
      if (s.resolvedBy) ids.add(s.resolvedBy);
    }
    for (const p of proposals) {
      ids.add(p.authorId);
      if (p.resolvedBy) ids.add(p.resolvedBy);
    }
    for (const e of seatHistory) {
      if (e.from) ids.add(e.from);
      ids.add(e.to);
    }
    for (const e of questionHistory) {
      if (e.actorId) ids.add(e.actorId);
    }
    if (ids.size === 0) return [];
    const res = await this.pool.query<SessionUserRow>(
      'SELECT id AS user_id, display_name FROM users WHERE id = ANY($1::uuid[])',
      [[...ids]],
    );
    return res.rows.map(toSessionUserJson);
  }

  async listSessionsForUser(args: {
    userId: string;
    status: SessionListStatus;
    limit: number;
  }): Promise<SessionListItem[]> {
    const statusWhere =
      args.status === 'running'
        ? "AND s.status IN ('spawning', 'queued', 'running')"
        : args.status === 'recent'
          ? "AND s.status NOT IN ('spawning', 'queued', 'running')"
          : '';
    const res = await this.pool.query<SessionListRow>(
      `SELECT s.*,
              c.name AS channel_name,
              u.display_name AS spawner_name
       FROM sessions s
       JOIN channels c ON c.id = s.channel_id
       JOIN users u ON u.id = s.spawned_by
       LEFT JOIN channel_members m
         ON m.channel_id = c.id AND m.user_id = $1
       -- Must mirror canAccessChannel: only 'public' is world-visible; every
       -- other kind (dm, gdm, private — and future ones) requires membership.
       WHERE (c.kind = 'public' OR m.user_id IS NOT NULL)
         ${statusWhere}
       ORDER BY CASE s.status
                  WHEN 'spawning' THEN 0
                  WHEN 'queued' THEN 1
                  WHEN 'running' THEN 2
                  ELSE 3
                END,
                s.created_at DESC
       LIMIT $2`,
      [args.userId, args.limit],
    );
    return res.rows.map(toListItem);
  }

  async streamCentaurEvents(
    session: SessionJson,
    userId: string,
    afterEventId: number,
    raw: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    const row = await this.getSessionRow(session.id);
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    const viewId = this.openSessionView(session.id, userId);
    // Named event (not a bare comment) so EventSource clients can observe it:
    // it proves the connection is alive and carries a server clock for
    // skew-free elapsed displays. Not a Centaur frame — no event_id, never
    // folded into the session reducer. The first ping goes out after the
    // mirror replay (below), so replay frames stay the stream's first bytes.
    const writePing = () => {
      raw.write(`event: ping\ndata: ${JSON.stringify({ atrium_ts: new Date().toISOString() })}\n\n`);
    };
    const keepAlive = setInterval(writePing, 15_000);
    keepAlive.unref?.();
    try {
      let cursor = afterEventId;
      await projectSessionIncremental(this.pool, session.id).catch(() => {});
      const mirrored = await this.readMirroredFrames(session.id, cursor);
      const replayHandles = await this.recordHandlesByEventId(
        session.id,
        mirrored.rows.map(({ frame }) => frame.event_id),
      );
      for (const { frame, created_at } of mirrored.rows) {
        if (signal.aborted) break;
        cursor = Math.max(cursor, frame.event_id);
        writeSessionFrame(raw, frame, replayHandles.get(frame.event_id), created_at.toISOString());
      }
      // Caught up: give the client its first server-clock ping now rather than
      // waiting out the first keep-alive interval.
      if (!signal.aborted) writePing();
      // Only tail live for a session with an active execution. A terminal
      // session's mirror already contains its terminal execution_state, which we
      // just replayed; the live tail would start past it (afterEventId: cursor)
      // and never observe a terminal frame to return on, holding the SSE open and
      // polling Centaur forever. Closing after replay matches the pre-replay
      // behavior (the terminal frame closed the stream); a follow-up turn flips
      // the status back to non-terminal and the client re-opens the stream.
      if (!signal.aborted && !TERMINAL_STATUSES.has(row.status)) {
        for await (const frame of this.centaur.tailEvents(row.centaur_thread_key, {
          executionId: row.current_execution_id ?? undefined,
          afterEventId: cursor,
          signal,
        })) {
          if (signal.aborted) break;
          const recordHandles = frameMayCreateTranscriptRecord(frame)
            ? (await this.recordHandlesByEventId(session.id, [frame.event_id])).get(frame.event_id)
            : undefined;
          // Live frames are happening now — receive time is the event time.
          writeSessionFrame(raw, frame, recordHandles, new Date().toISOString());
        }
      }
    } finally {
      clearInterval(keepAlive);
      void viewId.then((id) => {
        if (id != null) void this.closeSessionView(id);
      });
      raw.end();
    }
  }

  private async recordHandlesByEventId(
    sessionId: string,
    eventIds: number[],
  ): Promise<Map<number, SessionFrameRecordHandle[]>> {
    const uniqueEventIds = [...new Set(eventIds.filter((id) => Number.isSafeInteger(id) && id >= 0))];
    const byEventId = new Map<number, SessionFrameRecordHandle[]>();
    if (uniqueEventIds.length === 0) return byEventId;

    const res = await this.pool.query<{
      event_id: number;
      entry_uid: string;
      kind: string;
      actor: string;
      meta: unknown;
    }>(
      `SELECT event_id, entry_uid, kind, actor, meta
         FROM session_records
        WHERE session_id = $1
          AND event_id = ANY($2::bigint[])
          AND entry_uid IS NOT NULL
        ORDER BY seq ASC`,
      [sessionId, uniqueEventIds],
    );
    for (const row of res.rows) {
      const list = byEventId.get(row.event_id) ?? [];
      list.push({
        handle: encodeRecordHandle(row.entry_uid),
        kind: row.kind,
        actor: row.actor,
        meta: objectRecord(row.meta),
      });
      byEventId.set(row.event_id, list);
    }
    return byEventId;
  }

  async postUserMessage(
    id: string,
    userId: string,
    text: string,
    attachments: readonly AgentTurnAttachmentRef[] = [],
  ): Promise<void> {
    this.cancelScheduledRelease(id);
    const row = await this.requireDriver(id, userId);
    try {
      await this.postUserMessageOnce(row, userId, text, true, this.pool, undefined, attachments);
    } catch (err) {
      if (err instanceof DomainError && err.code === 'provider_auth_required') {
        await this.markProviderAuthRequired(id, 'missing_token', undefined).catch(() => {});
      }
      throw err;
    }
    this.startTailer(id);
  }

  /** Steer with an optional per-turn reasoning-effort override. Codex takes
   * it natively (`turn/start.effort`); claude gets a child respawn with a new
   * `--effort` (`--resume` keeps the transcript); amp has no channel. Returns
   * the effort-changed wire event when the override sticks, for the route to
   * publish post-commit. */
  async postUserMessageInTx(
    client: DbClient,
    id: string,
    userId: string,
    text: string,
    effort?: SessionEffortLevel,
    attachments: readonly AgentTurnAttachmentRef[] = [],
  ): Promise<WireEvent | null> {
    this.cancelScheduledRelease(id);
    const row = await this.requireDriverInTx(client, id, userId);
    if (effort && !(HARNESS_EFFORT_LEVELS[row.harness] ?? []).includes(effort)) {
      throw new DomainError(
        400,
        'effort_not_supported',
        `the ${row.harness} harness does not support effort "${effort}"`,
      );
    }
    await this.postUserMessageOnce(row, userId, text, true, client, effort, attachments);
    if (!effort || effort === row.model_effort) return null;
    await client.query('UPDATE sessions SET model_effort = $1 WHERE id = $2', [effort, id]);
    return appendEvent(client, {
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      threadRootEventId: row.thread_root_event_id,
      type: 'session.effort_changed',
      actorId: userId,
      payload: { sessionId: id, effort, by: userId },
    });
  }

  afterPostUserMessage(id: string): void {
    this.startTailer(id);
  }

  async answerQuestion(id: string, user: UserRef, questionId: string, answers: QuestionAnswerBody): Promise<void> {
    const row = await this.requireDriver(id, user.id);
    const pending = parsePendingQuestion(row.pending_question);
    if (!pending || pending.questionId !== questionId) {
      throw new DomainError(409, 'question_not_pending', 'question is not pending');
    }
    if (!row.current_execution_id) {
      throw new DomainError(409, 'execution_not_running', 'session has no running execution');
    }

    try {
      await this.postQuestionAnswer(row, user.id, questionId, answers);
    } catch (err) {
      if (isCentaurCode(err, 'QUESTION_NOT_PENDING')) {
        await this.clearPendingQuestion(id, questionId, 'empty');
        throw new DomainError(409, 'question_not_pending', 'question is not pending');
      }
      throw err;
    }

    const event = await withTx(this.pool, async (client) => {
      const before = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
      const locked = before.rows[0];
      const stillPending = locked ? parsePendingQuestion(locked.pending_question) : null;
      if (!locked || !stillPending || stillPending.questionId !== questionId) return null;
      const updated = await client.query<SessionRow>(
        'UPDATE sessions SET pending_question = NULL WHERE id = $1 RETURNING *',
        [id],
      );
      const next = updated.rows[0]!;
      return appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.question_answered',
        actorId: user.id,
        payload: {
          sessionId: id,
          questionId,
          by: user.id,
          answers: summarizeAnswers(stillPending, answers),
        },
      });
    });
    if (event) {
      this.cancelScheduledQuestionRenotify(id);
      this.hub.publishEvent(event);
    }
  }

  async answerQuestionInTx(
    client: DbClient,
    id: string,
    user: UserRef,
    questionId: string,
    answers: QuestionAnswerBody,
  ): Promise<WireEvent | null> {
    const before = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
    const row = before.rows[0];
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    if (row.driver_id !== user.id) {
      throw new DomainError(403, 'forbidden', 'only the current driver may steer this session');
    }
    const pending = parsePendingQuestion(row.pending_question);
    if (!pending || pending.questionId !== questionId) {
      throw new DomainError(409, 'question_not_pending', 'question is not pending');
    }
    if (!row.current_execution_id) {
      throw new DomainError(409, 'execution_not_running', 'session has no running execution');
    }

    try {
      await this.postQuestionAnswer(row, user.id, questionId, answers);
    } catch (err) {
      if (isCentaurCode(err, 'QUESTION_NOT_PENDING')) {
        throw new DomainError(409, 'question_not_pending', 'question is not pending');
      }
      throw err;
    }

    const updated = await client.query<SessionRow>(
      'UPDATE sessions SET pending_question = NULL WHERE id = $1 RETURNING *',
      [id],
    );
    this.cancelScheduledQuestionRenotify(id);
    const next = updated.rows[0]!;
    return appendEvent(client, {
      workspaceId: next.workspace_id,
      channelId: next.channel_id,
      threadRootEventId: next.thread_root_event_id,
      type: 'session.question_answered',
      actorId: user.id,
      payload: {
        sessionId: id,
        questionId,
        by: user.id,
        answers: summarizeAnswers(pending, answers),
      },
    });
  }

  private async postUserMessageOnce(
    row: SessionRow,
    userId: string,
    text: string,
    allowStaleRetry: boolean,
    client: Db | DbClient = this.pool,
    effort?: SessionEffortLevel,
    attachments: readonly AgentTurnAttachmentRef[] = [],
    contextBlock?: string,
  ): Promise<void> {
    const turnContextBlock =
      contextBlock ?? (await this.buildUserTurnContextBlock(client, row, userId, 'driver'));
    text = await appendReferencedEntriesAppendix(client, { sessionId: row.id, userId, text });
    // Stickiness is enforced HERE, at the single authoritative send point:
    // harness effort is per-turn (an omitted field reverts codex to its config
    // default, and a restarted claude child forgets its flag), so every steer
    // re-carries the session's recorded effort even when the client sent none
    // (mobile, suggestion-sends). The recorded value is re-validated in case
    // it predates the vocabulary (or the harness's support).
    if (
      effort === undefined &&
      row.model_effort &&
      (HARNESS_EFFORT_LEVELS[row.harness] ?? []).includes(row.model_effort)
    ) {
      effort = row.model_effort;
    }
    let generation = row.assignment_generation;
    if (generation == null) {
      const spawned = await this.spawnAssignment(row, client);
      generation = spawned.assignment_generation;
      row = spawned.row;
    }
    try {
      const messageId = await this.reserveMessageId(row.id, client);
      await this.centaur.postMessage(
        row.centaur_thread_key,
        generation,
        agentTurnMessageParts(text, attachments, turnContextBlock),
        { user_id: userId },
        { messageId },
      );
    } catch (err) {
      if (allowStaleRetry && isCentaurCode(err, 'ASSIGNMENT_GENERATION_STALE')) {
        const refreshed = await this.clearAssignment(row.id, client);
        await this.postUserMessageOnce(refreshed, userId, text, false, client, effort, attachments, turnContextBlock);
        return;
      }
      if (isCentaurCode(err, 'IDEMPOTENCY_PAYLOAD_MISMATCH')) {
        // A prior steer's message was delivered but its execute never
        // persisted, so the reserved id can't be reused for different text.
        // That delivered message still sits in Centaur's queue (the next
        // execute consumes it), so this steer is a NEW logical message:
        // mint a fresh id and post exactly once.
        await client.query('UPDATE sessions SET centaur_message_id = NULL WHERE id = $1', [row.id]);
        const freshId = await this.reserveMessageId(row.id, client);
        await this.centaur.postMessage(
          row.centaur_thread_key,
          generation,
          agentTurnMessageParts(text, attachments, turnContextBlock),
          { user_id: userId },
          { messageId: freshId },
        );
      } else {
        throw err;
      }
    }
    // A newly posted message needs a fresh execution: a pending execute id
    // left by a crashed earlier steer would make Centaur replay that old
    // execution and strand this message in the queue. Pending-id reuse is
    // only for boot resume (startSession), which posts no message.
    await client.query('UPDATE sessions SET centaur_execute_id = NULL WHERE id = $1', [row.id]);
    const executeId = await this.reserveExecuteId(row.id, client);
    let exec: ExecuteResponse;
    try {
      exec = await this.executeWithProviderEnvironment(row, generation, {
        executeId,
        inputLines: [agentTurnInputLine(text, attachments, effort, turnContextBlock)],
      });
    } catch (err) {
      if (isCentaurCode(err, 'execution_already_active')) {
        await client.query(
          'UPDATE sessions SET centaur_execute_id = NULL, centaur_message_id = NULL WHERE id = $1',
          [row.id],
        );
        return;
      }
      throw err;
    }
    await client.query(
      `UPDATE sessions
       SET current_execution_id = $1, status = CASE WHEN status = 'completed' THEN 'queued' ELSE status END,
           completed_at = CASE WHEN status = 'completed' THEN NULL ELSE completed_at END,
           provider_auth_required = NULL,
           centaur_execute_id = NULL,
           centaur_message_id = NULL
       WHERE id = $2`,
      [exec.execution_id, row.id],
    );
  }

  private async buildUserTurnContextBlock(
    client: Db | DbClient,
    row: SessionRow,
    userId: string,
    seat: string,
    suggestion?: Pick<SteerContextSuggestionAttribution, 'suggestedBy'>,
  ): Promise<string> {
    const res = await client.query<SteerContextRow>(
      `SELECT u.display_name,
              u.handle,
              c.name AS channel_name,
              now() AS sent_at
         FROM users u
         JOIN channels c ON c.id = $2
        WHERE u.id = $1`,
      [userId, row.channel_id],
    );
    const context = res.rows[0];
    if (!context) {
      throw new DomainError(404, 'user_not_found', 'user not found');
    }
    return buildSteerContextBlock({
      from: { name: context.display_name, handle: context.handle, kind: 'human', seat },
      channel: context.channel_name,
      sent: context.sent_at,
      ...(suggestion
        ? {
            suggestion: {
              suggestedBy: suggestion.suggestedBy,
              acceptedBy: { name: context.display_name, handle: context.handle, seat },
            },
          }
        : {}),
    });
  }

  private async postQuestionAnswer(
    row: SessionRow,
    _userId: string,
    questionId: string,
    answers: QuestionAnswerBody,
  ): Promise<void> {
    await this.centaur.answerQuestion(row.centaur_thread_key, row.current_execution_id ?? '', questionId, answers);
  }

  private async executeWithProviderEnvironment(
    row: SessionRow,
    generation: number,
    opts: { executeId?: string; inputLines?: string[] },
  ): Promise<ExecuteResponse> {
    const environment = await this.providerEnvironmentFor(row);
    return this.centaur.execute(row.centaur_thread_key, generation, row.harness, {
      ...opts,
      ...(environment ? { environment } : {}),
    });
  }

  private async providerEnvironmentFor(row: SessionRow): Promise<Record<string, string> | undefined> {
    const provider = providerForHarness(row.harness);
    if (!provider) return undefined;
    const profileEnvironment = await this.agentProfiles.environmentForSession(row.id, provider);
    const ownerId = row.provider_credential_user_id;
    if (!ownerId) return profileEnvironment;
    const secret = await this.providerCredentials.getProviderSecret(ownerId, provider);
    if (!secret) return profileEnvironment;
    const credentialEnvironment =
      provider === CLAUDE_CODE_PROVIDER ? claudeExecutionEnvironment(secret) : codexExecutionEnvironment(secret);
    return { ...(profileEnvironment ?? {}), ...credentialEnvironment };
  }

  async clearStalePendingQuestion(id: string, questionId: string): Promise<void> {
    await this.clearPendingQuestion(id, questionId, 'empty');
  }

  async clearStalePendingQuestionForProposal(id: string, proposalId: string): Promise<void> {
    const proposal = await this.pool.query<{ question_id: string }>(
      'SELECT question_id FROM session_answer_proposals WHERE id = $1 AND session_id = $2',
      [proposalId, id],
    );
    const questionId = proposal.rows[0]?.question_id;
    if (questionId) await this.clearPendingQuestion(id, questionId, 'empty');
  }

  async cancelSession(id: string, userId: string): Promise<void> {
    const row = await this.requireSpawnerOrDriver(id, userId);
    await this.centaur.release(row.centaur_thread_key, `rel-${id}`, true);
    await this.updateStatus(id, 'cancelled');
    await this.stopTailer(id);
  }

  async interruptTurn(id: string, userId: string): Promise<void> {
    const row = await this.requireSpawnerOrDriver(id, userId);
    await this.centaur.interruptTurn(row.centaur_thread_key);
  }

  async cancelSessionInTx(client: DbClient, id: string, userId: string): Promise<WireEvent[]> {
    const before = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
    const row = before.rows[0];
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    if (row.spawned_by !== userId && row.driver_id !== userId) {
      throw new DomainError(403, 'forbidden', 'only the spawner or current driver may cancel this session');
    }
    await this.centaur.release(row.centaur_thread_key, `rel-${id}`, true);
    if (row.status === 'cancelled' || TERMINAL_STATUSES.has(row.status)) return [];
    const pending = parsePendingQuestion(row.pending_question);
    const updated = await client.query<SessionRow>(
      `UPDATE sessions
       SET status = 'cancelled',
           pending_question = NULL
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    const next = updated.rows[0]!;
    const statusEvent = await appendEvent(client, {
      workspaceId: next.workspace_id,
      channelId: next.channel_id,
      threadRootEventId: next.thread_root_event_id,
      type: 'session.status_changed',
      actorId: next.spawned_by,
      payload: { sessionId: id, status: 'cancelled' },
    });
    if (!pending) return [statusEvent];
    const resolvedEvent = await appendEvent(client, {
      workspaceId: next.workspace_id,
      channelId: next.channel_id,
      threadRootEventId: next.thread_root_event_id,
      type: 'session.question_resolved',
      actorId: next.spawned_by,
      payload: { sessionId: id, questionId: pending.questionId, reason: 'cancelled' },
    });
    return [statusEvent, resolvedEvent];
  }

  afterCancelSession(id: string, events: WireEvent[]): void {
    for (const event of events) this.hub.publishEvent(event);
    void this.stopTailer(id);
  }

  async requestSeat(id: string, userId: string): Promise<void> {
    const event = await withTx(this.pool, async (client) => {
      const session = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
      const row = session.rows[0];
      if (!row) {
        throw new DomainError(404, 'session_not_found', 'session not found');
      }
      if (row.driver_id === userId) {
        throw new DomainError(403, 'forbidden', 'driver already holds the seat');
      }
      const inserted = await client.query(
        `INSERT INTO seat_requests (session_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [id, userId],
      );
      if (!inserted.rowCount) return null;
      return appendEvent(client, {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        threadRootEventId: row.thread_root_event_id,
        type: 'session.seat_requested',
        actorId: userId,
        payload: { sessionId: id, by: userId },
      });
    });
    if (event) this.hub.publishEvent(event);
  }

  async grantSeat(id: string, driverId: string, nextDriverId: string): Promise<void> {
    const event = await this.withSeatLock(async (client) => {
      const row = await this.lockSessionForSeatMutation(client, id);
      if (!row) {
        throw new DomainError(404, 'session_not_found', 'session not found');
      }
      if (row.driver_id !== driverId) {
        throw new DomainError(403, 'forbidden', 'only the current driver may grant the seat');
      }
      await this.assertUserExists(client, nextDriverId);
      const updated = await client.query<SessionRow>('UPDATE sessions SET driver_id = $1 WHERE id = $2 RETURNING *', [
        nextDriverId,
        id,
      ]);
      await client.query('DELETE FROM seat_requests WHERE session_id = $1 AND user_id = $2', [id, nextDriverId]);
      const next = updated.rows[0]!;
      return appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.seat_changed',
        actorId: driverId,
        payload: { sessionId: id, from: row.driver_id, to: nextDriverId, reason: 'granted' },
      });
    });
    this.hub.publishEvent(event);
  }

  async takeSeat(id: string, userId: string): Promise<void> {
    const event = await this.withSeatLock(async (client) => {
      const row = await this.lockSessionForSeatMutation(client, id);
      if (!row) {
        throw new DomainError(404, 'session_not_found', 'session not found');
      }
      if (row.driver_id === userId) {
        throw new DomainError(409, 'seat_held', 'requester already holds the seat');
      }
      if (row.driver_id && this.hub.isUserPresent(`session:${id}`, row.driver_id)) {
        throw new DomainError(409, 'seat_held', 'current driver is watching');
      }
      await client.query('UPDATE sessions SET driver_id = $1 WHERE id = $2', [userId, id]);
      await client.query('DELETE FROM seat_requests WHERE session_id = $1 AND user_id = $2', [id, userId]);
      return appendEvent(client, {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        threadRootEventId: row.thread_root_event_id,
        type: 'session.seat_changed',
        actorId: userId,
        payload: { sessionId: id, from: row.driver_id, to: userId, reason: 'taken' },
      });
    });
    this.hub.publishEvent(event);
  }

  // ---- suggestion queue (Phase 2) ------------------------------------------

  /**
   * A watcher proposes a steer; the driver later sends or dismisses it. Runs in
   * the caller's transaction (the route wraps it in runMutation for idempotency
   * + a single commit); the returned event is published in onApplied.
   */
  async createSuggestionInTx(client: DbClient, id: string, userId: string, text: string): Promise<WireEvent> {
    const session = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
    const row = session.rows[0];
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    // A truly-ended session can't be steered, so a suggestion on it is a dead
    // letter — refuse it (a completed session is resumable, so it's allowed).
    if (row.status === 'failed' || row.status === 'cancelled') {
      throw new DomainError(409, 'session_ended', 'session has ended');
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO session_suggestions (session_id, author_id, text)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [id, userId, text],
    );
    return appendEvent(client, {
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      threadRootEventId: row.thread_root_event_id,
      type: 'session.suggestion_added',
      actorId: userId,
      payload: { sessionId: id, suggestionId: inserted.rows[0]!.id, authorId: userId, text },
    });
  }

  /**
   * The driver disposes of a pending suggestion. `send` posts it as a steer
   * (reusing the steer path) and may carry edited text; `dismiss` records an
   * optional reason. Resolved rows persist for the session record. Runs in the
   * caller's transaction; the tailer start + event publish happen post-commit
   * (in the route's onApplied) keyed off `postedSteer`.
   */
  async resolveSuggestionInTx(
    client: DbClient,
    id: string,
    driverUserId: string,
    suggestionId: string,
    action: 'send' | 'dismiss',
    opts: { text?: string; note?: string } = {},
  ): Promise<{ event: WireEvent; postedSteer: boolean }> {
    const row = await this.requireDriverInTx(client, id, driverUserId);
    const res = await client.query<{
      status: SuggestionStatus;
      text: string;
      author_id: string;
      author_name: string;
      author_handle: string;
    }>(
      `SELECT s.status,
              s.text,
              s.author_id,
              author.display_name AS author_name,
              author.handle AS author_handle
         FROM session_suggestions s
         JOIN users author ON author.id = s.author_id
        WHERE s.id = $1
          AND s.session_id = $2
        FOR UPDATE OF s`,
      [suggestionId, id],
    );
    const sug = res.rows[0];
    if (!sug) {
      throw new DomainError(404, 'suggestion_not_found', 'suggestion not found');
    }
    if (sug.status !== 'pending') {
      throw new DomainError(409, 'suggestion_resolved', 'suggestion already resolved');
    }

    if (action === 'send') {
      // Mirror the steer path: cancel the idle-release so the freshly-steered
      // session isn't torn down underneath the turn it's about to run.
      this.cancelScheduledRelease(id);
      const sendText = (opts.text ?? '').trim() || sug.text;
      const edited = sendText !== sug.text;
      const contextBlock = await this.buildUserTurnContextBlock(client, row, driverUserId, 'driver', {
        suggestedBy: { name: sug.author_name, handle: sug.author_handle, kind: 'human' },
      });
      await this.postUserMessageOnce(row, driverUserId, sendText, true, client, undefined, [], contextBlock);
      await client.query(
        `UPDATE session_suggestions
         SET status = 'sent', resolved_by = $1, sent_text = $2, resolved_at = now()
         WHERE id = $3`,
        [driverUserId, edited ? sendText : null, suggestionId],
      );
      const event = await appendEvent(client, {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        threadRootEventId: row.thread_root_event_id,
        type: 'session.suggestion_resolved',
        actorId: driverUserId,
        payload: {
          sessionId: id,
          suggestionId,
          status: 'sent',
          resolvedBy: driverUserId,
          ...(edited ? { sentText: sendText } : {}),
        },
      });
      return { event, postedSteer: true };
    }

    const note = (opts.note ?? '').trim();
    await client.query(
      `UPDATE session_suggestions
       SET status = 'dismissed', resolved_by = $1, note = $2, resolved_at = now()
       WHERE id = $3`,
      [driverUserId, note || null, suggestionId],
    );
    const event = await appendEvent(client, {
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      threadRootEventId: row.thread_root_event_id,
      type: 'session.suggestion_resolved',
      actorId: driverUserId,
      payload: {
        sessionId: id,
        suggestionId,
        status: 'dismissed',
        resolvedBy: driverUserId,
        ...(note ? { note } : {}),
      },
    });
    return { event, postedSteer: false };
  }

  // ---- HITL answer proposals (Phase 2) -------------------------------------

  /**
   * A watcher proposes an answer to the pending question; the driver later
   * submits or dismisses it. Runs in the route's transaction.
   */
  async createAnswerProposalInTx(
    client: DbClient,
    id: string,
    userId: string,
    questionId: string,
    answers: QuestionAnswerBody,
  ): Promise<WireEvent> {
    const session = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
    const row = session.rows[0];
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    const pending = parsePendingQuestion(row.pending_question);
    if (!pending || pending.questionId !== questionId) {
      throw new DomainError(409, 'question_not_pending', 'question is not pending');
    }
    // The driver answers directly; only watchers propose.
    if (row.driver_id === userId) {
      throw new DomainError(409, 'driver_answers_directly', 'the driver answers directly');
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO session_answer_proposals (session_id, question_id, author_id, answers)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [id, questionId, userId, JSON.stringify(answers)],
    );
    return appendEvent(client, {
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      threadRootEventId: row.thread_root_event_id,
      type: 'session.answer_proposed',
      actorId: userId,
      payload: { sessionId: id, proposalId: inserted.rows[0]!.id, questionId, authorId: userId, answers },
    });
  }

  /**
   * The driver disposes of a pending answer proposal. `submit` answers the
   * question with the proposal's answers (driver-attributed, reusing the answer
   * path); `dismiss` records an optional reason. Both events publish post-commit.
   */
  async resolveAnswerProposalInTx(
    client: DbClient,
    id: string,
    driver: UserRef,
    proposalId: string,
    action: 'submit' | 'dismiss',
    opts: { note?: string } = {},
  ): Promise<{ events: WireEvent[]; postedAnswer: boolean }> {
    const row = await this.requireDriverInTx(client, id, driver.id);
    const res = await client.query<{ question_id: string; answers: QuestionAnswerBody; status: AnswerProposalStatus }>(
      'SELECT question_id, answers, status FROM session_answer_proposals WHERE id = $1 AND session_id = $2 FOR UPDATE',
      [proposalId, id],
    );
    const proposal = res.rows[0];
    if (!proposal) {
      throw new DomainError(404, 'proposal_not_found', 'proposal not found');
    }
    if (proposal.status !== 'pending') {
      throw new DomainError(409, 'proposal_resolved', 'proposal already resolved');
    }

    if (action === 'submit') {
      // Answer the question as the driver (validates still-pending + running +
      // posts to Centaur), then record the disposition.
      const answerEvent = await this.answerQuestionInTx(client, id, driver, proposal.question_id, proposal.answers);
      await client.query(
        `UPDATE session_answer_proposals
         SET status = 'submitted', resolved_by = $1, resolved_at = now()
         WHERE id = $2`,
        [driver.id, proposalId],
      );
      const resolvedEvent = await appendEvent(client, {
        workspaceId: row.workspace_id,
        channelId: row.channel_id,
        threadRootEventId: row.thread_root_event_id,
        type: 'session.answer_proposal_resolved',
        actorId: driver.id,
        payload: {
          sessionId: id,
          proposalId,
          questionId: proposal.question_id,
          status: 'submitted',
          resolvedBy: driver.id,
        },
      });
      const events = answerEvent ? [answerEvent, resolvedEvent] : [resolvedEvent];
      return { events, postedAnswer: true };
    }

    const note = (opts.note ?? '').trim();
    await client.query(
      `UPDATE session_answer_proposals
       SET status = 'dismissed', resolved_by = $1, note = $2, resolved_at = now()
       WHERE id = $3`,
      [driver.id, note || null, proposalId],
    );
    const event = await appendEvent(client, {
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      threadRootEventId: row.thread_root_event_id,
      type: 'session.answer_proposal_resolved',
      actorId: driver.id,
      payload: {
        sessionId: id,
        proposalId,
        questionId: proposal.question_id,
        status: 'dismissed',
        resolvedBy: driver.id,
        ...(note ? { note } : {}),
      },
    });
    return { events: [event], postedAnswer: false };
  }

  async resumeActiveSessions(): Promise<void> {
    if (!this.autoResume) return;
    const terminal = await this.pool.query<Pick<SessionRow, 'id'>>(
      `SELECT id FROM sessions
       WHERE status IN ('completed', 'failed', 'cancelled')
         AND assignment_generation IS NOT NULL
       ORDER BY completed_at ASC NULLS LAST, created_at ASC`,
    );
    for (const row of terminal.rows) this.scheduleRelease(row.id);

    const res = await this.pool.query<SessionRow>(
      `SELECT * FROM sessions
       WHERE status NOT IN ('completed', 'failed', 'cancelled')
       ORDER BY created_at ASC`,
    );
    for (const row of res.rows) {
      if (row.current_execution_id) this.startTailer(row.id);
      else {
        queueMicrotask(() => {
          void this.startSession(row.id, null).catch(() => {});
        });
      }
    }
  }

  async close(): Promise<void> {
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    for (const timer of this.questionRenotifyTimers.values()) clearTimeout(timer);
    this.questionRenotifyTimers.clear();
    const handles = [...this.tailers.values()];
    for (const handle of handles) handle.controller.abort();
    this.tailers.clear();
    // Await in-flight tailer iterations so no DB write races shutdown
    // (or, in tests, the next suite's TRUNCATE).
    await Promise.allSettled(handles.map((handle) => handle.done));
  }

  private async startSession(
    id: string,
    task: string | null,
    attachments: readonly AgentTurnAttachmentRef[] = [],
  ): Promise<void> {
    try {
      let row = await this.getStartableSessionRow(id);
      if (!row) return;
      let generation = row.assignment_generation;
      if (generation == null) {
        const spawned = await this.spawnAssignment(row);
        generation = spawned.assignment_generation;
        row = spawned.row;
        if (TERMINAL_STATUSES.has(row.status)) return;
      }
      row = await this.getStartableSessionRow(id);
      if (!row) return;
      generation = row.assignment_generation ?? generation;
      let initialContextBlock: string | undefined;
      if (task != null) {
        initialContextBlock = await this.buildUserTurnContextBlock(this.pool, row, row.spawned_by, 'spawner');
        // Inline any /e/<handle> references in the spawn task the same way steers do
        // (postUserMessageOnce), so an agent can resolve an explicit reference to a
        // channel message/artifact at spawn. Never let a resolver hiccup fail the spawn.
        const baseTask = task;
        task = await appendReferencedEntriesAppendix(this.pool, {
          sessionId: id,
          userId: row.spawned_by,
          text: baseTask,
        }).catch((err) => {
          console.warn('spawn referenced-entries appendix failed', { id, err });
          return baseTask;
        });
      }
      if (task != null) {
        await this.centaur.postMessage(
          row.centaur_thread_key,
          generation,
          agentTurnMessageParts(task, attachments, initialContextBlock),
          { user_id: row.spawned_by },
          { messageId: `msg-${id}-initial` },
        );
      }
      row = await this.getStartableSessionRow(id);
      if (!row) return;
      generation = row.assignment_generation ?? generation;
      const executeId = await this.reserveExecuteId(id);
      const exec = await this.executeWithProviderEnvironment(row, generation, {
        executeId,
        inputLines: task == null ? [] : [agentTurnInputLine(task, attachments, undefined, initialContextBlock)],
      });
      const updated = await this.updateExecution(id, exec.execution_id, generation);
      if (!updated) {
        await this.centaur.release(row.centaur_thread_key, `rel-${id}`, true).catch((err) => {
          console.warn('session release after cancelled start failed', { id, err });
        });
        return;
      }
      this.startTailer(id);
    } catch (err) {
      if (err instanceof DomainError && err.code === 'provider_auth_required') {
        await this.markProviderAuthRequired(id, 'missing_token', undefined).catch(() => {});
        return;
      }
      if (githubAuthFailureTextForError(err)) {
        await this.markGitHubNeedsAuth(id, undefined).catch(() => {});
        await this.updateStatus(id, 'failed').catch(() => {});
        return;
      }
      console.error('session start failed', { id, err });
      await this.updateStatus(id, 'failed').catch(() => {});
    }
  }

  private async getStartableSessionRow(id: string): Promise<SessionRow | null> {
    const row = await this.getSessionRow(id);
    if (!row || TERMINAL_STATUSES.has(row.status)) return null;
    return row;
  }

  private startTailer(id: string): void {
    void this.stopTailer(id);
    const controller = new AbortController();
    const done = Effect.runPromise(
      Effect.tryPromise({
        try: () => this.runTailer(id, controller),
        catch: (err) => err,
      }).pipe(
        Effect.tapError((err) =>
          Effect.sync(() => {
            if (!controller.signal.aborted) console.error('session tailer crashed', { id, err });
          }),
        ),
        Effect.catchAll(() => Effect.succeed(undefined)),
        Effect.ensuring(
          Effect.sync(() => {
            const current = this.tailers.get(id);
            if (current?.controller === controller) this.tailers.delete(id);
          }),
        ),
      ),
    );
    this.tailers.set(id, { controller, done });
  }

  private stopTailer(id: string): Promise<void> | undefined {
    const existing = this.tailers.get(id);
    if (!existing) return undefined;
    existing.controller.abort();
    this.tailers.delete(id);
    return existing.done.catch(() => {});
  }

  private async runTailer(id: string, controller: AbortController): Promise<void> {
    const row = await this.getSessionRow(id);
    if (!row || !row.current_execution_id || TERMINAL_STATUSES.has(row.status)) return;
    let lastEventId = row.last_event_id;
    let pendingLastEventId = lastEventId;
    let frameCountSinceFlush = 0;
    let lastFlushAt = Date.now();
    let lastProjectAt = 0;
    let providerAuthFailureEventId: number | null = null;
    let githubAuthFailureEventId: number | null = null;
    // Frame-order observability (addressable-entries H1): Centaur event ids are
    // global replay watermarks, so forward jumps are normal. Track the next
    // watermark only to catch late/regressive frames. OBSERVABILITY ONLY — no
    // behavior change.
    let expectedEventId: number | null = row.last_event_id > 0 ? row.last_event_id + 1 : null;
    try {
      for await (const frame of this.centaur.tailEvents(row.centaur_thread_key, {
        executionId: row.current_execution_id,
        afterEventId: row.last_event_id,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) return;
        this.observeFrameOrder(id, expectedEventId, frame.event_id);
        expectedEventId = Math.max(expectedEventId ?? 0, frame.event_id + 1);
        lastEventId = Math.max(lastEventId, frame.event_id);
        pendingLastEventId = lastEventId;
        frameCountSinceFlush += 1;
        await this.mirrorFrame(id, frame);
        if (providerAuthFailureTextForFrame(frame)) {
          providerAuthFailureEventId = frame.event_id;
        }
        if (githubAuthFailureTextForFrame(frame)) {
          githubAuthFailureEventId = frame.event_id;
        }
        await this.foldFrame(id, frame, providerAuthFailureEventId, githubAuthFailureEventId);
        if (isCompletedItemFrame(frame) && Date.now() - lastProjectAt >= 4000) {
          lastProjectAt = Date.now();
          await projectIncrementalAndEmit(this.pool, id).catch(() => {});
        }
        if (frameCountSinceFlush >= 25 || Date.now() - lastFlushAt >= 2000) {
          await this.persistLastEventId(id, pendingLastEventId);
          frameCountSinceFlush = 0;
          lastFlushAt = Date.now();
        }
      }
      await this.persistLastEventId(id, pendingLastEventId);
      if (!controller.signal.aborted) {
        await projectIncrementalAndEmit(this.pool, id)
          .catch(() => {})
          .finally(() => releaseSessionProjectionState(id));
      }
    } catch {
      if (!controller.signal.aborted) {
        await projectIncrementalAndEmit(this.pool, id)
          .catch(() => {})
          .finally(() => releaseSessionProjectionState(id));
        if (providerAuthFailureEventId != null) {
          const marked = await this.markProviderAuthRequired(
            id,
            'invalid_token',
            undefined,
            providerAuthFailureEventId,
          );
          if (marked) return;
        }
        if (githubAuthFailureEventId != null) {
          await this.markGitHubNeedsAuth(id, undefined, githubAuthFailureEventId);
        }
        await this.updateStatus(id, 'failed').catch(() => {});
      }
    }
  }

  /**
   * Record a frame's ordering against the expected next watermark and log the
   * first late frame per session. OBSERVABILITY ONLY — never alters the tail.
   * Forward jumps are expected because Centaur event ids are global, not
   * session-local sequence numbers.
   */
  private observeFrameOrder(id: string, expected: number | null, eventId: number): void {
    const { order, firstOfKind } = recordFrameObservation(id, expected, eventId);
    if (order !== 'late' || !firstOfKind) return;
    console.warn('session late frame observed', { sessionId: id, expected, got: eventId });
  }

  private async mirrorFrame(id: string, frame: CentaurEventFrame): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_events (session_id, centaur_event_id, event_kind, frame)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, centaur_event_id) DO NOTHING`,
      [id, frame.event_id, frame.event, JSON.stringify(frame)],
    );
  }

  private async foldFrame(
    id: string,
    frame: CentaurEventFrame,
    providerAuthFailureEventId: number | null = null,
    githubAuthFailureEventId: number | null = null,
  ): Promise<void> {
    if (frame.event === 'usage_observed') {
      const cost = typeof frame.data.cost_usd === 'number' ? frame.data.cost_usd : 0;
      if (cost > 0) {
        await this.pool.query('UPDATE sessions SET cost_usd = cost_usd + $1 WHERE id = $2', [cost, id]);
      }
      return;
    }
    if (frame.event === 'question_requested') {
      await this.persistQuestionRequested(id, frame);
      return;
    }
    if (frame.event === 'question_resolved') {
      await this.persistQuestionResolved(id, frame.data.question_id, frame.data.reason);
      return;
    }
    if (frame.event !== 'execution_state') return;
    const status = normalizeStatus(frame.data.status);
    if (isTerminalExecutionStatus(frame.data.status)) {
      const resultText = typeof frame.data.result_text === 'string' ? frame.data.result_text : null;
      const terminalAuthFailureEventId = providerAuthFailureTextForFrame(frame)
        ? frame.event_id
        : providerAuthFailureEventId;
      if (status === 'failed' && terminalAuthFailureEventId != null) {
        const marked = await this.markProviderAuthRequired(id, 'invalid_token', undefined, frame.event_id);
        if (marked) return;
      }
      const terminalGitHubAuthFailureEventId = githubAuthFailureTextForFrame(frame)
        ? frame.event_id
        : githubAuthFailureEventId;
      if (status === 'failed' && terminalGitHubAuthFailureEventId != null) {
        await this.markGitHubNeedsAuth(id, undefined, frame.event_id);
      }
      if (status === 'completed' && terminalAuthFailureEventId == null) {
        await this.markProviderConnectedIfProxy(id);
      }
      await this.completeSession(id, status, resultText, frame.event_id);
    } else {
      await this.updateStatus(id, status);
    }
  }

  private async persistQuestionRequested(
    id: string,
    frame: Extract<CentaurEventFrame, { event: 'question_requested' }>,
  ): Promise<void> {
    const event = await withTx(this.pool, async (client) => {
      const before = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
      const row = before.rows[0];
      if (!row || TERMINAL_STATUSES.has(row.status)) return null;
      const pending: SessionPendingQuestionJson = {
        questionId: frame.data.question_id,
        turnId: frame.data.turn_id,
        questions: frame.data.questions,
        eventId: frame.event_id,
      };
      const updated = await client.query<SessionRow>(
        `UPDATE sessions
         SET pending_question = $1,
             last_event_id = GREATEST(last_event_id, $2)
         WHERE id = $3
         RETURNING *`,
        [JSON.stringify(pending), frame.event_id, id],
      );
      const next = updated.rows[0]!;
      return appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.question_requested',
        actorId: next.spawned_by,
        payload: {
          sessionId: id,
          questionId: pending.questionId,
          questions: eventQuestions(pending.questions),
          permalink: `/s/${id}`,
        },
      });
    });
    if (event) {
      this.hub.publishEvent(event);
      void sendQuestionPush(
        this.pool,
        this.hub,
        event,
        this.questionPushFetchImpl ? { fetchImpl: this.questionPushFetchImpl } : undefined,
      ).catch((err) => console.warn('question push fanout failed', { id, err }));
      this.scheduleQuestionRenotify(id, event);
    }
  }

  private async persistQuestionResolved(
    id: string,
    questionId: string,
    reason: 'answered' | 'cancelled' | 'empty',
  ): Promise<void> {
    let cleared = false;
    const event = await withTx(this.pool, async (client) => {
      const before = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
      const row = before.rows[0];
      const pending = row ? parsePendingQuestion(row.pending_question) : null;
      if (!row || !pending || pending.questionId !== questionId) return null;
      const updated = await client.query<SessionRow>(
        'UPDATE sessions SET pending_question = NULL WHERE id = $1 RETURNING *',
        [id],
      );
      cleared = true;
      if (reason === 'answered') return null;
      const next = updated.rows[0]!;
      return appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.question_resolved',
        actorId: next.spawned_by,
        payload: { sessionId: id, questionId, reason },
      });
    });
    if (cleared) this.cancelScheduledQuestionRenotify(id);
    if (event) this.hub.publishEvent(event);
  }

  async clearClaudeAuthRequired(userId: string): Promise<void> {
    await this.clearProviderAuthRequired(userId, CLAUDE_CODE_PROVIDER);
  }

  private async markProviderConnectedIfProxy(id: string): Promise<void> {
    const res = await this.pool.query<Pick<SessionRow, 'harness' | 'spawned_by' | 'provider_credential_user_id'>>(
      `SELECT harness, spawned_by, provider_credential_user_id
       FROM sessions
       WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    const provider = row ? providerForHarness(row.harness) : null;
    if (!row || !provider) return;
    const ownerId = row.provider_credential_user_id ?? row.spawned_by;
    await this.providerCredentials.markConnectedIfProxy(ownerId, provider);
  }

  async clearProviderAuthRequired(userId: string, provider: ProviderCredentialProvider): Promise<void> {
    const events = await withTx(this.pool, async (client) => {
      const res = await client.query<SessionRow>(
        `SELECT *
         FROM sessions
         WHERE provider_credential_user_id = $1
           AND provider_auth_required->>'provider' = $2
         FOR UPDATE`,
        [userId, provider],
      );
      const out: WireEvent[] = [];
      for (const row of res.rows) {
        const updated = await client.query<SessionRow>(
          `UPDATE sessions
           SET provider_auth_required = NULL
           WHERE id = $1
           RETURNING *`,
          [row.id],
        );
        const next = updated.rows[0];
        if (!next) continue;
        out.push(
          await appendEvent(client, {
            workspaceId: next.workspace_id,
            channelId: next.channel_id,
            threadRootEventId: next.thread_root_event_id,
            type: 'session.provider_auth_resolved',
            actorId: userId,
            payload: { sessionId: next.id, provider, by: userId },
          }),
        );
      }
      return out;
    });
    for (const event of events) this.hub.publishEvent(event);
  }

  async markClaudeAuthMissing(id: string): Promise<void> {
    await this.markProviderAuthRequired(id, 'missing_token', undefined);
  }

  private async markProviderAuthRequired(
    id: string,
    reason: ProviderAuthRequiredJson['reason'],
    message: string | undefined,
    lastEventId = 0,
  ): Promise<boolean> {
    let rowToRelease: SessionRow | null = null;
    const events = await withTx(this.pool, async (client) => {
      const before = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
      const row = before.rows[0];
      const provider = row ? providerForHarness(row.harness) : null;
      if (!row || !provider || TERMINAL_STATUSES.has(row.status)) return [];
      const ownerId = row.provider_credential_user_id ?? row.spawned_by;
      const pending = parsePendingQuestion(row.pending_question);
      const authMessage = message ?? authRequiredMessage(provider, reason);
      const required = providerAuthRequired(provider, ownerId, reason, authMessage);
      const updated = await client.query<SessionRow>(
        `UPDATE sessions
         SET provider_auth_required = $1,
             status = 'queued',
             current_execution_id = NULL,
             pending_question = NULL,
             last_event_id = GREATEST(last_event_id, $2)
         WHERE id = $3
         RETURNING *`,
        [JSON.stringify(required), lastEventId, id],
      );
      const next = updated.rows[0]!;
      await this.providerCredentials.markProviderAuthRequired(provider, ownerId, authMessage, client);
      rowToRelease = next;
      const authEvent = await appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.provider_auth_required',
        actorId: ownerId,
        payload: { sessionId: id, ...required },
      });
      if (!pending) return [authEvent];
      const resolvedEvent = await appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.question_resolved',
        actorId: next.spawned_by,
        payload: { sessionId: id, questionId: pending.questionId, reason: 'cancelled' },
      });
      return [authEvent, resolvedEvent];
    });
    for (const event of events) this.hub.publishEvent(event);
    if (events.some((event) => event.type === 'session.question_resolved')) {
      this.cancelScheduledQuestionRenotify(id);
    }
    const releaseRow = rowToRelease as SessionRow | null;
    if (releaseRow && releaseRow.assignment_generation != null) {
      await this.centaur.release(releaseRow.centaur_thread_key, `rel-${id}-auth-${Date.now()}`, true).catch((err) => {
        console.warn('session release after provider auth failure failed', { id, err });
      });
    }
    return events.length > 0;
  }

  private async markGitHubNeedsAuth(id: string, message: string | undefined, lastEventId = 0): Promise<boolean> {
    const authMessage =
      message ?? 'GitHub authentication failed. Reconnect GitHub before retrying private repository access.';
    const before = await this.pool.query<
      Pick<SessionRow, 'workspace_id' | 'spawned_by' | 'provider_credential_user_id'>
    >('SELECT workspace_id, spawned_by, provider_credential_user_id FROM sessions WHERE id = $1', [id]);
    const owner = before.rows[0]
      ? {
          workspaceId: before.rows[0].workspace_id,
          userId: before.rows[0].provider_credential_user_id ?? before.rows[0].spawned_by,
        }
      : null;
    if (!owner) return false;
    const event = await this.connections.withConnectionLock(owner.workspaceId, owner.userId, 'github', async () => {
      if (this.ironControl?.configured) {
        await convergeGitHubPublicReadFallback(this.ironControl, owner).catch((err) => {
          console.warn('GitHub fallback convergence after auth failure failed', { id, err });
        });
      }
      return withTx(this.pool, async (client) => {
        const before = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
        const row = before.rows[0];
        if (!row) return null;
        const ownerId = row.provider_credential_user_id ?? row.spawned_by;
        await this.connections.markGitHubNeedsAuth(row.workspace_id, ownerId, authMessage, client);
        await client.query('UPDATE sessions SET last_event_id = GREATEST(last_event_id, $1) WHERE id = $2', [
          lastEventId,
          id,
        ]);
        return appendEvent(client, {
          workspaceId: row.workspace_id,
          channelId: row.channel_id,
          threadRootEventId: row.thread_root_event_id,
          type: 'session.github_auth_required',
          actorId: ownerId,
          payload: {
            sessionId: id,
            provider: 'github',
            userId: ownerId,
            reason: 'invalid_token',
            message: authMessage,
            at: new Date().toISOString(),
          },
        });
      });
    });
    if (!event) return false;
    this.hub.publishEvent(event);
    return true;
  }

  private async updateStatus(id: string, status: SessionStatus): Promise<void> {
    const events = await withTx(this.pool, async (client) => {
      const before = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
      const row = before.rows[0];
      if (!row || row.status === status || TERMINAL_STATUSES.has(row.status)) return [];
      const pending = parsePendingQuestion(row.pending_question);
      const terminal = TERMINAL_STATUSES.has(status);
      const updated = await client.query<SessionRow>(
        `UPDATE sessions
         SET status = $1,
             pending_question = CASE WHEN $3 THEN NULL ELSE pending_question END
         WHERE id = $2
         RETURNING *`,
        [status, id, terminal],
      );
      const next = updated.rows[0]!;
      const statusEvent = await appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.status_changed',
        actorId: next.spawned_by,
        payload: { sessionId: id, status },
      });
      if (!terminal || !pending) return [statusEvent];
      const resolvedEvent = await appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.question_resolved',
        actorId: next.spawned_by,
        payload: { sessionId: id, questionId: pending.questionId, reason: 'cancelled' },
      });
      return [statusEvent, resolvedEvent];
    });
    for (const event of events) this.hub.publishEvent(event);
    if (events.some((event) => event.type === 'session.question_resolved')) {
      this.cancelScheduledQuestionRenotify(id);
    }
  }

  private async clearPendingQuestion(id: string, questionId: string, reason: 'cancelled' | 'empty'): Promise<void> {
    let cleared = false;
    const event = await withTx(this.pool, async (client) => {
      const before = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
      const row = before.rows[0];
      const pending = row ? parsePendingQuestion(row.pending_question) : null;
      if (!row || !pending || pending.questionId !== questionId) return null;
      const updated = await client.query<SessionRow>(
        'UPDATE sessions SET pending_question = NULL WHERE id = $1 RETURNING *',
        [id],
      );
      cleared = true;
      const next = updated.rows[0]!;
      return appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.question_resolved',
        actorId: next.spawned_by,
        payload: { sessionId: id, questionId, reason },
      });
    });
    if (cleared) this.cancelScheduledQuestionRenotify(id);
    if (event) this.hub.publishEvent(event);
  }

  private async completeSession(
    id: string,
    status: SessionStatus,
    resultText: string | null,
    lastEventId: number,
  ): Promise<void> {
    const events = await withTx(this.pool, async (client) => {
      const before = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
      const row = before.rows[0];
      if (!row || TERMINAL_STATUSES.has(row.status)) return [];
      const pending = parsePendingQuestion(row.pending_question);
      const completed = await client.query<SessionRow>(
        `UPDATE sessions
         SET status = $1, result_text = $2, completed_at = now(), pending_question = NULL,
             last_event_id = GREATEST(last_event_id, $3)
         WHERE id = $4
         RETURNING *`,
        [status, resultText, lastEventId, id],
      );
      const next = completed.rows[0]!;
      const completedEvent = await appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.completed',
        actorId: next.spawned_by,
        payload: {
          sessionId: id,
          status,
          resultExcerpt: (resultText ?? '').slice(0, 200),
          permalink: `/s/${id}`,
        },
      });
      if (!pending) return [completedEvent];
      const resolvedEvent = await appendEvent(client, {
        workspaceId: next.workspace_id,
        channelId: next.channel_id,
        threadRootEventId: next.thread_root_event_id,
        type: 'session.question_resolved',
        actorId: next.spawned_by,
        payload: { sessionId: id, questionId: pending.questionId, reason: 'cancelled' },
      });
      return [completedEvent, resolvedEvent];
    });
    for (const event of events) this.hub.publishEvent(event);
    if (events.some((event) => event.type === 'session.question_resolved')) {
      this.cancelScheduledQuestionRenotify(id);
    }
    const completedEvent = events.find((event) => event.type === 'session.completed');
    if (completedEvent) {
      void sendSessionCompletedPush(
        this.pool,
        this.hub,
        completedEvent,
        this.questionPushFetchImpl ? { fetchImpl: this.questionPushFetchImpl } : undefined,
      ).catch((err) =>
        console.warn('session completed push fanout failed', { id, err }),
      );
    }
    if (events.length > 0) this.scheduleRelease(id);
  }

  // Free the sandbox after an idle window: terminal sessions must not pin a
  // warm runtime forever (pods accumulate and exhaust the node — found by live
  // e2e). The delay + cancel-on-steer avoids racing a follow-up turn that
  // arrives right after completion; the re-check makes a late fire harmless.
  private scheduleRelease(id: string): void {
    this.cancelScheduledRelease(id);
    const timer = setTimeout(() => {
      this.releaseTimers.delete(id);
      void this.releaseAssignment(id);
    }, releaseIdleMs());
    timer.unref?.();
    this.releaseTimers.set(id, timer);
  }

  private cancelScheduledRelease(id: string): void {
    const existing = this.releaseTimers.get(id);
    if (existing) {
      clearTimeout(existing);
      this.releaseTimers.delete(id);
    }
  }

  private scheduleQuestionRenotify(id: string, event: WireEvent): void {
    this.cancelScheduledQuestionRenotify(id);
    if (!(this.questionRenotifyMinutes > 0)) return;
    const questionId = typeof event.payload.questionId === 'string' ? event.payload.questionId : null;
    if (!questionId) return;
    const timer = setTimeout(() => {
      this.questionRenotifyTimers.delete(id);
      void this.renotifyQuestionIfStillPending(id, questionId, event);
    }, this.questionRenotifyMinutes * 60_000);
    timer.unref?.();
    this.questionRenotifyTimers.set(id, timer);
  }

  private cancelScheduledQuestionRenotify(id: string): void {
    const existing = this.questionRenotifyTimers.get(id);
    if (existing) {
      clearTimeout(existing);
      this.questionRenotifyTimers.delete(id);
    }
  }

  private async renotifyQuestionIfStillPending(id: string, questionId: string, event: WireEvent): Promise<void> {
    try {
      const row = await this.getSessionRow(id);
      const pending = row ? parsePendingQuestion(row.pending_question) : null;
      if (!pending || pending.questionId !== questionId) return;
      await sendQuestionPush(
        this.pool,
        this.hub,
        event,
        this.questionPushFetchImpl ? { fetchImpl: this.questionPushFetchImpl } : undefined,
      );
    } catch (err) {
      console.warn('question renotify failed', { id, err });
    }
  }

  private async releaseAssignment(id: string): Promise<void> {
    try {
      const row = await this.getSessionRow(id);
      if (!row || !TERMINAL_STATUSES.has(row.status)) return;
      if (row.assignment_generation == null) return;
      await this.centaur.release(row.centaur_thread_key, `rel-${id}-${Date.now()}`, false);
      await this.pool.query('UPDATE sessions SET assignment_generation = NULL WHERE id = $1', [id]);
    } catch (err) {
      console.warn('session release failed', { id, err });
    }
  }

  private async persistLastEventId(id: string, lastEventId: number): Promise<void> {
    await this.pool.query('UPDATE sessions SET last_event_id = GREATEST(last_event_id, $1) WHERE id = $2', [
      lastEventId,
      id,
    ]);
  }

  private async updateExecution(
    id: string,
    executionId: string | null,
    generation: number,
  ): Promise<SessionRow | null> {
    const res = await this.pool.query<SessionRow>(
      `UPDATE sessions
       SET current_execution_id = COALESCE($1, current_execution_id),
           assignment_generation = $2,
           provider_auth_required = NULL,
           centaur_execute_id = CASE WHEN $1::text IS NULL THEN centaur_execute_id ELSE NULL END,
           centaur_message_id = CASE WHEN $1::text IS NULL THEN centaur_message_id ELSE NULL END
       WHERE id = $3
         AND status NOT IN ('completed', 'failed', 'cancelled')
       RETURNING *`,
      [executionId, generation, id],
    );
    return res.rows[0] ?? null;
  }

  private async spawnAssignment(
    session: SessionRow,
    client: Db | DbClient = this.pool,
  ): Promise<{ row: SessionRow; assignment_generation: number }> {
    const spawnId = await this.reserveSpawnId(session.id, client);
    // Forward the session's checkout target so Centaur hydrates it from the node
    // repo-cache (centaur_session_repos → AGENT_REPOS_JSON → entrypoint clone).
    const sessionRepos = parseSessionRepos(session.session_repos);
    const repos =
      sessionRepos ??
      (session.repo ? [{ repo: session.repo, ...(session.branch ? { ref: session.branch } : {}) }] : []);
    const credentialOwnerUserId = session.provider_credential_user_id ?? session.spawned_by;
    const spawned = await this.centaur.spawn(session.centaur_thread_key, session.harness, {
      spawnId,
      metadata: {
        atrium_workspace_id: session.workspace_id,
        atrium_user_id: credentialOwnerUserId,
        github_identity_mode: session.github_identity_mode ?? 'automatic',
        credential_owner_user_id: credentialOwnerUserId,
        ...(session.provider_connection_id ? { provider_connection_id: session.provider_connection_id } : {}),
      },
      ...(repos.length ? { repos } : {}),
    });
    const generation = spawned.assignment_generation ?? 1;
    const row = await this.persistSpawnedAssignment(session.id, generation, client);
    return { row, assignment_generation: generation };
  }

  private async reserveSpawnId(id: string, client: Db | DbClient = this.pool): Promise<string> {
    const res = await client.query<{ centaur_spawn_id: string }>(
      `UPDATE sessions
       SET centaur_spawn_attempt = CASE
             WHEN centaur_spawn_id IS NULL THEN centaur_spawn_attempt + 1
             ELSE centaur_spawn_attempt
           END,
           centaur_spawn_id = COALESCE(
             centaur_spawn_id,
             'spawn-' || id::text || '-a' || (centaur_spawn_attempt + 1)::text
           )
       WHERE id = $1
       RETURNING centaur_spawn_id`,
      [id],
    );
    return res.rows[0]!.centaur_spawn_id;
  }

  private async persistSpawnedAssignment(
    id: string,
    generation: number,
    client: Db | DbClient = this.pool,
  ): Promise<SessionRow> {
    const res = await client.query<SessionRow>(
      `UPDATE sessions
       SET assignment_generation = $1,
           centaur_spawn_id = NULL
       WHERE id = $2
       RETURNING *`,
      [generation, id],
    );
    return res.rows[0]!;
  }

  private async reserveExecuteId(id: string, client: Db | DbClient = this.pool): Promise<string> {
    const res = await client.query<{ centaur_execute_id: string }>(
      `UPDATE sessions
       SET centaur_execute_attempt = CASE
             WHEN centaur_execute_id IS NULL THEN centaur_execute_attempt + 1
             ELSE centaur_execute_attempt
           END,
           centaur_execute_id = COALESCE(
             centaur_execute_id,
             'exec-' || id::text || '-a' || (centaur_execute_attempt + 1)::text
           )
       WHERE id = $1
       RETURNING centaur_execute_id`,
      [id],
    );
    return res.rows[0]!.centaur_execute_id;
  }

  private async reserveMessageId(id: string, client: Db | DbClient = this.pool): Promise<string> {
    const res = await client.query<{ centaur_message_id: string }>(
      `UPDATE sessions
       SET centaur_message_attempt = CASE
             WHEN centaur_message_id IS NULL THEN centaur_message_attempt + 1
             ELSE centaur_message_attempt
           END,
           centaur_message_id = COALESCE(
             centaur_message_id,
             'msg-' || id::text || '-a' || (centaur_message_attempt + 1)::text
           )
       WHERE id = $1
       RETURNING centaur_message_id`,
      [id],
    );
    return res.rows[0]!.centaur_message_id;
  }

  private async clearAssignment(id: string, client: Db | DbClient = this.pool): Promise<SessionRow> {
    const res = await client.query<SessionRow>(
      `UPDATE sessions
       SET assignment_generation = NULL,
           centaur_spawn_id = NULL
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    return res.rows[0]!;
  }

  private async getSessionRow(id: string): Promise<SessionRow | null> {
    // Non-UUID ids (hand-mangled permalinks) are "not found", not a Postgres
    // cast error surfacing as a 500.
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const res = await this.pool.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
    return res.rows[0] ?? null;
  }

  private async findByClientSpawnId(
    client: DbClient,
    userId: string,
    clientSpawnId: string | undefined,
  ): Promise<SessionRow | null> {
    if (!clientSpawnId) return null;
    const res = await client.query<SessionRow>(
      'SELECT * FROM sessions WHERE spawned_by = $1 AND client_spawn_id = $2',
      [userId, clientSpawnId],
    );
    return res.rows[0] ?? null;
  }

  /** True iff the user may see this session (its channel is public or they're
   *  a member). Seat/cancel ops gate on this so a guessed session id in a
   *  private/DM channel can't be hijacked or cancelled by an outsider. */
  async userCanAccessSession(id: string, userId: string): Promise<boolean> {
    const row = await this.getSessionRow(id);
    return row != null && canAccessChannel(this.pool, userId, row.channel_id);
  }

  private async requireDriver(id: string, userId: string): Promise<SessionRow> {
    const row = await this.getSessionRow(id);
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    if (row.driver_id !== userId) {
      throw new DomainError(403, 'forbidden', 'only the current driver may steer this session');
    }
    return row;
  }

  private async requireDriverInTx(client: DbClient, id: string, userId: string): Promise<SessionRow> {
    const res = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id]);
    const row = res.rows[0];
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    if (row.driver_id !== userId) {
      throw new DomainError(403, 'forbidden', 'only the current driver may steer this session');
    }
    return row;
  }

  private async requireSpawnerOrDriver(id: string, userId: string): Promise<SessionRow> {
    const row = await this.getSessionRow(id);
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    if (row.spawned_by !== userId && row.driver_id !== userId) {
      throw new DomainError(403, 'forbidden', 'only the spawner or current driver may cancel this session');
    }
    return row;
  }

  private async withSeatLock<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    try {
      return await withTx(this.pool, fn);
    } catch (err) {
      if ((err as { code?: string }).code === '55P03') {
        throw new DomainError(409, 'seat_held', 'seat mutation already in progress');
      }
      throw err;
    }
  }

  private async lockSessionForSeatMutation(client: DbClient, id: string): Promise<SessionRow | null> {
    const res = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE NOWAIT', [id]);
    return res.rows[0] ?? null;
  }

  private async assertUserExists(client: DbClient, userId: string): Promise<void> {
    const res = await client.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (!res.rowCount) {
      throw new DomainError(404, 'user_not_found', 'user not found');
    }
  }

  private async toJsonWithSeatInfo(row: SessionRow): Promise<SessionJson> {
    const [driver, requests, viewers, suggestions, proposals] = await Promise.all([
      row.driver_id
        ? this.pool.query<SessionUserRow>('SELECT id AS user_id, display_name FROM users WHERE id = $1', [
            row.driver_id,
          ])
        : Promise.resolve({ rows: [] as SessionUserRow[] }),
      this.pool.query<SessionUserRow>(
        `SELECT u.id AS user_id, u.display_name
         FROM seat_requests sr
         JOIN users u ON u.id = sr.user_id
         WHERE sr.session_id = $1
         ORDER BY sr.created_at ASC, u.display_name ASC`,
        [row.id],
      ),
      this.pool.query<{ viewer_count: number }>(
        `SELECT count(DISTINCT user_id) AS viewer_count
         FROM session_views
         WHERE session_id = $1 AND user_id <> $2`,
        [row.id, row.spawned_by],
      ),
      this.pool.query<SessionSuggestionRow>(
        `SELECT s.id, s.author_id, a.display_name AS author_name, s.text, s.status,
                s.resolved_by, r.display_name AS resolved_by_name,
                s.sent_text, s.note,
                s.created_at, s.resolved_at
         FROM session_suggestions s
         JOIN users a ON a.id = s.author_id
         LEFT JOIN users r ON r.id = s.resolved_by
         WHERE s.session_id = $1
         ORDER BY s.created_at ASC`,
        [row.id],
      ),
      // Pending proposals only — they're moot once the question resolves; the
      // disposition record for resolved ones lives in the event log.
      this.pool.query<SessionAnswerProposalRow>(
        `SELECT p.id, p.question_id, p.author_id, a.display_name AS author_name,
                p.answers, p.status,
                p.resolved_by, r.display_name AS resolved_by_name,
                p.note, p.created_at, p.resolved_at
         FROM session_answer_proposals p
         JOIN users a ON a.id = p.author_id
         LEFT JOIN users r ON r.id = p.resolved_by
         WHERE p.session_id = $1 AND p.status = 'pending'
         ORDER BY p.created_at ASC`,
        [row.id],
      ),
    ]);
    return toJson(row, {
      driver: driver.rows[0] ? toSessionUserJson(driver.rows[0]) : null,
      pendingSeatRequests: requests.rows.map(toSessionUserJson),
      // node-pg returns count() as a string; coerce so JSON carries a number.
      viewerCount: Number(viewers.rows[0]?.viewer_count ?? 0),
      suggestions: suggestions.rows.map(toSessionSuggestionJson),
      answerProposals: proposals.rows.map(toSessionAnswerProposalJson),
    });
  }

  private async openSessionView(sessionId: string, userId: string): Promise<number | null> {
    try {
      const res = await this.pool.query<{ id: number }>(
        'INSERT INTO session_views (session_id, user_id) VALUES ($1, $2) RETURNING id',
        [sessionId, userId],
      );
      return res.rows[0]?.id ?? null;
    } catch (err) {
      console.warn('session view open failed', err);
      return null;
    }
  }

  private async closeSessionView(id: number): Promise<void> {
    try {
      await this.pool.query('UPDATE session_views SET closed_at = now() WHERE id = $1', [id]);
    } catch (err) {
      console.warn('session view close failed', err);
    }
  }
}

async function getChannel(client: DbClient, channelId: string): Promise<ChannelRow | null> {
  const res = await client.query<ChannelRow>('SELECT workspace_id FROM channels WHERE id = $1', [channelId]);
  return res.rows[0] ?? null;
}

async function assertThreadRoot(client: DbClient, channelId: string, threadRootEventId: number): Promise<void> {
  const root = await client.query<{
    channel_id: string | null;
    thread_root_event_id: number | null;
    type: string;
  }>('SELECT channel_id, thread_root_event_id, type FROM events WHERE id = $1', [threadRootEventId]);
  const r = root.rows[0];
  if (!r || (r.type !== 'message.posted' && r.type !== 'session.spawned')) {
    throw new DomainError(404, 'thread_root_not_found', 'thread root not found');
  }
  if (r.channel_id !== channelId) {
    throw new DomainError(400, 'thread_channel_mismatch', 'thread root belongs to another channel');
  }
  if (r.thread_root_event_id != null) {
    throw new DomainError(400, 'nested_thread', 'cannot spawn from a nested thread event');
  }
}

function normalizeStatus(status: string): SessionStatus {
  if (status === 'completed' || status === 'cancelled') return status;
  if (status === 'queued' || status === 'running') return status;
  if (status === 'failed' || status === 'failed_permanent') return 'failed';
  return 'running';
}

export type SessionEffortLevel = string;
// Vocabulary + validation live in the shared package (single source with the
// web picker); re-exported here for the interaction routes.
export { HARNESS_EFFORT_LEVELS, isSessionEffortLevel };

function writeSessionFrame(
  raw: ServerResponse,
  frame: CentaurEventFrame,
  recordHandles?: SessionFrameRecordHandle[],
  ts?: string,
): void {
  raw.write(`event: ${frame.event}\n`);
  raw.write(
    `data: ${JSON.stringify({
      ...frame.data,
      ...(recordHandles?.length ? { recordHandles } : {}),
      // Namespaced so a raw harness payload's own `ts` can't be clobbered.
      ...(ts ? { atrium_ts: ts } : {}),
      event_id: frame.event_id,
    })}\n\n`,
  );
}

function providerAuthFailureTextForFrame(frame: CentaurEventFrame): string | null {
  if (frame.event === 'execution_state') {
    const text = frameAuthText(frame.data);
    return isProviderAuthFailureText(text) ? text : null;
  }
  if (frame.event !== 'amp_raw_event') return null;
  const raw = objectRecord(frame.data);
  if (!isRawHarnessErrorFrame(raw)) return null;
  const text = frameAuthText(raw);
  return isProviderAuthFailureText(text) ? text : null;
}

function githubAuthFailureTextForFrame(frame: CentaurEventFrame): string | null {
  if (frame.event === 'execution_state') {
    const text = frameAuthText(frame.data);
    return isGitHubAuthFailureText(text) ? text : null;
  }
  if (frame.event !== 'amp_raw_event') return null;
  const raw = objectRecord(frame.data);
  if (!isRawHarnessErrorFrame(raw)) return null;
  const text = frameAuthText(raw);
  return isGitHubAuthFailureText(text) ? text : null;
}

function isGitHubAuthFailureText(value: string | null | undefined): boolean {
  if (!value) return false;
  const text = value.toLowerCase();
  const hasGitHubContext =
    text.includes('github.com') ||
    text.includes('api.github.com') ||
    text.includes('github_token') ||
    text.includes('resource not accessible by integration');
  if (!hasGitHubContext) return false;
  return (
    text.includes('authentication failed') ||
    text.includes('bad credentials') ||
    text.includes('could not read username') ||
    text.includes('repository not found') ||
    text.includes('resource not accessible by integration') ||
    text.includes('401') ||
    text.includes('403') ||
    text.includes('unauthorized') ||
    text.includes('forbidden')
  );
}

function isRawHarnessErrorFrame(raw: Record<string, unknown>): boolean {
  return raw.method === 'error' || raw.method === 'turn/failed' || raw.type === 'error' || raw.type === 'turn.failed';
}

function frameAuthText(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function frameMayCreateTranscriptRecord(frame: CentaurEventFrame): boolean {
  if (frame.event === 'question_requested' || frame.event === 'question_resolved') return true;
  if (frame.event !== 'amp_raw_event') return false;
  const raw = frame.data as Record<string, unknown>;
  const type =
    typeof raw.type === 'string'
      ? raw.type
      : raw.method === 'item/completed'
        ? 'item.completed'
        : raw.method === 'item/started'
          ? 'item.started'
          : null;
  if (type === 'item.completed') return true;
  if (type !== 'assistant') return false;
  if (typeof raw.uuid === 'string' && raw.uuid.length > 0) return true;
  const message = objectRecord(raw.message);
  const content = message.content;
  return Array.isArray(content) && content.some((block) => objectRecord(block).type === 'tool_use');
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function isDemoHarness(harness: string): boolean {
  return harness.trim().toLowerCase() === DEMO_HARNESS;
}

function isCentaurCode(err: unknown, code: string): boolean {
  return err instanceof CentaurApiError && err.code === code;
}

function githubAuthFailureTextForError(err: unknown): string | null {
  if (!(err instanceof CentaurApiError)) return null;
  if (isGitHubAuthFailureText(err.message)) return err.message;
  if (typeof err.code === 'string' && isGitHubAuthFailureText(err.code)) return err.code;
  try {
    const body = JSON.stringify(err.body);
    return isGitHubAuthFailureText(body) ? body : null;
  } catch {
    return null;
  }
}

/** Trim + cap optional git metadata; empty becomes null. */
function normalizeGitMeta(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 200);
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSessionRepos(
  value: unknown,
  fallbackRepo?: string | null,
  fallbackBranch?: string | null,
): SessionRepoSpec[] {
  const raw = Array.isArray(value) ? value : [];
  const repos: SessionRepoSpec[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const repo = normalizeGitMeta(typeof record.repo === 'string' ? record.repo : null);
    if (!repo) continue;
    const ref = normalizeGitMeta(typeof record.ref === 'string' ? record.ref : null);
    const subdir = normalizeGitMeta(typeof record.subdir === 'string' ? record.subdir : null);
    const key = `${repo}\0${ref ?? ''}\0${subdir ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push({
      repo,
      ...(ref ? { ref } : {}),
      ...(subdir ? { subdir } : {}),
      ...(record.private === true ? { private: true } : {}),
    });
    if (repos.length >= 8) break;
  }
  if (repos.length > 0) return repos;
  const repo = normalizeGitMeta(fallbackRepo);
  if (!repo) return [];
  const ref = normalizeGitMeta(fallbackBranch);
  return [{ repo, ...(ref ? { ref } : {}) }];
}

function parseSessionRepos(value: unknown): SessionRepoSpec[] | null {
  const repos = normalizeSessionRepos(typeof value === 'string' ? safeJsonParse(value) : value);
  return repos.length ? repos : null;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toJson(
  row: SessionRow,
  seatInfo: {
    driver?: SessionUserJson | null;
    pendingSeatRequests?: SessionUserJson[];
    viewerCount?: number;
    suggestions?: SessionSuggestionJson[];
    answerProposals?: SessionAnswerProposalJson[];
  } = {},
): SessionJson {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    threadRootEventId: row.thread_root_event_id,
    title: row.title,
    status: row.status,
    harness: row.harness,
    repo: row.repo,
    branch: row.branch,
    repos: parseSessionRepos(row.session_repos),
    spawnedBy: row.spawned_by,
    driverId: row.driver_id,
    driver: seatInfo.driver ?? null,
    pendingSeatRequests: seatInfo.pendingSeatRequests ?? [],
    suggestions: seatInfo.suggestions ?? [],
    answerProposals: seatInfo.answerProposals ?? [],
    pendingQuestion: parsePendingQuestion(row.pending_question),
    providerAuthRequired: parseProviderAuthRequired(row.provider_auth_required),
    githubIdentityMode: row.github_identity_mode ?? 'automatic',
    providerConnectionId: row.provider_connection_id,
    agentProfileVersionId: row.agent_profile_version_id,
    modelEffort: row.model_effort,
    viewerCount: seatInfo.viewerCount ?? 0,
    costUsd: Number(row.cost_usd),
    resultText: row.result_text,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    lastEventId: row.last_event_id,
    permalink: `/s/${row.id}`,
  };
}

function toListItem(row: SessionListRow): SessionListItem {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    title: row.title,
    status: row.status,
    harness: row.harness,
    spawnedBy: row.spawned_by,
    spawnerName: row.spawner_name,
    costUsd: Number(row.cost_usd),
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

function toSessionUserJson(row: SessionUserRow): SessionUserJson {
  return { userId: row.user_id, displayName: row.display_name };
}

function toSessionSuggestionJson(row: SessionSuggestionRow): SessionSuggestionJson {
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    text: row.text,
    status: row.status,
    resolvedBy: row.resolved_by,
    resolvedByName: row.resolved_by_name,
    sentText: row.sent_text,
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
  };
}

function toSessionAnswerProposalJson(row: SessionAnswerProposalRow): SessionAnswerProposalJson {
  return {
    id: row.id,
    questionId: row.question_id,
    authorId: row.author_id,
    authorName: row.author_name,
    answers: row.answers,
    status: row.status,
    resolvedBy: row.resolved_by,
    resolvedByName: row.resolved_by_name,
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
  };
}

function buildSeatHistory(rows: SessionLifecycleEventRow[]): SessionSeatHistoryEntry[] {
  return rows
    .filter((r) => r.type === 'session.seat_changed')
    .map((r) => ({
      eventId: r.id,
      from: typeof r.payload.from === 'string' ? r.payload.from : null,
      to: typeof r.payload.to === 'string' ? r.payload.to : '',
      reason: typeof r.payload.reason === 'string' ? r.payload.reason : 'granted',
      at: new Date(r.created_at).toISOString(),
    }));
}

const QUESTION_EVENT_KINDS: Record<string, SessionQuestionHistoryEntry['kind']> = {
  'session.question_requested': 'requested',
  'session.question_answered': 'answered',
  'session.question_resolved': 'resolved',
};

function buildQuestionHistory(rows: SessionLifecycleEventRow[]): SessionQuestionHistoryEntry[] {
  const out: SessionQuestionHistoryEntry[] = [];
  for (const r of rows) {
    const kind = QUESTION_EVENT_KINDS[r.type];
    if (!kind) continue;
    const p = r.payload;
    out.push({
      eventId: r.id,
      questionId: typeof p.questionId === 'string' ? p.questionId : '',
      kind,
      actorId: r.actor_id,
      at: new Date(r.created_at).toISOString(),
      questions: Array.isArray(p.questions) ? (p.questions as QuestionPrompt[]) : null,
      answers: Array.isArray(p.answers) ? (p.answers as SessionQuestionAnswerJson[]) : null,
      reason: typeof p.reason === 'string' ? p.reason : null,
    });
  }
  return out;
}

function parsePendingQuestion(value: unknown): SessionPendingQuestionJson | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.questionId !== 'string' || typeof raw.turnId !== 'string') return null;
  if (!Array.isArray(raw.questions)) return null;
  const questions = raw.questions.filter(isQuestionPrompt);
  if (questions.length !== raw.questions.length) return null;
  const eventId = Number(raw.eventId);
  if (!Number.isFinite(eventId)) return null;
  return {
    questionId: raw.questionId,
    turnId: raw.turnId,
    questions,
    eventId,
  };
}

function parseProviderAuthRequired(value: unknown): ProviderAuthRequiredJson | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const provider = typeof raw.provider === 'string' ? providerForHarness(raw.provider) : null;
  if (!provider) return null;
  if (typeof raw.userId !== 'string') return null;
  if (raw.reason !== 'missing_token' && raw.reason !== 'invalid_token' && raw.reason !== 'auth_error') {
    return null;
  }
  return {
    provider,
    userId: raw.userId,
    reason: raw.reason,
    message: typeof raw.message === 'string' && raw.message.trim() ? raw.message : reconnectMessage(provider),
    at: typeof raw.at === 'string' ? raw.at : new Date().toISOString(),
  };
}

function reconnectMessage(provider: ProviderCredentialProvider): string {
  return `Reconnect ${providerDisplayName(provider)} to continue this session.`;
}

function authRequiredMessage(provider: ProviderCredentialProvider, reason: ProviderAuthRequiredJson['reason']): string {
  if (reason === 'invalid_token' || reason === 'auth_error') {
    return provider === CLAUDE_CODE_PROVIDER
      ? 'Claude Code authentication failed. Reconnect Claude to continue.'
      : 'Codex authentication failed. Reconnect Codex to continue.';
  }
  return reconnectMessage(provider);
}

function isQuestionPrompt(value: unknown): value is QuestionPrompt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.header !== 'string' || typeof raw.question !== 'string') {
    return false;
  }
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options)) return false;
    for (const option of raw.options) {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return false;
      const o = option as Record<string, unknown>;
      if (typeof o.label !== 'string' || typeof o.description !== 'string') return false;
      if (o.preview !== undefined && typeof o.preview !== 'string') return false;
      if (o.previewFormat !== undefined && o.previewFormat !== 'markdown' && o.previewFormat !== 'html') {
        return false;
      }
    }
  }
  if (raw.multiSelect !== undefined && typeof raw.multiSelect !== 'boolean') return false;
  return true;
}

function eventQuestions(questions: QuestionPrompt[]): Record<string, unknown>[] {
  return questions.slice(0, 4).map((q) => ({
    id: q.id,
    header: q.header,
    question: q.question,
    multiSelect: q.multiSelect === true,
    isOther: q.isOther === true,
    isSecret: q.isSecret === true,
    options: (q.options ?? []).slice(0, 8).map((option) => ({
      label: option.label.slice(0, 120),
      description: option.description.slice(0, 300),
      ...(option.preview ? { preview: option.preview.slice(0, 8000) } : {}),
      ...(option.previewFormat ? { previewFormat: option.previewFormat } : {}),
    })),
  }));
}

function summarizeAnswers(pending: SessionPendingQuestionJson, answers: QuestionAnswerBody): Record<string, unknown>[] {
  return Object.entries(answers).map(([id, value]) => {
    const prompt = pending.questions.find((q) => q.id === id);
    const answerValues = Array.isArray(value.answers) ? value.answers : [];
    return {
      id,
      header: prompt?.header ?? id,
      answers: prompt?.isSecret ? answerValues.map(() => 'redacted') : answerValues,
      count: answerValues.length,
    };
  });
}

export function isCompletedItemFrame(frame: CentaurEventFrame): boolean {
  if (frame.event !== 'amp_raw_event') return false;
  const raw = frame.data as { type?: unknown; method?: unknown };
  return raw.type === 'item.completed' || raw.method === 'item/completed';
}
