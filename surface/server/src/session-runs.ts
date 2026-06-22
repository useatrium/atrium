import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { basename } from 'node:path';
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
  type ArtifactBytes,
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
import { projectAndEmitChange } from './session-record-changefeed.js';
import { ArtifactLedger, casBlobKey, type MergeClass, type VersionRef } from './artifact-ledger.js';
import { presignGet as s3PresignGet, uploadObject as s3UploadObject } from './s3.js';
import {
  appendEvent,
  canAccessChannel,
  DomainError,
  type UserRef,
  type WireEvent,
} from './events.js';
import type { WsHub } from './hub.js';
import { sendQuestionPush } from './push.js';
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
  spawnedBy: string;
  driverId: string | null;
  driver: SessionUserJson | null;
  pendingSeatRequests: SessionUserJson[];
  suggestions: SessionSuggestionJson[];
  answerProposals: SessionAnswerProposalJson[];
  pendingQuestion: SessionPendingQuestionJson | null;
  providerAuthRequired: ProviderAuthRequiredJson | null;
  viewerCount: number;
  costUsd: number;
  resultText: string | null;
  createdAt: string;
  completedAt: string | null;
  lastEventId: number;
  permalink: string;
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

/** The bytes of a captured artifact plus the metadata the serve route needs to
 * set response headers (mime, path → filename). `bytes` is the proxied Centaur
 * stream; the route pipes it to the client. */
export interface SessionArtifactStream {
  artifact: Artifact;
  bytes: ArtifactBytes;
}

/**
 * How the serve route should deliver a captured artifact (B1: S3 offload):
 * - `redirect`: bytes are durably in atrium's S3 → presigned 302.
 * - `proxy`: not yet offloaded but still staged in Centaur → proxy the stream.
 * The 404 cases (unknown / manifest-only) throw a DomainError instead.
 */
export type ArtifactServePlan =
  | { kind: 'redirect'; url: string }
  | ({ kind: 'proxy' } & SessionArtifactStream);

/** Outcome of one offload batch, for logging/observability. */
export interface ArtifactOffloadResult {
  offloaded: number;
  evicted: number;
  failed: number;
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

/** The S3 surface the artifact offload + serve paths need. Injectable in tests
 * (the real impl is s3.ts; defaults to it). */
export interface ArtifactStorage {
  uploadObject: typeof s3UploadObject;
  presignGet: typeof s3PresignGet;
}

export interface SessionRunsOptions {
  centaur?: CentaurClient;
  baseUrl?: string;
  apiKey?: string;
  /** Auth key for Centaur's artifact-byte endpoint (distinct from `apiKey`).
   * Falls back to `apiKey` when unset. */
  artifactCaptureApiKey?: string;
  /** Object store for artifact offload/serve. Defaults to the real s3.ts. */
  artifactStorage?: ArtifactStorage;
  harness?: string;
  autoResume?: boolean;
  questionRenotifyMinutes?: number;
  questionPushFetchImpl?: typeof fetch;
  providerCredentials?: ProviderCredentials;
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
  last_event_id: number;
  result_text: string | null;
  cost_usd: string | number;
  created_at: Date;
  completed_at: Date | null;
}

interface SessionArtifactRow {
  id: string;
  session_id: string;
  execution_id: string | null;
  centaur_ref: string | null;
  s3_key: string | null;
  path: string;
  mime: string;
  size_bytes: string | number;
  sha256: string;
  offloaded_at: Date | null;
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

const TERMINAL_STATUSES = new Set<SessionStatus>(['completed', 'failed', 'cancelled']);
const DEMO_HARNESS = 'demo';
const DEMO_TITLE = 'Demo — watch an agent work';

// Idle window before a terminal session's sandbox assignment is released.
const releaseIdleMs = () => Number(process.env.SESSION_RELEASE_IDLE_MS ?? 60_000);

export class SessionRuns {
  private readonly centaur: CentaurClient;
  private readonly artifactCaptureApiKey: string;
  private readonly artifactStorage: ArtifactStorage;
  /** Durable CAS-ledger (notes/cas-ledger-build-plan.md). Shared by the
   * capture-bridge, serve, write-back, and GC paths. */
  private readonly artifactLedger: ArtifactLedger;
  private readonly harness: string;
  private readonly autoResume: boolean;
  private readonly questionRenotifyMinutes: number;
  private readonly questionPushFetchImpl?: typeof fetch;
  private readonly providerCredentials: ProviderCredentials;
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
    // The artifact-byte endpoint authenticates with its own key; fall back to
    // the session-API key when unset (treating '' as unset, since config env
    // defaults are empty strings). Last resort is '' which Centaur will reject.
    this.artifactCaptureApiKey =
      firstNonEmpty(
        options.artifactCaptureApiKey,
        config.artifactCaptureApiKey,
        options.apiKey,
        config.centaurApiKey,
      ) ?? '';
    this.artifactStorage =
      options.artifactStorage ?? { uploadObject: s3UploadObject, presignGet: s3PresignGet };
    this.artifactLedger = new ArtifactLedger(this.pool);
    this.harness = options.harness ?? config.centaurHarness;
    this.autoResume = options.autoResume ?? true;
    this.questionRenotifyMinutes =
      options.questionRenotifyMinutes ?? config.questionRenotifyMinutes;
    this.questionPushFetchImpl = options.questionPushFetchImpl;
    this.providerCredentials =
      options.providerCredentials ?? new ProviderCredentials(this.pool, config.providerCredentialSecret);
  }

