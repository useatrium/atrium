mod cleanup;

use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    env,
    path::{Component, Path},
    sync::Arc,
    time::{Duration, SystemTime},
};

use centaur_iron_control::SessionRegistrar;
use centaur_sandbox_core::{
    Mount, MountKind, PrepareClaimedOverlayHome, SandboxBackend,
    SandboxCapabilities as BackendSandboxCapabilities, SandboxError, SandboxId, SandboxIoGuard,
    SandboxRead, SandboxSpec, SandboxStatus, SandboxWrite,
};
use centaur_sandbox_manager::{
    SandboxManager, SandboxReaper, SandboxReaperConfig, WarmPoolConfig, WarmPoolError,
    WarmPoolManager, WarmSandboxSpecFactory, WarmSandboxWorkload,
};
use centaur_session_core::{
    ExecutionStatus, HarnessType, MessageRole, SandboxCapabilities as SessionSandboxCapabilities,
    Session, SessionEvent, SessionExecution, SessionMessageInput, ThreadKey, sandbox_token,
};
use centaur_session_sqlx::{
    PgSessionStore, SessionEventListener, SessionStoreError, default_metadata,
};
use centaur_telemetry::{
    export_thread_trace_root_span, record_sandbox_warm_pool_claim,
    record_session_execution_finished, record_session_execution_started, record_session_failure,
    record_session_first_token_latency, set_span_parent_trace,
};
use dashmap::DashMap;
use futures_util::{SinkExt, Stream, StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::{
    io,
    sync::Mutex,
    time::{Instant, Interval, MissedTickBehavior, interval_at, sleep},
};
use tokio_util::codec::{FramedRead, FramedWrite, LinesCodec, LinesCodecError};
use tracing::{Instrument, Span, error, info, info_span, warn};

pub use cleanup::SessionSandboxCleanupConfig;

pub const SESSION_OUTPUT_LINE_EVENT: &str = "session.output.line";
pub const SESSION_FIRST_TOKEN_EVENT: &str = "session.first_token";

const EVENT_STREAM_SAFETY_POLL_INTERVAL: Duration = Duration::from_secs(30);
const STEERING_STARTUP_RETRY_INTERVAL: Duration = Duration::from_millis(250);
const STEERING_STARTUP_RETRY_TIMEOUT: Duration = Duration::from_secs(15);
const SESSION_PIPE_MAX_REATTACH_ATTEMPTS: u32 = 3;
const SESSION_PIPE_REATTACH_DELAY: Duration = Duration::from_millis(500);
const COMPONENT_SESSION_RUNTIME: &str = "session_runtime";
const CLAUDE_CODE_OAUTH_TOKEN_ENV: &str = "CLAUDE_CODE_OAUTH_TOKEN";
const CODEX_AUTH_JSON_ENV: &str = "CODEX_AUTH_JSON";
const SESSION_REPOS_METADATA_KEY: &str = "centaur_session_repos";
const AGENT_REPOS_JSON_ENV: &str = "AGENT_REPOS_JSON";
const CENTAUR_WARM_RESOLVED_REPOS_JSON_ENV: &str = "CENTAUR_WARM_RESOLVED_REPOS_JSON";
const CENTAUR_WARM_SANDBOX_ENV: &str = "CENTAUR_WARM_SANDBOX";
const CENTAUR_WARM_REPO_OVERLAY_VERSION_ENV: &str = "CENTAUR_WARM_REPO_OVERLAY_VERSION";
const CENTAUR_WARM_REPO_OVERLAY_VERSION: &str = "2";
const REPOS_PATH_ENV: &str = "REPOS_PATH";
const REPO_CACHE_STATE_FILE: &str = ".repo-cache-state.json";
const SANDBOX_REPO_CACHE_MOUNT_PATH: &str = "/cache";
const OBSERVABILITY_TOOL_BLOCKLIST: &str =
    "vlogs,vmetrics,grafana,centaur_investigator,centaur-investigator";
const SANDBOX_STATE_DIR: &str = "/home/agent/state";
const SANDBOX_CODEX_HOME: &str = "/home/agent/state/codex";
const SANDBOX_CLAUDE_CONFIG_DIR: &str = "/home/agent/state/claude";

type SandboxSpecFactory = Arc<
    dyn Fn(&ThreadKey, &str, &HarnessType, Option<&PersonaContext>) -> SandboxSpec + Send + Sync,
>;
type SessionInputSink = FramedWrite<SandboxWrite, LinesCodec>;
type ExecutionSpanRegistry = Arc<Mutex<HashMap<String, Span>>>;
type SessionPipeMap = Arc<DashMap<String, SessionPipe>>;
type SessionPipeOpenLocks = Arc<DashMap<String, Arc<Mutex<()>>>>;
type SessionOperationLocks = Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>;
/// Execution ids whose active turn was interrupted by an explicit user request.
/// A marked execution's resulting `interrupted` terminal is recorded as a clean
/// user-stop (Completed) rather than a failure. Set on interrupt delivery,
/// consumed by `record_terminal_output`.
type UserInterruptSet = Arc<DashMap<String, ()>>;

#[derive(Clone)]
pub struct SessionRuntime {
    store: PgSessionStore,
    sandbox_runtime: SandboxRuntime,
    sandbox_pipes: SessionPipeMap,
    sandbox_pipe_open_locks: SessionPipeOpenLocks,
    execution_spans: ExecutionSpanRegistry,
    user_interrupts: UserInterruptSet,
    session_operation_locks: SessionOperationLocks,
    iron_control: Option<SessionRegistrar>,
    warm_pool: Option<Arc<WarmPoolManager>>,
    personas: Option<Arc<PersonaRegistry>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PersonaRegistry {
    personas: BTreeMap<String, PersonaDefinition>,
    default_persona_id: Option<String>,
    overlay_chain: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PersonaDefinition {
    pub id: String,
    pub source_root: String,
    pub source_path: String,
    pub source_ref: Option<String>,
    pub prompt_hash: String,
    #[serde(skip_serializing)]
    pub prompt: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PersonaSummary {
    pub id: String,
    pub source_root: String,
    pub source_path: String,
    pub source_ref: Option<String>,
    pub prompt_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PersonaContext {
    pub persona_id: String,
    pub source_root: String,
    pub source_path: String,
    pub source_ref: Option<String>,
    pub prompt_hash: String,
    pub defaulted: bool,
    pub overlay_chain: Vec<String>,
}

impl PersonaRegistry {
    pub fn new(
        personas: impl IntoIterator<Item = PersonaDefinition>,
        default_persona_id: Option<String>,
        overlay_chain: Vec<String>,
    ) -> Result<Self, String> {
        let personas = personas
            .into_iter()
            .map(|persona| (persona.id.clone(), persona))
            .collect::<BTreeMap<_, _>>();
        if let Some(default_persona_id) = default_persona_id.as_deref()
            && !personas.contains_key(default_persona_id)
        {
            return Err(format!(
                "CENTAUR_DEFAULT_PERSONA {default_persona_id:?} is not in the deployed persona registry"
            ));
        }
        Ok(Self {
            personas,
            default_persona_id,
            overlay_chain,
        })
    }

    pub fn summaries(&self) -> Vec<PersonaSummary> {
        self.personas
            .values()
            .map(|persona| PersonaSummary {
                id: persona.id.clone(),
                source_root: persona.source_root.clone(),
                source_path: persona.source_path.clone(),
                source_ref: persona.source_ref.clone(),
                prompt_hash: persona.prompt_hash.clone(),
            })
            .collect()
    }

    fn default_persona_id(&self) -> Option<&str> {
        self.default_persona_id.as_deref()
    }

    fn get(&self, persona_id: &str) -> Option<&PersonaDefinition> {
        self.personas.get(persona_id)
    }

    fn context_for(&self, persona_id: &str, defaulted: bool) -> Result<PersonaContext, String> {
        let Some(persona) = self.get(persona_id) else {
            return Err(format!(
                "persona {persona_id:?} is not available in this deployment"
            ));
        };
        Ok(PersonaContext {
            persona_id: persona.id.clone(),
            source_root: persona.source_root.clone(),
            source_path: persona.source_path.clone(),
            source_ref: persona.source_ref.clone(),
            prompt_hash: persona.prompt_hash.clone(),
            defaulted,
            overlay_chain: self.overlay_chain.clone(),
        })
    }
}

#[derive(Clone)]
pub struct SandboxRuntime {
    manager: Arc<SandboxManager>,
    spec_factory: SandboxSpecFactory,
    warm_spec_factory: Option<WarmSandboxSpecFactory>,
    warm_repos_json: Option<String>,
    /// The harness warm sandboxes boot with. A warm claim is only valid for a
    /// session on the same harness; other sessions get a cold sandbox.
    warm_harness: Option<HarnessType>,
}

#[derive(Clone, Debug)]
pub enum SandboxWorkloadMode {
    MockAppServer {
        image: String,
    },
    CodexAppServer {
        image: String,
        env: Vec<(String, String)>,
        mounts: Vec<Mount>,
        /// The harness used for warm sandboxes and as the workload default.
        /// Per-session sandboxes run the session's own harness.
        harness: HarnessType,
    },
}

/// What to do when a session already exists with a different harness.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HarnessConflictPolicy {
    /// Fail with [`SessionStoreError::HarnessConflict`] (the default).
    Reject,
    /// Restart the thread on the requested harness: stop the old sandbox,
    /// clear the harness thread state, and switch the session row over. The
    /// new harness starts with no conversational memory.
    Restart,
}

/// Result of [`SessionRuntime::create_or_get_session`].
#[derive(Clone, Debug)]
pub struct CreateOrGetSessionOutcome {
    pub session: Session,
    /// True when the session was restarted onto a different harness because
    /// the request asked for [`HarnessConflictPolicy::Restart`].
    pub harness_switched: bool,
}

/// Outcome of [`SessionRuntime::drain`]: the sandboxes that were stopped and
/// any that failed to stop (with the backend error text).
#[derive(Debug, Default)]
pub struct DrainReport {
    pub stopped: Vec<String>,
    pub failed: Vec<DrainFailure>,
}

#[derive(Debug)]
pub struct DrainFailure {
    pub sandbox_id: String,
    pub error: String,
}

/// Result of cancelling the currently active execution for a session.
#[derive(Debug, Default)]
pub struct CancelSessionOutcome {
    pub cancelled: bool,
    pub execution_id: Option<String>,
    pub stopped_sandbox_id: Option<String>,
    pub stop_error: Option<String>,
}

/// Result of interrupting the active turn of a session (stop-turn, no teardown).
#[derive(Clone, Debug, Default)]
pub struct InterruptTurnOutcome {
    /// True when an interrupt frame was delivered to a live turn.
    pub interrupted: bool,
    /// The execution the interrupt targeted, if any turn was active.
    pub execution_id: Option<String>,
    /// Populated when there was no active turn to interrupt or delivery failed.
    pub error: Option<String>,
}

/// Result of answering a pending user-input question for a running execution.
#[derive(Clone, Debug)]
pub struct AnswerQuestionOutcome {
    pub execution_id: String,
    pub thread_key: ThreadKey,
    pub status: String,
}

#[derive(Debug, Error)]
pub enum AnswerQuestionError {
    #[error("Execution not found")]
    ExecutionNotFound,
    #[error("Execution is not running")]
    ExecutionNotRunning,
    #[error("Question is not pending")]
    QuestionNotPending,
    #[error(transparent)]
    Runtime(#[from] SessionRuntimeError),
}

impl From<SessionStoreError> for AnswerQuestionError {
    fn from(error: SessionStoreError) -> Self {
        Self::Runtime(SessionRuntimeError::Store(error))
    }
}

#[derive(Debug, Default)]
pub struct WorkflowSandboxCleanupReport {
    pub stopped: Vec<String>,
    pub missing: Vec<String>,
    pub failed: Vec<DrainFailure>,
}

#[derive(Debug)]
pub struct ExecuteSessionInput {
    pub idempotency_key: Option<String>,
    pub metadata: Option<Value>,
    pub environment: BTreeMap<String, String>,
    pub input_lines: Vec<String>,
    pub idle_timeout_ms: Option<u64>,
    pub max_duration_ms: Option<u64>,
}

#[derive(Clone)]
struct SessionPipe {
    stdin: Arc<Mutex<SessionInputSink>>,
}

/// Shared handles threaded through background session tasks (stdout pump,
/// terminal-output recording, max-duration failure, idle pause).
#[derive(Clone)]
struct RuntimeContext {
    store: PgSessionStore,
    manager: Arc<SandboxManager>,
    sandbox_pipes: SessionPipeMap,
    execution_spans: ExecutionSpanRegistry,
    user_interrupts: UserInterruptSet,
}

struct EventStreamState {
    store: PgSessionStore,
    thread_key: ThreadKey,
    after_event_id: i64,
    execution_id: Option<String>,
    pending: VecDeque<SessionEvent>,
    listener: SessionEventListener,
    safety_tick: Interval,
    done: bool,
    emitted_count: u64,
    span: Span,
}

struct SandboxReadyObservation<'a> {
    thread_key: &'a ThreadKey,
    execution_id: &'a str,
    sandbox_id: &'a str,
    harness_type: &'a HarnessType,
    source: &'static str,
    ready_duration: Duration,
    startup_duration: Option<Duration>,
}

struct ClaimedWarmSandboxObservation<'a> {
    thread_key: &'a ThreadKey,
    execution_id: &'a str,
    sandbox_id: &'a str,
    harness_type: &'a HarnessType,
    workload_key: &'a str,
    iron_control_principal: Option<&'a str>,
    desired_capabilities: &'a SessionSandboxCapabilities,
    ready_duration: Duration,
    post_claim_overlay_home: bool,
}

struct EnsureSessionSandboxInput<'a> {
    thread_key: &'a ThreadKey,
    harness_type: &'a HarnessType,
    persona_id: Option<&'a str>,
    existing_sandbox_id: Option<&'a str>,
    existing_sandbox_capabilities: Option<&'a SessionSandboxCapabilities>,
    iron_control_principal: Option<&'a str>,
    desired_capabilities: &'a SessionSandboxCapabilities,
    resume_thread_id: Option<&'a str>,
    session_repos_json: Option<&'a str>,
    execution_id: &'a str,
    environment: &'a [(String, String)],
}

struct PersonaResolution {
    persona_id: Option<String>,
    context: Option<PersonaContext>,
    defaulted: bool,
}

impl SessionRuntime {
    pub fn new(store: PgSessionStore, sandbox_runtime: SandboxRuntime) -> Self {
        Self {
            store,
            sandbox_runtime,
            sandbox_pipes: Arc::new(DashMap::new()),
            sandbox_pipe_open_locks: Arc::new(DashMap::new()),
            execution_spans: Arc::new(Mutex::new(HashMap::new())),
            user_interrupts: Arc::new(DashMap::new()),
            session_operation_locks: Arc::new(Mutex::new(HashMap::new())),
            iron_control: None,
            warm_pool: None,
            personas: None,
        }
    }

    pub fn with_personas(mut self, personas: PersonaRegistry) -> Self {
        self.personas = Some(Arc::new(personas));
        self
    }

    pub fn personas(&self) -> Vec<PersonaSummary> {
        self.personas
            .as_ref()
            .map(|personas| personas.summaries())
            .unwrap_or_default()
    }

    fn resolve_persona_for_create(
        &self,
        requested_persona_id: Option<&str>,
    ) -> Result<PersonaResolution, SessionRuntimeError> {
        let requested = requested_persona_id.and_then(clean_persona_id);
        let selected = requested.or_else(|| self.default_persona_id());
        let defaulted = requested.is_none() && selected.is_some();
        let context = self.resolve_persona_context(selected, defaulted)?;
        Ok(PersonaResolution {
            persona_id: selected.map(str::to_owned),
            context,
            defaulted,
        })
    }

    fn resolve_stored_persona(
        &self,
        persona_id: Option<&str>,
        _harness_type: &HarnessType,
    ) -> Result<Option<PersonaContext>, SessionRuntimeError> {
        self.resolve_persona_context(persona_id.and_then(clean_persona_id), false)
    }

    fn resolve_persona_context(
        &self,
        persona_id: Option<&str>,
        defaulted: bool,
    ) -> Result<Option<PersonaContext>, SessionRuntimeError> {
        let Some(persona_id) = persona_id else {
            return Ok(None);
        };
        let Some(registry) = self.personas.as_ref() else {
            return Err(SessionRuntimeError::BadRequest(format!(
                "persona {persona_id:?} was requested but no persona registry is configured"
            )));
        };
        registry
            .context_for(persona_id, defaulted)
            .map(Some)
            .map_err(SessionRuntimeError::BadRequest)
    }

    fn default_persona_id(&self) -> Option<&str> {
        self.personas
            .as_ref()
            .and_then(|personas| personas.default_persona_id())
    }

    fn context(&self) -> RuntimeContext {
        RuntimeContext {
            store: self.store.clone(),
            manager: self.sandbox_runtime.manager.clone(),
            sandbox_pipes: self.sandbox_pipes.clone(),
            execution_spans: self.execution_spans.clone(),
            user_interrupts: self.user_interrupts.clone(),
        }
    }

    async fn session_operation_lock(&self, thread_key: &ThreadKey) -> Arc<Mutex<()>> {
        let mut locks = self.session_operation_locks.lock().await;
        locks
            .entry(thread_key.as_str().to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Attach an iron-control registrar so each new session upserts its
    /// principal and assigns the configured roles.
    pub fn with_iron_control(mut self, registrar: SessionRegistrar) -> Self {
        self.iron_control = Some(registrar);
        self
    }

    pub fn with_warm_pool(mut self, config: WarmPoolConfig) -> Self {
        if config.target_size == 0 {
            return self;
        }

        let Some(spec_factory) = self.sandbox_runtime.warm_spec_factory.clone() else {
            warn!(
                target_size = config.target_size,
                "session sandbox warm pool requested for runtime without a warm sandbox spec"
            );
            return self;
        };

        let pool = Arc::new(WarmPoolManager::new(
            self.sandbox_runtime.manager.clone(),
            self.store.clone(),
            spec_factory,
            config,
        ));
        pool.clone().spawn_replenisher();
        self.warm_pool = Some(pool);
        self
    }

    /// Spawn the background reaper that stops sandboxes whose idle pause or
    /// total lifetime expired. No-op when both TTLs are disabled.
    pub fn with_sandbox_reaper(self, config: SandboxReaperConfig) -> Self {
        if !config.is_enabled() {
            return self;
        }
        SandboxReaper::new(self.sandbox_runtime.manager.clone(), config).spawn();
        self
    }

    /// Spawn the DB-aware cleanup worker that reaps backend sandboxes no durable
    /// session/warm-pool row references and restores idle pauses lost across
    /// control-plane restarts.
    pub fn with_sandbox_cleanup(self, config: SessionSandboxCleanupConfig) -> Self {
        if !config.is_enabled() {
            return self;
        }
        cleanup::SessionSandboxCleanupWorker::new(self.context(), config).spawn();
        self
    }

    pub async fn create_or_get_session(
        &self,
        thread_key: &ThreadKey,
        harness_type: &HarnessType,
        persona_id: Option<&str>,
        metadata: Option<Value>,
        on_harness_conflict: HarnessConflictPolicy,
    ) -> Result<CreateOrGetSessionOutcome, SessionRuntimeError> {
        let span = info_span!(
            "centaur.api_rs.session.create_or_get",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_create_or_get",
            "centaur.thread_key" = thread_key.as_str(),
            "centaur.harness_type" = %harness_type,
            thread_key = %thread_key,
            harness_type = %harness_type,
            iron_control_enabled = self.iron_control.is_some(),
        );
        set_span_parent_trace(
            &span,
            &thread_trace_id(thread_key),
            &thread_trace_parent_span_id(thread_key),
        );
        let result = async {
            ensure_thread_trace_root_span(thread_key);
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_create_or_get_started",
                thread_key = %thread_key,
                harness_type = %harness_type,
                iron_control_enabled = self.iron_control.is_some(),
                "creating or loading session"
            );
            let mut harness_switched = false;
            let persona_resolution = self.resolve_persona_for_create(persona_id)?;
            let mut session_metadata = default_metadata(metadata);
            if let Some(context) = persona_resolution.context.as_ref() {
                add_persona_metadata(&mut session_metadata, context);
            }
            let session = match self
                .store
                .create_or_get_session(
                    thread_key,
                    harness_type,
                    persona_resolution.persona_id.as_deref(),
                    session_metadata.clone(),
                )
                .await
            {
                Ok(session) => session,
                Err(SessionStoreError::PersonaConflict { existing, .. })
                    if persona_id.is_none() && persona_resolution.defaulted =>
                {
                    self.store
                        .create_or_get_session(
                            thread_key,
                            harness_type,
                            existing.as_deref(),
                            default_metadata(None),
                        )
                        .await?
                }
                Err(SessionStoreError::HarnessConflict { existing, .. })
                    if on_harness_conflict == HarnessConflictPolicy::Restart =>
                {
                    let session = self
                        .restart_session_on_harness(thread_key, harness_type, &existing)
                        .await?;
                    harness_switched = true;
                    session
                }
                Err(error) => return Err(error.into()),
            };
            if let Some(context) =
                self.resolve_stored_persona(session.persona_id.as_deref(), harness_type)?
            {
                self.store
                    .append_event(
                        thread_key,
                        None,
                        "session.persona_resolved",
                        json!({
                            "persona": context,
                            "requested_persona_id": persona_id,
                            "deployment_default_persona_id": self.default_persona_id(),
                        }),
                    )
                    .await?;
            }
            if let Some(registrar) = &self.iron_control {
                // iron-control is the source of truth for the session's egress
                // proxy: without a registered principal the proxy has no identity
                // to bind to, so a registration failure must fail session creation
                // rather than silently boot a sandbox with a non-functional proxy.
                let principal = registrar
                    .register_session(thread_key.as_str(), Some(&session_metadata))
                    .await?;
                // Persist the principal OID on the session row so a resumed session
                // can recreate its sandbox after a restart without re-deriving it.
                let session = self
                    .store
                    .set_iron_control_principal(thread_key, Some(&principal.id))
                    .await?;
                info!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_create_or_get_completed",
                    thread_key = %thread_key,
                    harness_type = %harness_type,
                    status = %session.status,
                    iron_control_principal_persisted = true,
                    harness_switched,
                    "session ready"
                );
                return Ok(CreateOrGetSessionOutcome {
                    session,
                    harness_switched,
                });
            }
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_create_or_get_completed",
                thread_key = %thread_key,
                harness_type = %harness_type,
                status = %session.status,
                iron_control_principal_persisted = session.iron_control_principal.is_some(),
                harness_switched,
                "session ready"
            );
            Ok(CreateOrGetSessionOutcome {
                session,
                harness_switched,
            })
        }
        .instrument(span)
        .await;

        if let Err(error) = &result {
            error!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_create_or_get_failed",
                thread_key = %thread_key,
                harness_type = %harness_type,
                %error,
                "failed to create or load session"
            );
        }
        result
    }

    /// Restart an existing session on a different harness: stop its sandbox
    /// (killing any in-flight execution), clear the harness thread state, and
    /// flip the session row to the requested harness. Stored messages and
    /// events are preserved for the record, but the new harness boots with no
    /// conversational memory — callers that want continuity must re-send
    /// context with the next turn.
    async fn restart_session_on_harness(
        &self,
        thread_key: &ThreadKey,
        harness_type: &HarnessType,
        previous_harness: &str,
    ) -> Result<Session, SessionRuntimeError> {
        let previous = self.store.get_session(thread_key).await?;
        if let Some(sandbox_id) = previous.sandbox_id.as_deref() {
            self.sandbox_pipes.remove(sandbox_id);
            match self
                .sandbox_runtime
                .manager
                .stop(&SandboxId::new(sandbox_id))
                .await
            {
                Ok(()) | Err(SandboxError::NotFound(_)) => {}
                Err(error) => return Err(SessionRuntimeError::Sandbox(error)),
            }
        }
        let session = self
            .store
            .switch_session_harness(thread_key, harness_type)
            .await?;
        self.store
            .append_event(
                thread_key,
                None,
                "session.harness_switched",
                json!({
                    "thread_key": thread_key.as_str(),
                    "from_harness": previous_harness,
                    "to_harness": harness_type.as_ref(),
                    "stopped_sandbox_id": previous.sandbox_id,
                }),
            )
            .await?;
        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_harness_switched",
            thread_key = %thread_key,
            from_harness = previous_harness,
            to_harness = %harness_type,
            stopped_sandbox_id = previous.sandbox_id.as_deref().unwrap_or(""),
            "restarted session on a new harness"
        );
        Ok(session)
    }

    pub async fn append_messages(
        &self,
        thread_key: &ThreadKey,
        messages: &[SessionMessageInput],
    ) -> Result<Vec<String>, SessionRuntimeError> {
        let span = info_span!(
            "centaur.api_rs.session.messages.append",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_messages_append",
            "centaur.thread_key" = thread_key.as_str(),
            thread_key = %thread_key,
            message_count = messages.len(),
        );
        set_span_parent_trace(
            &span,
            &thread_trace_id(thread_key),
            &thread_trace_parent_span_id(thread_key),
        );
        let result = async {
            ensure_thread_trace_root_span(thread_key);
            if messages.is_empty() {
                return Err(SessionRuntimeError::BadRequest(
                    "messages must not be empty".to_owned(),
                ));
            }
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_messages_append_started",
                thread_key = %thread_key,
                message_count = messages.len(),
                "appending session messages"
            );
            let message_ids = self.store.append_messages(thread_key, messages).await?;
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_messages_append_completed",
                thread_key = %thread_key,
                message_count = messages.len(),
                message_id_count = message_ids.len(),
                "session messages appended"
            );
            Ok(message_ids)
        }
        .instrument(span)
        .await;

        let message_ids = match result {
            Ok(message_ids) => message_ids,
            Err(error) => {
                error!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_messages_append_failed",
                    thread_key = %thread_key,
                    message_count = messages.len(),
                    %error,
                    "failed to append session messages"
                );
                return Err(error);
            }
        };
        self.forward_messages_to_active_execution(thread_key, messages, &message_ids)
            .await;
        Ok(message_ids)
    }

    /// Stop every non-terminal sandbox the backend currently owns.
    ///
    /// Intended for a clean control-plane shutdown (e.g. before a deploy):
    /// each sandbox is stopped independently so one failure does not abort the
    /// rest, and the [`DrainReport`] records which were stopped and which
    /// failed so the caller can surface partial failure.
    pub async fn drain(&self) -> Result<DrainReport, SessionRuntimeError> {
        let observed = self.sandbox_runtime.manager.list_observed().await?;
        let mut report = DrainReport::default();
        for sandbox in observed {
            if sandbox.status.is_terminal() {
                continue;
            }
            let id = sandbox.id.as_str().to_owned();
            match self.sandbox_runtime.manager.stop(&sandbox.id).await {
                Ok(()) => {
                    self.sandbox_pipes.remove(&id);
                    if let Err(error) = self
                        .store
                        .mark_warm_sandbox_failed(&id, "sandbox drained")
                        .await
                    {
                        warn!(sandbox_id = %id, %error, "drain failed to clear warm sandbox row");
                        report.failed.push(DrainFailure {
                            sandbox_id: id.clone(),
                            error: error.to_string(),
                        });
                    }
                    report.stopped.push(id);
                }
                Err(error) => {
                    warn!(sandbox_id = %id, %error, "drain failed to stop sandbox");
                    report.failed.push(DrainFailure {
                        sandbox_id: id,
                        error: error.to_string(),
                    });
                }
            }
        }
        Ok(report)
    }

    pub async fn cancel_session(
        &self,
        thread_key: &ThreadKey,
    ) -> Result<CancelSessionOutcome, SessionRuntimeError> {
        let span = info_span!(
            "centaur.api_rs.session.cancel",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_cancel",
            "centaur.thread_key" = thread_key.as_str(),
            "centaur.execution_id" = tracing::field::Empty,
            "centaur.sandbox_id" = tracing::field::Empty,
            thread_key = %thread_key,
            execution_id = tracing::field::Empty,
            sandbox_id = tracing::field::Empty,
        );
        async {
            let session = self.store.get_session(thread_key).await?;
            let Some(active) = self.store.active_execution_for_thread(thread_key).await? else {
                let mut outcome = CancelSessionOutcome::default();
                if let Some(sandbox_id) = session.sandbox_id {
                    self.stop_session_sandbox_for_cancel(
                        thread_key,
                        None,
                        &sandbox_id,
                        &mut outcome,
                    )
                    .await?;
                }
                info!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_cancel_no_active_execution",
                    thread_key = %thread_key,
                    stopped_sandbox_id = outcome.stopped_sandbox_id.as_deref().unwrap_or(""),
                    stop_error = outcome.stop_error.as_deref().unwrap_or(""),
                    "session cancel found no active execution"
                );
                return Ok(outcome);
            };

            span.record("centaur.execution_id", active.execution_id.as_str());
            span.record("execution_id", active.execution_id.as_str());
            if let Some(sandbox_id) = session.sandbox_id.as_deref() {
                span.record("centaur.sandbox_id", sandbox_id);
                span.record("sandbox_id", sandbox_id);
            }

            let reason = "session cancelled by request";
            let Some(execution) = self
                .store
                .cancel_execution_if_active(&active.execution_id, reason)
                .await?
            else {
                info!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_cancel_already_terminal",
                    thread_key = %thread_key,
                    execution_id = %active.execution_id,
                    "session cancel lost the active-execution race"
                );
                return Ok(CancelSessionOutcome::default());
            };

            self.execution_spans
                .lock()
                .await
                .remove(&execution.execution_id);
            self.store
                .append_event(
                    thread_key,
                    Some(&execution.execution_id),
                    "session.execution_cancelled",
                    json!({
                        "execution_id": execution.execution_id,
                        "thread_key": thread_key.as_str(),
                        "reason": reason,
                    }),
                )
                .await?;
            record_finished_execution_metric(
                &self.store,
                thread_key,
                &execution,
                "cancelled",
                None,
            )
            .await;

            let mut outcome = CancelSessionOutcome {
                cancelled: true,
                execution_id: Some(execution.execution_id.clone()),
                stopped_sandbox_id: None,
                stop_error: None,
            };

            if let Some(sandbox_id) = session.sandbox_id {
                self.stop_session_sandbox_for_cancel(
                    thread_key,
                    Some(&execution.execution_id),
                    &sandbox_id,
                    &mut outcome,
                )
                .await?;
            }

            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_cancel_completed",
                thread_key = %thread_key,
                execution_id = %execution.execution_id,
                stopped_sandbox_id = outcome.stopped_sandbox_id.as_deref().unwrap_or(""),
                stop_error = outcome.stop_error.as_deref().unwrap_or(""),
                "session cancel completed"
            );
            Ok(outcome)
        }
        .instrument(span.clone())
        .await
    }

    pub async fn answer_execution_question(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
        question_id: &str,
        answers: Value,
    ) -> Result<AnswerQuestionOutcome, AnswerQuestionError> {
        let operation_lock = self.session_operation_lock(thread_key).await;
        let _operation_guard = operation_lock.lock().await;
        let execution = self
            .store
            .get_execution_optional(execution_id)
            .await?
            .ok_or(AnswerQuestionError::ExecutionNotFound)?;
        if execution.thread_key != *thread_key {
            return Err(AnswerQuestionError::ExecutionNotFound);
        }
        if execution.status != ExecutionStatus::Running {
            return Err(AnswerQuestionError::ExecutionNotRunning);
        }

        let active = self.store.active_execution_for_thread(thread_key).await?;
        if active.as_ref().map(|active| active.execution_id.as_str()) != Some(execution_id) {
            return Err(AnswerQuestionError::ExecutionNotRunning);
        }

        if !self
            .execution_question_is_pending(thread_key, execution_id, question_id)
            .await?
        {
            return Err(AnswerQuestionError::QuestionNotPending);
        }

        let pipe = self
            .wait_for_active_steering_pipe(thread_key, execution_id)
            .await
            .map_err(|_| AnswerQuestionError::ExecutionNotRunning)?;
        let answers = if answers.is_object() {
            answers
        } else {
            json!({})
        };
        let line = json!({
            "type": "question_answer",
            "question_id": question_id,
            "answers": answers,
        })
        .to_string();
        write_input_lines(&pipe, &[line], thread_key, execution_id, None).await?;

        self.store
            .append_event(
                thread_key,
                Some(execution_id),
                "session.question_answer_delivered",
                json!({
                    "execution_id": execution_id,
                    "thread_key": thread_key.as_str(),
                    "question_id": question_id,
                }),
            )
            .await?;

        Ok(AnswerQuestionOutcome {
            execution_id: execution_id.to_owned(),
            thread_key: thread_key.clone(),
            status: "answered".to_owned(),
        })
    }

    async fn execution_question_is_pending(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
        question_id: &str,
    ) -> Result<bool, SessionRuntimeError> {
        let mut after_event_id = 0;
        let mut pending = false;
        loop {
            let events = self
                .store
                .list_events_after(thread_key, after_event_id, Some(execution_id), 1000)
                .await?;
            if events.is_empty() {
                break;
            }
            for event in &events {
                after_event_id = event.event_id;
                if output_line_question_event_matches(event, question_id, "question_requested") {
                    pending = true;
                } else if output_line_question_event_matches(
                    event,
                    question_id,
                    "question_resolved",
                ) || event_question_id_matches(
                    event,
                    question_id,
                    "session.question_answer_delivered",
                ) {
                    pending = false;
                }
            }
        }
        Ok(pending)
    }

    async fn stop_session_sandbox_for_cancel(
        &self,
        thread_key: &ThreadKey,
        execution_id: Option<&str>,
        sandbox_id: &str,
        outcome: &mut CancelSessionOutcome,
    ) -> Result<(), SessionRuntimeError> {
        let id = SandboxId::new(sandbox_id);
        self.sandbox_pipes.remove(sandbox_id);
        match self.sandbox_runtime.manager.stop(&id).await {
            Ok(()) | Err(SandboxError::NotFound(_)) => {
                self.store.update_sandbox_id(thread_key, None).await?;
                outcome.stopped_sandbox_id = Some(sandbox_id.to_owned());
                info!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_cancel_sandbox_stopped",
                    thread_key = %thread_key,
                    execution_id = execution_id.unwrap_or(""),
                    sandbox_id = %sandbox_id,
                    "session cancel stopped sandbox"
                );
            }
            Err(error) => {
                let error_message = error.to_string();
                self.store
                    .append_event(
                        thread_key,
                        execution_id,
                        "session.sandbox_stop_failed",
                        json!({
                            "execution_id": execution_id,
                            "thread_key": thread_key.as_str(),
                            "sandbox_id": sandbox_id,
                            "error": error_message,
                        }),
                    )
                    .await?;
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_cancel_sandbox_stop_failed",
                    thread_key = %thread_key,
                    execution_id = execution_id.unwrap_or(""),
                    sandbox_id = %sandbox_id,
                    error = %error_message,
                    "session cancel failed to stop sandbox"
                );
                outcome.stop_error = Some(error_message);
            }
        }
        Ok(())
    }

    pub async fn stop_workflow_owned_sandboxes(
        &self,
        workflow_run_id: &str,
        reason: &str,
    ) -> Result<WorkflowSandboxCleanupReport, SessionRuntimeError> {
        let sandboxes = self
            .store
            .list_workflow_owned_sandboxes(workflow_run_id)
            .await?;
        let mut report = WorkflowSandboxCleanupReport::default();

        for sandbox in sandboxes {
            let sandbox_id = sandbox.sandbox_id;
            let thread_key = sandbox.thread_key;
            self.sandbox_pipes.remove(&sandbox_id);
            let id = SandboxId::new(sandbox_id.clone());
            let mut missing = false;
            match self.sandbox_runtime.manager.stop(&id).await {
                Ok(()) => report.stopped.push(sandbox_id.clone()),
                Err(SandboxError::NotFound(_)) => {
                    missing = true;
                    report.missing.push(sandbox_id.clone());
                }
                Err(error) => {
                    let error = error.to_string();
                    warn!(
                        thread_key = %thread_key,
                        sandbox_id,
                        workflow_run_id,
                        reason,
                        %error,
                        "failed to stop workflow-owned sandbox"
                    );
                    report.failed.push(DrainFailure {
                        sandbox_id: sandbox_id.clone(),
                        error: error.clone(),
                    });
                    if let Err(event_error) = self
                        .store
                        .append_event(
                            &thread_key,
                            None,
                            "session.workflow_sandbox_stop_failed",
                            json!({
                                "thread_key": thread_key.as_str(),
                                "sandbox_id": sandbox_id,
                                "workflow_run_id": workflow_run_id,
                                "reason": reason,
                                "error": error,
                            }),
                        )
                        .await
                    {
                        warn!(
                            thread_key = %thread_key,
                            sandbox_id,
                            workflow_run_id,
                            %event_error,
                            "failed to append workflow sandbox stop failure event"
                        );
                    }
                    continue;
                }
            }

            if let Err(error) = self
                .store
                .mark_warm_sandbox_failed(&sandbox_id, "workflow-owned sandbox stopped")
                .await
            {
                warn!(
                    thread_key = %thread_key,
                    sandbox_id,
                    workflow_run_id,
                    %error,
                    "failed to mark workflow-owned warm sandbox failed"
                );
            }

            let cleared = self
                .store
                .clear_sandbox_id_if_matches(&thread_key, &sandbox_id)
                .await?;
            if let Err(error) = self
                .store
                .append_event(
                    &thread_key,
                    None,
                    "session.workflow_sandbox_stopped",
                    json!({
                        "thread_key": thread_key.as_str(),
                        "sandbox_id": sandbox_id,
                        "workflow_run_id": workflow_run_id,
                        "reason": reason,
                        "missing": missing,
                        "cleared": cleared,
                    }),
                )
                .await
            {
                warn!(
                    thread_key = %thread_key,
                    sandbox_id,
                    workflow_run_id,
                    %error,
                    "failed to append workflow sandbox cleanup event"
                );
            }
        }

        Ok(report)
    }

    pub async fn execute_session(
        &self,
        thread_key: &ThreadKey,
        input: ExecuteSessionInput,
    ) -> Result<SessionExecution, SessionRuntimeError> {
        let ExecuteSessionInput {
            idempotency_key,
            metadata,
            environment,
            input_lines,
            idle_timeout_ms,
            max_duration_ms,
        } = input;
        let input_line_count = input_lines.len();
        let idempotency_key_present = idempotency_key.is_some();
        let span = info_span!(
            "centaur.api_rs.session.execute",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_execute",
            "centaur.thread_key" = thread_key.as_str(),
            "centaur.execution_id" = tracing::field::Empty,
            "centaur.sandbox_id" = tracing::field::Empty,
            thread_key = %thread_key,
            execution_id = tracing::field::Empty,
            sandbox_id = tracing::field::Empty,
            input_line_count,
            idempotency_key_present,
        );
        set_span_parent_trace(
            &span,
            &thread_trace_id(thread_key),
            &thread_trace_parent_span_id(thread_key),
        );
        let result = async {
            let operation_lock = self.session_operation_lock(thread_key).await;
            let _operation_guard = operation_lock.lock().await;
            ensure_thread_trace_root_span(thread_key);
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_execute_started",
                thread_key = %thread_key,
                input_line_count,
                idempotency_key_present,
                "starting session execution"
            );
            let session = self.store.get_session(thread_key).await?;
            let session_metadata = self.store.get_session_metadata(thread_key).await?;
            let session_repos_json = session_repos_json(&session_metadata);
            let resume_thread_id = session
                .harness_thread_id
                .as_deref()
                .map(str::trim)
                .filter(|thread_id| !thread_id.is_empty());
            let harness_label = session.harness_type.to_string();
            validate_input_lines(&input_lines)?;
            let environment = validate_execution_environment(&session.harness_type, environment)?;
            let (idle_timeout, max_duration) = duration_options(idle_timeout_ms, max_duration_ms)?;

            let execution = self
                .store
                .create_execution(
                    thread_key,
                    idempotency_key.as_deref(),
                    execution_metadata(metadata, idle_timeout_ms, max_duration_ms),
                )
                .await?;
            span.record(
                "centaur.execution_id",
                execution.execution.execution_id.as_str(),
            );
            span.record("execution_id", execution.execution.execution_id.as_str());
            if !execution.created && execution.execution.status != ExecutionStatus::Queued {
                info!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_execute_idempotent_replay",
                    thread_key = %thread_key,
                    execution_id = %execution.execution.execution_id,
                    status = %execution.execution.status,
                    "returning existing execution"
                );
                return Ok(execution.execution);
            }
            let claim = self
                .store
                .mark_execution_running(&execution.execution.execution_id)
                .await?;
            let execution = claim.execution;
            span.record("centaur.execution_id", execution.execution_id.as_str());
            span.record("execution_id", execution.execution_id.as_str());
            if !claim.claimed {
                // A concurrent request with the same idempotency key claimed
                // the execution first (or it already reached a terminal
                // state). Do not drive it again — return the current row so
                // the caller can attach to the event stream.
                info!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_execute_not_claimed",
                    thread_key = %thread_key,
                    execution_id = %execution.execution_id,
                    status = %execution.status,
                    "execution was already claimed or terminal"
                );
                return Ok(execution);
            }
            let execution_trace_span = info_span!(
                "centaur.api_rs.session.execution",
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_execution",
                "centaur.thread_key" = thread_key.as_str(),
                "centaur.execution_id" = execution.execution_id.as_str(),
                "centaur.sandbox_id" = tracing::field::Empty,
                thread_key = %thread_key,
                execution_id = %execution.execution_id,
                sandbox_id = tracing::field::Empty,
            );
            set_span_parent_trace(
                &execution_trace_span,
                &thread_trace_id(thread_key),
                &thread_trace_parent_span_id(thread_key),
            );
            self.execution_spans
                .lock()
                .await
                .insert(execution.execution_id.clone(), execution_trace_span.clone());
            record_session_execution_started(&harness_label);
            self.store
                .append_event(
                    thread_key,
                    Some(&execution.execution_id),
                    "session.execution_started",
                    json!({
                        "execution_id": execution.execution_id,
                        "thread_key": thread_key.as_str(),
                        "input_line_count": input_line_count,
                        "idle_timeout_ms": idle_timeout_ms,
                        "max_duration_ms": max_duration_ms,
                    }),
                )
                .await?;
            let desired_capabilities = self
                .resolve_sandbox_capabilities(session.iron_control_principal.as_deref())
                .await?;

            if let Some(execution) = self
                .inactive_execution_snapshot(thread_key, &execution.execution_id, None)
                .await?
            {
                return Ok(execution);
            }

            let sandbox_id = match self
                .ensure_session_sandbox(EnsureSessionSandboxInput {
                    thread_key,
                    harness_type: &session.harness_type,
                    persona_id: session.persona_id.as_deref(),
                    existing_sandbox_id: session.sandbox_id.as_deref(),
                    existing_sandbox_capabilities: session.sandbox_capabilities.as_ref(),
                    iron_control_principal: session.iron_control_principal.as_deref(),
                    desired_capabilities: &desired_capabilities,
                    resume_thread_id,
                    session_repos_json: session_repos_json.as_deref(),
                    execution_id: &execution.execution_id,
                    environment: &environment,
                })
                .instrument(execution_trace_span.clone())
                .await
            {
                Ok(sandbox_id) => sandbox_id,
                Err(error) => {
                    self.record_execution_failure(thread_key, &execution.execution_id, &error)
                        .await;
                    return Err(error);
                }
            };
            span.record("centaur.sandbox_id", sandbox_id.as_str());
            span.record("sandbox_id", sandbox_id.as_str());
            execution_trace_span.record("centaur.sandbox_id", sandbox_id.as_str());
            execution_trace_span.record("sandbox_id", sandbox_id.as_str());
            if let Err(error) = self
                .sandbox_runtime
                .manager
                .set_runtime_context(
                    &SandboxId::new(sandbox_id.as_str()),
                    thread_key.as_str(),
                    &execution.execution_id,
                )
                .await
                && !matches!(error, SandboxError::Unsupported { .. })
            {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "sandbox_runtime_context_update_failed",
                    thread_key = %thread_key,
                    execution_id = %execution.execution_id,
                    sandbox_id = %sandbox_id,
                    %error,
                    "failed to publish runtime context to sandbox"
                );
            }

            if let Some(execution) = self
                .inactive_execution_snapshot(thread_key, &execution.execution_id, Some(&sandbox_id))
                .await?
            {
                return Ok(execution);
            }

            let pipe = match self
                .ensure_session_pipe(thread_key, &sandbox_id)
                .instrument(execution_trace_span.clone())
                .await
            {
                Ok(pipe) => pipe,
                Err(error) => {
                    self.record_execution_failure(thread_key, &execution.execution_id, &error)
                        .await;
                    return Err(error);
                }
            };

            if let Some(execution) = self
                .inactive_execution_snapshot(thread_key, &execution.execution_id, Some(&sandbox_id))
                .await?
            {
                return Ok(execution);
            }

            let trace = SessionTraceContext::new(thread_key, Some(&execution_trace_span));
            let input_lines = input_lines_with_session_context(thread_key, &trace, &input_lines);
            if let Err(error) = write_input_lines(
                &pipe,
                &input_lines,
                thread_key,
                &execution.execution_id,
                Some(&sandbox_id),
            )
            .instrument(execution_trace_span.clone())
            .await
            {
                self.record_execution_failure(thread_key, &execution.execution_id, &error)
                    .await;
                return Err(error);
            }

            if let Some(max_duration) = max_duration {
                spawn_max_duration_failure(
                    self.context(),
                    thread_key.clone(),
                    execution.execution_id.clone(),
                    max_duration,
                    idle_timeout,
                );
            }

            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_execute_completed",
                thread_key = %thread_key,
                execution_id = %execution.execution_id,
                sandbox_id = %sandbox_id,
                status = %execution.status,
                completion_reason = "input_accepted",
                "session execution accepted input"
            );
            Ok(execution)
        }
        .instrument(span.clone())
        .await;

        if let Err(error) = &result {
            error!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_execute_failed",
                thread_key = %thread_key,
                input_line_count,
                %error,
                "session execution failed"
            );
        }
        result
    }

    async fn record_execution_failure(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
        error: &SessionRuntimeError,
    ) {
        let error_message = error.to_string();
        let Ok(Some(execution)) = self
            .store
            .fail_execution_if_active(execution_id, &error_message)
            .await
        else {
            self.execution_spans.lock().await.remove(execution_id);
            return;
        };

        self.execution_spans.lock().await.remove(execution_id);
        let _ = self
            .store
            .append_event(
                thread_key,
                Some(execution_id),
                "session.execution_failed",
                json!({
                    "execution_id": execution_id,
                    "thread_key": thread_key.as_str(),
                    "error": error_message,
                }),
            )
            .await;
        record_finished_execution_metric(
            &self.store,
            thread_key,
            &execution,
            "failed",
            Some(runtime_error_failure_class(error)),
        )
        .await;
    }

    async fn inactive_execution_snapshot(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
        sandbox_id: Option<&str>,
    ) -> Result<Option<SessionExecution>, SessionRuntimeError> {
        match self.store.active_execution_for_thread(thread_key).await? {
            Some(active) if active.execution_id == execution_id => Ok(None),
            active => {
                if active.is_none()
                    && let Some(sandbox_id) = sandbox_id
                {
                    self.stop_inactive_setup_sandbox(thread_key, sandbox_id)
                        .await?;
                }
                self.execution_spans.lock().await.remove(execution_id);
                Ok(Some(self.store.get_execution(execution_id).await?))
            }
        }
    }

    async fn stop_inactive_setup_sandbox(
        &self,
        thread_key: &ThreadKey,
        sandbox_id: &str,
    ) -> Result<(), SessionRuntimeError> {
        self.sandbox_pipes.remove(sandbox_id);
        match self
            .sandbox_runtime
            .manager
            .stop(&SandboxId::new(sandbox_id))
            .await
        {
            Ok(()) | Err(SandboxError::NotFound(_)) => {
                let session = self.store.get_session(thread_key).await?;
                if session.sandbox_id.as_deref() == Some(sandbox_id) {
                    self.store.update_sandbox_id(thread_key, None).await?;
                }
                Ok(())
            }
            Err(error) => Err(SessionRuntimeError::Sandbox(error)),
        }
    }

    /// Interrupt the active turn of a session without tearing down the sandbox.
    /// Delivers an `interrupt` frame down the live stdin pipe (the same channel
    /// steering uses); the harness aborts the turn and the session stays warm
    /// and steerable. The resulting `interrupted` terminal is recorded as a
    /// clean user-stop rather than a failure (see `record_terminal_output`).
    pub async fn interrupt_active_turn(
        &self,
        thread_key: &ThreadKey,
    ) -> Result<InterruptTurnOutcome, SessionRuntimeError> {
        let Some(execution) = self.store.active_execution_for_thread(thread_key).await? else {
            // No active turn — nothing to interrupt.
            return Ok(InterruptTurnOutcome::default());
        };

        // Mark BEFORE delivery so the terminal recorder maps the interrupted
        // turn to a clean stop even if the harness aborts and finishes before
        // this call returns.
        self.user_interrupts
            .insert(execution.execution_id.clone(), ());

        let pipe = match self
            .wait_for_active_steering_pipe(thread_key, &execution.execution_id)
            .await
        {
            Ok(pipe) => pipe,
            Err(error) => {
                self.user_interrupts.remove(&execution.execution_id);
                return Ok(InterruptTurnOutcome {
                    interrupted: false,
                    execution_id: Some(execution.execution_id),
                    error: Some(error),
                });
            }
        };

        if let Err(error) =
            write_interrupt_frame(&pipe, thread_key, &execution.execution_id).await
        {
            self.user_interrupts.remove(&execution.execution_id);
            return Ok(InterruptTurnOutcome {
                interrupted: false,
                execution_id: Some(execution.execution_id),
                error: Some(error.to_string()),
            });
        }

        if let Err(error) = self
            .store
            .append_event(
                thread_key,
                Some(&execution.execution_id),
                "session.turn_interrupt_delivered",
                json!({
                    "execution_id": execution.execution_id,
                    "thread_key": thread_key.as_str(),
                }),
            )
            .await
        {
            warn!(%thread_key, %error, "failed to record turn interrupt delivery");
        }

        Ok(InterruptTurnOutcome {
            interrupted: true,
            execution_id: Some(execution.execution_id),
            error: None,
        })
    }

    async fn forward_messages_to_active_execution(
        &self,
        thread_key: &ThreadKey,
        messages: &[SessionMessageInput],
        message_ids: &[String],
    ) {
        let input_lines = steering_input_lines(thread_key, messages, message_ids);
        if input_lines.is_empty() {
            return;
        }

        let Some(execution) = (match self.store.active_execution_for_thread(thread_key).await {
            Ok(execution) => execution,
            Err(error) => {
                warn!(%thread_key, %error, "active execution lookup failed during message append");
                return;
            }
        }) else {
            return;
        };

        // Steering joins the active execution's trace so harness spans for the
        // steered turn stay in the same tree.
        let execution_span = self
            .execution_spans
            .lock()
            .await
            .get(&execution.execution_id)
            .cloned();
        let trace = SessionTraceContext::new(thread_key, execution_span.as_ref());
        let input_lines = input_lines_with_session_context(thread_key, &trace, &input_lines);

        let pipe = match self
            .wait_for_active_steering_pipe(thread_key, &execution.execution_id)
            .await
        {
            Ok(pipe) => pipe,
            Err(error) => {
                self.record_steering_failure(thread_key, &execution.execution_id, error)
                    .await;
                return;
            }
        };

        if let Err(error) = write_input_lines(
            &pipe,
            &input_lines,
            thread_key,
            &execution.execution_id,
            None,
        )
        .await
        {
            self.record_steering_failure(thread_key, &execution.execution_id, error.to_string())
                .await;
            return;
        }

        if let Err(error) = self
            .store
            .append_event(
                thread_key,
                Some(&execution.execution_id),
                "session.steering_delivered",
                json!({
                    "execution_id": execution.execution_id,
                    "thread_key": thread_key.as_str(),
                    "message_ids": message_ids,
                    "input_line_count": input_lines.len(),
                }),
            )
            .await
        {
            warn!(%thread_key, %error, "failed to record steering delivery");
        }
    }

    async fn wait_for_active_steering_pipe(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
    ) -> Result<SessionPipe, String> {
        let deadline = Instant::now() + STEERING_STARTUP_RETRY_TIMEOUT;
        loop {
            let session = self
                .store
                .get_session(thread_key)
                .await
                .map_err(|error| format!("get session: {error}"))?;

            if let Some(sandbox_id) = session.sandbox_id.as_deref() {
                match self.ensure_session_pipe(thread_key, sandbox_id).await {
                    Ok(pipe) => return Ok(pipe),
                    Err(error)
                        if is_transient_steering_startup_error(&error)
                            && Instant::now() < deadline => {}
                    Err(error) => return Err(error.to_string()),
                }
            } else if Instant::now() >= deadline {
                return Err("session has no sandbox assigned".to_owned());
            }

            if !execution_still_active(&self.store, thread_key, execution_id).await {
                return Err("execution is no longer active".to_owned());
            }
            sleep(STEERING_STARTUP_RETRY_INTERVAL).await;
        }
    }

    async fn record_steering_failure(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
        error: String,
    ) {
        warn!(%thread_key, %execution_id, %error, "active steering delivery failed");
        let _ = self
            .store
            .append_event(
                thread_key,
                Some(execution_id),
                "session.steering_failed",
                json!({
                    "execution_id": execution_id,
                    "thread_key": thread_key.as_str(),
                    "error": error,
                }),
            )
            .await;
    }

    pub async fn stream_events(
        &self,
        thread_key: &ThreadKey,
        after_event_id: i64,
        execution_id: Option<&str>,
    ) -> Result<
        impl Stream<Item = Result<SessionEvent, SessionRuntimeError>> + use<>,
        SessionRuntimeError,
    > {
        let span = info_span!(
            "centaur.api_rs.session.events.stream",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_events_stream",
            "centaur.thread_key" = thread_key.as_str(),
            thread_key = %thread_key,
            after_event_id,
            execution_id = execution_id.unwrap_or(""),
        );
        let result = async {
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_events_stream_started",
                thread_key = %thread_key,
                after_event_id,
                execution_id = execution_id.unwrap_or(""),
                "opening session event stream"
            );
            let session = self.store.get_session(thread_key).await?;
            if let Some(sandbox_id) = session.sandbox_id.as_deref() {
                self.ensure_session_pipe_if_live(thread_key, sandbox_id)
                    .await?;
            }

            let listener = self.store.listen_session_events().await?;

            Ok(session_event_stream(
                self.store.clone(),
                thread_key.clone(),
                after_event_id,
                execution_id.map(ToOwned::to_owned),
                listener,
                span.clone(),
            ))
        }
        .instrument(span.clone())
        .await;

        if let Err(error) = &result {
            error!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_events_stream_failed",
                thread_key = %thread_key,
                after_event_id,
                %error,
                "failed to open session event stream"
            );
        }
        result
    }

    pub async fn execution_thread_key(
        &self,
        execution_id: &str,
    ) -> Result<ThreadKey, SessionRuntimeError> {
        self.store
            .execution_thread_key(execution_id)
            .await
            .map_err(Into::into)
    }

    async fn ensure_session_sandbox(
        &self,
        input: EnsureSessionSandboxInput<'_>,
    ) -> Result<String, SessionRuntimeError> {
        let EnsureSessionSandboxInput {
            thread_key,
            harness_type,
            persona_id,
            existing_sandbox_id,
            existing_sandbox_capabilities,
            iron_control_principal,
            desired_capabilities,
            resume_thread_id,
            session_repos_json,
            execution_id,
            environment,
        } = input;
        let span = info_span!(
            "centaur.api_rs.sandbox.ensure",
            component = COMPONENT_SESSION_RUNTIME,
            event = "sandbox_ensure",
            "centaur.thread_key" = thread_key.as_str(),
            "centaur.execution_id" = execution_id,
            "centaur.sandbox_id" = tracing::field::Empty,
            thread_key = %thread_key,
            execution_id,
            sandbox_id = tracing::field::Empty,
            existing_sandbox_id = existing_sandbox_id.unwrap_or(""),
            iron_control_principal_present = iron_control_principal.is_some(),
            persona_id = persona_id.unwrap_or(""),
            sandbox_repo_cache_enabled = desired_capabilities.repo_cache_enabled,
            sandbox_observability_enabled = desired_capabilities.observability_enabled,
        );
        let ensure_started = Instant::now();
        let result = async {
            let persona_context = self.resolve_stored_persona(persona_id, harness_type)?;
            if let Some(sandbox_id) = existing_sandbox_id {
                let id = SandboxId::new(sandbox_id);
                if !sandbox_capabilities_match(existing_sandbox_capabilities, desired_capabilities)
                {
                    self.sandbox_pipes.remove(sandbox_id);
                    match self.sandbox_runtime.manager.stop(&id).await {
                        Ok(()) | Err(SandboxError::NotFound(_)) => {}
                        Err(error) => return Err(SessionRuntimeError::Sandbox(error)),
                    }
                    self.store.update_sandbox_id(thread_key, None).await?;
                    self.store
                        .append_event(
                            thread_key,
                            Some(execution_id),
                            "session.sandbox_capabilities_replaced",
                            json!({
                                "execution_id": execution_id,
                                "thread_key": thread_key.as_str(),
                                "sandbox_id": sandbox_id,
                                "previous_capabilities": existing_sandbox_capabilities,
                                "desired_capabilities": desired_capabilities,
                            }),
                        )
                        .await?;
                    info!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "sandbox_ensure_capabilities_replaced",
                        thread_key = %thread_key,
                        execution_id,
                        sandbox_id,
                        sandbox_repo_cache_enabled = desired_capabilities.repo_cache_enabled,
                        sandbox_observability_enabled = desired_capabilities.observability_enabled,
                        "replacing existing sandbox whose capabilities do not match"
                    );
                } else {
                    match self.sandbox_runtime.manager.status(&id).await {
                    Ok(status) => match existing_sandbox_action(&status) {
                        ExistingSandboxAction::Reuse => {
                            if let Some(principal_id) = iron_control_principal {
                                self.sandbox_runtime
                                    .manager
                                    .ensure_iron_control_proxy_resources(&id, principal_id)
                                    .await?;
                            }
                            span.record("centaur.sandbox_id", sandbox_id);
                            span.record("sandbox_id", sandbox_id);
                            let ready_duration = ensure_started.elapsed();
                            self.record_sandbox_ready(SandboxReadyObservation {
                                thread_key,
                                execution_id,
                                sandbox_id,
                                harness_type,
                                source: "reused",
                                ready_duration,
                                startup_duration: None,
                            })
                            .await;
                            info!(
                                component = COMPONENT_SESSION_RUNTIME,
                                event = "sandbox_ensure_reused",
                                thread_key = %thread_key,
                                execution_id,
                                sandbox_id,
                                harness_type = %harness_type,
                                sandbox_ready_source = "reused",
                                sandbox_ready_duration_ms = duration_millis_u64(ready_duration),
                                "reusing existing session sandbox"
                            );
                            return Ok(sandbox_id.to_owned());
                        }
                        ExistingSandboxAction::ResumeOrReplace => {
                            self.sandbox_pipes.remove(sandbox_id);
                            if resume_thread_id.is_some() {
                                info!(
                                    component = COMPONENT_SESSION_RUNTIME,
                                    event = "sandbox_ensure_replacing_for_resume_restore",
                                    thread_key = %thread_key,
                                    execution_id,
                                    sandbox_id,
                                    harness_type = %harness_type,
                                    "replacing existing sandbox so transcript restore env is present"
                                );
                                if let Err(error) = self.sandbox_runtime.manager.stop(&id).await {
                                    warn!(
                                        component = COMPONENT_SESSION_RUNTIME,
                                        event = "sandbox_ensure_resume_replace_stop_failed",
                                        %thread_key,
                                        %execution_id,
                                        %sandbox_id,
                                        %error,
                                        "failed to stop sandbox before resume-target replacement"
                                    );
                                }
                            } else {
                                match self.sandbox_runtime.manager.resume(&id).await {
                                    Ok(()) => {
                                        span.record("centaur.sandbox_id", sandbox_id);
                                        span.record("sandbox_id", sandbox_id);
                                        let ready_duration = ensure_started.elapsed();
                                        self.store
                                            .append_event(
                                                thread_key,
                                                Some(execution_id),
                                                "session.sandbox_resumed",
                                                json!({
                                                    "execution_id": execution_id,
                                                    "thread_key": thread_key.as_str(),
                                                    "sandbox_id": sandbox_id,
                                                }),
                                            )
                                            .await?;
                                        self.record_sandbox_ready(SandboxReadyObservation {
                                            thread_key,
                                            execution_id,
                                            sandbox_id,
                                            harness_type,
                                            source: "resumed",
                                            ready_duration,
                                            startup_duration: None,
                                        })
                                        .await;
                                        info!(
                                            component = COMPONENT_SESSION_RUNTIME,
                                            event = "sandbox_ensure_resumed",
                                            thread_key = %thread_key,
                                            execution_id,
                                            sandbox_id,
                                            harness_type = %harness_type,
                                            sandbox_ready_source = "resumed",
                                            sandbox_ready_duration_ms = duration_millis_u64(ready_duration),
                                            "resumed existing session sandbox"
                                        );
                                        return Ok(sandbox_id.to_owned());
                                    }
                                    Err(error) => {
                                        warn!(
                                            component = COMPONENT_SESSION_RUNTIME,
                                            event = "sandbox_ensure_resume_failed",
                                            %thread_key,
                                            %execution_id,
                                            %sandbox_id,
                                            %error,
                                            "replacing sandbox after resume failed"
                                        );
                                        self.store
                                            .append_event(
                                                thread_key,
                                                Some(execution_id),
                                                "session.sandbox_resume_failed",
                                                json!({
                                                    "execution_id": execution_id,
                                                    "thread_key": thread_key.as_str(),
                                                    "sandbox_id": sandbox_id,
                                                    "error": error.to_string(),
                                                }),
                                            )
                                            .await?;
                                    }
                                }
                            }
                        }
                        ExistingSandboxAction::Replace => {
                            info!(
                                component = COMPONENT_SESSION_RUNTIME,
                                event = "sandbox_ensure_replacing",
                                thread_key = %thread_key,
                                execution_id,
                                sandbox_id,
                                status = ?status,
                                "existing sandbox is not reusable"
                            );
                        }
                    },
                    Err(SandboxError::NotFound(_)) => {
                        info!(
                            component = COMPONENT_SESSION_RUNTIME,
                            event = "sandbox_ensure_missing",
                            thread_key = %thread_key,
                            execution_id,
                            sandbox_id,
                            "existing sandbox is missing"
                        );
                    }
                    Err(error) => return Err(SessionRuntimeError::Sandbox(error)),
                }
                }
            }

            // Warm sandboxes are pre-booted with the workload's default
            // harness; a session on any other harness needs a cold sandbox.
            let warm_harness_matches = self
                .sandbox_runtime
                .warm_harness
                .as_ref()
                .is_none_or(|warm| warm == harness_type);
            let warm_persona_matches = persona_context.is_none();
            if !warm_harness_matches && self.warm_pool.is_some() {
                record_sandbox_warm_pool_claim("harness_mismatch");
            }
            if !warm_persona_matches && self.warm_pool.is_some() {
                record_sandbox_warm_pool_claim("persona_specific");
            }
            if !desired_capabilities.is_default_enabled() && self.warm_pool.is_some() {
                record_sandbox_warm_pool_claim("capabilities_non_default");
            }
            let mut spec = (self.sandbox_runtime.spec_factory)(
                thread_key,
                execution_id,
                harness_type,
                persona_context.as_ref(),
            );
            let composed_repos_json =
                compose_spec_repos_json(&mut spec, session_repos_json, iron_control_principal)?;
            let composed_repos_key = composed_repos_json
                .as_deref()
                .and_then(canonical_repos_json);
            let warm_default_repos_match = composed_repos_key.is_some()
                && composed_repos_key == self.sandbox_runtime.warm_repos_json;
            let warm_default_repos_mismatch = self.sandbox_runtime.warm_repos_json.is_some()
                && composed_repos_key != self.sandbox_runtime.warm_repos_json;
            if warm_default_repos_mismatch && self.warm_pool.is_some() {
                record_sandbox_warm_pool_claim("default_repos_mismatch");
            }
            let needs_claimed_overlay_home =
                composed_repos_json.is_some() && !warm_default_repos_match;
            let needs_claimed_overlay_prepare =
                needs_claimed_overlay_home || warm_default_repos_match;
            let has_private_repos = composed_repos_json
                .as_deref()
                .is_some_and(repos_json_contains_private_repo);
            let claimed_overlay_supported = !needs_claimed_overlay_prepare
                || self
                    .sandbox_runtime
                    .manager
                    .supports_claimed_overlay_home();
            if let Some(warm_pool) = self
                .warm_pool
                .as_ref()
                .filter(|_| {
                    warm_harness_matches
                        && warm_persona_matches
                        && environment.is_empty()
                        && resume_thread_id.is_none()
                        && desired_capabilities.is_default_enabled()
                        && claimed_overlay_supported
                        && !has_private_repos
                        && !warm_default_repos_mismatch
                })
            {
                match warm_pool.claim(thread_key.as_str()).await {
                    Ok(Some(claimed)) => {
                        let sandbox_id = claimed.sandbox_id;
                        let workload_key = claimed.workload_key;
                        let id = SandboxId::new(sandbox_id.as_str());
                        if let Some(repos_json) = composed_repos_json.as_deref()
                            && needs_claimed_overlay_prepare
                        {
                            let proxy_future = self.assign_claimed_warm_proxy(
                                &id,
                                thread_key,
                                execution_id,
                                iron_control_principal,
                            );
                            let prepare_future = async {
                                let prepare_started = Instant::now();
                                let result = self
                                    .sandbox_runtime
                                    .manager
                                    .prepare_claimed_overlay_home(
                                        &id,
                                        PrepareClaimedOverlayHome {
                                            thread_key: thread_key.as_str(),
                                            execution_id,
                                            repos_json,
                                            precomposed: warm_default_repos_match,
                                            harness: Some(harness_server_subcommand(harness_type)),
                                            harness_thread_id: resume_thread_id,
                                            harness_home: harness_home_for_spec(harness_type),
                                        },
                                    )
                                    .await;
                                (result, prepare_started.elapsed())
                            };
                            let (proxy_result, (prepare_result, prepare_duration)) =
                                tokio::join!(proxy_future, prepare_future);
                            match proxy_result {
                                Ok(()) => {}
                                Err(error) => {
                                    let error_text = error.to_string();
                                    record_sandbox_warm_pool_claim("proxy_assign_error");
                                    self.retire_claimed_warm_sandbox(
                                        thread_key,
                                        execution_id,
                                        &sandbox_id,
                                        &id,
                                        &error_text,
                                        "proxy assignment failed",
                                    )
                                    .await;
                                    self.store
                                        .append_event(
                                            thread_key,
                                            Some(execution_id),
                                            "session.warm_sandbox_proxy_assign_failed",
                                            json!({
                                                "execution_id": execution_id,
                                                "thread_key": thread_key.as_str(),
                                                "sandbox_id": sandbox_id.as_str(),
                                                "error": error_text,
                                            }),
                                        )
                                        .await?;
                                    return Err(SessionRuntimeError::Sandbox(error));
                                }
                            };
                            if let Err(error) = prepare_result {
                                record_sandbox_warm_pool_claim("post_claim_bind_error");
                                let error_text = error.to_string();
                                warn!(
                                    component = COMPONENT_SESSION_RUNTIME,
                                    event = "sandbox_ensure_warm_post_claim_bind_failed",
                                    thread_key = %thread_key,
                                    execution_id,
                                    sandbox_id = %sandbox_id,
                                    post_claim_overlay_prepare_duration_ms = duration_millis_u64(prepare_duration),
                                    precomposed_overlay_home = warm_default_repos_match,
                                    error = %error_text,
                                    "retiring claimed warm sandbox after post-claim overlay preparation failed"
                                );
                                self.retire_claimed_warm_sandbox(
                                    thread_key,
                                    execution_id,
                                    &sandbox_id,
                                    &id,
                                    &error_text,
                                    "post-claim overlay preparation failed",
                                )
                                .await;
                                self.store
                                    .append_event(
                                        thread_key,
                                        Some(execution_id),
                                        "session.warm_sandbox_post_claim_bind_failed",
                                        json!({
                                            "execution_id": execution_id,
                                            "thread_key": thread_key.as_str(),
                                            "sandbox_id": sandbox_id.as_str(),
                                            "error": error_text,
                                            "fallback": "cold_create",
                                        }),
                                    )
                                    .await?;
                                // Fall through to cold creation below. The cold
                                // path uses the same composed repo JSON.
                            } else {
                                info!(
                                    component = COMPONENT_SESSION_RUNTIME,
                                    event = "sandbox_ensure_warm_post_claim_bind_completed",
                                    thread_key = %thread_key,
                                    execution_id,
                                    sandbox_id = %sandbox_id,
                                    post_claim_overlay_prepare_duration_ms = duration_millis_u64(prepare_duration),
                                    precomposed_overlay_home = warm_default_repos_match,
                                    "prepared claimed warm sandbox overlay home"
                                );
                                record_sandbox_warm_pool_claim("hit");
                                span.record("centaur.sandbox_id", sandbox_id.as_str());
                                span.record("sandbox_id", sandbox_id.as_str());
                                let ready_duration = ensure_started.elapsed();
                                self.record_claimed_warm_sandbox(ClaimedWarmSandboxObservation {
                                    thread_key,
                                    execution_id,
                                    sandbox_id: sandbox_id.as_str(),
                                    harness_type,
                                    workload_key: workload_key.as_str(),
                                    iron_control_principal,
                                    desired_capabilities,
                                    ready_duration,
                                    post_claim_overlay_home: needs_claimed_overlay_home,
                                })
                                .await?;
                                return Ok(sandbox_id);
                            }
                        } else {
                            if let Err(error) = self
                                .assign_claimed_warm_proxy(
                                    &id,
                                    thread_key,
                                    execution_id,
                                    iron_control_principal,
                                )
                                .await
                            {
                                let error_text = error.to_string();
                                record_sandbox_warm_pool_claim("proxy_assign_error");
                                self.retire_claimed_warm_sandbox(
                                    thread_key,
                                    execution_id,
                                    &sandbox_id,
                                    &id,
                                    &error_text,
                                    "proxy assignment failed",
                                )
                                .await;
                                self.store
                                    .append_event(
                                        thread_key,
                                        Some(execution_id),
                                        "session.warm_sandbox_proxy_assign_failed",
                                        json!({
                                            "execution_id": execution_id,
                                            "thread_key": thread_key.as_str(),
                                            "sandbox_id": sandbox_id.as_str(),
                                            "error": error_text,
                                        }),
                                    )
                                    .await?;
                                return Err(SessionRuntimeError::Sandbox(error));
                            }
                            record_sandbox_warm_pool_claim("hit");
                            span.record("centaur.sandbox_id", sandbox_id.as_str());
                            span.record("sandbox_id", sandbox_id.as_str());
                            let ready_duration = ensure_started.elapsed();
                            self.record_claimed_warm_sandbox(ClaimedWarmSandboxObservation {
                                thread_key,
                                execution_id,
                                sandbox_id: sandbox_id.as_str(),
                                harness_type,
                                workload_key: workload_key.as_str(),
                                iron_control_principal,
                                desired_capabilities,
                                ready_duration,
                                post_claim_overlay_home: false,
                            })
                            .await?;
                            return Ok(sandbox_id);
                        }
                    }
                    Ok(None) => record_sandbox_warm_pool_claim("miss"),
                    Err(error) => {
                        record_sandbox_warm_pool_claim("error");
                        return Err(SessionRuntimeError::WarmPool(error));
                    }
                }
            }

            if let Some(repos_json) = composed_repos_json {
                spec = spec.env(AGENT_REPOS_JSON_ENV, repos_json);
            }
            for (name, value) in environment {
                spec = spec.env(name.clone(), value.clone());
            }
            spec = apply_resume_thread_env(spec, harness_type, resume_thread_id);
            if let Some(principal) = iron_control_principal {
                spec.iron_control_principal = Some(principal.to_owned());
            }
            apply_sandbox_capabilities(&mut spec, desired_capabilities);
            let create_started = Instant::now();
            let handle = self.sandbox_runtime.manager.create_running(spec).await?;
            let startup_duration = create_started.elapsed();
            let ready_duration = ensure_started.elapsed();
            span.record("centaur.sandbox_id", handle.id.as_str());
            span.record("sandbox_id", handle.id.as_str());
            self.store
                .update_sandbox_assignment(thread_key, handle.id.as_str(), desired_capabilities)
                .await?;
            self.record_sandbox_ready(SandboxReadyObservation {
                thread_key,
                execution_id,
                sandbox_id: handle.id.as_str(),
                harness_type,
                source: "cold_create",
                ready_duration,
                startup_duration: Some(startup_duration),
            })
            .await;
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "sandbox_ensure_created",
                thread_key = %thread_key,
                execution_id,
                sandbox_id = %handle.id.as_str(),
                harness_type = %harness_type,
                sandbox_ready_source = "cold_create",
                sandbox_ready_duration_ms = duration_millis_u64(ready_duration),
                sandbox_startup_duration_ms = duration_millis_u64(startup_duration),
                sandbox_startup_duration_seconds = startup_duration.as_secs_f64(),
                "created new session sandbox"
            );
            Ok(handle.id.into_string())
        }
        .instrument(span.clone())
        .await;

        if let Err(error) = &result {
            error!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "sandbox_ensure_failed",
                thread_key = %thread_key,
                execution_id,
                %error,
                "failed to ensure session sandbox"
            );
        }
        result
    }

    async fn record_claimed_warm_sandbox(
        &self,
        observation: ClaimedWarmSandboxObservation<'_>,
    ) -> Result<(), SessionRuntimeError> {
        let ClaimedWarmSandboxObservation {
            thread_key,
            execution_id,
            sandbox_id,
            harness_type,
            workload_key,
            iron_control_principal,
            desired_capabilities,
            ready_duration,
            post_claim_overlay_home,
        } = observation;
        self.store
            .update_sandbox_assignment(thread_key, sandbox_id, desired_capabilities)
            .await?;
        self.store
            .append_event(
                thread_key,
                None,
                "session.warm_sandbox_claimed",
                json!({
                    "sandbox_id": sandbox_id,
                    "workload_key": workload_key,
                    "iron_control_principal": iron_control_principal,
                    "sandbox_capabilities": desired_capabilities,
                    "post_claim_overlay_home": post_claim_overlay_home,
                }),
            )
            .await?;
        self.record_sandbox_ready(SandboxReadyObservation {
            thread_key,
            execution_id,
            sandbox_id,
            harness_type,
            source: "warm_pool",
            ready_duration,
            startup_duration: None,
        })
        .await;
        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "sandbox_ensure_warm_claimed",
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
            harness_type = %harness_type,
            sandbox_ready_source = "warm_pool",
            sandbox_ready_duration_ms = duration_millis_u64(ready_duration),
            workload_key,
            post_claim_overlay_home,
            "claimed warm session sandbox"
        );
        Ok(())
    }

    async fn assign_claimed_warm_proxy(
        &self,
        id: &SandboxId,
        thread_key: &ThreadKey,
        execution_id: &str,
        iron_control_principal: Option<&str>,
    ) -> Result<(), SandboxError> {
        let Some(principal_id) = iron_control_principal else {
            return Ok(());
        };
        match self
            .sandbox_runtime
            .manager
            .assign_iron_control_proxy_principal(id, principal_id)
            .await
        {
            Ok(()) => {
                info!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "sandbox_ensure_warm_proxy_assign_completed",
                    thread_key = %thread_key,
                    execution_id,
                    sandbox_id = %id.as_str(),
                    principal_id,
                    "assigned claimed warm sandbox proxy principal"
                );
                Ok(())
            }
            Err(error) => {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "sandbox_ensure_warm_proxy_assign_failed",
                    thread_key = %thread_key,
                    execution_id,
                    sandbox_id = %id.as_str(),
                    principal_id,
                    %error,
                    "failed to assign claimed warm sandbox proxy principal"
                );
                Err(error)
            }
        }
    }

    async fn retire_claimed_warm_sandbox(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
        sandbox_id: &str,
        id: &SandboxId,
        error_text: &str,
        reason: &'static str,
    ) {
        if let Err(mark_error) = self
            .store
            .mark_warm_sandbox_failed(sandbox_id, error_text)
            .await
        {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "sandbox_ensure_warm_mark_failed_error",
                thread_key = %thread_key,
                execution_id,
                sandbox_id,
                reason,
                error = %mark_error,
                "failed to mark claimed warm sandbox failed"
            );
        }
        if let Err(stop_error) = self.sandbox_runtime.manager.stop(id).await {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "sandbox_ensure_warm_retire_stop_failed",
                thread_key = %thread_key,
                execution_id,
                sandbox_id,
                reason,
                error = %stop_error,
                "failed to stop claimed warm sandbox after claim failure"
            );
        }
    }

    async fn resolve_sandbox_capabilities(
        &self,
        iron_control_principal: Option<&str>,
    ) -> Result<SessionSandboxCapabilities, SessionRuntimeError> {
        let Some(principal_id) = iron_control_principal else {
            return Ok(SessionSandboxCapabilities::default_enabled());
        };
        let Some(registrar) = &self.iron_control else {
            return Ok(SessionSandboxCapabilities::default_enabled());
        };
        let principal = registrar.get_principal(principal_id).await?;
        Ok(SessionSandboxCapabilities {
            repo_cache_enabled: principal.sandbox_repo_cache_enabled,
            observability_enabled: principal.sandbox_observability_enabled,
        })
    }

    async fn record_sandbox_ready(&self, observation: SandboxReadyObservation<'_>) {
        let SandboxReadyObservation {
            thread_key,
            execution_id,
            sandbox_id,
            harness_type,
            source,
            ready_duration,
            startup_duration,
        } = observation;
        let ready_duration_ms = duration_millis_u64(ready_duration);
        let startup_duration_ms = startup_duration.map(duration_millis_u64).unwrap_or(0);
        let sandbox_started_for_request = startup_duration.is_some();

        if let Err(error) = self
            .store
            .append_event(
                thread_key,
                Some(execution_id),
                "session.sandbox_ready",
                json!({
                    "execution_id": execution_id,
                    "thread_key": thread_key.as_str(),
                    "sandbox_id": sandbox_id,
                    "harness_type": harness_type.to_string(),
                    "sandbox_ready_source": source,
                    "sandbox_ready_duration_ms": ready_duration_ms,
                    "sandbox_startup_duration_ms": startup_duration_ms,
                    "sandbox_started_for_request": sandbox_started_for_request,
                }),
            )
            .await
        {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "sandbox_ready_event_append_failed",
                thread_key = %thread_key,
                execution_id,
                sandbox_id,
                %error,
                "failed to append sandbox ready event"
            );
        }

        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "sandbox_ready",
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
            harness_type = %harness_type,
            sandbox_ready_source = source,
            sandbox_ready_duration_ms = ready_duration_ms,
            sandbox_startup_duration_ms = startup_duration_ms,
            sandbox_started_for_request,
            "session sandbox ready"
        );
    }

    async fn ensure_session_pipe_if_live(
        &self,
        thread_key: &ThreadKey,
        sandbox_id: &str,
    ) -> Result<(), SessionRuntimeError> {
        let id = SandboxId::new(sandbox_id);
        match self.sandbox_runtime.manager.status(&id).await {
            Ok(status) if should_attach_session_pipe(&status) => {
                if let Err(error) = self.ensure_session_pipe(thread_key, sandbox_id).await
                    && !is_event_stream_attach_race(&error)
                {
                    return Err(error);
                }
            }
            Ok(_) => {}
            Err(SandboxError::NotFound(_)) => {}
            Err(error) => return Err(SessionRuntimeError::Sandbox(error)),
        }
        Ok(())
    }

    async fn ensure_session_pipe(
        &self,
        thread_key: &ThreadKey,
        sandbox_id: &str,
    ) -> Result<SessionPipe, SessionRuntimeError> {
        let span = info_span!(
            "centaur.api_rs.session.pipe.ensure",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_pipe_ensure",
            "centaur.thread_key" = thread_key.as_str(),
            "centaur.sandbox_id" = sandbox_id,
            thread_key = %thread_key,
            sandbox_id,
        );
        let result = async {
            if let Some(pipe) = self
                .sandbox_pipes
                .get(sandbox_id)
                .map(|entry| entry.clone())
            {
                info!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_pipe_reused",
                    thread_key = %thread_key,
                    sandbox_id,
                    "reusing session pipe"
                );
                return Ok(pipe);
            }

            let open_lock = {
                let entry = self
                    .sandbox_pipe_open_locks
                    .entry(sandbox_id.to_owned())
                    .or_insert_with(|| Arc::new(Mutex::new(())));
                entry.clone()
            };
            let _open_guard = open_lock.lock().await;

            if let Some(pipe) = self
                .sandbox_pipes
                .get(sandbox_id)
                .map(|entry| entry.clone())
            {
                info!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_pipe_reused",
                    thread_key = %thread_key,
                    sandbox_id,
                    "reusing session pipe"
                );
                return Ok(pipe);
            }

            let io = self
                .sandbox_runtime
                .manager
                .open_io(&SandboxId::new(sandbox_id))
                .await?
                .into_parts();
            let pipe = session_pipe_from_stdin(io.stdin);

            self.sandbox_pipes
                .insert(sandbox_id.to_owned(), pipe.clone());
            drop(_open_guard);
            let ctx = self.context();
            let thread_key = thread_key.clone();
            let pump_thread_key = thread_key.clone();
            let pump_key = sandbox_id.to_owned();
            let pump_pipe = pipe.clone();
            let stdout = io.stdout;
            let stderr = io.stderr;
            let guard = io.guard;
            let stderr_key = pump_key.clone();

            spawn_stdout_pump_loop(StdoutPumpLoop {
                ctx,
                open_lock,
                thread_key: pump_thread_key,
                sandbox_id: pump_key,
                pipe: pump_pipe,
                stdout,
                guard,
            });

            spawn_stderr_drain(stderr_key, stderr);

            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_pipe_opened",
                thread_key = %thread_key,
                sandbox_id,
                "session pipe opened"
            );
            Ok(pipe)
        }
        .instrument(span.clone())
        .await;

        if let Err(error) = &result {
            error!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_pipe_ensure_failed",
                thread_key = %thread_key,
                sandbox_id,
                %error,
                "failed to ensure session pipe"
            );
        }
        result
    }

    /// Reconciles executions left `queued`/`running` by a previous control
    /// plane process. Execution rows never time out on their own: the only
    /// writer of a terminal status is the process that was watching the
    /// sandbox, so a kill mid-turn leaves the row active forever, wedging the
    /// thread (the one-active-execution index blocks new executes) and any
    /// event-stream consumer waiting for a terminal event.
    ///
    /// Adoption order of preference:
    /// 1. The sandbox already finished the turn while nobody was attached:
    ///    recover the terminal outcome from the backend's recorded output.
    /// 2. The sandbox is still running the turn: re-attach the stdout pump
    ///    and re-arm the remaining max-duration deadline.
    /// 3. The sandbox is gone: record the failure honestly.
    pub async fn adopt_orphaned_executions(&self) {
        let executions = match self.store.list_active_executions().await {
            Ok(executions) => executions,
            Err(error) => {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "execution_adoption_scan_failed",
                    %error,
                    "failed to list orphaned executions"
                );
                return;
            }
        };
        if executions.is_empty() {
            return;
        }
        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "execution_adoption_scan",
            orphan_count = executions.len(),
            "adopting executions orphaned by a previous control plane process"
        );
        for execution in executions {
            if let Err(error) = self.adopt_orphaned_execution(&execution).await {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "execution_adoption_failed",
                    thread_key = %execution.thread_key,
                    execution_id = %execution.execution_id,
                    %error,
                    "failed to adopt orphaned execution; will retry on next startup"
                );
            }
        }
    }

    async fn adopt_orphaned_execution(
        &self,
        execution: &SessionExecution,
    ) -> Result<(), SessionRuntimeError> {
        let thread_key = &execution.thread_key;
        let execution_id = execution.execution_id.as_str();
        if execution.status == ExecutionStatus::Queued {
            // Input is only written after an execution is marked running, so
            // a queued orphan never reached the harness: nothing can come.
            self.fail_orphaned_execution(
                thread_key,
                execution_id,
                "",
                "orphaned before input was sent",
                None,
            )
            .await;
            return Ok(());
        }
        let session = self.store.get_session(thread_key).await?;
        let Some(sandbox_id) = session.sandbox_id.as_deref() else {
            self.fail_orphaned_execution(
                thread_key,
                execution_id,
                "",
                "orphaned with no sandbox assigned",
                None,
            )
            .await;
            return Ok(());
        };
        let id = SandboxId::new(sandbox_id);
        let (status, sandbox_reason) = match self.sandbox_runtime.manager.observe(&id).await {
            Ok(observed) => (observed.status, observed.reason),
            Err(SandboxError::NotFound(_)) => (SandboxStatus::Gone, None),
            // Transient status failures must not fail a possibly live
            // execution; surface the error and retry on the next startup.
            Err(error) => return Err(SessionRuntimeError::Sandbox(error)),
        };
        if !status.can_open_io() {
            self.fail_orphaned_execution(
                thread_key,
                execution_id,
                sandbox_id,
                &format!("sandbox no longer accepts io (status {status:?})"),
                sandbox_reason.as_deref(),
            )
            .await;
            return Ok(());
        }

        // The turn may have finished while no control plane was attached. An
        // attach stream cannot replay that output, but the backend's recorded
        // history (pod logs) can.
        let since = execution.started_at.unwrap_or(execution.created_at);
        let lines = match self
            .sandbox_runtime
            .manager
            .read_output_since(&id, Some(SystemTime::from(since)))
            .await
        {
            Ok(lines) => lines,
            Err(SandboxError::Unsupported { .. }) => Vec::new(),
            Err(error) => {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "execution_adoption_log_read_failed",
                    thread_key = %thread_key,
                    execution_id,
                    sandbox_id,
                    %error,
                    "failed to read recorded sandbox output; adopting live"
                );
                Vec::new()
            }
        };
        if let Some(terminal) = terminal_output_from_lines(&lines) {
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "execution_adopted",
                thread_key = %thread_key,
                execution_id,
                sandbox_id,
                mode = "recorded_output",
                "adopted orphaned execution from recorded sandbox output"
            );
            let _ = self
                .store
                .append_event(
                    thread_key,
                    Some(execution_id),
                    "session.execution_adopted",
                    json!({ "sandbox_id": sandbox_id, "mode": "recorded_output" }),
                )
                .await;
            record_terminal_output(
                &self.context(),
                thread_key,
                sandbox_id,
                execution_id,
                terminal,
            )
            .await?;
            return Ok(());
        }

        // No terminal in the recorded output: treat the turn as still in
        // flight. Re-attach the stdout pump and re-arm the remaining
        // max-duration budget so an adopted-but-silent turn stays bounded.
        self.ensure_session_pipe(thread_key, sandbox_id).await?;
        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "execution_adopted",
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
            mode = "live_attach",
            "adopted orphaned execution with a live sandbox attach"
        );
        let _ = self
            .store
            .append_event(
                thread_key,
                Some(execution_id),
                "session.execution_adopted",
                json!({ "sandbox_id": sandbox_id, "mode": "live_attach" }),
            )
            .await;
        if let Some(max_duration) = max_duration_from_execution(execution) {
            let elapsed = SystemTime::now()
                .duration_since(SystemTime::from(since))
                .unwrap_or_default();
            spawn_max_duration_failure(
                self.context(),
                thread_key.clone(),
                execution.execution_id.clone(),
                max_duration.saturating_sub(elapsed),
                idle_timeout_from_execution(execution),
            );
        }
        Ok(())
    }

    async fn fail_orphaned_execution(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
        sandbox_id: &str,
        detail: &str,
        sandbox_reason: Option<&str>,
    ) {
        let error = match sandbox_reason {
            Some(reason) if !reason.trim().is_empty() => {
                format!(
                    "execution orphaned by control plane restart; {detail}; sandbox: {}",
                    reason.trim()
                )
            }
            _ => format!("execution orphaned by control plane restart; {detail}"),
        };
        if let Err(record_error) = record_terminal_output(
            &self.context(),
            thread_key,
            sandbox_id,
            execution_id,
            TerminalOutput::Failed { error },
        )
        .await
        {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "execution_adoption_fail_record_failed",
                thread_key = %thread_key,
                execution_id,
                error = %record_error,
                "failed to record orphaned execution failure"
            );
        }
    }
}

impl SandboxRuntime {
    pub async fn create_running_io(
        &self,
        spec: SandboxSpec,
    ) -> Result<(SandboxId, centaur_sandbox_core::SandboxIoParts), SessionRuntimeError> {
        let handle = self.manager.create_running(spec).await?;
        let io = self.manager.open_io(&handle.id).await?.into_parts();
        Ok((handle.id, io))
    }

    pub async fn stop_sandbox(&self, sandbox_id: &SandboxId) -> Result<(), SessionRuntimeError> {
        self.manager.stop(sandbox_id).await?;
        Ok(())
    }

    pub fn backend(backend: Arc<dyn SandboxBackend>, spec: SandboxSpec) -> Self {
        let warm_spec = spec.clone();
        let spec_factory =
            move |_thread_key: &ThreadKey,
                  _execution_id: &str,
                  _harness: &HarnessType,
                  _persona: Option<&PersonaContext>| { spec.clone() };
        let warm_spec_factory = move || warm_spec.clone();
        Self::backend_with_warm_spec_factory(backend, spec_factory, warm_spec_factory)
    }

    pub fn backend_with_workload(
        backend: Arc<dyn SandboxBackend>,
        workload: SandboxWorkloadMode,
    ) -> Self {
        let warm_harness = workload.default_harness();
        let warm_workload = workload.clone();
        let mut runtime = Self::backend_with_warm_spec_factory(
            backend,
            move |thread_key, execution_id, harness, persona| {
                workload
                    .spec(thread_key, harness, persona)
                    .env("CENTAUR_EXECUTION_ID", execution_id)
            },
            move || warm_workload.warm_spec(),
        );
        runtime.warm_harness = warm_harness;
        runtime
    }