  async createSession(args: {
    channelId: string;
    threadRootEventId: number | null;
    task: string;
    harness?: string;
    repo?: string | null;
    branch?: string | null;
    /** Client's optimistic id, echoed on session.spawned so a spawn whose
     * POST response was lost still reconciles instead of duplicating. */
    clientSpawnId?: string;
    user: UserRef;
  }): Promise<SessionJson> {
    const result = await withTx(this.pool, (client) => this.createSessionInTx(client, args));
    this.afterCreateSession(result, args.task);
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
      clientSpawnId?: string;
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
    const repo = normalizeGitMeta(args.repo);
    const branch = normalizeGitMeta(args.branch);
    const provider = providerForHarness(harness);
    const providerCredentialUserId = provider ? args.user.id : null;
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
    const inserted = await client.query<SessionRow>(
      `INSERT INTO sessions (
         workspace_id, channel_id, thread_root_event_id, centaur_thread_key, harness, repo, branch,
         title, status, spawned_by, driver_id, client_spawn_id, provider_credential_user_id
       )
       -- driver_id starts as the spawner ($9 used for both spawned_by + driver_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'spawning', $9, $9, $10, $11)
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
        title,
        args.user.id,
        args.clientSpawnId ?? null,
        providerCredentialUserId,
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
    return { session: toJson(row), created: true, event, row };
  }

  afterCreateSession(result: SessionCreateResult, task: string): void {
    if (!result.created || !result.event || !result.row) return;
    this.hub.publishEvent(result.event);
    queueMicrotask(() => {
      void this.startSession(result.row!.id, task).catch(() => {});
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

  /**
   * Decide how to serve a captured artifact (B1: S3 offload). Channel access is
   * gated by the route (like {@link getSessionRecord}). The artifact metadata
   * comes from the durable mirror ({@link collectArtifacts}); the offload state
   * lives in `session_artifacts`:
   *  - offloaded (s3_key set) → a presigned S3 redirect (durable, no Centaur hit);
   *  - still staged (ref set, not yet offloaded) → proxy the bytes from Centaur.
   *
   * Throws a 404 DomainError when the artifact is unknown or has no staged bytes
   * (`ref === null`, manifest-only), and a 502 when Centaur has no record of the
   * execution. CentaurApiError (e.g. an evicted ref → 404 from Centaur) bubbles
   * up to the route, which maps it to 410/502.
   */
  async getArtifactServePlan(sessionId: string, artifactId: string): Promise<ArtifactServePlan> {
    const row = await this.getSessionRow(sessionId);
    if (!row) {
      throw new DomainError(404, 'session_not_found', 'session not found');
    }
    const mirrored = await this.readMirroredState(sessionId);
    const artifact = collectArtifacts(mirrored).find((a) => a.id === artifactId);
    if (!artifact) {
      throw new DomainError(404, 'artifact_not_found', 'artifact not found');
    }
    if (artifact.ref == null) {
      // Manifest-only: metadata captured, bytes never staged (too large/junk).
      throw new DomainError(404, 'artifact_not_captured', 'artifact bytes were not captured');
    }
    // Already offloaded to atrium's store? Serve a presigned redirect — the
    // bytes are durable there, so this works even after Centaur evicts the ref.
    const offloaded = await this.pool.query<{ s3_key: string }>(
      `SELECT s3_key FROM session_artifacts
       WHERE session_id = $1 AND id = $2 AND s3_key IS NOT NULL`,
      [sessionId, artifactId],
    );
    const s3Key = offloaded.rows[0]?.s3_key;
    if (s3Key) {
      const filename = basename(artifact.path) || 'artifact';
      const inline = (artifact.mime || '').startsWith('image/');
      const url = await this.artifactStorage.presignGet(s3Key, filename, inline);
      return { kind: 'redirect', url };
    }
    // Not yet offloaded: proxy from Centaur staging. Fetch from the execution
    // that captured the artifact (on the event since Centaur added
    // execution_id); fall back to the session's current execution for artifacts
    // captured before that, which only resolve while the session hasn't moved
    // to a newer execution.
    const executionId = artifact.executionId ?? row.current_execution_id;
    if (!executionId) {
      throw new DomainError(502, 'artifact_unavailable', 'session has no execution to serve artifacts from');
    }
    const bytes = await this.centaur.getArtifactBytes(executionId, artifact.ref, {
      apiKey: this.artifactCaptureApiKey,
    });
    return { kind: 'proxy', artifact, bytes };
  }

  // === serve additions ===

  async getLedgerServePlan(sessionId: string, path: string, ref: VersionRef): Promise<ArtifactServePlan> {
    const v = await this.artifactLedger.resolveVersion(sessionId, path, ref);
    if (!v) {
      throw new DomainError(404, 'artifact_not_found', 'artifact not found');
    }
    if (v.kind === 'deleted') {
      throw new DomainError(410, 'artifact_deleted', 'artifact was deleted');
    }
    if (v.s3Key) {
      const filename = basename(path) || 'artifact';
      const inline = (v.mime || '').startsWith('image/');
      const url = await this.artifactStorage.presignGet(v.s3Key, filename, inline);
      return { kind: 'redirect', url };
    }
    if (!v.blobSha) {
      throw new DomainError(404, 'artifact_not_captured', 'artifact bytes were not captured');
    }
    const staged = await this.pool.query<{ execution_id: string | null; centaur_ref: string }>(
      `SELECT execution_id, centaur_ref FROM session_artifacts
       WHERE session_id = $1 AND sha256 = $2 AND centaur_ref IS NOT NULL
       ORDER BY captured_at DESC LIMIT 1`,
      [sessionId, v.blobSha],
    );
    const stagingRef = staged.rows[0];
    if (!stagingRef) {
      throw new DomainError(404, 'artifact_not_captured', 'artifact bytes were not captured');
    }
    if (!stagingRef.execution_id) {
      throw new DomainError(502, 'artifact_unavailable', 'session has no execution to serve artifacts from');
    }
    const bytes = await this.centaur.getArtifactBytes(stagingRef.execution_id, stagingRef.centaur_ref, {
      apiKey: this.artifactCaptureApiKey,
    });
    return {
      kind: 'proxy',
      artifact: {
        id: v.artifactId,
        path,
        kind: v.kind,
        mime: v.mime || 'application/octet-stream',
        size: Number(v.sizeBytes ?? 0),
        sha256: v.blobSha,
        ref: stagingRef.centaur_ref,
        executionId: stagingRef.execution_id,
        sourceEventIds: [],
      },
      bytes,
    };
  }

  /**
   * Offload one batch of staged artifacts (B1: S3 offload) from Centaur staging
   * into atrium's durable store. Runs on an interval (see artifact-offload.ts).
   *
   * Claim-then-release (the lease): a batch is claimed in one SHORT transaction
   * — `FOR UPDATE SKIP LOCKED` selects up-to-`limit` un-offloaded rows whose
   * lease is free (never claimed, or claimed longer ago than the lease window)
   * and stamps `claimed_at = now()` on them. The transaction commits and the row
   * locks release immediately; the slow Centaur fetch + S3 upload then run
   * OUTSIDE any transaction, one short tx per row to stamp the result. This is
   * the key difference from the original single-transaction design, which held
   * the row locks open across every network hop in the batch.
   *
   * Concurrency: `SKIP LOCKED` stops two workers grabbing the same row in the
   * same instant; the lease stops a second worker re-claiming a row whose first
   * claimant is still uploading. A worker that crashes mid-upload leaves a stale
   * `claimed_at`; once it ages past the lease the row is reclaimable again.
   *
   * Per-row outcomes: success stamps `s3_key`/`offloaded_at` (terminal); a
   * Centaur 404 (ref evicted from staging before we offloaded) stamps
   * `evicted_at` (terminal — drops out of the queue rather than re-claiming
   * every lease); any other error is logged + counted and leaves the lease in
   * place so the row is retried after it expires. One bad row never stops the
   * batch.
   */
  async offloadArtifactBatch(limit = config.artifactOffloadBatchSize): Promise<ArtifactOffloadResult> {
    const result: ArtifactOffloadResult = { offloaded: 0, evicted: 0, failed: 0 };
    const leaseSeconds = Math.max(1, Math.round(config.artifactOffloadClaimLeaseMs / 1000));
    // Claim phase — one short transaction. The composite-key subquery takes the
    // row locks (SKIP LOCKED) and the outer UPDATE stamps the lease on exactly
    // those rows, then commits and releases the locks.
    const claimed = await withTx(this.pool, (client) =>
      client.query<SessionArtifactRow>(
        `UPDATE session_artifacts SET claimed_at = now()
         WHERE (session_id, id) IN (
           SELECT session_id, id FROM session_artifacts
           WHERE offloaded_at IS NULL AND evicted_at IS NULL AND centaur_ref IS NOT NULL
             AND (claimed_at IS NULL OR claimed_at < now() - ($1::int * interval '1 second'))
           ORDER BY captured_at ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, session_id, execution_id, centaur_ref, s3_key, path, mime,
                   size_bytes, sha256, offloaded_at`,
        [leaseSeconds, limit],
      ),
    );
    // Work phase — outside any transaction. A per-row failure leaves the lease
    // in place (reclaimed after it expires) and never blocks the rest.
    for (const artifact of claimed.rows) {
      try {
        const outcome = await this.offloadOneArtifact(artifact);
        if (outcome === 'offloaded') result.offloaded += 1;
        else result.evicted += 1;
      } catch (err) {
        result.failed += 1;
        console.warn('artifact offload failed', {
          sessionId: artifact.session_id,
          artifactId: artifact.id,
          err,
        });
      }
    }
    return result;
  }

  /** Offload a single claimed artifact: fetch bytes from Centaur, upload to S3,
   * then stamp `s3_key` + `offloaded_at` in a short transaction (well after the
   * slow hops). Returns 'evicted' (stamping `evicted_at`, terminal) when Centaur
   * 404s the ref; throws on any other failure so the caller counts it and leaves
   * the lease in place to retry after it expires. */
  private async offloadOneArtifact(
    artifact: SessionArtifactRow,
  ): Promise<'offloaded' | 'evicted'> {
    if (!artifact.execution_id || !artifact.centaur_ref) {
      // The queue excludes null refs, so this shouldn't be claimed — but if a
      // stray row is, mark it terminal so it doesn't sit leased forever.
      await this.markArtifactEvicted(artifact);
      return 'evicted';
    }
    const s3Key = casBlobKey(artifact.sha256);
    if (!(await this.artifactLedger.blobIsOffloaded(artifact.sha256))) {
      let bytes: ArtifactBytes;
      try {
        bytes = await this.centaur.getArtifactBytes(artifact.execution_id, artifact.centaur_ref, {
          apiKey: this.artifactCaptureApiKey,
        });
      } catch (err) {
        if (err instanceof CentaurApiError && err.status === 404) {
          // Ref evicted from staging before we offloaded — the bytes are gone for
          // good. Mark terminal (evicted_at) so the row leaves the queue.
          console.warn('artifact offload skipped: ref evicted from Centaur staging', {
            sessionId: artifact.session_id,
            artifactId: artifact.id,
          });
          await this.markArtifactEvicted(artifact);
          return 'evicted';
        }
        throw err;
      }
      const body = bytes.body ? Buffer.from(await new Response(bytes.body).arrayBuffer()) : Buffer.alloc(0);
      const contentType = bytes.contentType || artifact.mime || 'application/octet-stream';
      await this.artifactStorage.uploadObject(s3Key, body, contentType);
    }
    await this.artifactLedger.stampBlobS3Key(artifact.sha256, s3Key);
    // Single auto-committed statement — short, well after the network hops.
    // Clearing claimed_at is tidy; offloaded_at already makes the row terminal.
    await this.pool.query(
      `UPDATE session_artifacts
       SET s3_key = $1, offloaded_at = now(), claimed_at = NULL
       WHERE session_id = $2 AND id = $3`,
      [s3Key, artifact.session_id, artifact.id],
    );
    return 'offloaded';
  }

  /** Mark an artifact terminally evicted: its Centaur ref is gone, so it can
   * never offload. Drops it out of the queue (the index excludes evicted_at). */
  private async markArtifactEvicted(artifact: SessionArtifactRow): Promise<void> {
    await this.pool.query(
      `UPDATE session_artifacts
       SET evicted_at = now(), claimed_at = NULL
       WHERE session_id = $1 AND id = $2`,
      [artifact.session_id, artifact.id],
    );
  }

  /** Replay the durable mirror into a reduced session state (transcript items +
   * derived work products). Survives Centaur retention. */
  private async readMirroredState(id: string): Promise<ReturnType<typeof initialSessionState>> {
    const res = await this.readMirroredFrames(id, 0);
    let state = initialSessionState();
    for (const r of res.rows) state = reduceSession(state, r.frame);
    return state;
  }

  private readMirroredFrames(id: string, afterEventId: number): Promise<{ rows: { frame: CentaurEventFrame }[] }> {
    return this.pool.query<{ frame: CentaurEventFrame }>(
      `SELECT frame
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
    const keepAlive = setInterval(() => {
      raw.write(': keep-alive\n\n');
    }, 15_000);
    keepAlive.unref?.();
    try {
      let cursor = afterEventId;
      const mirrored = await this.readMirroredFrames(session.id, cursor);
      for (const { frame } of mirrored.rows) {
        if (signal.aborted) break;
        cursor = Math.max(cursor, frame.event_id);
        writeSessionFrame(raw, frame);
      }
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
          writeSessionFrame(raw, frame);
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

  async postUserMessage(id: string, userId: string, text: string): Promise<void> {
    this.cancelScheduledRelease(id);
    const row = await this.requireDriver(id, userId);
    try {
      await this.postUserMessageOnce(row, userId, text, true);
    } catch (err) {
      if (err instanceof DomainError && err.code === 'provider_auth_required') {
        await this.markProviderAuthRequired(
          id,
          'missing_token',
          undefined,
        ).catch(() => {});
      }
      throw err;
    }
    this.startTailer(id);
  }

  async postUserMessageInTx(client: DbClient, id: string, userId: string, text: string): Promise<void> {
    this.cancelScheduledRelease(id);
    const row = await this.requireDriverInTx(client, id, userId);
    await this.postUserMessageOnce(row, userId, text, true, client);
  }

  afterPostUserMessage(id: string): void {
    this.startTailer(id);
  }

  async answerQuestion(
    id: string,
    user: UserRef,
    questionId: string,
    answers: QuestionAnswerBody,
  ): Promise<void> {
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
  ): Promise<void> {
    let generation = row.assignment_generation;
    if (generation == null) {
      const spawned = await this.spawnAssignment(row.id, row.centaur_thread_key, row.harness, client);
      generation = spawned.assignment_generation;
      row = spawned.row;
    }
    try {
      const messageId = await this.reserveMessageId(row.id, client);
      await this.centaur.postMessage(
        row.centaur_thread_key,
        generation,
        [{ type: 'text', text }],
        { user_id: userId },
        { messageId },
      );
    } catch (err) {
      if (allowStaleRetry && isCentaurCode(err, 'ASSIGNMENT_GENERATION_STALE')) {
        const refreshed = await this.clearAssignment(row.id, client);
        await this.postUserMessageOnce(refreshed, userId, text, false, client);
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
          [{ type: 'text', text }],
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
    const exec = await this.executeWithProviderEnvironment(row, generation, {
      executeId,
      inputLines: [userInputLine(text)],
    });
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

  private async postQuestionAnswer(
    row: SessionRow,
    _userId: string,
    questionId: string,
    answers: QuestionAnswerBody,
  ): Promise<void> {
    await this.centaur.answerQuestion(
      row.centaur_thread_key,
      row.current_execution_id ?? '',
      questionId,
      answers,
    );
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

  private async providerEnvironmentFor(
    row: SessionRow,
  ): Promise<Record<string, string> | undefined> {
    const provider = providerForHarness(row.harness);
    if (!provider) return undefined;
    const ownerId = row.provider_credential_user_id;
    if (!ownerId) return undefined;
    const secret = await this.providerCredentials.getProviderSecret(ownerId, provider);
    if (!secret) return undefined;
    return provider === CLAUDE_CODE_PROVIDER
      ? claudeExecutionEnvironment(secret)
      : codexExecutionEnvironment(secret);
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
      const updated = await client.query<SessionRow>(
        'UPDATE sessions SET driver_id = $1 WHERE id = $2 RETURNING *',
        [nextDriverId, id],
      );
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
  async createSuggestionInTx(
    client: DbClient,
    id: string,
    userId: string,
    text: string,
  ): Promise<WireEvent> {
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
    const res = await client.query<{ status: SuggestionStatus; text: string }>(
      'SELECT status, text FROM session_suggestions WHERE id = $1 AND session_id = $2 FOR UPDATE',
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
      await this.postUserMessageOnce(row, driverUserId, sendText, true, client);
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
      const answerEvent = await this.answerQuestionInTx(
        client,
        id,
        driver,
        proposal.question_id,
        proposal.answers,
      );
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

  private async startSession(id: string, task: string | null): Promise<void> {
    try {
      let row = await this.getStartableSessionRow(id);
      if (!row) return;
      let generation = row.assignment_generation;
      if (generation == null) {
        const spawned = await this.spawnAssignment(row.id, row.centaur_thread_key, row.harness);
        generation = spawned.assignment_generation;
        row = spawned.row;
        if (TERMINAL_STATUSES.has(row.status)) return;
      }
      row = await this.getStartableSessionRow(id);
      if (!row) return;
      generation = row.assignment_generation ?? generation;
      if (task != null) {
        await this.centaur.postMessage(
          row.centaur_thread_key,
          generation,
          [{ type: 'text', text: task }],
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
        inputLines: task == null ? [] : [userInputLine(task)],
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
        await this.markProviderAuthRequired(
          id,
          'missing_token',
          undefined,
        ).catch(() => {});
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
    const done = this.runTailer(id, controller).finally(() => {
      const current = this.tailers.get(id);
      if (current?.controller === controller) this.tailers.delete(id);
    });
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
    try {
      for await (const frame of this.centaur.tailEvents(row.centaur_thread_key, {
        executionId: row.current_execution_id,
        afterEventId: row.last_event_id,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) return;
        lastEventId = Math.max(lastEventId, frame.event_id);
        pendingLastEventId = lastEventId;
        frameCountSinceFlush += 1;
        await this.mirrorFrame(id, frame);
        await this.foldFrame(id, frame);
        if (frameCountSinceFlush >= 25 || Date.now() - lastFlushAt >= 2000) {
          await this.persistLastEventId(id, pendingLastEventId);
          frameCountSinceFlush = 0;
          lastFlushAt = Date.now();
        }
      }
      await this.persistLastEventId(id, pendingLastEventId);
      // The execution's frames are now fully mirrored — (re)project them into
      // searchable session_records and emit a change-feed row so the /atrium
      // materializer refreshes. Best-effort: never fail the tailer. (#72 P3)
      if (!controller.signal.aborted) {
        await projectAndEmitChange(this.pool, id).catch(() => {});
      }
    } catch {
      if (!controller.signal.aborted) {
        await this.updateStatus(id, 'failed').catch(() => {});
      }
    }
  }

  private async mirrorFrame(id: string, frame: CentaurEventFrame): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_events (session_id, centaur_event_id, event_kind, frame)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, centaur_event_id) DO NOTHING`,
      [id, frame.event_id, frame.event, JSON.stringify(frame)],
    );
    if (frame.event === 'artifact.captured') {
      await this.recordArtifact(id, frame.data);
      await this.ingestCapturedArtifactToLedger(id, frame.data);
    }
  }

  /** Stage an `artifact.captured` frame into session_artifacts so the offload
   * worker can durably copy its bytes into atrium's store. Keyed by (session,
   * artifact_id); artifacts are immutable by content hash so a replayed capture
   * is a no-op (DO NOTHING). Manifest-only artifacts (ref null) still get a row
   * for the durable record but are never offloaded (the queue index filters
   * them). */
  private async recordArtifact(
    id: string,
    data: Extract<CentaurEventFrame, { event: 'artifact.captured' }>['data'],
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_artifacts
         (id, session_id, execution_id, centaur_ref, path, mime, size_bytes, sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (session_id, id) DO NOTHING`,
      [
        data.artifact_id,
        id,
        data.execution_id ?? null,
        data.ref ?? null,
        data.path,
        data.mime,
        data.size_bytes,
        data.sha256,
      ],
    );
  }

  // === bridge additions ===
  private async ingestCapturedArtifactToLedger(
    sessionId: string,
    data: Extract<CentaurEventFrame, { event: 'artifact.captured' }>['data'],
  ): Promise<void> {
    try {
      const session = await this.pool.query<{ channel_id: string }>(
        'SELECT channel_id FROM sessions WHERE id = $1',
        [sessionId],
      );
      const channelId = session.rows[0]?.channel_id;
      if (!channelId) {
        console.warn('artifact ledger ingest skipped: session not found', { sessionId, path: data.path });
        return;
      }
      await this.artifactLedger.commitVersion({
        sessionId,
        channelId,
        path: data.path,
        blobSha: data.kind === 'deleted' ? null : data.sha256,
        sizeBytes: data.size_bytes,
        mime: data.mime,
        author: `agent:${sessionId}`,
        kind: data.kind,
        mergeClass: mergeClassForMime(data.mime),
      });
    } catch (err) {
      console.warn('artifact ledger ingest failed', {
        sessionId,
        path: data.path,
        err,
      });
    }
  }

  private async foldFrame(id: string, frame: CentaurEventFrame): Promise<void> {
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
      if (status === 'failed' && isProviderAuthFailureText(resultText)) {
        const marked = await this.markProviderAuthRequired(
          id,
          'invalid_token',
          undefined,
          frame.event_id,
        );
        if (marked) return;
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
      ).catch((err) =>
        console.warn('question push fanout failed', { id, err }),
      );
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

  async clearProviderAuthRequired(
    userId: string,
    provider: ProviderCredentialProvider,
  ): Promise<void> {
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
    await this.markProviderAuthRequired(
      id,
      'missing_token',
      undefined,
    );
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
             status = CASE WHEN status = 'spawning' THEN 'queued' ELSE status END,
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
      await this.centaur
        .release(releaseRow.centaur_thread_key, `rel-${id}-auth-${Date.now()}`, true)
        .catch((err) => {
          console.warn('session release after provider auth failure failed', { id, err });
        });
    }
    return events.length > 0;
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

  private async clearPendingQuestion(
    id: string,
    questionId: string,
    reason: 'cancelled' | 'empty',
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
    const questionId =
      typeof event.payload.questionId === 'string' ? event.payload.questionId : null;
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

  private async renotifyQuestionIfStillPending(
    id: string,
    questionId: string,
    event: WireEvent,
  ): Promise<void> {
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
    id: string,
    threadKey: string,
    harness: string,
    client: Db | DbClient = this.pool,
  ): Promise<{ row: SessionRow; assignment_generation: number }> {
    const spawnId = await this.reserveSpawnId(id, client);
    const spawned = await this.centaur.spawn(threadKey, harness, { spawnId });
    const generation = spawned.assignment_generation ?? 1;
    const row = await this.persistSpawnedAssignment(id, generation, client);
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
        ? this.pool.query<SessionUserRow>(
            'SELECT id AS user_id, display_name FROM users WHERE id = $1',
            [row.driver_id],
          )
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

async function assertThreadRoot(
  client: DbClient,
  channelId: string,
  threadRootEventId: number,
): Promise<void> {
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

function userInputLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'text', text }],
    },
  });
}

function writeSessionFrame(raw: ServerResponse, frame: CentaurEventFrame): void {
  raw.write(`event: ${frame.event}\n`);
  raw.write(`data: ${JSON.stringify({ ...frame.data, event_id: frame.event_id })}\n\n`);
}

function isDemoHarness(harness: string): boolean {
  return harness.trim().toLowerCase() === DEMO_HARNESS;
}

function isCentaurCode(err: unknown, code: string): boolean {
  return err instanceof CentaurApiError && err.code === code;
}

function mergeClassForMime(mime: string): MergeClass | undefined {
  const normalized = mime.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  if (
    normalized.startsWith('text/') ||
    normalized.endsWith('/markdown') ||
    normalized === 'application/json'
  ) {
    return 'mergeable-doc';
  }
  return undefined;
}

/** First defined, non-empty string in the list (config env defaults are ''). */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Trim + cap optional git metadata; empty becomes null. */
function normalizeGitMeta(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 200);
  return trimmed.length > 0 ? trimmed : null;
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
    spawnedBy: row.spawned_by,
    driverId: row.driver_id,
    driver: seatInfo.driver ?? null,
    pendingSeatRequests: seatInfo.pendingSeatRequests ?? [],
    suggestions: seatInfo.suggestions ?? [],
    answerProposals: seatInfo.answerProposals ?? [],
    pendingQuestion: parsePendingQuestion(row.pending_question),
    providerAuthRequired: parseProviderAuthRequired(row.provider_auth_required),
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
  if (
    raw.reason !== 'missing_token' &&
    raw.reason !== 'invalid_token' &&
    raw.reason !== 'auth_error'
  ) {
    return null;
  }
  return {
    provider,
    userId: raw.userId,
    reason: raw.reason,
    message:
      typeof raw.message === 'string' && raw.message.trim()
        ? raw.message
        : reconnectMessage(provider),
    at: typeof raw.at === 'string' ? raw.at : new Date().toISOString(),
  };
}

function reconnectMessage(provider: ProviderCredentialProvider): string {
  return `Reconnect ${providerDisplayName(provider)} to continue this session.`;
}

function authRequiredMessage(
  provider: ProviderCredentialProvider,
  reason: ProviderAuthRequiredJson['reason'],
): string {
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
      if (
        o.previewFormat !== undefined &&
        o.previewFormat !== 'markdown' &&
        o.previewFormat !== 'html'
      ) {
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

function summarizeAnswers(
  pending: SessionPendingQuestionJson,
  answers: QuestionAnswerBody,
): Record<string, unknown>[] {
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