    pub fn backend_with_spec_factory<F>(backend: Arc<dyn SandboxBackend>, spec_factory: F) -> Self
    where
        F: Fn(&ThreadKey, &str, &HarnessType, Option<&PersonaContext>) -> SandboxSpec
            + Send
            + Sync
            + 'static,
    {
        Self {
            manager: Arc::new(SandboxManager::new(backend)),
            spec_factory: Arc::new(spec_factory),
            warm_spec_factory: None,
            warm_repos_json: None,
            warm_harness: None,
        }
    }

    pub fn backend_with_warm_spec_factory<F, W>(
        backend: Arc<dyn SandboxBackend>,
        spec_factory: F,
        warm_spec_factory: W,
    ) -> Self
    where
        F: Fn(&ThreadKey, &str, &HarnessType, Option<&PersonaContext>) -> SandboxSpec
            + Send
            + Sync
            + 'static,
        W: Fn() -> SandboxSpec + Send + Sync + 'static,
    {
        let warm_spec_factory: WarmSandboxSpecFactory = Arc::new(move || {
            let spec = warm_spec_with_resolved_repos(warm_spec_factory());
            let workload_key = sandbox_spec_key(&spec);
            WarmSandboxWorkload { spec, workload_key }
        });
        let warm_workload = warm_spec_factory();
        let warm_repos_json = spec_env_value(&warm_workload.spec, AGENT_REPOS_JSON_ENV)
            .and_then(canonical_repos_json);
        Self {
            manager: Arc::new(SandboxManager::new(backend)),
            spec_factory: Arc::new(spec_factory),
            warm_spec_factory: Some(warm_spec_factory),
            warm_repos_json,
            warm_harness: None,
        }
    }
}

impl SandboxWorkloadMode {
    pub fn mock_app_server(image: impl Into<String>) -> Self {
        Self::MockAppServer {
            image: image.into(),
        }
    }

    pub fn codex_app_server(
        image: impl Into<String>,
        env: impl IntoIterator<Item = (String, String)>,
        harness: HarnessType,
    ) -> Self {
        Self::CodexAppServer {
            image: image.into(),
            env: env.into_iter().collect(),
            mounts: Vec::new(),
            harness,
        }
    }

    pub fn mount(mut self, mount: Mount) -> Self {
        match &mut self {
            Self::MockAppServer { .. } => {}
            Self::CodexAppServer { mounts, .. } => mounts.push(mount),
        }
        self
    }

    fn default_harness(&self) -> Option<HarnessType> {
        match self {
            Self::MockAppServer { .. } => None,
            Self::CodexAppServer { harness, .. } => Some(harness.clone()),
        }
    }

    fn spec(
        &self,
        thread_key: &ThreadKey,
        harness: &HarnessType,
        persona: Option<&PersonaContext>,
    ) -> SandboxSpec {
        self.spec_for(Some(thread_key), harness, persona)
    }

    fn warm_spec(&self) -> SandboxSpec {
        let spec = match self {
            Self::MockAppServer { .. } => self.spec_for(None, &HarnessType::Codex, None),
            Self::CodexAppServer { harness, .. } => self.spec_for(None, harness, None),
        };
        let spec = spec.env(CENTAUR_WARM_SANDBOX_ENV, "1");
        if spec_env_value(&spec, AGENT_REPOS_JSON_ENV).is_some() {
            spec.env(
                CENTAUR_WARM_REPO_OVERLAY_VERSION_ENV,
                CENTAUR_WARM_REPO_OVERLAY_VERSION,
            )
        } else {
            spec
        }
    }

    fn spec_for(
        &self,
        thread_key: Option<&ThreadKey>,
        harness: &HarnessType,
        persona: Option<&PersonaContext>,
    ) -> SandboxSpec {
        match self {
            Self::MockAppServer { image } => apply_persona_spec_env(
                SandboxSpec::new(image)
                    .command(["/bin/sh", "-lc"])
                    .args([mock_app_server_script()])
                    .env("CENTAUR_HARNESS_TYPE", harness.as_ref()),
                persona,
            ),
            Self::CodexAppServer {
                image, env, mounts, ..
            } => {
                // Pin the harness via container args (the image entrypoint is
                // kept) so the sandbox runs the session's harness rather than
                // whatever the image CMD defaults to.
                //
                // Flat-~ (overlay home): codex/claude config + auth live in the overlay
                // HOME (~/.codex, ~/.claude) — persisted via the overlay upper and visible
                // to the node-sync daemon's harness-transcript lane — not the legacy
                // ephemeral $STATE_DIR (whose dirs the entrypoint no longer creates under
                // flat-home). Setting it on the SPEC keeps the agent, the overlay manifest
                // (harness_home derives from CODEX_HOME), and the daemon all consistent.
                // Keyed off the api-rs's own overlay-flat-home flag.
                let flat_home = std::env::var("CENTAUR_SANDBOX_OVERLAY_FLAT_HOME")
                    .map(|v| matches!(v.as_str(), "1" | "true" | "True" | "TRUE" | "yes" | "on"))
                    .unwrap_or(false);
                let codex_home = if flat_home {
                    "/home/agent/.codex"
                } else {
                    SANDBOX_CODEX_HOME
                };
                let claude_config_dir = if flat_home {
                    "/home/agent/.claude"
                } else {
                    SANDBOX_CLAUDE_CONFIG_DIR
                };
                let mut spec = SandboxSpec::new(image)
                    .label("centaur.ai/component", "session-sandbox")
                    .label("centaur.ai/harness", harness.to_string())
                    .args(["harness-server", harness_server_subcommand(harness)])
                    .env("CENTAUR_HARNESS_TYPE", harness_server_subcommand(harness))
                    .env("CENTAUR_STATE_DIR", SANDBOX_STATE_DIR)
                    .env("CODEX_HOME", codex_home)
                    .env("CLAUDE_CONFIG_DIR", claude_config_dir)
                    .mount(Mount::new(MountKind::EmptyDir, SANDBOX_STATE_DIR));
                if let Some(thread_key) = thread_key {
                    spec = spec.env("CENTAUR_THREAD_KEY", thread_key.as_str());
                    if let Some(token) = scoped_sandbox_api_token(thread_key) {
                        spec = spec.env("CENTAUR_API_KEY", token);
                    }
                }
                for mount in mounts {
                    spec = spec.mount(mount.clone());
                }
                for (name, value) in env {
                    spec = spec.env(name.clone(), value.clone());
                }
                apply_persona_spec_env(spec, persona)
            }
        }
    }
}

/// The harness-server CLI subcommand for a harness type
/// (see crates/harness-server/src/main.rs).
fn harness_server_subcommand(harness: &HarnessType) -> &'static str {
    match harness {
        HarnessType::Codex => "codex",
        HarnessType::ClaudeCode => "claude-code",
        HarnessType::Amp => "amp",
    }
}

fn harness_home_for_spec(harness: &HarnessType) -> Option<&'static str> {
    let flat_home = std::env::var("CENTAUR_SANDBOX_OVERLAY_FLAT_HOME")
        .map(|v| matches!(v.as_str(), "1" | "true" | "True" | "TRUE" | "yes" | "on"))
        .unwrap_or(false);
    match harness {
        HarnessType::Codex => Some(if flat_home {
            "/home/agent/.codex"
        } else {
            SANDBOX_CODEX_HOME
        }),
        HarnessType::ClaudeCode => Some(if flat_home {
            "/home/agent/.claude"
        } else {
            SANDBOX_CLAUDE_CONFIG_DIR
        }),
        HarnessType::Amp => None,
    }
}

fn scoped_sandbox_api_token(thread_key: &ThreadKey) -> Option<String> {
    let signing_key = env::var("SANDBOX_SIGNING_KEY")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())?;
    match sandbox_token::mint_sandbox_token(thread_key, &signing_key) {
        Ok(token) => Some(token),
        Err(error) => {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                thread_key = %thread_key,
                %error,
                "failed to mint scoped sandbox API token"
            );
            None
        }
    }
}

fn sandbox_spec_key(spec: &SandboxSpec) -> String {
    let encoded = serde_json::to_vec(spec).expect("sandbox specs should serialize");
    let digest = Sha256::digest(encoded);
    format!("sandbox-spec-sha256:{digest:x}")
}

fn warm_spec_with_resolved_repos(mut spec: SandboxSpec) -> SandboxSpec {
    let resolved_repos_json = resolved_warm_repos_json(&spec);
    remove_spec_env(&mut spec, CENTAUR_WARM_RESOLVED_REPOS_JSON_ENV);
    match resolved_repos_json {
        Some(repos_json) => spec.env(CENTAUR_WARM_RESOLVED_REPOS_JSON_ENV, repos_json),
        None => spec,
    }
}

fn resolved_warm_repos_json(spec: &SandboxSpec) -> Option<String> {
    let repos_json = spec_env_value(spec, AGENT_REPOS_JSON_ENV)?;
    let repo_cache_root = env::var(REPOS_PATH_ENV)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())?;
    let state_path = Path::new(&repo_cache_root).join(REPO_CACHE_STATE_FILE);
    let state = std::fs::read(&state_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RepoCacheState>(&bytes).ok())?;
    resolved_repos_json_from_state(repos_json, Path::new(&repo_cache_root), &state)
}

fn resolved_repos_json_from_state(
    repos_json: &str,
    repo_cache_root: &Path,
    state: &RepoCacheState,
) -> Option<String> {
    let mut repos = parse_repo_array(Some(repos_json));
    if repos.is_empty() {
        return None;
    }

    for repo in &mut repos {
        if repo_is_private(repo) {
            return None;
        }
        let repo_name = repo.get("repo").and_then(Value::as_str)?.to_owned();
        let repo_ref = repo
            .get("ref")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let resolved = state.repositories.iter().find(|candidate| {
            candidate.repo == repo_name && candidate.r#ref.as_deref() == repo_ref.as_deref()
        })?;
        if resolved.resolved_sha.trim().is_empty()
            || resolved.cache_path.trim().is_empty()
            || !repo_cache_snapshot_exists(repo_cache_root, &resolved.cache_path)
        {
            return None;
        }
        let object = repo.as_object_mut()?;
        object.insert(
            "resolved_sha".to_owned(),
            Value::String(resolved.resolved_sha.clone()),
        );
        object.insert(
            "cache_path".to_owned(),
            Value::String(resolved.cache_path.clone()),
        );
    }

    Some(Value::Array(repos).to_string())
}

fn repo_cache_snapshot_exists(repo_cache_root: &Path, cache_path: &str) -> bool {
    if cache_path.contains('\0') || cache_path.trim().is_empty() || cache_path.trim() != cache_path
    {
        return false;
    }
    let cache_path = Path::new(cache_path);
    if cache_path.components().any(|component| {
        matches!(
            component,
            Component::CurDir | Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return false;
    }
    repo_cache_root.join(cache_path).join(".git").is_dir()
}

#[derive(Debug, Deserialize)]
struct RepoCacheState {
    #[serde(default)]
    repositories: Vec<RepoCacheStateEntry>,
}

#[derive(Debug, Deserialize)]
struct RepoCacheStateEntry {
    repo: String,
    #[serde(default, rename = "ref")]
    r#ref: Option<String>,
    resolved_sha: String,
    cache_path: String,
}

fn spec_env_value<'a>(spec: &'a SandboxSpec, name: &str) -> Option<&'a str> {
    spec.env
        .iter()
        .find(|env| env.name == name)
        .map(|env| env.value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn canonical_repos_json(repos_json: &str) -> Option<String> {
    let repos = parse_repo_array(Some(repos_json));
    (!repos.is_empty()).then(|| Value::Array(repos).to_string())
}

fn mock_app_server_script() -> &'static str {
    r#"while IFS= read -r line; do
model="$(printf '%s\n' "$line" | sed -n 's/.*"model":"\([^"]*\)".*/\1/p')"
[ -n "$model" ] || model="unknown"
harness="${CENTAUR_HARNESS_TYPE:-unknown}"
printf '%s\n' '{"type":"system","subtype":"wrapper_heartbeat","phase":"startup"}'
sleep 0.2
printf '%s\n' '{"type":"system","subtype":"wrapper_heartbeat","phase":"app_server_started"}'
sleep 0.2
printf '%s\n' '{"type":"thread.started","thread_id":"mock-codex-thread"}'
sleep 0.2
turn_index=1
while [ "$turn_index" -le 3 ]; do
  turn_id="mock-turn-$turn_index"
  printf '{"type":"turn.started","turn_id":"%s"}\n' "$turn_id"
  sleep 0.2
  printf '{"type":"item.agentMessage.delta","turnId":"%s","session_id":"mock-codex-thread","delta":"PONG model=%s harness=%s"}\n' "$turn_id" "$model" "$harness"
  sleep 0.2
  printf '{"type":"turn.completed","turn":{"id":"%s"},"usage":{"input_tokens":0,"output_tokens":1}}\n' "$turn_id"
  sleep 0.2
  turn_index=$((turn_index + 1))
done
done"#
}

fn session_event_stream(
    store: PgSessionStore,
    thread_key: ThreadKey,
    after_event_id: i64,
    execution_id: Option<String>,
    listener: SessionEventListener,
    span: Span,
) -> impl Stream<Item = Result<SessionEvent, SessionRuntimeError>> {
    stream::unfold(
        EventStreamState {
            store,
            thread_key,
            after_event_id,
            execution_id,
            pending: VecDeque::new(),
            listener,
            safety_tick: {
                let mut tick = interval_at(
                    Instant::now() + EVENT_STREAM_SAFETY_POLL_INTERVAL,
                    EVENT_STREAM_SAFETY_POLL_INTERVAL,
                );
                tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
                tick
            },
            done: false,
            emitted_count: 0,
            span,
        },
        |mut state| {
            let span = state.span.clone();
            async move {
                loop {
                    if let Some(event) = state.pending.pop_front() {
                        state.after_event_id = event.event_id;
                        state.emitted_count += 1;
                        return Some((Ok(event), state));
                    }
                    if state.done {
                        info!(
                            component = COMPONENT_SESSION_RUNTIME,
                            event = "session_events_stream_completed",
                            thread_key = %state.thread_key,
                            emitted_count = state.emitted_count,
                            "session event stream completed"
                        );
                        return None;
                    }
                    match state
                        .store
                        .list_events_after(
                            &state.thread_key,
                            state.after_event_id,
                            state.execution_id.as_deref(),
                            100,
                        )
                        .await
                    {
                        Ok(events) if events.is_empty() => loop {
                            tokio::select! {
                                notification = state.listener.recv() => {
                                    match notification {
                                        Ok(notification)
                                            if notification.thread_key == state.thread_key.as_str()
                                                && notification.event_id > state.after_event_id =>
                                        {
                                            break;
                                        }
                                        Ok(_) => {}
                                        Err(error) => {
                                            state.done = true;
                                            return Some((Err(SessionRuntimeError::Store(error)), state));
                                        }
                                    }
                                }
                                _ = state.safety_tick.tick() => break,
                            }
                        }
                        Ok(events) => state.pending = events.into(),
                        Err(error) => {
                            state.done = true;
                            return Some((Err(SessionRuntimeError::Store(error)), state));
                        }
                    }
                }
            }
            .instrument(span)
        },
    )
}

/// How a stdout pump pass ended once the attach stream closed.
enum StdoutPumpEnd {
    /// The stream closed with no execution in flight, or the execution was
    /// already terminalized by a read/codec failure.
    Idle,
    /// The stream closed while an execution was still active. Treat this as a
    /// transport detach; the pump loop decides whether to recover or fail.
    EofActiveExecution {
        execution: Box<SessionExecution>,
        lines_pumped: u64,
    },
}

struct StdoutPumpLoop {
    ctx: RuntimeContext,
    open_lock: Arc<Mutex<()>>,
    thread_key: ThreadKey,
    sandbox_id: String,
    pipe: SessionPipe,
    stdout: SandboxRead,
    guard: SandboxIoGuard,
}

enum ReattachOutcome {
    Reattached {
        pipe: SessionPipe,
        stdout: SandboxRead,
        guard: SandboxIoGuard,
    },
    /// Another pipe replaced ours; that pump now owns the sandbox stream.
    Superseded,
    /// A retryable attach/status failure. The caller bounds attempts.
    Retryable(String),
    /// The sandbox cannot serve IO anymore.
    Dead(String),
}

fn session_pipe_from_stdin(stdin: SandboxWrite) -> SessionPipe {
    SessionPipe {
        stdin: Arc::new(Mutex::new(FramedWrite::new(stdin, LinesCodec::new()))),
    }
}

fn spawn_stderr_drain(sandbox_id: String, stderr: SandboxRead) {
    tokio::spawn(async move {
        if let Err(error) = drain_stderr(stderr).await {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_stderr_drain_failed",
                sandbox_id = %sandbox_id,
                %error,
                "session stderr drain failed"
            );
        }
    });
}

fn remove_pipe_if_current(sandbox_pipes: &SessionPipeMap, sandbox_id: &str, pipe: &SessionPipe) {
    sandbox_pipes.remove_if(sandbox_id, |_sandbox_id, current| {
        Arc::ptr_eq(&current.stdin, &pipe.stdin)
    });
}

/// Runs the stdout pump and reattaches when Kubernetes closes the attach
/// stream before the active execution emits terminal output.
fn spawn_stdout_pump_loop(state: StdoutPumpLoop) {
    tokio::spawn(async move {
        let StdoutPumpLoop {
            ctx,
            open_lock,
            thread_key,
            sandbox_id,
            mut pipe,
            mut stdout,
            mut guard,
        } = state;
        let mut reattach_attempts = 0_u32;
        let mut last_reattach_detail = "stdout reattach attempts exhausted".to_owned();

        'pump: loop {
            let result =
                run_stdout_pump(ctx.clone(), thread_key.clone(), &sandbox_id, stdout, guard).await;
            let (execution, lines_pumped) = match result {
                Ok(StdoutPumpEnd::Idle) => break,
                Ok(StdoutPumpEnd::EofActiveExecution {
                    execution,
                    lines_pumped,
                }) => (execution, lines_pumped),
                Err(error) => {
                    warn!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "session_stdout_pump_failed",
                        thread_key = %thread_key,
                        sandbox_id = %sandbox_id,
                        %error,
                        "session stdout pump failed"
                    );
                    let _ = ctx
                        .store
                        .append_event(
                            &thread_key,
                            None,
                            "session.stdout_pump_failed",
                            json!({
                                "sandbox_id": sandbox_id.as_str(),
                                "error": error.to_string(),
                            }),
                        )
                        .await;
                    break;
                }
            };

            if recover_detached_terminal_output(&ctx, &thread_key, &sandbox_id, &execution)
                .await
                .unwrap_or_else(|error| {
                    warn!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "session_stdout_recovery_failed",
                        thread_key = %thread_key,
                        sandbox_id = %sandbox_id,
                        execution_id = %execution.execution_id,
                        %error,
                        "failed to recover detached stdout from recorded output"
                    );
                    false
                })
            {
                break;
            }

            if lines_pumped > 0 {
                reattach_attempts = 0;
            }

            loop {
                if reattach_attempts >= SESSION_PIPE_MAX_REATTACH_ATTEMPTS {
                    fail_detached_execution(
                        &ctx,
                        &thread_key,
                        &sandbox_id,
                        &execution.execution_id,
                        &last_reattach_detail,
                    )
                    .await;
                    break 'pump;
                }
                reattach_attempts += 1;
                if reattach_attempts > 1 {
                    sleep(SESSION_PIPE_REATTACH_DELAY).await;
                }

                match reattach_session_pipe(&ctx, &open_lock, &sandbox_id, &pipe).await {
                    ReattachOutcome::Reattached {
                        pipe: new_pipe,
                        stdout: new_stdout,
                        guard: new_guard,
                    } => {
                        info!(
                            component = COMPONENT_SESSION_RUNTIME,
                            event = "session_stdout_pump_reattached",
                            thread_key = %thread_key,
                            sandbox_id = %sandbox_id,
                            execution_id = %execution.execution_id,
                            attempt = reattach_attempts,
                            "reattached session stdout pump after eof"
                        );
                        let _ = ctx
                            .store
                            .append_event(
                                &thread_key,
                                Some(&execution.execution_id),
                                "session.stdout_pump_reattached",
                                json!({
                                    "sandbox_id": sandbox_id.as_str(),
                                    "attempt": reattach_attempts,
                                }),
                            )
                            .await;
                        pipe = new_pipe;
                        stdout = new_stdout;
                        guard = new_guard;
                        continue 'pump;
                    }
                    ReattachOutcome::Superseded => return,
                    ReattachOutcome::Retryable(detail) => {
                        warn!(
                            component = COMPONENT_SESSION_RUNTIME,
                            event = "session_stdout_pump_reattach_failed",
                            thread_key = %thread_key,
                            sandbox_id = %sandbox_id,
                            execution_id = %execution.execution_id,
                            attempt = reattach_attempts,
                            detail = %detail,
                            "session stdout pump reattach attempt failed"
                        );
                        last_reattach_detail = detail;
                    }
                    ReattachOutcome::Dead(detail) => {
                        fail_detached_execution(
                            &ctx,
                            &thread_key,
                            &sandbox_id,
                            &execution.execution_id,
                            &detail,
                        )
                        .await;
                        break 'pump;
                    }
                }
            }
        }

        remove_pipe_if_current(&ctx.sandbox_pipes, &sandbox_id, &pipe);
    });
}

async fn reattach_session_pipe(
    ctx: &RuntimeContext,
    open_lock: &Arc<Mutex<()>>,
    sandbox_id: &str,
    pipe: &SessionPipe,
) -> ReattachOutcome {
    let _open_guard = open_lock.lock().await;
    if ctx
        .sandbox_pipes
        .get(sandbox_id)
        .is_none_or(|current| !Arc::ptr_eq(&current.stdin, &pipe.stdin))
    {
        return ReattachOutcome::Superseded;
    }

    let id = SandboxId::new(sandbox_id);
    match ctx.manager.status(&id).await {
        Ok(status) if status.can_open_io() => match ctx.manager.open_io(&id).await {
            Ok(io) => {
                let parts = io.into_parts();
                let new_pipe = session_pipe_from_stdin(parts.stdin);
                ctx.sandbox_pipes
                    .insert(sandbox_id.to_owned(), new_pipe.clone());
                spawn_stderr_drain(sandbox_id.to_owned(), parts.stderr);
                ReattachOutcome::Reattached {
                    pipe: new_pipe,
                    stdout: parts.stdout,
                    guard: parts.guard,
                }
            }
            Err(error) => {
                ReattachOutcome::Retryable(format!("sandbox stdout reattach failed: {error}"))
            }
        },
        Ok(status) => {
            ReattachOutcome::Dead(format!("sandbox no longer accepts io (status {status:?})"))
        }
        Err(SandboxError::NotFound(_)) => {
            ReattachOutcome::Dead("sandbox no longer exists".to_owned())
        }
        Err(error) => ReattachOutcome::Retryable(format!("sandbox status check failed: {error}")),
    }
}

async fn recover_detached_terminal_output(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    sandbox_id: &str,
    execution: &SessionExecution,
) -> Result<bool, SessionRuntimeError> {
    let since = execution.started_at.unwrap_or(execution.created_at);
    let id = SandboxId::new(sandbox_id);
    let lines = match ctx
        .manager
        .read_output_since(&id, Some(SystemTime::from(since)))
        .await
    {
        Ok(lines) => lines,
        Err(SandboxError::Unsupported { .. }) => return Ok(false),
        Err(error) => {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_stdout_recorded_output_read_failed",
                thread_key = %thread_key,
                execution_id = %execution.execution_id,
                sandbox_id,
                %error,
                "failed to read recorded sandbox output; reattaching live"
            );
            return Ok(false);
        }
    };

    let Some(terminal) = terminal_output_from_lines(&lines) else {
        return Ok(false);
    };

    info!(
        component = COMPONENT_SESSION_RUNTIME,
        event = "session_stdout_pump_recovered",
        thread_key = %thread_key,
        execution_id = %execution.execution_id,
        sandbox_id,
        mode = "recorded_output",
        "recovered detached stdout pump from recorded sandbox output"
    );
    let _ = ctx
        .store
        .append_event(
            thread_key,
            Some(&execution.execution_id),
            "session.stdout_pump_recovered",
            json!({ "sandbox_id": sandbox_id, "mode": "recorded_output" }),
        )
        .await;
    record_terminal_output(
        ctx,
        thread_key,
        sandbox_id,
        &execution.execution_id,
        terminal,
    )
    .await?;
    Ok(true)
}

async fn fail_detached_execution(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    sandbox_id: &str,
    execution_id: &str,
    detail: &str,
) {
    let error = format!("sandbox stdout closed before terminal output; {detail}");
    if let Err(record_error) = record_terminal_output(
        ctx,
        thread_key,
        sandbox_id,
        execution_id,
        TerminalOutput::Failed { error },
    )
    .await
    {
        warn!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_stdout_detached_fail_record_failed",
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
            error = %record_error,
            "failed to record detached stdout failure"
        );
    }
}

async fn run_stdout_pump(
    ctx: RuntimeContext,
    thread_key: ThreadKey,
    sandbox_id: &str,
    stdout: SandboxRead,
    _guard: SandboxIoGuard,
) -> Result<StdoutPumpEnd, SessionRuntimeError> {
    let span = info_span!(
        "centaur.api_rs.session.stdout_pump",
        component = COMPONENT_SESSION_RUNTIME,
        event = "session_stdout_pump",
        "centaur.thread_key" = thread_key.as_str(),
        "centaur.sandbox_id" = sandbox_id,
        thread_key = %thread_key,
        sandbox_id,
    );
    set_span_parent_trace(
        &span,
        &thread_trace_id(&thread_key),
        &thread_trace_parent_span_id(&thread_key),
    );
    async {
        ensure_thread_trace_root_span(&thread_key);
        let mut stdout = FramedRead::new(stdout, LinesCodec::new());
        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_stdout_pump_started",
            thread_key = %thread_key,
            sandbox_id,
            "session stdout pump started"
        );
        let mut output_state = StdoutPumpState::default();
        let mut line_count = 0_u64;
        while let Some(line) = stdout.next().await {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    let message = stdout_pump_error_message(&error);
                    record_stdout_pump_failure(&ctx, &thread_key, sandbox_id, message).await?;
                    return Ok(StdoutPumpEnd::Idle);
                }
            };
            line_count += 1;
            let output_value = serde_json::from_str::<Value>(&line).ok();
            if let Some(harness_thread_id) = harness_thread_id_from_output_line(&line)
                && let Err(error) = ctx
                    .store
                    .update_harness_thread_id(&thread_key, Some(&harness_thread_id))
                    .await
            {
                warn!(%thread_key, %harness_thread_id, %error, "failed to persist harness thread id");
            }
            let active_execution = ctx.store.active_execution_for_thread(&thread_key).await?;
            let execution_id = active_execution
                .as_ref()
                .map(|execution| execution.execution_id.as_str());
            let Some(output_execution_id) = output_state.execution_for_line(execution_id, &line)
            else {
                continue;
            };
            let first_token_execution = active_execution
                .as_ref()
                .filter(|execution| {
                    execution.execution_id == output_execution_id
                        && output_state.should_record_first_token(
                            &output_execution_id,
                            output_value.as_ref(),
                        )
                })
                .cloned();
            let execution_span = ctx
                .execution_spans
                .lock()
                .await
                .get(&output_execution_id)
                .cloned();
            let output_span = output_state.stdout_span_for_execution(
                execution_span.as_ref(),
                &thread_key,
                sandbox_id,
                &output_execution_id,
            );
            let output_event =
                append_output_line(&ctx.store, &thread_key, Some(&output_execution_id), &line)
                .instrument(output_span.clone())
                .await?;
            if let Some(execution) = first_token_execution {
                record_first_token_observation(
                    &ctx,
                    &thread_key,
                    &execution,
                    &output_event,
                    &mut output_state,
                )
                .await;
            }
            if let Some(value) = output_value.as_ref() {
                output_state.record_codex_app_server_spans(
                    &output_span,
                    &thread_key,
                    sandbox_id,
                    &output_execution_id,
                    value,
                );
            }
            if let Some(execution) = active_execution
                && execution.execution_id == output_execution_id
                && let Some(terminal) = output_state.observe(&output_execution_id, &line)
            {
                record_terminal_output(
                    &ctx,
                    &thread_key,
                    sandbox_id,
                    &output_execution_id,
                    terminal,
                )
                .instrument(output_span)
                .await?;
                ctx.execution_spans.lock().await.remove(&output_execution_id);
                output_state.forget(&output_execution_id);
            }
        }
        let active_execution = ctx.store.active_execution_for_thread(&thread_key).await?;
        ctx.store
            .append_event(
                &thread_key,
                None,
                "session.stdout_eof",
                json!({
                    "sandbox_id": sandbox_id,
                }),
            )
            .await?;
        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_stdout_pump_completed",
            thread_key = %thread_key,
            sandbox_id,
            output_line_count = line_count,
            "session stdout pump completed"
        );
        match active_execution {
            Some(execution) => Ok(StdoutPumpEnd::EofActiveExecution {
                execution: Box::new(execution),
                lines_pumped: line_count,
            }),
            None => Ok(StdoutPumpEnd::Idle),
        }
    }
    .instrument(span)
    .await
}

async fn record_stdout_pump_failure(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    sandbox_id: &str,
    error: String,
) -> Result<(), SessionRuntimeError> {
    let active_execution = ctx.store.active_execution_for_thread(thread_key).await?;
    let execution_id = active_execution
        .as_ref()
        .map(|execution| execution.execution_id.as_str());
    ctx.store
        .append_event(
            thread_key,
            execution_id,
            "session.stdout_pump_failed",
            json!({
                "sandbox_id": sandbox_id,
                "error": error.as_str(),
                "terminalized_execution": execution_id.is_some(),
            }),
        )
        .await?;
    if let Some(execution) = active_execution {
        record_terminal_output(
            ctx,
            thread_key,
            sandbox_id,
            &execution.execution_id,
            TerminalOutput::Failed { error },
        )
        .await?;
    }
    Ok(())
}

async fn record_first_token_observation(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    execution: &SessionExecution,
    output_event: &SessionEvent,
    output_state: &mut StdoutPumpState,
) {
    match ctx
        .store
        .execution_event_exists(&execution.execution_id, SESSION_FIRST_TOKEN_EVENT)
        .await
    {
        Ok(true) => {
            output_state.mark_first_token_recorded(&execution.execution_id);
            return;
        }
        Ok(false) => {}
        Err(error) => {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_first_token_marker_check_failed",
                thread_key = %thread_key,
                execution_id = %execution.execution_id,
                %error,
                "failed to check existing first-token marker"
            );
        }
    }

    let Some(latency) = first_token_latency(execution, output_event) else {
        output_state.mark_first_token_recorded(&execution.execution_id);
        return;
    };
    let harness_label = match ctx.store.get_session(thread_key).await {
        Ok(session) => session.harness_type.to_string(),
        Err(error) => {
            warn!(%thread_key, %error, "failed to load session for first-token metric labels");
            "unknown".to_owned()
        }
    };
    let latency_ms = duration_millis_u64(latency);
    if let Err(error) = ctx
        .store
        .append_event(
            thread_key,
            Some(&execution.execution_id),
            SESSION_FIRST_TOKEN_EVENT,
            json!({
                "execution_id": execution.execution_id.as_str(),
                "thread_key": thread_key.as_str(),
                "harness_type": harness_label.as_str(),
                "latency_ms": latency_ms,
                "output_event_id": output_event.event_id,
            }),
        )
        .await
    {
        warn!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_first_token_marker_append_failed",
            thread_key = %thread_key,
            execution_id = %execution.execution_id,
            output_event_id = output_event.event_id,
            %error,
            "failed to append first-token marker"
        );
    }
    record_session_first_token_latency(&harness_label, latency);
    output_state.mark_first_token_recorded(&execution.execution_id);
    info!(
        component = COMPONENT_SESSION_RUNTIME,
        event = "session_first_token_observed",
        thread_key = %thread_key,
        execution_id = %execution.execution_id,
        harness_type = %harness_label,
        latency_ms,
        output_event_id = output_event.event_id,
        "session first answer token observed"
    );
}

fn first_token_latency(
    execution: &SessionExecution,
    output_event: &SessionEvent,
) -> Option<Duration> {
    let started_at = execution.started_at.unwrap_or(execution.created_at);
    (output_event.created_at - started_at).try_into().ok()
}

#[derive(Default)]
struct StdoutPumpState {
    final_answer_text_by_execution: HashMap<String, String>,
    first_token_recorded_by_execution: HashSet<String>,
    turn_execution_by_id: HashMap<String, String>,
    item_execution_by_id: HashMap<String, String>,
    tool_call_by_id: HashMap<String, ToolCallLabels>,
    stdout_span_by_execution: HashMap<String, Span>,
}

impl StdoutPumpState {
    fn execution_for_line(
        &mut self,
        active_execution_id: Option<&str>,
        line: &str,
    ) -> Option<String> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return active_execution_id.map(ToOwned::to_owned);
        };

        if let Some(known_execution_id) = self.known_execution_for_value(&value) {
            if active_execution_id == Some(known_execution_id.as_str()) {
                self.remember_value_execution(&value, &known_execution_id);
                return Some(known_execution_id);
            }
            if terminal_output(
                &value,
                self.final_answer_text_by_execution
                    .get(&known_execution_id)
                    .map(String::as_str)
                    .unwrap_or(""),
            )
            .is_some()
            {
                self.forget(&known_execution_id);
            }
            return None;
        }

        let active_execution_id = active_execution_id?;
        self.remember_value_execution(&value, active_execution_id);
        Some(active_execution_id.to_owned())
    }

    fn observe(&mut self, execution_id: &str, line: &str) -> Option<TerminalOutput> {
        let value: Value = serde_json::from_str(line).ok()?;
        if let Some(update) = output_line_final_answer_text(&value) {
            let text = self
                .final_answer_text_by_execution
                .entry(execution_id.to_owned())
                .or_default();
            match update {
                FinalAnswerTextUpdate::Append(delta) => text.push_str(&delta),
                FinalAnswerTextUpdate::Replace(canonical) => *text = canonical,
            }
        }
        terminal_output(
            &value,
            self.final_answer_text_by_execution
                .get(execution_id)
                .map(String::as_str)
                .unwrap_or(""),
        )
    }

    fn should_record_first_token(&self, execution_id: &str, value: Option<&Value>) -> bool {
        if self
            .first_token_recorded_by_execution
            .contains(execution_id)
            || self
                .final_answer_text_by_execution
                .get(execution_id)
                .is_some_and(|text| !text.trim().is_empty())
        {
            return false;
        }

        let Some(value) = value else {
            return false;
        };
        if output_line_final_answer_text(value).is_some() {
            return true;
        }
        matches!(
            terminal_output(value, ""),
            Some(TerminalOutput::Completed {
                result_text: Some(_),
                ..
            })
        )
    }

    fn mark_first_token_recorded(&mut self, execution_id: &str) {
        self.first_token_recorded_by_execution
            .insert(execution_id.to_owned());
    }

    fn forget(&mut self, execution_id: &str) {
        self.final_answer_text_by_execution.remove(execution_id);
        self.first_token_recorded_by_execution.remove(execution_id);
        let tool_ids_to_forget = self
            .item_execution_by_id
            .iter()
            .filter(|&(_item_id, mapped_execution_id)| mapped_execution_id == execution_id)
            .map(|(item_id, _mapped_execution_id)| item_id.clone())
            .collect::<Vec<_>>();
        self.turn_execution_by_id
            .retain(|_, mapped_execution_id| mapped_execution_id != execution_id);
        self.item_execution_by_id
            .retain(|_, mapped_execution_id| mapped_execution_id != execution_id);
        self.stdout_span_by_execution.remove(execution_id);
        for item_id in tool_ids_to_forget {
            self.tool_call_by_id.remove(&item_id);
        }
    }

    fn stdout_span_for_execution(
        &mut self,
        parent: Option<&Span>,
        thread_key: &ThreadKey,
        sandbox_id: &str,
        execution_id: &str,
    ) -> Span {
        if let Some(span) = self.stdout_span_by_execution.get(execution_id) {
            return span.clone();
        }
        let span = new_stdout_pump_span(parent, thread_key, sandbox_id, execution_id);
        self.stdout_span_by_execution
            .insert(execution_id.to_owned(), span.clone());
        span
    }

    fn record_codex_app_server_spans(
        &mut self,
        parent: &Span,
        thread_key: &ThreadKey,
        sandbox_id: &str,
        execution_id: &str,
        value: &Value,
    ) {
        record_codex_app_server_event_span(parent, thread_key, sandbox_id, execution_id, value);
        for event in tool_call_span_events(value, &mut self.tool_call_by_id) {
            record_codex_app_server_tool_span(parent, thread_key, sandbox_id, execution_id, &event);
        }
    }

    fn known_execution_for_value(&self, value: &Value) -> Option<String> {
        for turn_id in turn_ids(value) {
            if let Some(execution_id) = self.turn_execution_by_id.get(&turn_id) {
                return Some(execution_id.clone());
            }
        }
        for item_id in item_ids(value) {
            if let Some(execution_id) = self.item_execution_by_id.get(&item_id) {
                return Some(execution_id.clone());
            }
        }
        None
    }

    fn remember_value_execution(&mut self, value: &Value, execution_id: &str) {
        for turn_id in turn_ids(value) {
            self.turn_execution_by_id
                .insert(turn_id, execution_id.to_owned());
        }
        for item_id in item_ids(value) {
            self.item_execution_by_id
                .insert(item_id, execution_id.to_owned());
        }
    }
}

fn new_stdout_pump_span(
    parent: Option<&Span>,
    thread_key: &ThreadKey,
    sandbox_id: &str,
    execution_id: &str,
) -> Span {
    if let Some(parent) = parent {
        info_span!(
            parent: parent,
            "centaur.api_rs.session.stdout_pump",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_stdout_pump",
            "centaur.thread_key" = thread_key.as_str(),
            "centaur.execution_id" = execution_id,
            "centaur.sandbox_id" = sandbox_id,
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
        )
    } else {
        info_span!(
            "centaur.api_rs.session.stdout_pump",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_stdout_pump",
            "centaur.thread_key" = thread_key.as_str(),
            "centaur.execution_id" = execution_id,
            "centaur.sandbox_id" = sandbox_id,
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ToolCallLabels {
    kind: String,
    name: String,
    method: String,
}

#[derive(Clone, Debug, PartialEq)]
struct ToolCallSpanEvent {
    labels: ToolCallLabels,
    status: &'static str,
    duration: Option<Duration>,
}

fn record_codex_app_server_event_span(
    parent: &Span,
    thread_key: &ThreadKey,
    sandbox_id: &str,
    execution_id: &str,
    value: &Value,
) {
    let event_type = sandbox_output_event_type(value);
    let source = sandbox_output_source(value);
    let item = protocol_item(value);
    let item_type = item
        .and_then(|item| string_at_path(item, &["type"]))
        .unwrap_or_default();
    let turn_id = turn_ids(value).into_iter().next().unwrap_or_default();
    let item_id = item_ids(value).into_iter().next().unwrap_or_default();

    let span = info_span!(
        parent: parent,
        "centaur.api_rs.codex_app_server.event",
        component = COMPONENT_SESSION_RUNTIME,
        event = "codex_app_server_event",
        "centaur.thread_key" = thread_key.as_str(),
        "centaur.execution_id" = execution_id,
        "centaur.sandbox_id" = sandbox_id,
        "codex_app_server.source" = source,
        "codex_app_server.event_type" = event_type,
        "codex_app_server.item_type" = item_type.as_str(),
        "codex_app_server.turn_id" = turn_id.as_str(),
        "codex_app_server.item_id" = item_id.as_str(),
    );
    let _entered = span.enter();
}

fn record_codex_app_server_tool_span(
    parent: &Span,
    thread_key: &ThreadKey,
    sandbox_id: &str,
    execution_id: &str,
    event: &ToolCallSpanEvent,
) {
    let duration_ms = event
        .duration
        .map(|duration| duration.as_secs_f64() * 1000.0);
    let span = info_span!(
        parent: parent,
        "centaur.api_rs.codex_app_server.tool_call",
        component = COMPONENT_SESSION_RUNTIME,
        event = "codex_app_server_tool_call",
        "centaur.thread_key" = thread_key.as_str(),
        "centaur.execution_id" = execution_id,
        "centaur.sandbox_id" = sandbox_id,
        "tool.kind" = event.labels.kind.as_str(),
        "tool.name" = event.labels.name.as_str(),
        "tool.method" = event.labels.method.as_str(),
        "tool.status" = event.status,
        "tool.duration_ms" = tracing::field::Empty,
    );
    if let Some(duration_ms) = duration_ms {
        span.record("tool.duration_ms", duration_ms);
    }
    let _entered = span.enter();
}

fn sandbox_output_event_type(value: &Value) -> &str {
    value
        .get("method")
        .and_then(Value::as_str)
        .or_else(|| value.get("type").and_then(Value::as_str))
        .filter(|event_type| !event_type.trim().is_empty())
        .unwrap_or("json")
}

fn sandbox_output_source(value: &Value) -> &str {
    if value.get("method").and_then(Value::as_str).is_some() {
        return "codex_app_server";
    }
    match value.get("type").and_then(Value::as_str) {
        Some(event_type)
            if event_type.starts_with("item.")
                || event_type.starts_with("turn.")
                || event_type.starts_with("thread.") =>
        {
            "codex_app_server"
        }
        Some("system")
            if value
                .get("subtype")
                .and_then(Value::as_str)
                .is_some_and(|subtype| subtype.starts_with("wrapper_")) =>
        {
            "codex_app_server"
        }
        Some("assistant" | "user" | "tool") => "harness",
        Some(_) | None => "sandbox",
    }
}

fn tool_call_span_events(
    value: &Value,
    known_tool_calls: &mut HashMap<String, ToolCallLabels>,
) -> Vec<ToolCallSpanEvent> {
    let mut events = Vec::new();
    let event_type = sandbox_output_event_type(value);

    if matches!(event_type, "item/started" | "item.started")
        && let Some(item) = protocol_item(value)
        && let Some(labels) = tool_labels_from_item(item)
    {
        remember_tool_call_labels(item, &labels, known_tool_calls);
        events.push(ToolCallSpanEvent {
            labels,
            status: "started",
            duration: None,
        });
    }

    if matches!(event_type, "item/completed" | "item.completed")
        && let Some(item) = protocol_item(value)
    {
        let item_id = string_at_path(item, &["id"]);
        let labels = tool_labels_from_item(item).or_else(|| {
            item_id
                .as_deref()
                .and_then(|item_id| known_tool_calls.get(item_id).cloned())
        });
        if let Some(labels) = labels {
            let status = completed_tool_status(item);
            if let Some(item_id) = item_id {
                known_tool_calls.remove(&item_id);
            }
            events.push(ToolCallSpanEvent {
                labels,
                status,
                duration: duration_from_ms_value(
                    item.get("durationMs").or_else(|| item.get("duration_ms")),
                ),
            });
        }
    }

    if matches!(
        event_type,
        "item/mcpToolCall/progress" | "item.mcpToolCall.progress"
    ) {
        let labels = progress_item_id(value)
            .and_then(|item_id| known_tool_calls.get(&item_id).cloned())
            .unwrap_or_else(|| ToolCallLabels {
                kind: "mcp".to_owned(),
                name: "unknown".to_owned(),
                method: "unknown".to_owned(),
            });
        events.push(ToolCallSpanEvent {
            labels,
            status: "progress",
            duration: None,
        });
    }

    for tool_use in anthropic_tool_uses(value) {
        let labels = ToolCallLabels {
            kind: "anthropic".to_owned(),
            name: string_at_path(tool_use, &["name"]).unwrap_or_else(|| "unknown".to_owned()),
            method: "call".to_owned(),
        };
        if let Some(tool_id) = string_at_path(tool_use, &["id"]) {
            known_tool_calls.insert(tool_id, labels.clone());
        }
        events.push(ToolCallSpanEvent {
            labels,
            status: "started",
            duration: None,
        });
    }

    for tool_result in anthropic_tool_results(value) {
        let labels = string_at_path(tool_result, &["tool_use_id"])
            .and_then(|tool_use_id| known_tool_calls.remove(&tool_use_id))
            .unwrap_or_else(|| ToolCallLabels {
                kind: "anthropic".to_owned(),
                name: "unknown".to_owned(),
                method: "call".to_owned(),
            });
        events.push(ToolCallSpanEvent {
            labels,
            status: if tool_result
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "failed"
            } else {
                "completed"
            },
            duration: None,
        });
    }

    events
}

fn protocol_item(value: &Value) -> Option<&Value> {
    value
        .get("params")
        .and_then(|params| params.get("item"))
        .or_else(|| value.get("item"))
}

fn tool_labels_from_item(item: &Value) -> Option<ToolCallLabels> {
    let item_type = string_at_path(item, &["type"])?;
    match item_type.as_str() {
        "mcpToolCall" | "mcp_tool_call" => Some(ToolCallLabels {
            kind: "mcp".to_owned(),
            name: string_at_path(item, &["tool"]).unwrap_or_else(|| "unknown".to_owned()),
            method: string_at_path(item, &["server"]).unwrap_or_else(|| "call".to_owned()),
        }),
        "dynamicToolCall" | "dynamic_tool_call" => Some(ToolCallLabels {
            kind: "dynamic".to_owned(),
            name: string_at_path(item, &["tool"]).unwrap_or_else(|| "unknown".to_owned()),
            method: string_at_path(item, &["namespace"]).unwrap_or_else(|| "call".to_owned()),
        }),
        "collabAgentToolCall" | "collab_agent_tool_call" => Some(ToolCallLabels {
            kind: "collab_agent".to_owned(),
            name: string_at_path(item, &["tool"]).unwrap_or_else(|| "agent".to_owned()),
            method: "call".to_owned(),
        }),
        _ => None,
    }
}

fn remember_tool_call_labels(
    item: &Value,
    labels: &ToolCallLabels,
    known_tool_calls: &mut HashMap<String, ToolCallLabels>,
) {
    if let Some(item_id) = string_at_path(item, &["id"]) {
        known_tool_calls.insert(item_id, labels.clone());
    }
}

fn completed_tool_status(item: &Value) -> &'static str {
    if item
        .get("success")
        .and_then(Value::as_bool)
        .is_some_and(|success| !success)
        || item.get("error").is_some()
    {
        return "failed";
    }

    if let Some(exit_code) = item.get("exitCode").and_then(Value::as_i64) {
        return if exit_code == 0 {
            "completed"
        } else {
            "failed"
        };
    }

    match item
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("completed")
    {
        "failed" | "error" | "cancelled" | "declined" => "failed",
        "inProgress" | "in_progress" | "running" => "started",
        _ => "completed",
    }
}

fn duration_from_ms_value(value: Option<&Value>) -> Option<Duration> {
    let millis = value.and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_u64().map(|millis| millis as f64))
            .or_else(|| value.as_i64().map(|millis| millis as f64))
    })?;
    if millis.is_finite() && millis >= 0.0 {
        Some(Duration::from_secs_f64(millis / 1000.0))
    } else {
        None
    }
}

fn progress_item_id(value: &Value) -> Option<String> {
    [
        &["params", "itemId"][..],
        &["params", "item_id"][..],
        &["itemId"][..],
        &["item_id"][..],
    ]
    .into_iter()
    .filter_map(|path| string_at_path(value, path))
    .next()
}

fn anthropic_tool_uses(value: &Value) -> Vec<&Value> {
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    content_blocks(value)
        .into_iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("tool_use"))
        .collect()
}

fn anthropic_tool_results(value: &Value) -> Vec<&Value> {
    if !matches!(
        value.get("type").and_then(Value::as_str),
        Some("user" | "tool")
    ) {
        return Vec::new();
    }
    content_blocks(value)
        .into_iter()
        .filter(|part| {
            part.get("type").and_then(Value::as_str) == Some("tool_result")
                || part.get("tool_use_id").and_then(Value::as_str).is_some()
        })
        .collect()
}

fn content_blocks(value: &Value) -> Vec<&Value> {
    value
        .get("content")
        .or_else(|| {
            value
                .get("message")
                .and_then(|message| message.get("content"))
        })
        .and_then(Value::as_array)
        .map(|values| values.iter().collect())
        .unwrap_or_default()
}

#[derive(Debug, Eq, PartialEq)]
enum TerminalOutput {
    Completed {
        reason: &'static str,
        result_text: Option<String>,
    },
    Failed {
        error: String,
    },
}

/// When the user interrupted the turn, a `Failed` terminal (the harness reports
/// `interrupted` with no final answer) becomes a clean user-stop so the session
/// stays steerable, not failed. Every other terminal — including a turn that
/// completed normally in the interrupt race — passes through unchanged. Pure so
/// the coercion can be unit-tested without a store.
fn coerce_terminal_for_user_interrupt(
    terminal: TerminalOutput,
    user_interrupted: bool,
) -> TerminalOutput {
    match terminal {
        TerminalOutput::Failed { .. } if user_interrupted => TerminalOutput::Completed {
            reason: "stopped_by_user",
            result_text: None,
        },
        other => other,
    }
}

async fn record_terminal_output(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    sandbox_id: &str,
    execution_id: &str,
    terminal: TerminalOutput,
) -> Result<(), SessionRuntimeError> {
    // A user-initiated turn interrupt surfaces here as a `Failed` terminal
    // ("interrupted before final answer"). Coerce it to a clean user-stop so
    // the session stays steerable (completed) instead of failed. `remove` also
    // clears the marker unconditionally so it can't leak onto a later turn.
    let user_interrupted = ctx.user_interrupts.remove(execution_id).is_some();
    let terminal = coerce_terminal_for_user_interrupt(terminal, user_interrupted);
    let mut failure_class = None;
    let (terminal_execution, terminal_status) = match terminal {
        TerminalOutput::Completed {
            reason,
            result_text,
        } => {
            let Some(execution) = ctx.store.complete_execution_if_active(execution_id).await?
            else {
                return Ok(());
            };
            let mut payload = json!({
                "execution_id": execution_id,
                "thread_key": thread_key.as_str(),
                "completion_reason": reason,
            });
            if let (Some(result_text), Some(object)) =
                (result_text.as_deref(), payload.as_object_mut())
            {
                object.insert("result_text".to_owned(), json!(result_text));
            }
            ctx.store
                .append_event(
                    thread_key,
                    Some(execution_id),
                    "session.execution_completed",
                    payload,
                )
                .await?;
            (execution, "completed")
        }
        TerminalOutput::Failed { error } => {
            failure_class = Some(terminal_failure_class(&error));
            let Some(execution) = ctx
                .store
                .fail_execution_if_active(execution_id, &error)
                .await?
            else {
                return Ok(());
            };
            ctx.store
                .append_event(
                    thread_key,
                    Some(execution_id),
                    "session.execution_failed",
                    json!({
                        "execution_id": execution_id,
                        "thread_key": thread_key.as_str(),
                        "error": error.as_str(),
                    }),
                )
                .await?;
            (execution, "failed")
        }
    };
    ctx.execution_spans.lock().await.remove(execution_id);
    record_finished_execution_metric(
        &ctx.store,
        thread_key,
        &terminal_execution,
        terminal_status,
        failure_class,
    )
    .await;
    if let Some(idle_timeout) = idle_timeout_from_execution(&terminal_execution) {
        spawn_idle_pause(
            ctx.clone(),
            thread_key.clone(),
            terminal_execution.execution_id,
            sandbox_id.to_owned(),
            idle_timeout,
        );
    }
    Ok(())
}

fn spawn_max_duration_failure(
    ctx: RuntimeContext,
    thread_key: ThreadKey,
    execution_id: String,
    max_duration: Duration,
    idle_timeout: Option<Duration>,
) {
    tokio::spawn(async move {
        sleep(max_duration).await;
        if let Err(error) = record_max_duration_failure(
            &ctx,
            &thread_key,
            &execution_id,
            max_duration,
            idle_timeout,
        )
        .await
        {
            warn!(%thread_key, %execution_id, %error, "max duration failure task failed");
        }
    });
}

async fn record_max_duration_failure(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    execution_id: &str,
    max_duration: Duration,
    idle_timeout: Option<Duration>,
) -> Result<(), SessionRuntimeError> {
    let max_duration_ms = duration_millis_u64(max_duration);
    let error = format!("execution exceeded max_duration_ms={max_duration_ms}");
    let Some(execution) = ctx
        .store
        .fail_execution_if_active(execution_id, &error)
        .await?
    else {
        return Ok(());
    };
    ctx.execution_spans.lock().await.remove(execution_id);
    ctx.store
        .append_event(
            thread_key,
            Some(execution_id),
            "session.execution_failed",
            json!({
                "execution_id": execution_id,
                "thread_key": thread_key.as_str(),
                "error": error,
                "reason": "max_duration_exceeded",
                "max_duration_ms": max_duration_ms,
            }),
        )
        .await?;
    record_finished_execution_metric(
        &ctx.store,
        thread_key,
        &execution,
        "failed",
        Some("timeout"),
    )
    .await;
    if let Some(idle_timeout) = idle_timeout.or_else(|| idle_timeout_from_execution(&execution))
        && let Some(sandbox_id) = ctx.store.get_session(thread_key).await?.sandbox_id
    {
        spawn_idle_pause(
            ctx.clone(),
            thread_key.clone(),
            execution_id.to_owned(),
            sandbox_id,
            idle_timeout,
        );
    }
    Ok(())
}

fn spawn_idle_pause(
    ctx: RuntimeContext,
    thread_key: ThreadKey,
    execution_id: String,
    sandbox_id: String,
    idle_timeout: Duration,
) {
    tokio::spawn(async move {
        sleep(idle_timeout).await;
        if let Err(error) =
            record_idle_pause(&ctx, &thread_key, &execution_id, &sandbox_id, idle_timeout).await
        {
            warn!(%thread_key, %execution_id, %sandbox_id, %error, "idle pause task failed");
        }
    });
}

async fn record_idle_pause(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    execution_id: &str,
    sandbox_id: &str,
    idle_timeout: Duration,
) -> Result<(), SessionRuntimeError> {
    let latest_execution = ctx.store.latest_execution_for_thread(thread_key).await?;
    let session = ctx.store.get_session(thread_key).await?;
    if !should_pause_idle_sandbox(
        &session,
        latest_execution.as_ref(),
        execution_id,
        sandbox_id,
    ) {
        return Ok(());
    }

    let id = SandboxId::new(sandbox_id);
    match ctx.manager.status(&id).await {
        Ok(SandboxStatus::Suspended | SandboxStatus::Stopped | SandboxStatus::Gone) => {
            return Ok(());
        }
        Ok(SandboxStatus::Running | SandboxStatus::Created) => {}
        Ok(SandboxStatus::Unknown(_)) => return Ok(()),
        Err(SandboxError::NotFound(_)) => return Ok(()),
        Err(error) => {
            record_idle_pause_failure(
                &ctx.store,
                thread_key,
                execution_id,
                sandbox_id,
                idle_timeout,
                &error.to_string(),
            )
            .await?;
            return Err(SessionRuntimeError::Sandbox(error));
        }
    }

    ctx.sandbox_pipes.remove(sandbox_id);
    match ctx.manager.pause(&id).await {
        Ok(()) => {
            ctx.store
                .append_event(
                    thread_key,
                    Some(execution_id),
                    "session.sandbox_paused",
                    json!({
                        "execution_id": execution_id,
                        "thread_key": thread_key.as_str(),
                        "sandbox_id": sandbox_id,
                        "reason": "idle_timeout",
                        "idle_timeout_ms": duration_millis_u64(idle_timeout),
                    }),
                )
                .await?;
        }
        Err(error) => {
            record_idle_pause_failure(
                &ctx.store,
                thread_key,
                execution_id,
                sandbox_id,
                idle_timeout,
                &error.to_string(),
            )
            .await?;
            return Err(SessionRuntimeError::Sandbox(error));
        }
    }
    Ok(())
}

async fn record_idle_pause_failure(
    store: &PgSessionStore,
    thread_key: &ThreadKey,
    execution_id: &str,
    sandbox_id: &str,
    idle_timeout: Duration,
    error: &str,
) -> Result<(), SessionRuntimeError> {
    store
        .append_event(
            thread_key,
            Some(execution_id),
            "session.sandbox_pause_failed",
            json!({
                "execution_id": execution_id,
                "thread_key": thread_key.as_str(),
                "sandbox_id": sandbox_id,
                "reason": "idle_timeout",
                "idle_timeout_ms": duration_millis_u64(idle_timeout),
                "error": error,
            }),
        )
        .await?;
    Ok(())
}

fn should_pause_idle_sandbox(
    session: &Session,
    latest_execution: Option<&SessionExecution>,
    execution_id: &str,
    sandbox_id: &str,
) -> bool {
    if session.sandbox_id.as_deref() != Some(sandbox_id) {
        return false;
    }
    let Some(execution) = latest_execution else {
        return false;
    };
    if execution.execution_id != execution_id {
        return false;
    }
    matches!(
        execution.status,
        ExecutionStatus::Completed | ExecutionStatus::Failed | ExecutionStatus::Cancelled
    )
}

fn duration_millis_u64(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

fn clean_persona_id(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() { None } else { Some(value) }
}

fn sandbox_capabilities_match(
    existing: Option<&SessionSandboxCapabilities>,
    desired: &SessionSandboxCapabilities,
) -> bool {
    existing.map_or_else(
        || desired.is_default_enabled(),
        |existing| existing == desired,
    )
}

fn apply_sandbox_capabilities(spec: &mut SandboxSpec, capabilities: &SessionSandboxCapabilities) {
    spec.capabilities = BackendSandboxCapabilities {
        repo_cache_enabled: capabilities.repo_cache_enabled,
        observability_enabled: capabilities.observability_enabled,
    };
    upsert_spec_env(
        spec,
        "CENTAUR_SANDBOX_REPO_CACHE_ENABLED",
        capabilities.repo_cache_enabled.to_string(),
    );
    upsert_spec_env(
        spec,
        "CENTAUR_SANDBOX_OBSERVABILITY_ENABLED",
        capabilities.observability_enabled.to_string(),
    );
    if !capabilities.repo_cache_enabled {
        spec.mounts
            .retain(|mount| mount.target_path != SANDBOX_REPO_CACHE_MOUNT_PATH);
    }
    if !capabilities.observability_enabled {
        append_spec_env_csv(spec, "TOOL_BLOCKLIST", OBSERVABILITY_TOOL_BLOCKLIST);
    }
}

fn upsert_spec_env(spec: &mut SandboxSpec, name: &str, value: String) {
    if let Some(existing) = spec.env.iter_mut().find(|env| env.name == name) {
        existing.value = value;
    } else {
        spec.env
            .push(centaur_sandbox_core::EnvVar::new(name, value));
    }
}

fn append_spec_env_csv(spec: &mut SandboxSpec, name: &str, values: &str) {
    let existing = spec
        .env
        .iter()
        .find(|env| env.name == name)
        .map(|env| env.value.as_str())
        .unwrap_or("");
    let merged = if existing.trim().is_empty() {
        values.to_owned()
    } else {
        format!("{existing},{values}")
    };
    upsert_spec_env(spec, name, merged);
}

fn apply_resume_thread_env(
    mut spec: SandboxSpec,
    harness_type: &HarnessType,
    resume_thread_id: Option<&str>,
) -> SandboxSpec {
    let Some(resume_thread_id) = resume_thread_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return spec;
    };
    spec = spec
        .env("CENTAUR_HARNESS_TRANSCRIPT_RESTORE", "1")
        .env("CENTAUR_RESUME_THREAD_ID", resume_thread_id);
    if harness_type == &HarnessType::Codex {
        spec = spec.env("CODEX_CONTINUE_THREAD_ID", resume_thread_id);
    }
    spec
}

fn apply_persona_spec_env(mut spec: SandboxSpec, persona: Option<&PersonaContext>) -> SandboxSpec {
    for name in [
        "AGENT_PERSONA",
        "CENTAUR_PERSONA_ID",
        "CENTAUR_PERSONA_PROMPT_HASH",
        "CENTAUR_PERSONA_SOURCE_PATH",
        "CENTAUR_PERSONA_SOURCE_REF",
    ] {
        remove_spec_env(&mut spec, name);
    }
    let Some(persona) = persona else {
        return spec;
    };
    upsert_spec_env(&mut spec, "AGENT_PERSONA", persona.persona_id.clone());
    upsert_spec_env(&mut spec, "CENTAUR_PERSONA_ID", persona.persona_id.clone());
    upsert_spec_env(
        &mut spec,
        "CENTAUR_PERSONA_PROMPT_HASH",
        persona.prompt_hash.clone(),
    );
    upsert_spec_env(
        &mut spec,
        "CENTAUR_PERSONA_SOURCE_PATH",
        persona.source_path.clone(),
    );
    if let Some(source_ref) = persona.source_ref.as_ref() {
        upsert_spec_env(&mut spec, "CENTAUR_PERSONA_SOURCE_REF", source_ref.clone());
    }
    spec
}

fn remove_spec_env(spec: &mut SandboxSpec, name: &str) {
    spec.env.retain(|env| env.name != name);
}

fn add_persona_metadata(metadata: &mut Value, context: &PersonaContext) {
    if let Value::Object(object) = metadata {
        object.insert("persona".to_owned(), json!(context));
    }
}

async fn record_finished_execution_metric(
    store: &PgSessionStore,
    thread_key: &ThreadKey,
    execution: &SessionExecution,
    status: &'static str,
    failure_class: Option<&'static str>,
) {
    let harness_label = match store.get_session(thread_key).await {
        Ok(session) => session.harness_type.to_string(),
        Err(error) => {
            warn!(%thread_key, %error, "failed to load session for execution metric labels");
            "unknown".to_owned()
        }
    };
    record_session_execution_finished(&harness_label, status, execution_duration(execution));
    if let Some(failure_class) = failure_class {
        record_session_failure(&harness_label, failure_class);
    }
}

fn execution_duration(execution: &SessionExecution) -> Option<Duration> {
    let started_at = execution.started_at.unwrap_or(execution.created_at);
    let completed_at = execution.completed_at?;
    (completed_at - started_at).try_into().ok()
}

fn runtime_error_failure_class(error: &SessionRuntimeError) -> &'static str {
    match error {
        SessionRuntimeError::BadRequest(_) => "bad_request",
        SessionRuntimeError::Store(_) => "store",
        SessionRuntimeError::Sandbox(SandboxError::NotFound(_)) => "sandbox_not_found",
        SessionRuntimeError::Sandbox(SandboxError::Unsupported { .. }) => "sandbox_unsupported",
        SessionRuntimeError::Sandbox(SandboxError::NotReady(_)) => "sandbox_not_ready",
        SessionRuntimeError::Sandbox(SandboxError::Io { .. }) => "sandbox_io",
        SessionRuntimeError::Sandbox(SandboxError::Backend { .. }) => "sandbox_backend",
        SessionRuntimeError::Sandbox(SandboxError::InvalidSpec(_)) => "sandbox_invalid_spec",
        SessionRuntimeError::IronControl(_) => "iron_control",
        SessionRuntimeError::WarmPool(_) => "warm_pool",
    }
}

fn terminal_failure_class(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    if error.contains("max_duration") || error.contains("timeout") || error.contains("timed out") {
        return "timeout";
    }
    if error.contains("execution orphaned") {
        return "orphaned";
    }
    if error.contains("sandbox stdout") || error.contains("stdout closed") {
        return "sandbox_io";
    }
    "harness"
}

fn should_attach_session_pipe(status: &SandboxStatus) -> bool {
    status.can_open_io()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExistingSandboxAction {
    Reuse,
    ResumeOrReplace,
    Replace,
}

fn existing_sandbox_action(status: &SandboxStatus) -> ExistingSandboxAction {
    match status {
        SandboxStatus::Running => ExistingSandboxAction::Reuse,
        SandboxStatus::Created | SandboxStatus::Suspended => ExistingSandboxAction::ResumeOrReplace,
        SandboxStatus::Stopped | SandboxStatus::Gone | SandboxStatus::Unknown(_) => {
            ExistingSandboxAction::Replace
        }
    }
}

fn is_event_stream_attach_race(error: &SessionRuntimeError) -> bool {
    matches!(
        error,
        SessionRuntimeError::Sandbox(SandboxError::NotReady(_))
    )
}

fn terminal_output(value: &Value, prior_final_answer_text: &str) -> Option<TerminalOutput> {
    let method = value.get("method").and_then(Value::as_str);
    let event_type = value.get("type").and_then(Value::as_str);

    if matches!(method, Some("error" | "turn/failed"))
        || matches!(event_type, Some("error" | "turn.failed"))
    {
        return Some(TerminalOutput::Failed {
            error: terminal_error_text(value),
        });
    }

    if method == Some("turn/completed") {
        return Some(completed_turn_terminal_output(
            value,
            prior_final_answer_text,
        ));
    }

    match event_type {
        Some("turn.completed") => Some(completed_turn_terminal_output(
            value,
            prior_final_answer_text,
        )),
        Some("turn.done") => Some(completed_terminal_output(value, "turn_done")),
        Some("result") => {
            if result_is_failure(value) {
                Some(TerminalOutput::Failed {
                    error: terminal_error_text(value),
                })
            } else {
                Some(completed_terminal_output(value, "result"))
            }
        }
        _ => None,
    }
}

fn completed_turn_terminal_output(value: &Value, prior_final_answer_text: &str) -> TerminalOutput {
    match turn_completion_status(value).as_deref() {
        Some("completed" | "succeeded" | "success") | None => {
            completed_terminal_output_with_fallback(
                value,
                "turn_completed",
                prior_final_answer_text,
            )
        }
        Some(_status) if !prior_final_answer_text.trim().is_empty() => {
            completed_terminal_output_with_fallback(
                value,
                "turn_completed",
                prior_final_answer_text,
            )
        }
        Some(status) => TerminalOutput::Failed {
            error: format!("turn completed with status {status} before final answer"),
        },
    }
}

fn completed_terminal_output(value: &Value, reason: &'static str) -> TerminalOutput {
    completed_terminal_output_with_fallback(value, reason, "")
}

fn completed_terminal_output_with_fallback(
    value: &Value,
    reason: &'static str,
    fallback_text: &str,
) -> TerminalOutput {
    let result_text = terminal_payload_text(value).trim().to_owned();
    let result_text = if result_text.is_empty() {
        fallback_text.trim().to_owned()
    } else {
        result_text
    };
    TerminalOutput::Completed {
        reason,
        result_text: (!result_text.is_empty()).then_some(result_text),
    }
}

fn turn_completion_status(value: &Value) -> Option<String> {
    [
        &["turn", "status"][..],
        &["params", "turn", "status"][..],
        &["status"][..],
        &["params", "status"][..],
    ]
    .into_iter()
    .filter_map(|path| string_at_path(value, path))
    .next()
}

enum FinalAnswerTextUpdate {
    Append(String),
    Replace(String),
}

fn output_line_final_answer_text(value: &Value) -> Option<FinalAnswerTextUpdate> {
    let method = value.get("method").and_then(Value::as_str);
    let event_type = value.get("type").and_then(Value::as_str);
    if matches!(method, Some("item/agentMessage/delta"))
        || matches!(event_type, Some("item.agentMessage.delta"))
    {
        let text = terminal_payload_text(value).trim().to_owned();
        return (!text.is_empty()).then_some(FinalAnswerTextUpdate::Append(text));
    }
    if event_type == Some("assistant") {
        let text = terminal_payload_text(value).trim().to_owned();
        return (!text.is_empty()).then_some(FinalAnswerTextUpdate::Replace(text));
    }
    if matches!(method, Some("item/completed")) || matches!(event_type, Some("item.completed")) {
        let item = value
            .get("item")
            .or_else(|| value.get("params").and_then(|params| params.get("item")));
        if let Some(item) = item
            && matches!(
                item.get("type").and_then(Value::as_str),
                Some("agentMessage" | "agent_message")
            )
            && matches!(
                item.get("phase").and_then(Value::as_str),
                Some("final_answer" | "answer") | None
            )
        {
            let text = terminal_payload_text(item).trim().to_owned();
            return (!text.is_empty()).then_some(FinalAnswerTextUpdate::Replace(text));
        }
    }
    None
}

fn turn_ids(value: &Value) -> Vec<String> {
    [
        &["turn_id"][..],
        &["turnId"][..],
        &["turn", "id"][..],
        &["params", "turnId"][..],
        &["params", "turn", "id"][..],
    ]
    .into_iter()
    .filter_map(|path| string_at_path(value, path))
    .collect()
}

fn item_ids(value: &Value) -> Vec<String> {
    [
        &["item_id"][..],
        &["itemId"][..],
        &["item", "id"][..],
        &["params", "itemId"][..],
        &["params", "item", "id"][..],
    ]
    .into_iter()
    .filter_map(|path| string_at_path(value, path))
    .collect()
}

fn string_at_path(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    let text = current.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn result_is_failure(value: &Value) -> bool {
    matches!(
        value.get("subtype").and_then(Value::as_str),
        Some("error" | "failure" | "failed")
    )
}

fn terminal_error_text(value: &Value) -> String {
    for key in ["error", "message", "result", "text"] {
        if let Some(text) = value.get(key).and_then(Value::as_str)
            && !text.trim().is_empty()
        {
            return text.trim().to_owned();
        }
    }
    terminal_payload_text(value)
        .trim()
        .to_owned()
        .if_empty("terminal harness output reported failure")
}

fn terminal_payload_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(values) => values
            .iter()
            .map(terminal_payload_text)
            .find(|text| !text.trim().is_empty())
            .unwrap_or_default(),
        Value::Object(object) => {
            for key in [
                "result",
                "result_text",
                "text",
                "final_text",
                "message",
                "delta",
                "content",
                "params",
            ] {
                if let Some(text) = object.get(key).map(terminal_payload_text)
                    && !text.trim().is_empty()
                {
                    return text;
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

trait StringExt {
    fn if_empty(self, fallback: &str) -> String;
}

impl StringExt for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_owned()
        } else {
            self
        }
    }
}

async fn drain_stderr(mut stderr: SandboxRead) -> Result<(), SessionRuntimeError> {
    io::copy(&mut stderr, &mut io::sink())
        .await
        .map_err(|err| {
            SessionRuntimeError::Sandbox(SandboxError::io_source("drain stderr", err))
        })?;
    Ok(())
}

/// Write a single `interrupt` control frame to the harness stdin. The
/// harness-server parses this line into `BlocksCommand::Interrupt` and, while a
/// turn is running, aborts it (codex `turn/interrupt`; claude SDK bridge
/// `{"type":"interrupt"}` abort). Mirrors `write_input_lines` but sends one
/// control line instead of user input.
async fn write_interrupt_frame(
    pipe: &SessionPipe,
    thread_key: &ThreadKey,
    execution_id: &str,
) -> Result<(), SessionRuntimeError> {
    let mut stdin = pipe.stdin.lock().await;
    stdin
        .send(&json!({ "type": "interrupt" }).to_string())
        .await
        .map_err(codec_error_to_runtime)?;
    info!(
        component = COMPONENT_SESSION_RUNTIME,
        event = "sandbox_interrupt_delivered",
        thread_key = %thread_key,
        execution_id,
        "turn interrupt frame written to sandbox stdin"
    );
    Ok(())
}

async fn write_input_lines(
    pipe: &SessionPipe,
    input_lines: &[String],
    thread_key: &ThreadKey,
    execution_id: &str,
    sandbox_id: Option<&str>,
) -> Result<(), SessionRuntimeError> {
    let sandbox_id = sandbox_id.unwrap_or("");
    let span = info_span!(
        "centaur.api_rs.sandbox.write_input",
        component = COMPONENT_SESSION_RUNTIME,
        event = "sandbox_write_input",
        "centaur.thread_key" = thread_key.as_str(),
        "centaur.execution_id" = execution_id,
        "centaur.sandbox_id" = sandbox_id,
        thread_key = %thread_key,
        execution_id,
        sandbox_id,
        input_line_count = input_lines.len(),
    );
    async {
        let mut stdin = pipe.stdin.lock().await;
        for line in input_lines {
            stdin.send(line).await.map_err(codec_error_to_runtime)?;
        }
        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "sandbox_write_input_completed",
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
            input_line_count = input_lines.len(),
            "sandbox input written"
        );
        Ok(())
    }
    .instrument(span)
    .await
}

/// Trace identity injected into sandbox stdin lines so the Rust harness server
/// can configure the harness OTLP export. Without a `trace_id` or `traceparent`
/// on the first turn, Codex exports no `session_task.turn` spans and Laminar
/// has no token usage to price into cost.
#[derive(Clone, Debug)]
struct SessionTraceContext {
    /// Stable per-thread trace id, derived from the thread key (UUIDv5) so it
    /// needs no persisted state and survives API restarts.
    trace_id: String,
    /// W3C traceparent of the current execution span, when the OpenTelemetry
    /// layer is active. Lets harness spans join the execution's trace.
    traceparent: Option<String>,
}

impl SessionTraceContext {
    fn new(thread_key: &ThreadKey, execution_span: Option<&Span>) -> Self {
        Self {
            trace_id: thread_trace_id(thread_key),
            traceparent: execution_span.and_then(centaur_telemetry::traceparent_for_span),
        }
    }
}

/// Deterministic per-thread trace id: one trace identity per thread without a
/// `thread_traces` table (derive, don't store).
pub fn thread_trace_id(thread_key: &ThreadKey) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("centaur:thread:{}", thread_key.as_str()).as_bytes(),
    )
    .to_string()
}

fn ensure_thread_trace_root_span(thread_key: &ThreadKey) {
    let trace_id = thread_trace_id(thread_key);
    let root_span_id = thread_trace_parent_span_id(thread_key);
    let thread_key = thread_key.as_str().to_owned();
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            let _ = export_thread_trace_root_span(&trace_id, &root_span_id, &thread_key).await;
        });
    }
}

pub fn thread_trace_parent_span_id(thread_key: &ThreadKey) -> String {
    let digest = Sha256::digest(format!("centaur:thread-parent:{}", thread_key.as_str()));
    let mut bytes = [0_u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    if bytes.iter().all(|byte| *byte == 0) {
        bytes[7] = 1;
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn input_lines_with_session_context(
    thread_key: &ThreadKey,
    trace: &SessionTraceContext,
    input_lines: &[String],
) -> Vec<String> {
    input_lines
        .iter()
        .map(|line| input_line_with_session_context(thread_key, trace, line))
        .collect()
}

fn input_line_with_session_context(
    thread_key: &ThreadKey,
    trace: &SessionTraceContext,
    line: &str,
) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(line) else {
        return line.to_owned();
    };
    let Value::Object(map) = &mut value else {
        return line.to_owned();
    };
    map.entry("thread_key")
        .or_insert_with(|| Value::String(thread_key.as_str().to_owned()));
    map.entry("trace_id")
        .or_insert_with(|| Value::String(trace.trace_id.clone()));
    if let Some(traceparent) = &trace.traceparent {
        map.entry("traceparent")
            .or_insert_with(|| Value::String(traceparent.clone()));
    }
    merge_session_context(map, session_context_for_thread(thread_key));
    serde_json::to_string(&value).unwrap_or_else(|_| line.to_owned())
}

fn merge_session_context(
    map: &mut serde_json::Map<String, Value>,
    context: Option<serde_json::Map<String, Value>>,
) {
    let Some(context) = context else {
        return;
    };
    let entry = map
        .entry("session_context")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Value::Object(existing) = entry else {
        return;
    };
    for (key, value) in context {
        existing.entry(key).or_insert(value);
    }
}

fn session_context_for_thread(thread_key: &ThreadKey) -> Option<serde_json::Map<String, Value>> {
    let slack = slack_context_for_thread(thread_key)?;
    let mut context = serde_json::Map::new();
    context.insert("platform".to_owned(), Value::String("slack".to_owned()));
    context.insert("slack".to_owned(), Value::Object(slack));
    Some(context)
}

fn slack_context_for_thread(thread_key: &ThreadKey) -> Option<serde_json::Map<String, Value>> {
    let parts = thread_key.as_str().split(':').collect::<Vec<_>>();
    let (team_id, channel_id, thread_ts) = match parts.as_slice() {
        ["slack", channel_id, thread_ts] => (None, *channel_id, *thread_ts),
        ["slack", team_id, channel_id, thread_ts] => (Some(*team_id), *channel_id, *thread_ts),
        [channel_id, thread_ts] if is_slack_conversation_id(channel_id) => {
            (None, *channel_id, *thread_ts)
        }
        _ => return None,
    };
    if channel_id.is_empty() || thread_ts.is_empty() {
        return None;
    }

    let mut slack = serde_json::Map::new();
    if let Some(team_id) = team_id.filter(|value| !value.is_empty()) {
        slack.insert("team_id".to_owned(), Value::String(team_id.to_owned()));
    }
    slack.insert(
        "channel_id".to_owned(),
        Value::String(channel_id.to_owned()),
    );
    slack.insert("thread_ts".to_owned(), Value::String(thread_ts.to_owned()));
    Some(slack)
}

fn is_slack_conversation_id(value: &str) -> bool {
    matches!(value.as_bytes().first(), Some(b'C' | b'D' | b'G'))
}

fn steering_input_lines(
    thread_key: &ThreadKey,
    messages: &[SessionMessageInput],
    message_ids: &[String],
) -> Vec<String> {
    messages
        .iter()
        .zip(message_ids)
        .filter_map(|(message, message_id)| steering_input_line(thread_key, message, message_id))
        .collect()
}

fn steering_input_line(
    thread_key: &ThreadKey,
    message: &SessionMessageInput,
    message_id: &str,
) -> Option<String> {
    if message.role != MessageRole::User {
        return None;
    }
    serde_json::to_string(&json!({
        "type": "user",
        "thread_key": thread_key.as_str(),
        "trace_metadata": {
            "source": "session.append_messages",
            "action": "steer_active_execution",
            "message_id": message_id,
            "metadata": message.metadata.clone(),
        },
        "message": {
            "role": message.role.as_ref(),
            "content": message.parts.clone(),
        },
    }))
    .ok()
}

async fn append_output_line(
    store: &PgSessionStore,
    thread_key: &ThreadKey,
    execution_id: Option<&str>,
    line: &str,
) -> Result<SessionEvent, SessionRuntimeError> {
    let safe_line = redact_sensitive_text(line);
    let event = store
        .append_event(
            thread_key,
            execution_id,
            SESSION_OUTPUT_LINE_EVENT,
            Value::String(safe_line),
        )
        .await?;
    Ok(event)
}

fn output_line_question_event_matches(
    event: &SessionEvent,
    question_id: &str,
    expected_type: &str,
) -> bool {
    if event.event_type != SESSION_OUTPUT_LINE_EVENT {
        return false;
    }
    let Some(line) = event.payload.as_str() else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    value.get("type").and_then(Value::as_str) == Some(expected_type)
        && value.get("question_id").and_then(Value::as_str) == Some(question_id)
}

fn event_question_id_matches(
    event: &SessionEvent,
    question_id: &str,
    expected_event_type: &str,
) -> bool {
    event.event_type == expected_event_type
        && event.payload.get("question_id").and_then(Value::as_str) == Some(question_id)
}

fn redact_sensitive_text(input: &str) -> String {
    let bearer_redacted = redact_bearer_tokens(input);
    let env_redacted = redact_sensitive_env_assignments(&bearer_redacted);
    redact_prefixed_tokens(&env_redacted)
}

fn redact_bearer_tokens(input: &str) -> String {
    const BEARER: &str = "bearer ";
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;

    while let Some(relative) = lower[index..].find(BEARER) {
        let start = index + relative;
        let token_start = start + BEARER.len();
        let token_end = consume_sensitive_token(input, token_start);
        out.push_str(&input[index..token_start]);
        if token_end > token_start {
            out.push_str("[REDACTED_TOKEN]");
            index = token_end;
        } else {
            index = token_start;
        }
    }

    out.push_str(&input[index..]);
    out
}

fn redact_sensitive_env_assignments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut index = 0;

    while let Some(relative) = input[index..].find('=') {
        let equals = index + relative;
        let key_start = env_key_start(input, equals);
        let key = &input[key_start..equals];
        out.push_str(&input[index..=equals]);
        if is_sensitive_env_key(key) {
            let token_start = equals + 1;
            let token_end = consume_sensitive_token(input, token_start);
            if token_end > token_start {
                out.push_str("[REDACTED_TOKEN]");
                index = token_end;
                continue;
            }
        }
        index = equals + 1;
    }

    out.push_str(&input[index..]);
    out
}

fn redact_prefixed_tokens(input: &str) -> String {
    const PREFIXES: &[&str] = &[
        "sbx1.",
        "xoxa-",
        "xoxb-",
        "xoxp-",
        "xoxr-",
        "xoxs-",
        "sk-ant-",
        "sk-",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
    ];

    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if let Some(prefix) = PREFIXES
            .iter()
            .find(|prefix| input[index..].starts_with(**prefix))
        {
            let token_end = consume_sensitive_token(input, index + prefix.len());
            out.push_str("[REDACTED_TOKEN]");
            index = token_end;
            continue;
        }

        let ch = input[index..].chars().next().expect("valid char boundary");
        out.push(ch);
        index += ch.len_utf8();
    }

    out
}

fn consume_sensitive_token(input: &str, start: usize) -> usize {
    let mut end = start;
    for (relative, ch) in input[start..].char_indices() {
        if !is_sensitive_token_char(ch) {
            break;
        }
        end = start + relative + ch.len_utf8();
    }
    end
}

fn is_sensitive_token_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '=' | '+' | '/' | '.' | ':')
}

fn env_key_start(input: &str, equals: usize) -> usize {
    let mut start = equals;
    for (index, ch) in input[..equals].char_indices().rev() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-') {
            start = index;
        } else {
            break;
        }
    }
    start
}

fn is_sensitive_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.contains("API_KEY")
        || upper.contains("TOKEN")
        || upper.contains("SECRET")
        || upper.contains("PASSWORD")
}

async fn execution_still_active(
    store: &PgSessionStore,
    thread_key: &ThreadKey,
    execution_id: &str,
) -> bool {
    matches!(
        store.active_execution_for_thread(thread_key).await,
        Ok(Some(execution)) if execution.execution_id == execution_id
    )
}

fn is_transient_steering_startup_error(error: &SessionRuntimeError) -> bool {
    matches!(
        error,
        SessionRuntimeError::Sandbox(SandboxError::NotFound(_))
            | SessionRuntimeError::Sandbox(SandboxError::NotReady(_))
    )
}

fn harness_thread_id_from_output_line(line: &str) -> Option<String> {
    let value: Value = serde_json::from_str(line).ok()?;
    let event_type = value.get("type").and_then(Value::as_str);
    if event_type != Some("thread.started") {
        return None;
    }
    value
        .get("thread_id")
        .or_else(|| value.get("threadId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())
        .map(ToOwned::to_owned)
}

fn validate_input_lines(lines: &[String]) -> Result<(), SessionRuntimeError> {
    for (index, line) in lines.iter().enumerate() {
        if line.contains('\n') || line.contains('\r') {
            return Err(SessionRuntimeError::BadRequest(format!(
                "input_lines[{index}] must be one line"
            )));
        }
    }
    Ok(())
}

fn validate_execution_environment(
    harness_type: &HarnessType,
    environment: BTreeMap<String, String>,
) -> Result<Vec<(String, String)>, SessionRuntimeError> {
    if environment.is_empty() {
        return Ok(Vec::new());
    }
    let allowed_name = match harness_type {
        HarnessType::ClaudeCode => CLAUDE_CODE_OAUTH_TOKEN_ENV,
        HarnessType::Codex => CODEX_AUTH_JSON_ENV,
        _ => {
            return Err(SessionRuntimeError::BadRequest(
                "execution environment is only supported for codex or claudecode sessions"
                    .to_owned(),
            ));
        }
    };
    let mut allowed = Vec::new();
    for (name, value) in environment {
        if name != allowed_name {
            return Err(SessionRuntimeError::BadRequest(format!(
                "unsupported execution environment variable: {name}"
            )));
        }
        if value.is_empty() {
            return Err(SessionRuntimeError::BadRequest(format!(
                "execution environment variable {name} must not be empty"
            )));
        }
        allowed.push((name, value));
    }
    Ok(allowed)
}

fn stdout_pump_error_message(error: &LinesCodecError) -> String {
    match error {
        LinesCodecError::MaxLineLengthExceeded => {
            "sandbox stdout line exceeded codec maximum length".to_owned()
        }
        LinesCodecError::Io(error) => format!("sandbox stdout I/O failed: {error}"),
    }
}

fn codec_error_to_runtime(error: LinesCodecError) -> SessionRuntimeError {
    let context = error.to_string();
    SessionRuntimeError::Sandbox(SandboxError::Io {
        context,
        source: Some(Box::new(error)),
    })
}

fn duration_options(
    idle_timeout_ms: Option<u64>,
    max_duration_ms: Option<u64>,
) -> Result<(Option<Duration>, Option<Duration>), SessionRuntimeError> {
    let idle_timeout = idle_timeout_ms.map(nonzero_duration_millis).transpose()?;
    let max_duration = max_duration_ms.map(nonzero_duration_millis).transpose()?;

    if let (Some(idle_timeout), Some(max_duration)) = (idle_timeout, max_duration)
        && idle_timeout > max_duration
    {
        return Err(SessionRuntimeError::BadRequest(
            "idle_timeout_ms must be less than or equal to max_duration_ms".to_owned(),
        ));
    }

    Ok((idle_timeout, max_duration))
}

fn nonzero_duration_millis(value: u64) -> Result<Duration, SessionRuntimeError> {
    if value == 0 {
        return Err(SessionRuntimeError::BadRequest(
            "duration values must be greater than zero".to_owned(),
        ));
    }
    Ok(Duration::from_millis(value))
}

fn execution_metadata(
    metadata: Option<Value>,
    idle_timeout_ms: Option<u64>,
    max_duration_ms: Option<u64>,
) -> Value {
    let mut metadata = default_metadata(metadata);
    if let Value::Object(object) = &mut metadata {
        if let Some(value) = idle_timeout_ms {
            object.insert("idle_timeout_ms".to_owned(), json!(value));
        }
        if let Some(value) = max_duration_ms {
            object.insert("max_duration_ms".to_owned(), json!(value));
        }
    }
    metadata
}

fn session_repos_json(metadata: &Value) -> Option<String> {
    let repos = metadata.get(SESSION_REPOS_METADATA_KEY)?;
    match repos {
        Value::Array(entries) if !entries.is_empty() => Some(repos.to_string()),
        _ => None,
    }
}

fn compose_spec_repos_json(
    spec: &mut SandboxSpec,
    session_repos_json: Option<&str>,
    iron_control_principal: Option<&str>,
) -> Result<Option<String>, SessionRuntimeError> {
    let workload_repos_json = take_spec_env(spec, AGENT_REPOS_JSON_ENV);
    let Some(repos_json) = merge_repos_json(workload_repos_json.as_deref(), session_repos_json)
    else {
        return Ok(None);
    };
    scope_private_repo_entries(&repos_json, iron_control_principal)
        .map(Some)
        .map_err(SessionRuntimeError::BadRequest)
}

fn take_spec_env(spec: &mut SandboxSpec, name: &str) -> Option<String> {
    let index = spec.env.iter().position(|env| env.name == name)?;
    Some(spec.env.remove(index).value)
}

fn merge_repos_json(
    default_repos_json: Option<&str>,
    session_repos_json: Option<&str>,
) -> Option<String> {
    let mut repos = parse_repo_array(default_repos_json);
    let session_repos = parse_repo_array(session_repos_json);
    for repo in session_repos {
        let Some(repo_name) = repo.get("repo").and_then(Value::as_str) else {
            continue;
        };
        if let Some(existing) = repos.iter_mut().find(|existing| {
            existing
                .get("repo")
                .and_then(Value::as_str)
                .is_some_and(|existing_repo| existing_repo == repo_name)
        }) {
            *existing = repo;
        } else {
            repos.push(repo);
        }
    }
    (!repos.is_empty()).then(|| Value::Array(repos).to_string())
}

fn parse_repo_array(repos_json: Option<&str>) -> Vec<Value> {
    let Some(repos_json) = repos_json.map(str::trim).filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(repos_json) {
        Ok(Value::Array(mut entries)) => {
            for entry in &mut entries {
                strip_internal_repo_cache_fields(entry);
            }
            entries
        }
        Ok(_) | Err(_) => Vec::new(),
    }
}

fn strip_internal_repo_cache_fields(repo: &mut Value) {
    if let Some(object) = repo.as_object_mut() {
        object.remove("cache_path");
        object.remove("resolved_sha");
    }
}

fn scope_private_repo_entries(
    repos_json: &str,
    iron_control_principal: Option<&str>,
) -> Result<String, String> {
    let mut repos = parse_repo_array(Some(repos_json));
    for repo in &mut repos {
        if !repo_is_private(repo) {
            continue;
        }
        let principal = iron_control_principal.ok_or_else(|| {
            format!(
                "private repo {:?} requires a session iron-control principal",
                repo.get("repo")
                    .and_then(Value::as_str)
                    .unwrap_or("<unknown>")
            )
        })?;
        let object = repo
            .as_object_mut()
            .ok_or_else(|| "repo entry must be a JSON object".to_string())?;
        object.insert(
            "cache_scope".to_owned(),
            json!({"kind": "principal", "principal_id": principal}),
        );
    }
    Ok(Value::Array(repos).to_string())
}

fn repo_is_private(repo: &Value) -> bool {
    repo.get("private")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || repo
            .get("visibility")
            .and_then(Value::as_str)
            .is_some_and(|visibility| visibility.eq_ignore_ascii_case("private"))
}

fn repos_json_contains_private_repo(repos_json: &str) -> bool {
    parse_repo_array(Some(repos_json))
        .iter()
        .any(repo_is_private)
}

fn idle_timeout_from_execution(execution: &SessionExecution) -> Option<Duration> {
    execution
        .metadata
        .get("idle_timeout_ms")
        .and_then(Value::as_u64)
        .and_then(|value| nonzero_duration_millis(value).ok())
}

fn max_duration_from_execution(execution: &SessionExecution) -> Option<Duration> {
    execution
        .metadata
        .get("max_duration_ms")
        .and_then(Value::as_u64)
        .and_then(|value| nonzero_duration_millis(value).ok())
}

/// Folds recorded sandbox output the same way the live stdout pump does,
/// returning the first terminal outcome (with its accumulated final answer)
/// if the recorded history already contains the end of the turn.
fn terminal_output_from_lines(lines: &[String]) -> Option<TerminalOutput> {
    let mut final_answer_text = String::new();
    for line in lines {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(update) = output_line_final_answer_text(&value) {
            match update {
                FinalAnswerTextUpdate::Append(delta) => final_answer_text.push_str(&delta),
                FinalAnswerTextUpdate::Replace(canonical) => final_answer_text = canonical,
            }
        }
        if let Some(terminal) = terminal_output(&value, &final_answer_text) {
            return Some(terminal);
        }
    }
    None
}

#[derive(Debug, Error)]
pub enum SessionRuntimeError {
    #[error("{0}")]
    BadRequest(String),
    #[error(transparent)]
    Store(#[from] SessionStoreError),
    #[error(transparent)]
    Sandbox(#[from] SandboxError),
    #[error(transparent)]
    IronControl(#[from] centaur_iron_control::IronControlError),
    #[error(transparent)]
    WarmPool(#[from] WarmPoolError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use centaur_sandbox_core::MountKind;
    use centaur_session_core::SessionStatus;
    use serde_json::json;
    use time::OffsetDateTime;

    #[test]
    fn stdout_pump_max_line_error_is_stable() {
        assert_eq!(
            stdout_pump_error_message(&LinesCodecError::MaxLineLengthExceeded),
            "sandbox stdout line exceeded codec maximum length"
        );
    }

    #[test]
    fn output_line_question_event_match_requires_output_line_type_and_question_id() {
        let event = session_event(
            1,
            SESSION_OUTPUT_LINE_EVENT,
            Value::String(
                json!({
                    "type": "question_requested",
                    "question_id": "q-1",
                })
                .to_string(),
            ),
        );
        assert!(output_line_question_event_matches(
            &event,
            "q-1",
            "question_requested"
        ));
        assert!(!output_line_question_event_matches(
            &event,
            "q-2",
            "question_requested"
        ));
        assert!(!output_line_question_event_matches(
            &event,
            "q-1",
            "question_resolved"
        ));

        let canonical_event = session_event(
            2,
            "question_requested",
            json!({"type": "question_requested", "question_id": "q-1"}),
        );
        assert!(!output_line_question_event_matches(
            &canonical_event,
            "q-1",
            "question_requested"
        ));

        let delivered_event = session_event(
            3,
            "session.question_answer_delivered",
            json!({"question_id": "q-1"}),
        );
        assert!(event_question_id_matches(
            &delivered_event,
            "q-1",
            "session.question_answer_delivered"
        ));
        assert!(!event_question_id_matches(
            &delivered_event,
            "q-2",
            "session.question_answer_delivered"
        ));
    }

    #[test]
    fn persona_registry_validates_default_and_summarizes_without_prompt() {
        let registry = PersonaRegistry::new(
            [PersonaDefinition {
                id: "eng".to_owned(),
                source_root: "/repo/tools".to_owned(),
                source_path: "/repo/tools/personas/eng".to_owned(),
                source_ref: Some("abc123".to_owned()),
                prompt_hash: "sha256:prompt".to_owned(),
                prompt: "secret prompt".to_owned(),
            }],
            Some("eng".to_owned()),
            vec!["/repo/tools".to_owned()],
        )
        .unwrap();

        let summaries = registry.summaries();

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "eng");
        assert!(
            serde_json::to_value(registry.get("eng").unwrap())
                .unwrap()
                .get("prompt")
                .is_none()
        );
        assert!(PersonaRegistry::new(Vec::new(), Some("missing".to_owned()), Vec::new()).is_err());
    }

    #[test]
    fn turn_completed_without_answer_text_is_terminal() {
        let event = json!({
            "type": "turn.completed",
            "turn": {"id": "turn-1", "status": "completed"},
        });

        assert_eq!(
            terminal_output(&event, ""),
            Some(TerminalOutput::Completed {
                reason: "turn_completed",
                result_text: None
            })
        );
    }

    #[test]
    fn turn_completed_after_answer_text_is_terminal() {
        let delta = json!({
            "method": "item/agentMessage/delta",
            "params": {"turnId": "turn-1", "delta": "Final answer"},
        });
        let terminal = json!({
            "method": "turn/completed",
            "params": {"turn": {"id": "turn-1", "status": "completed"}},
        });

        assert!(matches!(
            output_line_final_answer_text(&delta),
            Some(FinalAnswerTextUpdate::Append(_))
        ));
        assert_eq!(
            terminal_output(&terminal, "Final answer"),
            Some(TerminalOutput::Completed {
                reason: "turn_completed",
                result_text: Some("Final answer".to_owned())
            })
        );
    }

    #[test]
    fn turn_completed_uses_completed_agent_message_text_when_terminal_is_empty() {
        let completed = json!({
            "type": "item.completed",
            "item": {
                "id": "msg-final",
                "type": "agentMessage",
                "phase": "final_answer",
                "text": "1. No new findings.\n\n2. No writes were used."
            }
        });
        let terminal = json!({
            "type": "turn.completed",
            "turn": {"id": "turn-1", "status": "completed"},
        });

        let Some(FinalAnswerTextUpdate::Replace(final_text)) =
            output_line_final_answer_text(&completed)
        else {
            panic!("completed agentMessage should replace final answer text")
        };
        assert_eq!(
            terminal_output(&terminal, &final_text),
            Some(TerminalOutput::Completed {
                reason: "turn_completed",
                result_text: Some("1. No new findings.\n\n2. No writes were used.".to_owned())
            })
        );
    }

    #[test]
    fn interrupted_turn_completed_without_answer_is_failure() {
        let event = json!({
            "type": "turn.completed",
            "turn": {"id": "turn-1", "status": "interrupted"},
        });

        assert_eq!(
            terminal_output(&event, ""),
            Some(TerminalOutput::Failed {
                error: "turn completed with status interrupted before final answer".to_owned()
            })
        );
    }

    #[test]
    fn user_interrupt_coerces_failed_to_stopped() {
        // The exact terminal a user stop-turn produces (interrupted, no answer).
        let out = coerce_terminal_for_user_interrupt(
            TerminalOutput::Failed {
                error: "turn completed with status interrupted before final answer".to_owned(),
            },
            true,
        );
        assert_eq!(
            out,
            TerminalOutput::Completed {
                reason: "stopped_by_user",
                result_text: None,
            }
        );
    }

    #[test]
    fn non_user_interrupt_failure_stays_failed() {
        let out = coerce_terminal_for_user_interrupt(
            TerminalOutput::Failed {
                error: "boom".to_owned(),
            },
            false,
        );
        assert_eq!(out, TerminalOutput::Failed { error: "boom".to_owned() });
    }

    #[test]
    fn user_interrupt_leaves_a_normal_completion_untouched() {
        // A turn that completed normally in the interrupt race must not be relabelled.
        let out = coerce_terminal_for_user_interrupt(
            TerminalOutput::Completed {
                reason: "turn_completed",
                result_text: Some("done".to_owned()),
            },
            true,
        );
        assert_eq!(
            out,
            TerminalOutput::Completed {
                reason: "turn_completed",
                result_text: Some("done".to_owned()),
            }
        );
    }

    #[test]
    fn interrupted_turn_completed_after_answer_stays_terminal() {
        let event = json!({
            "method": "turn/completed",
            "params": {"turn": {"id": "turn-1", "status": "interrupted"}},
        });

        assert_eq!(
            terminal_output(&event, "Final answer"),
            Some(TerminalOutput::Completed {
                reason: "turn_completed",
                result_text: Some("Final answer".to_owned())
            })
        );
    }

    #[test]
    fn terminal_result_completes_even_without_prior_delta() {
        let event = json!({
            "type": "result",
            "result": {"text": "Final answer"},
        });

        assert_eq!(
            terminal_output(&event, ""),
            Some(TerminalOutput::Completed {
                reason: "result",
                result_text: Some("Final answer".to_owned())
            })
        );
    }

    #[test]
    fn turn_done_carries_terminal_result_text() {
        let event = json!({
            "type": "turn.done",
            "result": "Final answer",
        });

        assert_eq!(
            terminal_output(&event, ""),
            Some(TerminalOutput::Completed {
                reason: "turn_done",
                result_text: Some("Final answer".to_owned())
            })
        );
    }

    #[test]
    fn turn_failed_is_terminal_failure() {
        let event = json!({
            "type": "turn.failed",
            "error": "sandbox exited",
        });

        assert_eq!(
            terminal_output(&event, ""),
            Some(TerminalOutput::Failed {
                error: "sandbox exited".to_owned()
            })
        );
    }

    #[test]
    fn nested_terminal_text_is_normalized() {
        let event = json!({
            "result": {
                "message": {
                    "content": [{"type": "text", "text": "Final answer"}],
                },
            },
        });

        assert_eq!(terminal_payload_text(&event), "Final answer");
    }

    #[test]
    fn timeout_event_uses_millisecond_duration() {
        assert_eq!(duration_millis_u64(Duration::from_millis(3_000)), 3_000);
    }

    #[test]
    fn stdout_state_first_token_detection_uses_answer_text() {
        let state = StdoutPumpState::default();
        let turn_started = json!({"type": "turn.started", "turn_id": "turn-1"});
        let delta = json!({
            "type": "item.agentMessage.delta",
            "turnId": "turn-1",
            "itemId": "msg-1",
            "delta": "Hello"
        });
        let terminal_result = json!({"type": "result", "result": {"text": "Done"}});

        assert!(!state.should_record_first_token("exe-1", Some(&turn_started)));
        assert!(state.should_record_first_token("exe-1", Some(&delta)));
        assert!(state.should_record_first_token("exe-2", Some(&terminal_result)));
    }

    #[test]
    fn terminal_failure_class_is_low_cardinality() {
        assert_eq!(
            terminal_failure_class("sandbox stdout closed before terminal output"),
            "sandbox_io"
        );
        assert_eq!(
            terminal_failure_class("execution orphaned by control plane restart"),
            "orphaned"
        );
        assert_eq!(
            terminal_failure_class("turn failed: model error"),
            "harness"
        );
    }

    #[test]
    fn execution_metadata_preserves_idle_and_max_duration() {
        let metadata =
            execution_metadata(Some(json!({"source": "test"})), Some(2_000), Some(5_000));

        assert_eq!(metadata["source"], "test");
        assert_eq!(metadata["idle_timeout_ms"], 2_000);
        assert_eq!(metadata["max_duration_ms"], 5_000);
    }

    #[test]
    fn session_repos_json_extracts_non_empty_repo_specs() {
        let metadata = json!({
            SESSION_REPOS_METADATA_KEY: [
                {"repo": "acme/foo", "ref": "main", "subdir": "foo"},
            ],
        });

        let repos_json = session_repos_json(&metadata).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&repos_json).unwrap(),
            metadata[SESSION_REPOS_METADATA_KEY]
        );
        assert_eq!(
            session_repos_json(&json!({SESSION_REPOS_METADATA_KEY: []})),
            None
        );
        assert_eq!(session_repos_json(&json!({})), None);
    }

    #[test]
    fn compose_spec_repos_json_preserves_org_default_only_repos() {
        let mut spec = SandboxSpec::new("centaur-agent:latest").env(
            AGENT_REPOS_JSON_ENV,
            r#"[{"repo":"acme/default","ref":"main"}]"#,
        );

        let repos_json = compose_spec_repos_json(&mut spec, None, None)
            .unwrap()
            .unwrap();

        assert_eq!(
            serde_json::from_str::<Value>(&repos_json).unwrap(),
            json!([{"repo":"acme/default","ref":"main"}])
        );
        assert!(
            spec.env
                .iter()
                .all(|env| env.name.as_str() != AGENT_REPOS_JSON_ENV)
        );
    }

    #[test]
    fn compose_spec_repos_json_preserves_session_only_repos() {
        let mut spec = SandboxSpec::new("centaur-agent:latest");

        let repos_json = compose_spec_repos_json(
            &mut spec,
            Some(r#"[{"repo":"acme/work","ref":"feature"}]"#),
            None,
        )
        .unwrap()
        .unwrap();

        assert_eq!(
            serde_json::from_str::<Value>(&repos_json).unwrap(),
            json!([{"repo":"acme/work","ref":"feature"}])
        );
    }

    #[test]
    fn compose_spec_repos_json_merges_with_session_repo_winning_collision() {
        let mut spec = SandboxSpec::new("centaur-agent:latest").env(
            AGENT_REPOS_JSON_ENV,
            r#"[
                {"repo":"acme/work","ref":"main"},
                {"repo":"acme/default","ref":"main"}
            ]"#,
        );

        let repos_json = compose_spec_repos_json(
            &mut spec,
            Some(r#"[{"repo":"acme/work","ref":"feature"}]"#),
            None,
        )
        .unwrap()
        .unwrap();

        assert_eq!(
            serde_json::from_str::<Value>(&repos_json).unwrap(),
            json!([
                {"repo":"acme/work","ref":"feature"},
                {"repo":"acme/default","ref":"main"}
            ])
        );
    }

    #[test]
    fn compose_spec_repos_json_strips_internal_cache_fields() {
        let mut spec = SandboxSpec::new("centaur-agent:latest").env(
            AGENT_REPOS_JSON_ENV,
            r#"[{
                "repo":"acme/default",
                "ref":"main",
                "cache_path":".snapshots/acme/default/old",
                "resolved_sha":"old"
            }]"#,
        );

        let repos_json = compose_spec_repos_json(
            &mut spec,
            Some(
                r#"[{
                    "repo":"acme/work",
                    "ref":"feature",
                    "cache_path":"principals/private/repo",
                    "resolved_sha":"private"
                }]"#,
            ),
            None,
        )
        .unwrap()
        .unwrap();

        assert_eq!(
            serde_json::from_str::<Value>(&repos_json).unwrap(),
            json!([
                {"repo":"acme/default","ref":"main"},
                {"repo":"acme/work","ref":"feature"}
            ])
        );
    }

    #[test]
    fn compose_spec_repos_json_scopes_private_repos_to_session_principal() {
        let mut spec = SandboxSpec::new("centaur-agent:latest").env(
            AGENT_REPOS_JSON_ENV,
            r#"[{"repo":"acme/public","ref":"main"}]"#,
        );

        let repos_json = compose_spec_repos_json(
            &mut spec,
            Some(r#"[{"repo":"acme/private","ref":"feature","private":true}]"#),
            Some("prn_user_one"),
        )
        .unwrap()
        .unwrap();

        assert_eq!(
            serde_json::from_str::<Value>(&repos_json).unwrap(),
            json!([
                {"repo":"acme/public","ref":"main"},
                {
                    "repo":"acme/private",
                    "ref":"feature",
                    "private":true,
                    "cache_scope":{"kind":"principal","principal_id":"prn_user_one"}
                }
            ])
        );
    }

    #[test]
    fn compose_spec_repos_json_rejects_private_repos_without_principal() {
        let mut spec = SandboxSpec::new("centaur-agent:latest");

        let err = compose_spec_repos_json(
            &mut spec,
            Some(r#"[{"repo":"acme/private","private":true}]"#),
            None,
        )
        .unwrap_err();

        assert!(matches!(err, SessionRuntimeError::BadRequest(_)));
        assert!(
            err.to_string()
                .contains("requires a session iron-control principal")
        );
    }

    #[test]
    fn idle_timeout_is_read_from_execution_metadata() {
        let execution = session_execution(
            "exe-idle",
            ExecutionStatus::Completed,
            json!({"idle_timeout_ms": 1500}),
        );

        assert_eq!(
            idle_timeout_from_execution(&execution),
            Some(Duration::from_millis(1500))
        );
    }

    #[test]
    fn redacts_sensitive_values_from_output_lines() {
        let line = r#"{"type":"item.completed","item":{"aggregatedOutput":"Authorization: Bearer sbx1.threadpayload.signature\nSANDBOX_TOKEN=sbx1.otherpayload.othersig\nSLACK_BOT_TOKEN=xoxb-1234567890-abcdef\n"}}"#;

        let redacted = redact_sensitive_text(line);

        assert!(!redacted.contains("sbx1.threadpayload.signature"));
        assert!(!redacted.contains("sbx1.otherpayload.othersig"));
        assert!(!redacted.contains("xoxb-1234567890-abcdef"));
        assert!(redacted.contains("Authorization: Bearer [REDACTED_TOKEN]"));
        assert!(redacted.contains("SANDBOX_TOKEN=[REDACTED_TOKEN]"));
        assert!(redacted.contains("SLACK_BOT_TOKEN=[REDACTED_TOKEN]"));
    }

    #[test]
    fn codex_app_server_event_source_and_type_are_classified() {
        let app_server = json!({
            "method": "item/agentMessage/delta",
            "params": {"turnId": "turn-1", "itemId": "item-1"},
        });
        let harness = json!({
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "redacted"}]},
        });
        let sandbox = json!({
            "type": "custom.wrapper.event",
        });

        assert_eq!(
            sandbox_output_event_type(&app_server),
            "item/agentMessage/delta"
        );
        assert_eq!(sandbox_output_source(&app_server), "codex_app_server");
        assert_eq!(sandbox_output_source(&harness), "harness");
        assert_eq!(sandbox_output_source(&sandbox), "sandbox");
    }

    #[test]
    fn codex_app_server_mcp_tool_events_emit_tool_spans() {
        let started = json!({
            "method": "item/started",
            "params": {
                "item": {
                    "id": "tool-1",
                    "type": "mcpToolCall",
                    "server": "github",
                    "tool": "list_issues"
                }
            }
        });
        let progress = json!({
            "method": "item/mcpToolCall/progress",
            "params": {"itemId": "tool-1"}
        });
        let completed = json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "id": "tool-1",
                    "durationMs": 125
                }
            }
        });
        let mut known = HashMap::new();

        assert_eq!(
            tool_call_span_events(&started, &mut known),
            vec![ToolCallSpanEvent {
                labels: ToolCallLabels {
                    kind: "mcp".to_owned(),
                    name: "list_issues".to_owned(),
                    method: "github".to_owned(),
                },
                status: "started",
                duration: None,
            }]
        );
        assert_eq!(
            tool_call_span_events(&progress, &mut known),
            vec![ToolCallSpanEvent {
                labels: ToolCallLabels {
                    kind: "mcp".to_owned(),
                    name: "list_issues".to_owned(),
                    method: "github".to_owned(),
                },
                status: "progress",
                duration: None,
            }]
        );
        assert_eq!(
            tool_call_span_events(&completed, &mut known),
            vec![ToolCallSpanEvent {
                labels: ToolCallLabels {
                    kind: "mcp".to_owned(),
                    name: "list_issues".to_owned(),
                    method: "github".to_owned(),
                },
                status: "completed",
                duration: Some(Duration::from_millis(125)),
            }]
        );
        assert!(known.is_empty());
    }

    #[test]
    fn command_execution_items_do_not_emit_tool_spans() {
        let started = json!({
            "method": "item/started",
            "params": {
                "item": {
                    "id": "cmd-1",
                    "type": "commandExecution",
                    "command": "ls -la"
                }
            }
        });
        let completed = json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "id": "cmd-1",
                    "type": "commandExecution",
                    "command": "ls -la",
                    "exitCode": 0,
                    "durationMs": 42
                }
            }
        });
        let mut known = HashMap::new();

        assert_eq!(tool_call_span_events(&started, &mut known), Vec::new());
        assert_eq!(tool_call_span_events(&completed, &mut known), Vec::new());
        assert!(known.is_empty());
    }

    #[test]
    fn anthropic_tool_use_and_result_events_emit_tool_spans() {
        let assistant = json!({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "id": "use-1", "name": "todo_write", "input": {"redacted": true}}
                ]
            }
        });
        let result = json!({
            "type": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "use-1", "content": "redacted"}
            ]
        });
        let mut known = HashMap::new();

        assert_eq!(
            tool_call_span_events(&assistant, &mut known),
            vec![ToolCallSpanEvent {
                labels: ToolCallLabels {
                    kind: "anthropic".to_owned(),
                    name: "todo_write".to_owned(),
                    method: "call".to_owned(),
                },
                status: "started",
                duration: None,
            }]
        );
        assert_eq!(
            tool_call_span_events(&result, &mut known),
            vec![ToolCallSpanEvent {
                labels: ToolCallLabels {
                    kind: "anthropic".to_owned(),
                    name: "todo_write".to_owned(),
                    method: "call".to_owned(),
                },
                status: "completed",
                duration: None,
            }]
        );
        assert!(known.is_empty());
    }

    #[test]
    fn idle_pause_requires_latest_terminal_execution_and_same_sandbox() {
        let session = session_with_sandbox("asbx-1");
        let completed = session_execution("exe-1", ExecutionStatus::Completed, json!({}));
        let running = session_execution("exe-1", ExecutionStatus::Running, json!({}));
        let newer = session_execution("exe-2", ExecutionStatus::Completed, json!({}));

        assert!(should_pause_idle_sandbox(
            &session,
            Some(&completed),
            "exe-1",
            "asbx-1"
        ));
        assert!(!should_pause_idle_sandbox(
            &session,
            Some(&running),
            "exe-1",
            "asbx-1"
        ));
        assert!(!should_pause_idle_sandbox(
            &session,
            Some(&newer),
            "exe-1",
            "asbx-1"
        ));
        assert!(!should_pause_idle_sandbox(
            &session,
            Some(&completed),
            "exe-1",
            "asbx-other"
        ));
    }

    #[test]
    fn event_stream_attaches_only_to_running_sandboxes() {
        assert!(should_attach_session_pipe(&SandboxStatus::Running));
        assert!(!should_attach_session_pipe(&SandboxStatus::Created));
        assert!(!should_attach_session_pipe(&SandboxStatus::Suspended));
        assert!(!should_attach_session_pipe(&SandboxStatus::Stopped));
        assert!(!should_attach_session_pipe(&SandboxStatus::Gone));
        assert!(!should_attach_session_pipe(&SandboxStatus::Unknown(
            "other".to_owned()
        )));
    }

    #[test]
    fn execution_environment_allows_only_provider_auth_for_matching_harness() {
        let claude_allowed = validate_execution_environment(
            &HarnessType::ClaudeCode,
            BTreeMap::from([(
                CLAUDE_CODE_OAUTH_TOKEN_ENV.to_owned(),
                "oauth-token".to_owned(),
            )]),
        )
        .unwrap();

        assert_eq!(
            claude_allowed,
            vec![(
                CLAUDE_CODE_OAUTH_TOKEN_ENV.to_owned(),
                "oauth-token".to_owned()
            )]
        );
        let codex_allowed = validate_execution_environment(
            &HarnessType::Codex,
            BTreeMap::from([(
                CODEX_AUTH_JSON_ENV.to_owned(),
                r#"{"auth_mode":"chatgpt"}"#.to_owned(),
            )]),
        )
        .unwrap();

        assert_eq!(
            codex_allowed,
            vec![(
                CODEX_AUTH_JSON_ENV.to_owned(),
                r#"{"auth_mode":"chatgpt"}"#.to_owned()
            )]
        );
        assert!(
            validate_execution_environment(
                &HarnessType::ClaudeCode,
                BTreeMap::from([("OPENAI_API_KEY".to_owned(), "secret".to_owned())]),
            )
            .is_err()
        );
        assert!(
            validate_execution_environment(
                &HarnessType::Codex,
                BTreeMap::from([(
                    CLAUDE_CODE_OAUTH_TOKEN_ENV.to_owned(),
                    "oauth-token".to_owned()
                )]),
            )
            .is_err()
        );
        assert!(
            validate_execution_environment(
                &HarnessType::ClaudeCode,
                BTreeMap::from([(CODEX_AUTH_JSON_ENV.to_owned(), "{}".to_owned())]),
            )
            .is_err()
        );
    }

    #[test]
    fn existing_sandbox_action_repairs_or_replaces_non_attachable_assignments() {
        assert_eq!(
            existing_sandbox_action(&SandboxStatus::Running),
            ExistingSandboxAction::Reuse
        );
        assert_eq!(
            existing_sandbox_action(&SandboxStatus::Suspended),
            ExistingSandboxAction::ResumeOrReplace
        );
        assert_eq!(
            existing_sandbox_action(&SandboxStatus::Created),
            ExistingSandboxAction::ResumeOrReplace
        );
        assert_eq!(
            existing_sandbox_action(&SandboxStatus::Stopped),
            ExistingSandboxAction::Replace
        );
        assert_eq!(
            existing_sandbox_action(&SandboxStatus::Gone),
            ExistingSandboxAction::Replace
        );
        assert_eq!(
            existing_sandbox_action(&SandboxStatus::Unknown("rollout missing".to_owned())),
            ExistingSandboxAction::Replace
        );
    }

    #[test]
    fn event_stream_tolerates_not_ready_attach_race() {
        let not_ready =
            SessionRuntimeError::Sandbox(SandboxError::NotReady("sandbox paused".to_owned()));
        let backend_error = SessionRuntimeError::Sandbox(SandboxError::backend("api failed"));

        assert!(is_event_stream_attach_race(&not_ready));
        assert!(!is_event_stream_attach_race(&backend_error));
    }

    #[test]
    fn steering_startup_retries_only_transient_sandbox_errors() {
        let not_ready =
            SessionRuntimeError::Sandbox(SandboxError::NotReady("sandbox starting".to_owned()));
        let not_found = SessionRuntimeError::Sandbox(SandboxError::NotFound("asbx-1".to_owned()));
        let io = SessionRuntimeError::Sandbox(SandboxError::io("stdin closed"));
        let store = SessionRuntimeError::Store(SessionStoreError::NotFound {
            thread_key: "cli:test".to_owned(),
        });

        assert!(is_transient_steering_startup_error(&not_ready));
        assert!(is_transient_steering_startup_error(&not_found));
        assert!(!is_transient_steering_startup_error(&io));
        assert!(!is_transient_steering_startup_error(&store));
    }

    #[test]
    fn stdout_state_drops_late_output_from_inactive_turn() {
        let mut state = StdoutPumpState::default();
        let started = r#"{"type":"turn.started","turn_id":"turn-old"}"#;
        let delta = r#"{"type":"item.agentMessage.delta","turnId":"turn-old","itemId":"msg-old","delta":"late"}"#;

        assert_eq!(
            state.execution_for_line(Some("exe-old"), started),
            Some("exe-old".to_owned())
        );
        assert_eq!(state.execution_for_line(None, delta), None);
        assert_eq!(state.execution_for_line(Some("exe-new"), delta), None);
    }

    #[test]
    fn stdout_state_uses_final_agent_message_when_turn_completed_is_textless() {
        let mut state = StdoutPumpState::default();
        let started = r#"{"type":"turn.started","turn_id":"turn-1"}"#;
        let delta = r#"{"type":"item.agentMessage.delta","turnId":"turn-1","itemId":"msg-final","delta":"draft"}"#;
        let completed = r#"{"type":"item.completed","item":{"id":"msg-final","type":"agentMessage","phase":"final_answer","text":"Final canonical answer."}}"#;
        let terminal =
            r#"{"type":"turn.completed","turn":{"id":"turn-1","status":"completed"},"usage":null}"#;

        assert_eq!(
            state.execution_for_line(Some("exe-1"), started),
            Some("exe-1".to_owned())
        );
        assert_eq!(state.observe("exe-1", delta), None);
        assert_eq!(state.observe("exe-1", completed), None);
        assert_eq!(
            state.observe("exe-1", terminal),
            Some(TerminalOutput::Completed {
                reason: "turn_completed",
                result_text: Some("Final canonical answer.".to_owned())
            })
        );
    }

    #[test]
    fn steering_input_lines_forward_only_user_messages() {
        let thread_key = ThreadKey::parse("cli:test-steering").unwrap();
        let messages = vec![
            SessionMessageInput {
                client_message_id: None,
                role: MessageRole::User,
                parts: vec![json!({"type": "text", "text": "steer now"})],
                metadata: json!({"platform": "test"}),
            },
            SessionMessageInput {
                client_message_id: None,
                role: MessageRole::Assistant,
                parts: vec![json!({"type": "text", "text": "do not echo assistant"})],
                metadata: json!({}),
            },
        ];
        let message_ids = vec!["msg-user".to_owned(), "msg-assistant".to_owned()];

        let lines = steering_input_lines(&thread_key, &messages, &message_ids);
        assert_eq!(lines.len(), 1);

        let value: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(value["type"], "user");
        assert_eq!(value["thread_key"], "cli:test-steering");
        assert_eq!(value["trace_metadata"]["action"], "steer_active_execution");
        assert_eq!(value["trace_metadata"]["message_id"], "msg-user");
        assert_eq!(value["message"]["content"][0]["text"], "steer now");
    }

    #[test]
    fn harness_thread_id_is_extracted_from_thread_started_output() {
        assert_eq!(
            harness_thread_id_from_output_line(
                r#"{"type":"thread.started","thread_id":"codex-thread-1"}"#
            ),
            Some("codex-thread-1".to_owned())
        );
        assert_eq!(
            harness_thread_id_from_output_line(
                r#"{"type":"thread.started","threadId":"codex-thread-2"}"#
            ),
            Some("codex-thread-2".to_owned())
        );
        assert_eq!(
            harness_thread_id_from_output_line(r#"{"type":"turn.started","turn_id":"turn-1"}"#),
            None
        );
    }

    #[test]
    fn codex_workload_applies_mounts_to_sandbox_spec() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            [("CENTAUR_API_URL".to_owned(), "http://api:8000".to_owned())],
            HarnessType::Codex,
        )
        .mount(
            Mount::new(
                MountKind::Bind {
                    source_path: "/host/repos".to_owned(),
                },
                "/home/agent/repos",
            )
            .read_only(),
        );
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();

        let spec = workload.spec(&thread_key, &HarnessType::Codex, None);

        assert!(spec.mounts.iter().any(|mount| {
            mount.target_path == SANDBOX_STATE_DIR && mount.kind == MountKind::EmptyDir
        }));
        assert!(spec.mounts.iter().any(|mount| {
            mount.target_path == "/home/agent/repos"
                && mount.read_only
                && mount.kind
                    == (MountKind::Bind {
                        source_path: "/host/repos".to_owned(),
                    })
        }));
    }

    #[test]
    fn codex_workload_reflects_resolved_persona_in_sandbox_spec() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            [("AGENT_PERSONA".to_owned(), "stale".to_owned())],
            HarnessType::Codex,
        );
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        let persona = test_persona_context("eng");

        let spec = workload.spec(&thread_key, &HarnessType::Codex, Some(&persona));

        assert_eq!(env_value(&spec, "AGENT_PERSONA"), Some("eng"));
        assert_eq!(env_value(&spec, "CENTAUR_PERSONA_ID"), Some("eng"));
        assert_eq!(
            env_value(&spec, "CENTAUR_PERSONA_PROMPT_HASH"),
            Some("sha256:prompt")
        );
        assert_eq!(
            env_value(&spec, "CENTAUR_PERSONA_SOURCE_REF"),
            Some("abc123")
        );
        assert_eq!(env_value(&workload.warm_spec(), "AGENT_PERSONA"), None);
    }

    #[test]
    fn codex_workload_does_not_inject_stale_continue_thread_id() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            Vec::new(),
            HarnessType::Codex,
        );
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();

        let spec = workload.spec(&thread_key, &HarnessType::Codex, None);

        assert_eq!(
            spec.env
                .iter()
                .find(|env| env.name == "CODEX_CONTINUE_THREAD_ID")
                .map(|env| env.value.as_str()),
            None
        );
        assert_eq!(
            spec.env
                .iter()
                .find(|env| env.name == "AMP_CONTINUE_THREAD_ID")
                .map(|env| env.value.as_str()),
            None
        );
        assert_eq!(env_value(&spec, "CENTAUR_RESUME_THREAD_ID"), None);
    }

    #[test]
    fn codex_resume_env_injects_continue_thread_id_for_resume_target() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            Vec::new(),
            HarnessType::Codex,
        );
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();

        let spec = apply_resume_thread_env(
            workload.spec(&thread_key, &HarnessType::Codex, None),
            &HarnessType::Codex,
            Some("codex-thread-1"),
        );

        assert_eq!(
            env_value(&spec, "CODEX_CONTINUE_THREAD_ID"),
            Some("codex-thread-1")
        );
        assert_eq!(
            env_value(&spec, "CENTAUR_RESUME_THREAD_ID"),
            Some("codex-thread-1")
        );
        assert_eq!(
            env_value(&spec, "CENTAUR_HARNESS_TRANSCRIPT_RESTORE"),
            Some("1")
        );
        assert_eq!(env_value(&spec, "AMP_CONTINUE_THREAD_ID"), None);
    }

    #[test]
    fn claude_resume_env_sets_resume_target_without_codex_continue() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            Vec::new(),
            HarnessType::Codex,
        );
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();

        let spec = apply_resume_thread_env(
            workload.spec(&thread_key, &HarnessType::ClaudeCode, None),
            &HarnessType::ClaudeCode,
            Some("claude-thread-1"),
        );

        assert_eq!(
            env_value(&spec, "CENTAUR_RESUME_THREAD_ID"),
            Some("claude-thread-1")
        );
        assert_eq!(env_value(&spec, "CODEX_CONTINUE_THREAD_ID"), None);
    }

    #[test]
    fn codex_workload_wires_ephemeral_harness_homes() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            Vec::new(),
            HarnessType::Codex,
        );
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();

        let spec = workload.spec(&thread_key, &HarnessType::Codex, None);

        assert_eq!(
            env_value(&spec, "CENTAUR_STATE_DIR"),
            Some(SANDBOX_STATE_DIR)
        );
        assert_eq!(env_value(&spec, "CODEX_HOME"), Some(SANDBOX_CODEX_HOME));
        assert_eq!(
            env_value(&spec, "CLAUDE_CONFIG_DIR"),
            Some(SANDBOX_CLAUDE_CONFIG_DIR)
        );
        assert!(spec.mounts.iter().any(|mount| {
            mount.target_path == SANDBOX_STATE_DIR && mount.kind == MountKind::EmptyDir
        }));
    }

    #[test]
    fn codex_warm_spec_starts_profileless() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            [("CENTAUR_API_URL".to_owned(), "http://api:8000".to_owned())],
            HarnessType::Codex,
        );
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();

        let claimed_spec = workload.spec(&thread_key, &HarnessType::ClaudeCode, None);
        let warm_spec = workload.warm_spec();

        assert_eq!(
            env_value(&claimed_spec, "CENTAUR_THREAD_KEY"),
            Some(thread_key.as_str())
        );
        assert_eq!(env_value(&warm_spec, "CENTAUR_THREAD_KEY"), None);
        assert_eq!(env_value(&warm_spec, CENTAUR_WARM_SANDBOX_ENV), Some("1"));
        assert_eq!(env_value(&claimed_spec, CENTAUR_WARM_SANDBOX_ENV), None);
    }

    #[test]
    fn warm_workload_key_ignores_claimed_thread_key() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            [("CENTAUR_API_URL".to_owned(), "http://api:8000".to_owned())],
            HarnessType::Codex,
        );
        let first_thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        let second_thread_key = ThreadKey::parse("chat:C456:1780000000.000001").unwrap();

        assert_ne!(
            sandbox_spec_key(&workload.spec(&first_thread_key, &HarnessType::ClaudeCode, None)),
            sandbox_spec_key(&workload.spec(&second_thread_key, &HarnessType::ClaudeCode, None))
        );
        assert_eq!(
            sandbox_spec_key(&workload.warm_spec()),
            sandbox_spec_key(&workload.warm_spec())
        );
    }

    #[test]
    fn resolved_repos_json_from_state_adds_snapshot_fields() {
        let root = std::env::temp_dir().join(format!(
            "centaur-repo-cache-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let snapshot = root.join(".snapshots/acme/widget/abc123/.git");
        std::fs::create_dir_all(&snapshot).unwrap();

        let state = RepoCacheState {
            repositories: vec![RepoCacheStateEntry {
                repo: "acme/widget".to_owned(),
                r#ref: Some("main".to_owned()),
                resolved_sha: "abc123".to_owned(),
                cache_path: ".snapshots/acme/widget/abc123".to_owned(),
            }],
        };
        let resolved = resolved_repos_json_from_state(
            r#"[{"repo":"acme/widget","ref":"main","subdir":"widget"}]"#,
            &root,
            &state,
        )
        .unwrap();
        let value: Value = serde_json::from_str(&resolved).unwrap();

        assert_eq!(value[0]["repo"], "acme/widget");
        assert_eq!(value[0]["ref"], "main");
        assert_eq!(value[0]["subdir"], "widget");
        assert_eq!(value[0]["resolved_sha"], "abc123");
        assert_eq!(value[0]["cache_path"], ".snapshots/acme/widget/abc123");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn codex_workload_pins_harness_via_container_args() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            Vec::new(),
            HarnessType::Codex,
        );
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();

        let codex_spec = workload.spec(&thread_key, &HarnessType::Codex, None);
        let claude_spec = workload.spec(&thread_key, &HarnessType::ClaudeCode, None);
        let amp_spec = workload.spec(&thread_key, &HarnessType::Amp, None);

        assert_eq!(codex_spec.args, vec!["harness-server", "codex"]);
        assert_eq!(claude_spec.args, vec!["harness-server", "claude-code"]);
        assert_eq!(amp_spec.args, vec!["harness-server", "amp"]);
        // The image entrypoint must be preserved: only CMD is overridden.
        assert_eq!(codex_spec.command, None);
    }

    #[test]
    fn codex_workload_labels_session_sandbox_for_observability() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            Vec::new(),
            HarnessType::Codex,
        );
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();

        let spec = workload.spec(&thread_key, &HarnessType::ClaudeCode, None);

        assert_eq!(
            spec.labels.get("centaur.ai/component").map(String::as_str),
            Some("session-sandbox")
        );
        assert_eq!(
            spec.labels.get("centaur.ai/harness").map(String::as_str),
            Some("claudecode")
        );
    }

    #[test]
    fn warm_spec_uses_workload_default_harness() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            Vec::new(),
            HarnessType::Codex,
        );

        assert_eq!(
            workload.warm_spec().args,
            vec!["harness-server", "codex"],
            "warm sandboxes boot the configured default harness"
        );
        // A session on a different harness produces a different spec, so a
        // warm claim for it would hand over the wrong harness.
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        assert_eq!(
            workload
                .spec(&thread_key, &HarnessType::ClaudeCode, None)
                .args,
            vec!["harness-server", "claude-code"]
        );
    }

    #[test]
    fn warm_spec_carries_workload_repo_defaults() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            [(
                AGENT_REPOS_JSON_ENV.to_owned(),
                r#"[{"repo":"acme/default","ref":"main"}]"#.to_owned(),
            )],
            HarnessType::Codex,
        );

        let warm_spec = workload.warm_spec();

        assert_eq!(
            warm_spec
                .env
                .iter()
                .find(|env| env.name == AGENT_REPOS_JSON_ENV)
                .map(|env| env.value.as_str()),
            Some(r#"[{"repo":"acme/default","ref":"main"}]"#)
        );
        assert_eq!(
            warm_spec
                .env
                .iter()
                .find(|env| env.name == CENTAUR_WARM_REPO_OVERLAY_VERSION_ENV)
                .map(|env| env.value.as_str()),
            Some(CENTAUR_WARM_REPO_OVERLAY_VERSION)
        );
        assert!(
            warm_spec
                .env
                .iter()
                .all(|env| env.name != "CENTAUR_THREAD_KEY")
        );
    }

    #[test]
    fn input_line_with_session_context_enriches_json_objects() {
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        let trace = SessionTraceContext::new(&thread_key, None);

        let line = input_line_with_session_context(&thread_key, &trace, r#"{"type":"user"}"#);
        let value: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(value["type"], "user");
        assert_eq!(value["thread_key"], thread_key.as_str());
        assert_eq!(value["trace_id"], trace.trace_id);
        // Without an OpenTelemetry layer there is no traceparent to forward.
        assert!(value.get("traceparent").is_none());
        assert!(value.get("session_context").is_none());
    }

    #[test]
    fn input_line_with_session_context_adds_slack_thread_context() {
        let thread_key = ThreadKey::parse("slack:T123:C123:1780000000.000000").unwrap();
        let trace = SessionTraceContext::new(&thread_key, None);

        let line = input_line_with_session_context(&thread_key, &trace, r#"{"type":"user"}"#);
        let value: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(value["session_context"]["platform"], "slack");
        assert_eq!(value["session_context"]["slack"]["team_id"], "T123");
        assert_eq!(value["session_context"]["slack"]["channel_id"], "C123");
        assert_eq!(
            value["session_context"]["slack"]["thread_ts"],
            "1780000000.000000"
        );
    }

    #[test]
    fn input_line_with_session_context_preserves_existing_session_context() {
        let thread_key = ThreadKey::parse("slack:T123:C123:1780000000.000000").unwrap();
        let trace = SessionTraceContext::new(&thread_key, None);

        let line = input_line_with_session_context(
            &thread_key,
            &trace,
            r#"{"type":"user","session_context":{"requester":{"github_handle":"@ada"},"platform":"custom"}}"#,
        );
        let value: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(
            value["session_context"]["requester"]["github_handle"],
            "@ada"
        );
        assert_eq!(value["session_context"]["platform"], "custom");
        assert_eq!(value["session_context"]["slack"]["channel_id"], "C123");
    }

    #[test]
    fn input_line_with_session_context_preserves_existing_fields_and_non_json() {
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        let trace = SessionTraceContext {
            trace_id: thread_trace_id(&thread_key),
            traceparent: Some("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01".to_owned()),
        };

        let line = input_line_with_session_context(
            &thread_key,
            &trace,
            r#"{"type":"user","thread_key":"chat:existing","trace_id":"caller-trace"}"#,
        );
        let value: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(value["thread_key"], "chat:existing");
        assert_eq!(value["trace_id"], "caller-trace");
        assert_eq!(
            value["traceparent"],
            "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
        );
        assert_eq!(
            input_line_with_session_context(&thread_key, &trace, "raw"),
            "raw"
        );
    }

    #[test]
    fn thread_trace_id_is_deterministic_per_thread() {
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        let other = ThreadKey::parse("chat:C456:1780000000.000000").unwrap();

        assert_eq!(thread_trace_id(&thread_key), thread_trace_id(&thread_key));
        assert_ne!(thread_trace_id(&thread_key), thread_trace_id(&other));
        // The wrapper parses this with uuid.UUID(...): must stay a canonical UUID.
        assert!(uuid::Uuid::parse_str(&thread_trace_id(&thread_key)).is_ok());
        assert_eq!(
            thread_trace_parent_span_id(&thread_key),
            thread_trace_parent_span_id(&thread_key)
        );
        assert_ne!(
            thread_trace_parent_span_id(&thread_key),
            thread_trace_parent_span_id(&other)
        );
        assert_eq!(thread_trace_parent_span_id(&thread_key).len(), 16);
        assert_ne!(thread_trace_parent_span_id(&thread_key), "0000000000000000");
    }

    fn session_with_sandbox(sandbox_id: &str) -> Session {
        let thread_key = ThreadKey::parse("cli:test-idle").unwrap();
        let now = OffsetDateTime::now_utc();
        Session {
            thread_key,
            sandbox_id: Some(sandbox_id.to_owned()),
            sandbox_capabilities: None,
            harness_type: HarnessType::Codex,
            harness_thread_id: None,
            persona_id: None,
            status: SessionStatus::Idle,
            iron_control_principal: None,
            created_at: now,
            updated_at: now,
        }
    }

    fn session_execution(
        execution_id: &str,
        status: ExecutionStatus,
        metadata: serde_json::Value,
    ) -> SessionExecution {
        let thread_key = ThreadKey::parse("cli:test-idle").unwrap();
        let now = OffsetDateTime::now_utc();
        SessionExecution {
            execution_id: execution_id.to_owned(),
            idempotency_key: None,
            thread_key,
            status,
            metadata,
            error: None,
            created_at: now,
            updated_at: now,
            started_at: Some(now),
            completed_at: Some(now),
        }
    }

    fn session_event(event_id: i64, event_type: &str, payload: Value) -> SessionEvent {
        let thread_key = ThreadKey::parse("cli:test-idle").unwrap();
        let now = OffsetDateTime::now_utc();
        SessionEvent {
            event_id,
            thread_key,
            execution_id: Some("exe-1".to_owned()),
            event_type: event_type.to_owned(),
            payload,
            created_at: now,
        }
    }

    fn env_value<'a>(spec: &'a SandboxSpec, name: &str) -> Option<&'a str> {
        spec.env
            .iter()
            .find(|env| env.name == name)
            .map(|env| env.value.as_str())
    }

    fn test_persona_context(persona_id: &str) -> PersonaContext {
        PersonaContext {
            persona_id: persona_id.to_owned(),
            source_root: "/repo/tools".to_owned(),
            source_path: format!("/repo/tools/personas/{persona_id}"),
            source_ref: Some("abc123".to_owned()),
            prompt_hash: "sha256:prompt".to_owned(),
            defaulted: false,
            overlay_chain: vec!["/repo/tools".to_owned()],
        }
    }
}

/// Integration tests for orphaned-execution adoption. They need a real
/// Postgres; set `SESSION_RUNTIME_TEST_DATABASE_URL` to run them (they skip
/// silently otherwise, mirroring `ABSURD_TEST_DATABASE_URL` in absurd-sdk).
#[cfg(test)]
mod adoption_tests {
    use std::{
        collections::BTreeSet,
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    use centaur_sandbox_core::{ObservedSandbox, SandboxHandle, SandboxIo, SandboxResult};
    use centaur_session_core::SessionStatus;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream},
        sync::Barrier,
    };

    use super::*;

    /// The adoption scan is database-wide, so concurrently running tests
    /// would adopt each other's executions. Serialize the module; every test
    /// fully terminalizes its own executions before releasing the lock.
    static TEST_LOCK: Mutex<()> = Mutex::const_new(());

    struct MockBackend {
        ios: Mutex<VecDeque<SandboxIo>>,
        recorded_output: std::sync::Mutex<Vec<String>>,
        created_specs: std::sync::Mutex<Vec<SandboxSpec>>,
        prepared_homes: std::sync::Mutex<Vec<PreparedHomeCall>>,
        prepare_home_error: std::sync::Mutex<Option<String>>,
        supports_prepare_home: AtomicBool,
        open_count: AtomicUsize,
        stop_count: AtomicUsize,
        stop_error: std::sync::Mutex<Option<String>>,
        create_gate: std::sync::Mutex<Option<Arc<CreateGate>>>,
        status: std::sync::Mutex<SandboxStatus>,
        reason: std::sync::Mutex<Option<String>>,
        create_id: String,
        resume_fails: AtomicBool,
        stopped: std::sync::Mutex<Vec<String>>,
        missing_on_stop: std::sync::Mutex<BTreeSet<String>>,
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    struct PreparedHomeCall {
        sandbox_id: String,
        thread_key: String,
        execution_id: String,
        repos_json: String,
        precomposed: bool,
    }

    struct CreateGate {
        entered: Barrier,
        release: Barrier,
    }

    impl CreateGate {
        fn new() -> Self {
            Self {
                entered: Barrier::new(2),
                release: Barrier::new(2),
            }
        }
    }

    impl MockBackend {
        fn new(status: SandboxStatus, recorded_output: Vec<String>) -> Self {
            Self {
                ios: Mutex::new(VecDeque::new()),
                recorded_output: std::sync::Mutex::new(recorded_output),
                created_specs: std::sync::Mutex::new(Vec::new()),
                prepared_homes: std::sync::Mutex::new(Vec::new()),
                prepare_home_error: std::sync::Mutex::new(None),
                supports_prepare_home: AtomicBool::new(false),
                open_count: AtomicUsize::new(0),
                stop_count: AtomicUsize::new(0),
                stop_error: std::sync::Mutex::new(None),
                create_gate: std::sync::Mutex::new(None),
                status: std::sync::Mutex::new(status),
                reason: std::sync::Mutex::new(None),
                create_id: "mock-sbx".to_owned(),
                resume_fails: AtomicBool::new(false),
                stopped: std::sync::Mutex::new(Vec::new()),
                missing_on_stop: std::sync::Mutex::new(BTreeSet::new()),
            }
        }

        async fn push_io(&self, io: SandboxIo) {
            self.ios.lock().await.push_back(io);
        }

        fn opens(&self) -> usize {
            self.open_count.load(Ordering::SeqCst)
        }

        fn stops(&self) -> usize {
            self.stop_count.load(Ordering::SeqCst)
        }

        fn created_specs(&self) -> Vec<SandboxSpec> {
            self.created_specs.lock().unwrap().clone()
        }

        fn prepared_homes(&self) -> Vec<PreparedHomeCall> {
            self.prepared_homes.lock().unwrap().clone()
        }

        fn support_prepare_home(&self) {
            self.supports_prepare_home.store(true, Ordering::SeqCst);
        }

        fn fail_prepare_home(&self, error: impl Into<String>) {
            *self.prepare_home_error.lock().unwrap() = Some(error.into());
        }

        fn fail_stop(&self, error: impl Into<String>) {
            *self.stop_error.lock().unwrap() = Some(error.into());
        }

        fn pause_create(&self) -> Arc<CreateGate> {
            let gate = Arc::new(CreateGate::new());
            *self.create_gate.lock().unwrap() = Some(gate.clone());
            gate
        }

        fn set_recorded_output(&self, recorded_output: Vec<String>) {
            *self.recorded_output.lock().unwrap() = recorded_output;
        }

        fn set_status(&self, status: SandboxStatus) {
            *self.status.lock().unwrap() = status;
        }

        fn set_reason(&self, reason: impl Into<String>) {
            *self.reason.lock().unwrap() = Some(reason.into());
        }

        fn fail_resume(&self) {
            self.resume_fails.store(true, Ordering::SeqCst);
        }

        fn mark_stop_missing(&self, sandbox_id: &str) {
            self.missing_on_stop
                .lock()
                .unwrap()
                .insert(sandbox_id.to_owned());
        }

        fn stopped(&self) -> Vec<String> {
            self.stopped.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl SandboxBackend for MockBackend {
        fn name(&self) -> &'static str {
            "mock"
        }

        async fn create(&self, spec: SandboxSpec) -> SandboxResult<SandboxHandle> {
            let gate = self.create_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.entered.wait().await;
                gate.release.wait().await;
            }
            self.created_specs.lock().unwrap().push(spec);
            Ok(SandboxHandle::new(
                SandboxId::new(self.create_id.clone()),
                "mock",
            ))
        }

        async fn open_io(&self, _id: &SandboxId) -> SandboxResult<SandboxIo> {
            self.open_count.fetch_add(1, Ordering::SeqCst);
            self.ios
                .lock()
                .await
                .pop_front()
                .ok_or_else(|| SandboxError::io("mock backend has no more ios"))
        }

        async fn read_output_since(
            &self,
            _id: &SandboxId,
            _since: Option<SystemTime>,
        ) -> SandboxResult<Vec<String>> {
            Ok(self.recorded_output.lock().unwrap().clone())
        }

        async fn status(&self, _id: &SandboxId) -> SandboxResult<SandboxStatus> {
            Ok(self.status.lock().unwrap().clone())
        }

        async fn observe(&self, id: &SandboxId) -> SandboxResult<ObservedSandbox> {
            let status = self.status(id).await?;
            Ok(ObservedSandbox::new(id.clone(), "mock", status)
                .with_reason(self.reason.lock().unwrap().clone()))
        }

        async fn list_observed(&self) -> SandboxResult<Vec<ObservedSandbox>> {
            Ok(Vec::new())
        }

        async fn stop(&self, id: &SandboxId) -> SandboxResult<()> {
            self.stop_count.fetch_add(1, Ordering::SeqCst);
            if let Some(error) = self.stop_error.lock().unwrap().clone() {
                return Err(SandboxError::backend(error));
            }
            if self.missing_on_stop.lock().unwrap().contains(id.as_str()) {
                return Err(SandboxError::NotFound(id.as_str().to_owned()));
            }
            self.stopped.lock().unwrap().push(id.as_str().to_owned());
            *self.status.lock().unwrap() = SandboxStatus::Stopped;
            Ok(())
        }

        fn supports_claimed_overlay_home(&self) -> bool {
            self.supports_prepare_home.load(Ordering::SeqCst)
        }

        async fn prepare_claimed_overlay_home(
            &self,
            id: &SandboxId,
            request: PrepareClaimedOverlayHome<'_>,
        ) -> SandboxResult<()> {
            self.prepared_homes.lock().unwrap().push(PreparedHomeCall {
                sandbox_id: id.as_str().to_owned(),
                thread_key: request.thread_key.to_owned(),
                execution_id: request.execution_id.to_owned(),
                repos_json: request.repos_json.to_owned(),
                precomposed: request.precomposed,
            });
            if let Some(error) = self.prepare_home_error.lock().unwrap().clone() {
                return Err(SandboxError::backend(error));
            }
            Ok(())
        }

        async fn pause(&self, _id: &SandboxId) -> SandboxResult<()> {
            Ok(())
        }

        async fn resume(&self, _id: &SandboxId) -> SandboxResult<()> {
            if self.resume_fails.load(Ordering::SeqCst) {
                return Err(SandboxError::NotFound(_id.as_str().to_owned()));
            }
            Ok(())
        }
    }

    fn mock_io() -> (SandboxIo, DuplexStream, DuplexStream) {
        let (stdin_near, stdin_far) = tokio::io::duplex(64 * 1024);
        let (stdout_near, stdout_far) = tokio::io::duplex(64 * 1024);
        let (stderr_near, _stderr_far) = tokio::io::duplex(1024);
        let io = SandboxIo::new(
            Box::pin(stdin_near),
            Box::pin(stdout_near),
            Box::pin(stderr_near),
        );
        (io, stdout_far, stdin_far)
    }

    fn completed_output_lines(result_text: &str) -> Vec<String> {
        vec![
            json!({
                "type": "item.completed",
                "item": {
                    "id": "msg-1",
                    "type": "agentMessage",
                    "text": result_text,
                    "phase": "final_answer"
                }
            })
            .to_string(),
            json!({"type": "turn.completed", "turn": {"id": "turn-1", "status": "completed"}})
                .to_string(),
        ]
    }

    fn completed_output_bytes(result_text: &str) -> Vec<u8> {
        let mut output = completed_output_lines(result_text).join("\n");
        output.push('\n');
        output.into_bytes()
    }

    async fn test_store() -> Option<PgSessionStore> {
        let Ok(url) = std::env::var("SESSION_RUNTIME_TEST_DATABASE_URL") else {
            eprintln!("skipping: SESSION_RUNTIME_TEST_DATABASE_URL not set");
            return None;
        };
        let store = PgSessionStore::connect(&url)
            .await
            .expect("connect test db");
        store.run_migrations().await.expect("run migrations");
        Some(store)
    }

    /// Acquire the serial test lock AND reset the executions table, so each
    /// adoption test's `adopt_orphaned_executions` only ever sees the orphan it
    /// created — never leftovers from a prior test, a prior process, or another
    /// crate's test binary sharing this database. Without this, the global
    /// orphan sweep accumulates foreign executions and the open-count asserts
    /// flake under full-suite runs.
    async fn lock_clean_slate() -> tokio::sync::MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().await;
        if let Ok(url) = std::env::var("SESSION_RUNTIME_TEST_DATABASE_URL") {
            let pool = sqlx::PgPool::connect(&url)
                .await
                .expect("connect to reset test executions");
            sqlx::query(
                "truncate table session_executions, session_warm_sandboxes, session_warm_pool_state cascade",
            )
                .execute(&pool)
                .await
                .expect("reset session runtime test tables");
            pool.close().await;
        }
        guard
    }

    async fn orphaned_execution(
        store: &PgSessionStore,
        thread_key: &ThreadKey,
        sandbox_id: Option<&str>,
        running: bool,
    ) -> String {
        store
            .create_or_get_session(thread_key, &HarnessType::Codex, None, json!({}))
            .await
            .expect("create session");
        if sandbox_id.is_some() {
            store
                .update_sandbox_id(thread_key, sandbox_id)
                .await
                .expect("set sandbox id");
        }
        let created = store
            .create_execution(thread_key, None, json!({}))
            .await
            .expect("create execution");
        let execution_id = created.execution.execution_id;
        if running {
            store
                .mark_execution_running(&execution_id)
                .await
                .expect("mark running");
        }
        execution_id
    }

    async fn wait_for_event(store: &PgSessionStore, thread_key: &ThreadKey, event_type: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let events = store
                .list_events_after(thread_key, 0, None, 1000)
                .await
                .expect("list events");
            if events.iter().any(|event| event.event_type == event_type) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {event_type}"
            );
            sleep(Duration::from_millis(25)).await;
        }
    }

    async fn events(store: &PgSessionStore, thread_key: &ThreadKey) -> Vec<SessionEvent> {
        store
            .list_events_after(thread_key, 0, None, 1000)
            .await
            .expect("list events")
    }

    fn runtime_with(store: &PgSessionStore, backend: Arc<MockBackend>) -> SessionRuntime {
        SessionRuntime::new(
            store.clone(),
            SandboxRuntime::backend(backend, SandboxSpec::new("mock")),
        )
    }

    fn spec_env_value<'a>(spec: &'a SandboxSpec, name: &str) -> Option<&'a str> {
        spec.env
            .iter()
            .find(|env| env.name == name)
            .map(|env| env.value.as_str())
    }

    fn spec_env_json(spec: &SandboxSpec, name: &str) -> Value {
        serde_json::from_str(spec_env_value(spec, name).expect("env value")).expect("env json")
    }

    fn runtime_with_warm_pool(
        store: &PgSessionStore,
        backend: Arc<MockBackend>,
        spec: SandboxSpec,
    ) -> SessionRuntime {
        let warm_spec = spec.clone();
        let sandbox_runtime = SandboxRuntime::backend_with_warm_spec_factory(
            backend,
            move |_, _, _, _| spec.clone(),
            move || warm_spec.clone(),
        );
        let mut runtime = SessionRuntime::new(store.clone(), sandbox_runtime);
        let warm_pool = Arc::new(WarmPoolManager::new(
            runtime.sandbox_runtime.manager.clone(),
            store.clone(),
            runtime
                .sandbox_runtime
                .warm_spec_factory
                .clone()
                .expect("warm spec factory"),
            WarmPoolConfig {
                target_size: 1,
                replenish_interval: Duration::from_secs(60 * 60),
                bootstrap_iron_control_principal: None,
            },
        ));
        runtime.warm_pool = Some(warm_pool);
        runtime
    }

    async fn create_test_session(store: &PgSessionStore, thread_key: &ThreadKey, metadata: Value) {
        store
            .create_or_get_session(thread_key, &HarnessType::Codex, None, metadata)
            .await
            .expect("create session");
    }

    async fn create_test_execution(store: &PgSessionStore, thread_key: &ThreadKey) -> String {
        store
            .create_execution(thread_key, None, json!({}))
            .await
            .expect("create execution")
            .execution
            .execution_id
    }

    async fn insert_ready_warm_for_runtime(
        store: &PgSessionStore,
        runtime: &SessionRuntime,
        sandbox_id: &str,
    ) {
        let workload_key = runtime
            .sandbox_runtime
            .warm_spec_factory
            .as_ref()
            .expect("warm spec factory")()
        .workload_key;
        store
            .prepare_warm_pool_state("session-default", workload_key.as_str(), 1)
            .await
            .expect("prepare warm pool state");
        store
            .insert_ready_warm_sandbox(sandbox_id, workload_key.as_str())
            .await
            .expect("insert warm sandbox");
    }

    async fn warm_status(store: &PgSessionStore, sandbox_id: &str) -> String {
        sqlx::query_scalar::<_, String>(
            "select status from session_warm_sandboxes where sandbox_id = $1",
        )
        .bind(sandbox_id)
        .fetch_one(store.pool())
        .await
        .expect("warm status")
    }

    #[tokio::test]
    async fn stale_ready_warm_drain_preserves_current_claimed_and_session_referenced() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        store
            .insert_ready_warm_sandbox("old-claimed", "old-key")
            .await
            .expect("insert old claimed");
        let claimed_thread =
            ThreadKey::parse(format!("test:warm-claimed-{}", uuid::Uuid::new_v4())).unwrap();
        create_test_session(&store, &claimed_thread, json!({})).await;
        assert_eq!(
            store
                .claim_ready_warm_sandbox("old-key", claimed_thread.as_str())
                .await
                .expect("claim old warm")
                .as_deref(),
            Some("old-claimed")
        );

        store
            .insert_ready_warm_sandbox("old-ready", "old-key")
            .await
            .expect("insert old ready");
        store
            .insert_ready_warm_sandbox("old-session-ref", "old-key")
            .await
            .expect("insert old session ref");
        store
            .insert_ready_warm_sandbox("current-ready", "current-key")
            .await
            .expect("insert current ready");

        let session_ref_thread =
            ThreadKey::parse(format!("test:warm-session-ref-{}", uuid::Uuid::new_v4())).unwrap();
        create_test_session(&store, &session_ref_thread, json!({})).await;
        store
            .update_sandbox_id(&session_ref_thread, Some("old-session-ref"))
            .await
            .expect("set session sandbox");

        let drained = store
            .drain_stale_ready_warm_sandboxes(&["current-key".to_owned()], 10, "test drain")
            .await
            .expect("drain stale warm");

        assert_eq!(drained, vec!["old-ready".to_owned()]);
        assert_eq!(warm_status(&store, "old-ready").await, "drained");
        assert_eq!(warm_status(&store, "old-claimed").await, "claimed");
        assert_eq!(warm_status(&store, "old-session-ref").await, "ready");
        assert_eq!(warm_status(&store, "current-ready").await, "ready");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repo_session_claims_generic_warm_when_post_claim_home_supported() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key =
            ThreadKey::parse(format!("test:warm-repo-hit-{}", uuid::Uuid::new_v4())).unwrap();
        create_test_session(&store, &thread_key, json!({})).await;
        let execution_id = create_test_execution(&store, &thread_key).await;
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        backend.support_prepare_home();
        let runtime = runtime_with_warm_pool(&store, backend.clone(), SandboxSpec::new("mock"));
        insert_ready_warm_for_runtime(&store, &runtime, "warm-repo-hit").await;

        let sandbox_id = runtime
            .ensure_session_sandbox(EnsureSessionSandboxInput {
                thread_key: &thread_key,
                harness_type: &HarnessType::Codex,
                persona_id: None,
                existing_sandbox_id: None,
                existing_sandbox_capabilities: None,
                desired_capabilities: &SessionSandboxCapabilities::default_enabled(),
                iron_control_principal: None,
                resume_thread_id: None,
                session_repos_json: Some(r#"[{"repo":"acme/work","ref":"feature"}]"#),
                execution_id: &execution_id,
                environment: &[],
            })
            .await
            .expect("ensure sandbox");

        assert_eq!(sandbox_id, "warm-repo-hit");
        assert!(backend.created_specs().is_empty());
        assert_eq!(
            backend.prepared_homes(),
            vec![PreparedHomeCall {
                sandbox_id: "warm-repo-hit".to_owned(),
                thread_key: thread_key.as_str().to_owned(),
                execution_id: execution_id.clone(),
                repos_json: json!([
                    {"repo":"acme/work","ref":"feature"}
                ])
                .to_string(),
                precomposed: false,
            }]
        );
        assert_eq!(
            store.get_session(&thread_key).await.unwrap().sandbox_id,
            Some("warm-repo-hit".to_owned())
        );
        let all = events(&store, &thread_key).await;
        assert!(all.iter().any(|event| {
            event.event_type == "session.warm_sandbox_claimed"
                && event.payload["post_claim_overlay_home"] == json!(true)
        }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn private_repo_session_skips_warm_claim_for_cache_hydration() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key =
            ThreadKey::parse(format!("test:warm-private-repo-{}", uuid::Uuid::new_v4())).unwrap();
        create_test_session(&store, &thread_key, json!({})).await;
        let execution_id = create_test_execution(&store, &thread_key).await;
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        backend.support_prepare_home();
        let runtime = runtime_with_warm_pool(
            &store,
            backend.clone(),
            SandboxSpec::new("mock").env(
                AGENT_REPOS_JSON_ENV,
                r#"[{"repo":"acme/default","ref":"main"}]"#,
            ),
        );
        insert_ready_warm_for_runtime(&store, &runtime, "warm-private-repo").await;

        let sandbox_id = runtime
            .ensure_session_sandbox(EnsureSessionSandboxInput {
                thread_key: &thread_key,
                harness_type: &HarnessType::Codex,
                persona_id: None,
                existing_sandbox_id: None,
                existing_sandbox_capabilities: None,
                desired_capabilities: &SessionSandboxCapabilities::default_enabled(),
                iron_control_principal: Some("prn_user"),
                resume_thread_id: None,
                session_repos_json: Some(r#"[{"repo":"acme/private","private":true}]"#),
                execution_id: &execution_id,
                environment: &[],
            })
            .await
            .expect("ensure sandbox");

        assert_ne!(sandbox_id, "warm-private-repo");
        assert!(backend.prepared_homes().is_empty());
        assert_eq!(backend.created_specs().len(), 1);
        let all = events(&store, &thread_key).await;
        assert!(
            !all.iter()
                .any(|event| event.event_type == "session.warm_sandbox_claimed")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn default_repo_session_claims_precomposed_warm_with_manifest_finalize_only() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key =
            ThreadKey::parse(format!("test:warm-default-repo-{}", uuid::Uuid::new_v4())).unwrap();
        create_test_session(&store, &thread_key, json!({})).await;
        let execution_id = create_test_execution(&store, &thread_key).await;
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        backend.support_prepare_home();
        let runtime = runtime_with_warm_pool(
            &store,
            backend.clone(),
            SandboxSpec::new("mock").env(
                AGENT_REPOS_JSON_ENV,
                r#"[{"repo":"acme/default","ref":"main"}]"#,
            ),
        );
        insert_ready_warm_for_runtime(&store, &runtime, "warm-default-repo").await;

        let sandbox_id = runtime
            .ensure_session_sandbox(EnsureSessionSandboxInput {
                thread_key: &thread_key,
                harness_type: &HarnessType::Codex,
                persona_id: None,
                existing_sandbox_id: None,
                existing_sandbox_capabilities: None,
                desired_capabilities: &SessionSandboxCapabilities::default_enabled(),
                iron_control_principal: None,
                resume_thread_id: None,
                session_repos_json: None,
                execution_id: &execution_id,
                environment: &[],
            })
            .await
            .expect("ensure sandbox");

        assert_eq!(sandbox_id, "warm-default-repo");
        assert!(backend.created_specs().is_empty());
        assert_eq!(
            backend.prepared_homes(),
            vec![PreparedHomeCall {
                sandbox_id: "warm-default-repo".to_owned(),
                thread_key: thread_key.as_str().to_owned(),
                execution_id: execution_id.clone(),
                repos_json: json!([{"repo":"acme/default","ref":"main"}]).to_string(),
                precomposed: true,
            }]
        );
        let all = events(&store, &thread_key).await;
        assert!(all.iter().any(|event| {
            event.event_type == "session.warm_sandbox_claimed"
                && event.payload["post_claim_overlay_home"] == json!(false)
        }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn custom_repo_session_skips_precomposed_default_warm_pool() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key =
            ThreadKey::parse(format!("test:warm-default-miss-{}", uuid::Uuid::new_v4())).unwrap();
        create_test_session(&store, &thread_key, json!({})).await;
        let execution_id = create_test_execution(&store, &thread_key).await;
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        backend.support_prepare_home();
        let runtime = runtime_with_warm_pool(
            &store,
            backend.clone(),
            SandboxSpec::new("mock").env(
                AGENT_REPOS_JSON_ENV,
                r#"[{"repo":"acme/default","ref":"main"}]"#,
            ),
        );
        insert_ready_warm_for_runtime(&store, &runtime, "warm-default-miss").await;

        let sandbox_id = runtime
            .ensure_session_sandbox(EnsureSessionSandboxInput {
                thread_key: &thread_key,
                harness_type: &HarnessType::Codex,
                persona_id: None,
                existing_sandbox_id: None,
                existing_sandbox_capabilities: None,
                desired_capabilities: &SessionSandboxCapabilities::default_enabled(),
                iron_control_principal: None,
                resume_thread_id: None,
                session_repos_json: Some(r#"[{"repo":"acme/work","ref":"feature"}]"#),
                execution_id: &execution_id,
                environment: &[],
            })
            .await
            .expect("ensure sandbox");

        assert_eq!(sandbox_id, "mock-sbx");
        assert!(backend.prepared_homes().is_empty());
        let created_specs = backend.created_specs();
        assert_eq!(created_specs.len(), 1);
        assert_eq!(
            spec_env_json(&created_specs[0], AGENT_REPOS_JSON_ENV),
            json!([{"repo":"acme/work","ref":"feature"}])
        );
        let all = events(&store, &thread_key).await;
        assert!(
            !all.iter()
                .any(|event| event.event_type == "session.warm_sandbox_claimed")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repo_session_skips_warm_claim_when_post_claim_home_unsupported() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key = ThreadKey::parse(format!(
            "test:warm-repo-unsupported-{}",
            uuid::Uuid::new_v4()
        ))
        .unwrap();
        create_test_session(&store, &thread_key, json!({})).await;
        let execution_id = create_test_execution(&store, &thread_key).await;
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with_warm_pool(&store, backend.clone(), SandboxSpec::new("mock"));
        insert_ready_warm_for_runtime(&store, &runtime, "warm-unsupported").await;

        let sandbox_id = runtime
            .ensure_session_sandbox(EnsureSessionSandboxInput {
                thread_key: &thread_key,
                harness_type: &HarnessType::Codex,
                persona_id: None,
                existing_sandbox_id: None,
                existing_sandbox_capabilities: None,
                desired_capabilities: &SessionSandboxCapabilities::default_enabled(),
                iron_control_principal: None,
                resume_thread_id: None,
                session_repos_json: Some(r#"[{"repo":"acme/work","ref":"feature"}]"#),
                execution_id: &execution_id,
                environment: &[],
            })
            .await
            .expect("ensure sandbox");

        assert_eq!(sandbox_id, "mock-sbx");
        assert!(backend.prepared_homes().is_empty());
        let created_specs = backend.created_specs();
        assert_eq!(created_specs.len(), 1);
        assert_eq!(
            spec_env_json(&created_specs[0], AGENT_REPOS_JSON_ENV),
            json!([
                {"repo":"acme/default","ref":"main"},
                {"repo":"acme/work","ref":"feature"}
            ])
        );
        assert_eq!(
            store.get_session(&thread_key).await.unwrap().sandbox_id,
            Some("mock-sbx".to_owned())
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn post_claim_home_failure_retires_warm_and_cold_spawns() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key =
            ThreadKey::parse(format!("test:warm-repo-fallback-{}", uuid::Uuid::new_v4())).unwrap();
        create_test_session(&store, &thread_key, json!({})).await;
        let execution_id = create_test_execution(&store, &thread_key).await;
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        backend.support_prepare_home();
        backend.fail_prepare_home("bind failed");
        let runtime = runtime_with_warm_pool(&store, backend.clone(), SandboxSpec::new("mock"));
        insert_ready_warm_for_runtime(&store, &runtime, "warm-bind-fails").await;

        let sandbox_id = runtime
            .ensure_session_sandbox(EnsureSessionSandboxInput {
                thread_key: &thread_key,
                harness_type: &HarnessType::Codex,
                persona_id: None,
                existing_sandbox_id: None,
                existing_sandbox_capabilities: None,
                desired_capabilities: &SessionSandboxCapabilities::default_enabled(),
                iron_control_principal: None,
                resume_thread_id: None,
                session_repos_json: Some(r#"[{"repo":"acme/work","ref":"feature"}]"#),
                execution_id: &execution_id,
                environment: &[],
            })
            .await
            .expect("ensure sandbox");

        assert_eq!(sandbox_id, "mock-sbx");
        assert_eq!(backend.prepared_homes().len(), 1);
        assert_eq!(backend.stopped(), vec!["warm-bind-fails".to_owned()]);
        let created_specs = backend.created_specs();
        assert_eq!(created_specs.len(), 1);
        assert_eq!(
            spec_env_json(&created_specs[0], AGENT_REPOS_JSON_ENV),
            json!([{"repo":"acme/work","ref":"feature"}])
        );
        assert_eq!(
            store.get_session(&thread_key).await.unwrap().sandbox_id,
            Some("mock-sbx".to_owned())
        );
        let all = events(&store, &thread_key).await;
        assert!(all.iter().any(|event| {
            event.event_type == "session.warm_sandbox_post_claim_bind_failed"
                && event.payload["sandbox_id"] == json!("warm-bind-fails")
                && event.payload["fallback"] == json!("cold_create")
        }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workflow_cleanup_stops_and_clears_owned_sandbox() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let workflow_run_id = format!("run-{}", uuid::Uuid::new_v4());
        let thread_key =
            ThreadKey::parse(format!("test:wf-cleanup-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({
                    "source": "absurd_workflow",
                    "workflow_run_id": workflow_run_id,
                    "workflow_owned_thread": true,
                }),
            )
            .await
            .expect("create session");
        store
            .update_sandbox_id(&thread_key, Some("sbx-owned"))
            .await
            .expect("set sandbox id");
        store
            .insert_ready_warm_sandbox("sbx-owned", "test-workload")
            .await
            .expect("insert warm sandbox");
        assert_eq!(
            store
                .claim_ready_warm_sandbox("test-workload", thread_key.as_str())
                .await
                .expect("claim warm sandbox"),
            Some("sbx-owned".to_owned())
        );
        assert!(
            store
                .list_referenced_sandbox_ids()
                .await
                .expect("list referenced sandboxes")
                .contains(&"sbx-owned".to_owned())
        );

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());
        let report = runtime
            .stop_workflow_owned_sandboxes(&workflow_run_id, "test")
            .await
            .expect("cleanup workflow sandboxes");

        assert_eq!(report.stopped, vec!["sbx-owned".to_owned()]);
        assert_eq!(backend.stopped(), vec!["sbx-owned".to_owned()]);
        assert_eq!(
            store.get_session(&thread_key).await.unwrap().sandbox_id,
            None
        );
        assert!(
            !store
                .list_referenced_sandbox_ids()
                .await
                .expect("list referenced sandboxes")
                .contains(&"sbx-owned".to_owned())
        );
        let all = events(&store, &thread_key).await;
        assert!(all.iter().any(|event| {
            event.event_type == "session.workflow_sandbox_stopped"
                && event.payload["workflow_run_id"] == json!(workflow_run_id)
                && event.payload["cleared"] == json!(true)
        }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workflow_cleanup_preserves_explicit_unowned_thread_key() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let workflow_run_id = format!("run-{}", uuid::Uuid::new_v4());
        let thread_key =
            ThreadKey::parse(format!("test:wf-explicit-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({
                    "source": "absurd_workflow",
                    "workflow_run_id": workflow_run_id,
                }),
            )
            .await
            .expect("create session");
        store
            .update_sandbox_id(&thread_key, Some("sbx-explicit"))
            .await
            .expect("set sandbox id");

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());
        let report = runtime
            .stop_workflow_owned_sandboxes(&workflow_run_id, "test")
            .await
            .expect("cleanup workflow sandboxes");

        assert!(report.stopped.is_empty());
        assert!(backend.stopped().is_empty());
        assert_eq!(
            store.get_session(&thread_key).await.unwrap().sandbox_id,
            Some("sbx-explicit".to_owned())
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workflow_cleanup_clears_owned_sandbox_when_backend_reports_missing() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let workflow_run_id = format!("run-{}", uuid::Uuid::new_v4());
        let thread_key =
            ThreadKey::parse(format!("test:wf-missing-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({
                    "source": "absurd_workflow",
                    "workflow_run_id": workflow_run_id,
                    "workflow_owned_thread": true,
                }),
            )
            .await
            .expect("create session");
        store
            .update_sandbox_id(&thread_key, Some("sbx-missing"))
            .await
            .expect("set sandbox id");

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        backend.mark_stop_missing("sbx-missing");
        let runtime = runtime_with(&store, backend);
        let report = runtime
            .stop_workflow_owned_sandboxes(&workflow_run_id, "test")
            .await
            .expect("cleanup workflow sandboxes");

        assert_eq!(report.missing, vec!["sbx-missing".to_owned()]);
        assert_eq!(
            store.get_session(&thread_key).await.unwrap().sandbox_id,
            None
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resume_failure_replaces_sandbox_and_preserves_harness_thread_id() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:resume-failed-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(&thread_key, &HarnessType::Codex, None, json!({}))
            .await
            .expect("create session");
        store
            .update_sandbox_id(&thread_key, Some("sbx-old"))
            .await
            .expect("set sandbox id");
        store
            .update_harness_thread_id(&thread_key, Some("harness-thread-1"))
            .await
            .expect("set harness thread id");
        let execution_id = store
            .create_execution(&thread_key, None, json!({}))
            .await
            .expect("create execution")
            .execution
            .execution_id;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Suspended, Vec::new()));
        backend.fail_resume();
        let runtime = runtime_with(&store, backend);
        let sandbox_id = runtime
            .ensure_session_sandbox(EnsureSessionSandboxInput {
                thread_key: &thread_key,
                harness_type: &HarnessType::Codex,
                persona_id: None,
                existing_sandbox_id: Some("sbx-old"),
                existing_sandbox_capabilities: None,
                desired_capabilities: &SessionSandboxCapabilities::default_enabled(),
                iron_control_principal: None,
                resume_thread_id: None,
                session_repos_json: None,
                execution_id: &execution_id,
                environment: &[],
            })
            .await
            .expect("resume failure should fall through to replacement");

        assert_eq!(sandbox_id, "mock-sbx");
        let session = store.get_session(&thread_key).await.unwrap();
        assert_eq!(session.sandbox_id, Some("mock-sbx".to_owned()));
        assert_eq!(
            session.harness_thread_id,
            Some("harness-thread-1".to_owned())
        );
        let all = events(&store, &thread_key).await;
        assert!(
            all.iter()
                .any(|event| event.event_type == "session.sandbox_resume_failed")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_pipe_ensure_opens_one_io_per_sandbox() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:pipe-race-{}", uuid::Uuid::new_v4())).unwrap();
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (first_io, _first_stdout, _first_stdin) = mock_io();
        let (second_io, _second_stdout, _second_stdin) = mock_io();
        backend.push_io(first_io).await;
        backend.push_io(second_io).await;

        let runtime = runtime_with(&store, backend.clone());
        let (first, second) = tokio::join!(
            runtime.ensure_session_pipe(&thread_key, "sbx-pipe-race"),
            runtime.ensure_session_pipe(&thread_key, "sbx-pipe-race"),
        );

        first.expect("first pipe ensure should succeed");
        second.expect("second pipe ensure should reuse the first pipe");
        assert_eq!(backend.opens(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stdout_eof_recovers_terminal_output_from_recorded_logs() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:eof-recorded-{}", uuid::Uuid::new_v4())).unwrap();
        orphaned_execution(&store, &thread_key, Some("sbx-recorded"), true).await;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (io, stdout, _stdin) = mock_io();
        backend.push_io(io).await;

        let runtime = runtime_with(&store, backend.clone());
        runtime
            .ensure_session_pipe(&thread_key, "sbx-recorded")
            .await
            .expect("open initial pipe");
        backend.set_recorded_output(completed_output_lines("Recovered from pod logs."));
        drop(stdout);

        wait_for_event(&store, &thread_key, "session.execution_completed").await;
        let all = events(&store, &thread_key).await;
        assert!(
            all.iter()
                .any(|event| event.event_type == "session.stdout_pump_recovered"),
            "expected recorded-output recovery event"
        );
        assert!(
            !all.iter()
                .any(|event| event.event_type == "session.stdout_pump_reattached"),
            "recorded terminal output should avoid a live reattach"
        );
        assert!(
            !all.iter()
                .any(|event| event.event_type == "session.execution_failed"),
            "stdout eof should not fail an active execution when logs contain a terminal turn"
        );
        let completed = all
            .iter()
            .find(|event| event.event_type == "session.execution_completed")
            .expect("completed event");
        assert_eq!(
            completed.payload["result_text"].as_str(),
            Some("Recovered from pod logs.")
        );
        assert_eq!(backend.opens(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stdout_eof_reattaches_and_delivers_late_terminal_output() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:eof-reattach-{}", uuid::Uuid::new_v4())).unwrap();
        orphaned_execution(&store, &thread_key, Some("sbx-reattach"), true).await;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (first_io, mut first_stdout, _first_stdin) = mock_io();
        let (second_io, mut second_stdout, _second_stdin) = mock_io();
        backend.push_io(first_io).await;
        backend.push_io(second_io).await;

        let runtime = runtime_with(&store, backend.clone());
        runtime
            .ensure_session_pipe(&thread_key, "sbx-reattach")
            .await
            .expect("open initial pipe");
        first_stdout
            .write_all(b"{\"type\":\"thread.started\",\"thread_id\":\"mock-thread\"}\n")
            .await
            .unwrap();
        drop(first_stdout);

        wait_for_event(&store, &thread_key, "session.stdout_pump_reattached").await;
        second_stdout
            .write_all(&completed_output_bytes("Completed after reattach."))
            .await
            .unwrap();

        wait_for_event(&store, &thread_key, "session.execution_completed").await;
        let all = events(&store, &thread_key).await;
        assert!(
            !all.iter()
                .any(|event| event.event_type == "session.execution_failed"),
            "reattached stdout should not produce the old false failure"
        );
        let completed = all
            .iter()
            .find(|event| event.event_type == "session.execution_completed")
            .expect("completed event");
        assert_eq!(
            completed.payload["result_text"].as_str(),
            Some("Completed after reattach.")
        );
        assert_eq!(backend.opens(), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stdout_eof_fails_when_sandbox_no_longer_accepts_io() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:eof-gone-{}", uuid::Uuid::new_v4())).unwrap();
        orphaned_execution(&store, &thread_key, Some("sbx-gone"), true).await;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (io, stdout, _stdin) = mock_io();
        backend.push_io(io).await;

        let runtime = runtime_with(&store, backend.clone());
        runtime
            .ensure_session_pipe(&thread_key, "sbx-gone")
            .await
            .expect("open initial pipe");
        backend.set_status(SandboxStatus::Gone);
        drop(stdout);

        wait_for_event(&store, &thread_key, "session.execution_failed").await;
        let all = events(&store, &thread_key).await;
        let failed = all
            .iter()
            .find(|event| event.event_type == "session.execution_failed")
            .expect("failed event");
        let error = failed.payload["error"].as_str().unwrap_or_default();
        assert!(
            error.contains("sandbox stdout closed before terminal output"),
            "unexpected error: {error}"
        );
        assert!(
            error.contains("sandbox no longer accepts io"),
            "expected sandbox status detail: {error}"
        );
        assert!(
            !all.iter()
                .any(|event| event.event_type == "session.stdout_pump_reattached"),
            "gone sandbox should not reattach"
        );
        assert_eq!(backend.opens(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn adopts_finished_turn_from_recorded_sandbox_output() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key =
            ThreadKey::parse(format!("test:adopt-logs-{}", uuid::Uuid::new_v4())).unwrap();
        orphaned_execution(&store, &thread_key, Some("sbx-mock"), true).await;

        let backend = Arc::new(MockBackend::new(
            SandboxStatus::Running,
            vec![
                json!({"type": "item.completed", "item": {"id": "msg-1", "type": "agentMessage", "text": "Done: pushed commit abc123.", "phase": "final_answer"}}).to_string(),
                json!({"type": "turn.completed", "turn": {"id": "turn-1", "status": "completed"}}).to_string(),
            ],
        ));
        let runtime = runtime_with(&store, backend.clone());
        runtime.adopt_orphaned_executions().await;

        wait_for_event(&store, &thread_key, "session.execution_completed").await;
        let all = events(&store, &thread_key).await;
        assert!(
            all.iter()
                .any(|event| event.event_type == "session.execution_adopted"),
            "expected an adoption event"
        );
        let completed = all
            .iter()
            .find(|event| event.event_type == "session.execution_completed")
            .expect("completed event");
        assert_eq!(
            completed.payload["result_text"].as_str(),
            Some("Done: pushed commit abc123.")
        );
        // The terminal came from recorded output; no live attach was needed.
        assert_eq!(backend.opens(), 0);
        let session = store.get_session(&thread_key).await.unwrap();
        assert_ne!(session.status.as_ref(), "failed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn adopts_live_when_recorded_output_has_no_terminal() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key =
            ThreadKey::parse(format!("test:adopt-live-{}", uuid::Uuid::new_v4())).unwrap();
        orphaned_execution(&store, &thread_key, Some("sbx-mock"), true).await;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (io, mut stdout, _stdin) = mock_io();
        backend.push_io(io).await;

        let runtime = runtime_with(&store, backend.clone());
        runtime.adopt_orphaned_executions().await;
        assert_eq!(backend.opens(), 1);

        stdout
            .write_all(
                b"{\"type\":\"turn.completed\",\"turn\":{\"id\":\"turn-1\",\"status\":\"completed\"}}\n",
            )
            .await
            .unwrap();
        wait_for_event(&store, &thread_key, "session.execution_completed").await;
        let all = events(&store, &thread_key).await;
        assert!(
            all.iter().any(|event| {
                event.event_type == "session.execution_adopted"
                    && event.payload["mode"] == json!("live_attach")
            }),
            "expected a live adoption event"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fails_orphans_whose_sandbox_is_gone() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key =
            ThreadKey::parse(format!("test:adopt-gone-{}", uuid::Uuid::new_v4())).unwrap();
        orphaned_execution(&store, &thread_key, Some("sbx-mock"), true).await;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Gone, Vec::new()));
        backend.set_reason("agent terminated: Error (exit 1): missing credentials");
        let runtime = runtime_with(&store, backend.clone());
        runtime.adopt_orphaned_executions().await;

        wait_for_event(&store, &thread_key, "session.execution_failed").await;
        let all = events(&store, &thread_key).await;
        let failed = all
            .iter()
            .find(|event| event.event_type == "session.execution_failed")
            .expect("failed event");
        let error = failed.payload["error"].as_str().unwrap_or_default();
        assert!(
            error.contains("execution orphaned by control plane restart"),
            "unexpected error: {error}"
        );
        assert!(
            error.contains("sandbox no longer accepts io"),
            "expected status detail: {error}"
        );
        assert!(
            error.contains("sandbox: agent terminated: Error (exit 1): missing credentials"),
            "expected sandbox reason: {error}"
        );
        assert_eq!(backend.opens(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fails_queued_orphans_that_never_received_input() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key =
            ThreadKey::parse(format!("test:adopt-queued-{}", uuid::Uuid::new_v4())).unwrap();
        orphaned_execution(&store, &thread_key, Some("sbx-mock"), false).await;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());
        runtime.adopt_orphaned_executions().await;

        wait_for_event(&store, &thread_key, "session.execution_failed").await;
        let all = events(&store, &thread_key).await;
        let failed = all
            .iter()
            .find(|event| event.event_type == "session.execution_failed")
            .expect("failed event");
        let error = failed.payload["error"].as_str().unwrap_or_default();
        assert!(
            error.contains("orphaned before input was sent"),
            "unexpected error: {error}"
        );
        assert_eq!(backend.opens(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_during_sandbox_setup_stops_created_sandbox_and_keeps_execution_cancelled() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key =
            ThreadKey::parse(format!("test:cancel-setup-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(&thread_key, &HarnessType::Codex, None, json!({}))
            .await
            .expect("create session");

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let gate = backend.pause_create();
        let runtime = runtime_with(&store, backend.clone());
        let execute_runtime = runtime.clone();
        let execute_thread_key = thread_key.clone();
        let execute_task = tokio::spawn(async move {
            execute_runtime
                .execute_session(
                    &execute_thread_key,
                    ExecuteSessionInput {
                        idempotency_key: None,
                        metadata: None,
                        environment: BTreeMap::new(),
                        input_lines: vec![
                            json!({
                                "type": "user",
                                "message": {"content": [{"type": "text", "text": "cancel me"}]},
                            })
                            .to_string(),
                        ],
                        idle_timeout_ms: None,
                        max_duration_ms: None,
                    },
                )
                .await
        });

        gate.entered.wait().await;
        let active = store
            .active_execution_for_thread(&thread_key)
            .await
            .expect("active execution lookup")
            .expect("active execution");
        let outcome = runtime.cancel_session(&thread_key).await.unwrap();
        assert!(outcome.cancelled);
        assert_eq!(
            outcome.execution_id.as_deref(),
            Some(active.execution_id.as_str())
        );
        assert_eq!(outcome.stopped_sandbox_id, None);

        gate.release.wait().await;
        let returned = execute_task.await.unwrap().unwrap();
        assert_eq!(returned.status, ExecutionStatus::Cancelled);

        let execution = store.get_execution(&active.execution_id).await.unwrap();
        assert_eq!(execution.status, ExecutionStatus::Cancelled);
        let session = store.get_session(&thread_key).await.unwrap();
        assert_eq!(session.sandbox_id, None);
        assert_eq!(backend.stops(), 1);

        let all = events(&store, &thread_key).await;
        assert!(
            all.iter()
                .any(|event| event.event_type == "session.execution_cancelled"),
            "expected a cancellation event"
        );
        assert!(
            all.iter()
                .all(|event| event.event_type != "session.execution_failed"),
            "cancelled setup must not be overwritten as failed"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancels_active_execution_and_stops_sandbox() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key =
            ThreadKey::parse(format!("test:cancel-active-{}", uuid::Uuid::new_v4())).unwrap();
        let execution_id = orphaned_execution(&store, &thread_key, Some("sbx-cancel"), true).await;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());
        let outcome = runtime.cancel_session(&thread_key).await.unwrap();

        assert!(outcome.cancelled);
        assert_eq!(outcome.execution_id.as_deref(), Some(execution_id.as_str()));
        assert_eq!(outcome.stopped_sandbox_id.as_deref(), Some("sbx-cancel"));
        assert_eq!(outcome.stop_error, None);
        assert_eq!(backend.stops(), 1);

        let execution = store.get_execution(&execution_id).await.unwrap();
        assert_eq!(execution.status, ExecutionStatus::Cancelled);
        let session = store.get_session(&thread_key).await.unwrap();
        assert_eq!(session.status, SessionStatus::Idle);
        assert_eq!(session.sandbox_id, None);

        let all = events(&store, &thread_key).await;
        assert!(
            all.iter()
                .any(|event| event.event_type == "session.execution_cancelled"),
            "expected a cancellation event"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn answers_pending_question_by_writing_active_execution_stdin() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key =
            ThreadKey::parse(format!("test:answer-question-{}", uuid::Uuid::new_v4())).unwrap();
        let execution_id = orphaned_execution(&store, &thread_key, Some("sbx-answer"), true).await;
        store
            .append_event(
                &thread_key,
                Some(&execution_id),
                SESSION_OUTPUT_LINE_EVENT,
                Value::String(
                    json!({
                        "type": "question_requested",
                        "question_id": "q-1",
                        "turn_id": "turn-1",
                        "questions": [],
                    })
                    .to_string(),
                ),
            )
            .await
            .expect("append question event");

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (io, _stdout, stdin) = mock_io();
        backend.push_io(io).await;
        let runtime = runtime_with(&store, backend.clone());
        let outcome = runtime
            .answer_execution_question(
                &thread_key,
                &execution_id,
                "q-1",
                json!({"choice": {"answers": ["A"]}}),
            )
            .await
            .expect("answer question");

        assert_eq!(outcome.execution_id, execution_id);
        assert_eq!(outcome.thread_key, thread_key);
        assert_eq!(outcome.status, "answered");
        assert_eq!(backend.opens(), 1);

        let mut reader = BufReader::new(stdin);
        let mut delivered = String::new();
        reader
            .read_line(&mut delivered)
            .await
            .expect("read delivered answer");
        let delivered: Value = serde_json::from_str(delivered.trim()).expect("answer json");
        assert_eq!(delivered["type"], "question_answer");
        assert_eq!(delivered["question_id"], "q-1");
        assert_eq!(delivered["answers"]["choice"]["answers"][0], "A");

        let all = events(&store, &thread_key).await;
        assert!(
            all.iter()
                .any(|event| event.event_type == "session.question_answer_delivered"),
            "expected answer delivery event"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_question_answers_deliver_once() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key = ThreadKey::parse(format!(
            "test:answer-question-race-{}",
            uuid::Uuid::new_v4()
        ))
        .unwrap();
        let execution_id =
            orphaned_execution(&store, &thread_key, Some("sbx-answer-race"), true).await;
        store
            .append_event(
                &thread_key,
                Some(&execution_id),
                SESSION_OUTPUT_LINE_EVENT,
                Value::String(
                    json!({
                        "type": "question_requested",
                        "question_id": "q-1",
                        "turn_id": "turn-1",
                        "questions": [],
                    })
                    .to_string(),
                ),
            )
            .await
            .expect("append question event");

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (io, _stdout, stdin) = mock_io();
        backend.push_io(io).await;
        let runtime = runtime_with(&store, backend.clone());
        let barrier = Arc::new(Barrier::new(3));

        let first = {
            let runtime = runtime.clone();
            let thread_key = thread_key.clone();
            let execution_id = execution_id.clone();
            let barrier = barrier.clone();
            tokio::spawn(async move {
                barrier.wait().await;
                runtime
                    .answer_execution_question(
                        &thread_key,
                        &execution_id,
                        "q-1",
                        json!({"choice": {"answers": ["A"]}}),
                    )
                    .await
            })
        };
        let second = {
            let runtime = runtime.clone();
            let thread_key = thread_key.clone();
            let execution_id = execution_id.clone();
            let barrier = barrier.clone();
            tokio::spawn(async move {
                barrier.wait().await;
                runtime
                    .answer_execution_question(
                        &thread_key,
                        &execution_id,
                        "q-1",
                        json!({"choice": {"answers": ["B"]}}),
                    )
                    .await
            })
        };

        barrier.wait().await;
        let first = first.await.expect("first task");
        let second = second.await.expect("second task");
        let successes = [first.as_ref(), second.as_ref()]
            .into_iter()
            .filter(|result| result.is_ok())
            .count();
        let stale = [first.as_ref(), second.as_ref()]
            .into_iter()
            .filter(|result| matches!(result, Err(AnswerQuestionError::QuestionNotPending)))
            .count();
        assert_eq!(successes, 1);
        assert_eq!(stale, 1);
        assert_eq!(backend.opens(), 1);

        let mut reader = BufReader::new(stdin);
        let mut delivered = String::new();
        tokio::time::timeout(Duration::from_secs(1), reader.read_line(&mut delivered))
            .await
            .expect("timely answer line")
            .expect("read delivered answer");
        let delivered: Value = serde_json::from_str(delivered.trim()).expect("answer json");
        assert_eq!(delivered["type"], "question_answer");
        assert_eq!(delivered["question_id"], "q-1");
        assert!(
            delivered["answers"]["choice"]["answers"][0] == "A"
                || delivered["answers"]["choice"]["answers"][0] == "B"
        );

        let mut extra = String::new();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), reader.read_line(&mut extra))
                .await
                .is_err(),
            "unexpected extra answer line: {extra:?}"
        );

        let all = events(&store, &thread_key).await;
        assert_eq!(
            all.iter()
                .filter(|event| event.event_type == "session.question_answer_delivered")
                .count(),
            1
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rejects_stale_question_answer_before_opening_sandbox_io() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key =
            ThreadKey::parse(format!("test:answer-stale-{}", uuid::Uuid::new_v4())).unwrap();
        let execution_id = orphaned_execution(&store, &thread_key, Some("sbx-stale"), true).await;
        for line in [
            json!({"type": "question_requested", "question_id": "q-1"}).to_string(),
            json!({"type": "question_resolved", "question_id": "q-1", "reason": "empty"})
                .to_string(),
        ] {
            store
                .append_event(
                    &thread_key,
                    Some(&execution_id),
                    SESSION_OUTPUT_LINE_EVENT,
                    Value::String(line),
                )
                .await
                .expect("append question event");
        }

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());
        let error = runtime
            .answer_execution_question(&thread_key, &execution_id, "q-1", json!({}))
            .await
            .expect_err("stale question should be rejected");

        assert!(matches!(error, AnswerQuestionError::QuestionNotPending));
        assert_eq!(backend.opens(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_without_active_execution_stops_assigned_sandbox() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key =
            ThreadKey::parse(format!("test:cancel-idle-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(&thread_key, &HarnessType::Codex, None, json!({}))
            .await
            .expect("create session");
        store
            .update_sandbox_id(&thread_key, Some("sbx-idle"))
            .await
            .expect("assign sandbox");

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());
        let outcome = runtime.cancel_session(&thread_key).await.unwrap();

        assert!(!outcome.cancelled);
        assert_eq!(outcome.execution_id, None);
        assert_eq!(outcome.stopped_sandbox_id.as_deref(), Some("sbx-idle"));
        assert_eq!(outcome.stop_error, None);
        assert_eq!(backend.stops(), 1);
        let session = store.get_session(&thread_key).await.unwrap();
        assert_eq!(session.sandbox_id, None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_reports_sandbox_stop_failure_without_clearing_assignment() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = lock_clean_slate().await;
        let thread_key =
            ThreadKey::parse(format!("test:cancel-stop-fail-{}", uuid::Uuid::new_v4())).unwrap();
        let execution_id = orphaned_execution(&store, &thread_key, Some("sbx-sticky"), true).await;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        backend.fail_stop("delete failed");
        let runtime = runtime_with(&store, backend.clone());
        let outcome = runtime.cancel_session(&thread_key).await.unwrap();

        assert!(outcome.cancelled);
        assert_eq!(outcome.execution_id.as_deref(), Some(execution_id.as_str()));
        assert_eq!(outcome.stopped_sandbox_id, None);
        assert!(
            outcome
                .stop_error
                .as_deref()
                .unwrap_or_default()
                .contains("delete failed")
        );
        assert_eq!(backend.stops(), 1);

        let execution = store.get_execution(&execution_id).await.unwrap();
        assert_eq!(execution.status, ExecutionStatus::Cancelled);
        let session = store.get_session(&thread_key).await.unwrap();
        assert_eq!(session.sandbox_id.as_deref(), Some("sbx-sticky"));

        let all = events(&store, &thread_key).await;
        assert!(
            all.iter()
                .any(|event| event.event_type == "session.execution_cancelled"),
            "expected a cancellation event"
        );
        assert!(
            all.iter()
                .any(|event| event.event_type == "session.sandbox_stop_failed"),
            "expected a sandbox stop failure event"
        );
    }
}
