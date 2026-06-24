//! Agent Sandbox Kubernetes backend.
//!
//! The Agent Sandbox CRD types are generated from the upstream CRD with
//! `just codegen-agent-sandbox-crd`.

use std::collections::{BTreeMap, HashMap};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use centaur_iron_control::IronControlClient;
use centaur_sandbox_core::{
    MountKind, ObservedSandbox, SandboxBackend, SandboxError, SandboxHandle, SandboxId, SandboxIo,
    SandboxResult, SandboxSpec, SandboxStatus,
};
use k8s_openapi::api::core::v1::{PersistentVolumeClaim, Pod};
use kube::api::{
    AttachParams, DeleteParams, ListParams, LogParams, Patch, PatchParams, PostParams,
};
use kube::{Api, Client, Error};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Mutex;
use tokio::time::{Instant, sleep};

pub use generated::agents_x_k8s_io as crd;
pub use iron_proxy::IronProxyConfig;
pub use overlay::OverlayConfig;
pub use tools::{GitHubTokenRef, ToolSource, ToolsConfig};

pub mod generated;
mod iron_proxy;
mod overlay;
mod tools;

const BACKEND_NAME: &str = "agent-sandbox-k8s";
const DEFAULT_CONTAINER_NAME: &str = "agent";
const MANAGED_BY_LABEL: &str = "centaur.ai/managed-by";
const SANDBOX_ID_LABEL: &str = "centaur.ai/sandbox-id";
const MANAGED_BY_VALUE: &str = "api-rs";
// iron-control principal OID the sandbox's proxy binds to, stamped at create
// so resume (which has only the sandbox id) can rebind without the spec or any
// in-memory state. Survives pause and api-rs restarts.
const IRON_CONTROL_PRINCIPAL_ANNOTATION: &str = "centaur.ai/iron-control-principal";
const RUNTIME_THREAD_KEY_ANNOTATION: &str = "centaur.ai/thread-key";
const RUNTIME_EXECUTION_ID_ANNOTATION: &str = "centaur.ai/execution-id";
const RUNTIME_CONTEXT_VOLUME: &str = "runtime-context";
const RUNTIME_CONTEXT_MOUNT_PATH: &str = "/etc/centaur/runtime-context";
// RFC 3339 instant stamped when the sandbox is paused for idleness and
// cleared on resume. The reaper uses it to stop sandboxes whose pause
// outlived the idle TTL, surviving api-rs restarts (the pause timer is
// otherwise in-memory only).
const PAUSED_AT_ANNOTATION: &str = "centaur.ai/paused-at";

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct AgentSandboxConfig {
    pub namespace: String,
    pub field_manager: String,
    pub container_name: String,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub image_pull_policy: Option<String>,
    pub image_pull_secrets: Vec<String>,
    pub state_volume: Option<StateVolumeConfig>,
    pub iron_proxy: Option<IronProxyConfig>,
    pub iron_control: Option<IronControlSettings>,
    /// When set, every sandbox gets a `tools-bootstrap` init container that
    /// git-clones the tools repo into the agent's `/app/tools`, and `TOOL_DIRS`
    /// is set so the agent's shim installer finds them.
    pub tools: Option<ToolsConfig>,
    /// When set, every sandbox writes an overlay manifest, waits for the
    /// node-sync daemon's ready marker, and mounts the daemon-owned workspace
    /// into the hardened agent container.
    pub overlay: Option<OverlayConfig>,
    /// In-cluster OTLP collector (e.g. Laminar) the sandbox exports harness
    /// traces to directly. The per-sandbox egress NetworkPolicy denies all
    /// destinations except the proxy/control plane, so without this rule the
    /// harness's usage/cost spans never leave the pod.
    pub otlp_egress: Option<OtlpEgressTarget>,
    pub ready_timeout: Duration,
}

/// Destination of the sandbox's direct OTLP export, expressed as the target
/// namespace (matched by `kubernetes.io/metadata.name`) and port of the
/// collector service.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OtlpEgressTarget {
    pub namespace: String,
    pub port: u16,
}

/// iron-control coordinates for sync-mode egress proxies. When set, a sandbox
/// whose spec carries an `iron_control_principal` gets a per-sandbox proxy
/// registered in iron-control (synced over `IRON_CONTROL_URL` with its
/// `iprx_` token) instead of a rendered static proxy config.
#[derive(Clone, Debug)]
pub struct IronControlSettings {
    /// Admin client used to register/deregister the per-sandbox proxy.
    pub client: IronControlClient,
    /// Base URL injected into the proxy pod as `IRON_CONTROL_URL`.
    pub control_url: String,
    /// iron-control namespace, used to resolve principals by `foreign_id`.
    pub namespace: String,
}

impl AgentSandboxConfig {
    pub fn new(namespace: impl Into<String>) -> Self {
        Self {
            namespace: namespace.into(),
            field_manager: "centaur-api-rs".to_owned(),
            container_name: DEFAULT_CONTAINER_NAME.to_owned(),
            labels: BTreeMap::new(),
            annotations: BTreeMap::new(),
            image_pull_policy: None,
            image_pull_secrets: Vec::new(),
            state_volume: None,
            iron_proxy: None,
            iron_control: None,
            tools: None,
            overlay: None,
            otlp_egress: None,
            ready_timeout: Duration::from_secs(60),
        }
    }

    pub fn state_volume(mut self, state_volume: StateVolumeConfig) -> Self {
        self.state_volume = Some(state_volume);
        self
    }

    pub fn iron_proxy(mut self, iron_proxy: IronProxyConfig) -> Self {
        self.iron_proxy = Some(iron_proxy);
        self
    }

    pub fn iron_control(mut self, iron_control: IronControlSettings) -> Self {
        self.iron_control = Some(iron_control);
        self
    }

    pub fn tools(mut self, tools: ToolsConfig) -> Self {
        self.tools = Some(tools);
        self
    }

    pub fn overlay(mut self, overlay: OverlayConfig) -> Self {
        self.overlay = Some(overlay);
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StateVolumeConfig {
    pub mount_path: String,
    pub size: String,
    pub storage_class_name: Option<String>,
}

impl StateVolumeConfig {
    pub fn new(mount_path: impl Into<String>, size: impl Into<String>) -> Self {
        Self {
            mount_path: mount_path.into(),
            size: size.into(),
            storage_class_name: None,
        }
    }

    pub fn storage_class_name(mut self, storage_class_name: impl Into<String>) -> Self {
        self.storage_class_name = Some(storage_class_name.into());
        self
    }
}

#[derive(Clone)]
pub struct AgentSandboxBackend {
    client: Client,
    config: AgentSandboxConfig,
    // sandbox id -> iron-control proxy OID, so the proxy can be deregistered on
    // stop. Only populated for sync-mode sandboxes.
    proxy_ids: Arc<Mutex<HashMap<String, String>>>,
}

impl AgentSandboxBackend {
    pub fn new(client: Client, config: AgentSandboxConfig) -> Self {
        Self {
            client,
            config,
            proxy_ids: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn try_default(namespace: impl Into<String>) -> SandboxResult<Self> {
        let client = Client::try_default()
            .await
            .map_err(|err| SandboxError::backend_source("create kube client", err))?;
        Ok(Self::new(client, AgentSandboxConfig::new(namespace)))
    }

    fn sandboxes(&self) -> Api<crd::Sandbox> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    fn pods(&self) -> Api<Pod> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    fn persistent_volume_claims(&self) -> Api<PersistentVolumeClaim> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    async fn get_sandbox(&self, id: &SandboxId) -> SandboxResult<Option<crd::Sandbox>> {
        match self.sandboxes().get(id.as_str()).await {
            Ok(sandbox) => Ok(Some(sandbox)),
            Err(err) if is_not_found(&err) => Ok(None),
            Err(err) => Err(map_kube_error("get sandbox", err)),
        }
    }

    async fn get_pod(&self, id: &SandboxId) -> SandboxResult<Option<Pod>> {
        match self.pods().get(id.as_str()).await {
            Ok(pod) => Ok(Some(pod)),
            Err(err) if is_not_found(&err) => Ok(None),
            Err(err) => Err(map_kube_error("get sandbox pod", err)),
        }
    }

    async fn observed_from_sandbox(
        &self,
        id: &SandboxId,
        sandbox: &crd::Sandbox,
    ) -> SandboxResult<ObservedSandbox> {
        let replicas = sandbox.spec.replicas.unwrap_or(1);
        let pod = self.get_pod(id).await?;
        let status = sandbox_status_from_pod(replicas, pod.as_ref());
        Ok(ObservedSandbox::new(id.clone(), BACKEND_NAME, status)
            .with_created_at(sandbox_creation_time(sandbox))
            .with_suspended_since(sandbox_paused_at(sandbox)))
    }

    async fn patch_sandbox_merge(&self, id: &SandboxId, patch: Value) -> SandboxResult<()> {
        let params = PatchParams::apply(&self.config.field_manager);
        self.sandboxes()
            .patch(id.as_str(), &params, &Patch::Merge(patch))
            .await
            .map(|_| ())
            .map_err(|err| map_kube_error("patch sandbox", err))
    }

    async fn delete_state_pvc(&self, id: &SandboxId) -> SandboxResult<()> {
        if self.config.state_volume.is_none() {
            return Ok(());
        }
        match self
            .persistent_volume_claims()
            .delete(&state_pvc_name(id), &DeleteParams::default())
            .await
        {
            Ok(_) => Ok(()),
            Err(err) if is_not_found(&err) => Ok(()),
            Err(err) => Err(map_kube_error("delete sandbox state pvc", err)),
        }
    }

    async fn wait_until_running(&self, id: &SandboxId) -> SandboxResult<()> {
        let deadline = Instant::now() + self.config.ready_timeout;
        loop {
            match self.status(id).await? {
                SandboxStatus::Running => return Ok(()),
                SandboxStatus::Gone | SandboxStatus::Stopped => {
                    return Err(SandboxError::NotReady(format!(
                        "sandbox {} reached terminal state before running",
                        id.as_str()
                    )));
                }
                status if Instant::now() >= deadline => {
                    return Err(SandboxError::NotReady(format!(
                        "sandbox {} did not become running before timeout; latest status: {status:?}",
                        id.as_str()
                    )));
                }
                _ => sleep(Duration::from_millis(500)).await,
            }
        }
    }

    async fn attach_io(&self, id: &SandboxId) -> SandboxResult<SandboxIo> {
        if self.status(id).await? != SandboxStatus::Running {
            return Err(SandboxError::NotReady(format!(
                "agent sandbox {} is not running",
                id.as_str()
            )));
        }
        let params = AttachParams::default()
            .container(self.config.container_name.clone())
            .stdin(true)
            .stdout(true)
            .stderr(true)
            .tty(false);
        let mut attached = self
            .pods()
            .attach(id.as_str(), &params)
            .await
            .map_err(|err| map_kube_error("attach sandbox pod", err))?;
        let stdin = attached
            .stdin()
            .map(|stream| Box::pin(stream) as Pin<Box<dyn AsyncWrite + Send>>);
        let stdout = attached
            .stdout()
            .map(|stream| Box::pin(stream) as Pin<Box<dyn AsyncRead + Send>>);
        let stderr = attached
            .stderr()
            .map(|stream| Box::pin(stream) as Pin<Box<dyn AsyncRead + Send>>);
        let stdin = stdin.ok_or_else(|| SandboxError::io("stdin was not attached"))?;
        let stdout = stdout.ok_or_else(|| SandboxError::io("stdout was not attached"))?;
        let stderr = stderr.ok_or_else(|| SandboxError::io("stderr was not attached"))?;
        // Keep kube's attach process alive as long as the returned streams are in use.
        Ok(SandboxIo::with_guard(stdin, stdout, stderr, attached))
    }
}

#[async_trait]
impl SandboxBackend for AgentSandboxBackend {
    fn name(&self) -> &'static str {
        BACKEND_NAME
    }

    async fn create(&self, spec: SandboxSpec) -> SandboxResult<SandboxHandle> {
        let id = SandboxId::new(next_sandbox_name());
        let mut spec = spec;
        let resolved_iron_proxy = self.resolve_iron_proxy(&id, &spec).await?;
        if let Some(resolved) = &resolved_iron_proxy {
            iron_proxy::apply_proxy_env(&mut spec, resolved);
        }
        if let Err(err) = self
            .create_iron_proxy_resources(&id, resolved_iron_proxy.as_ref())
            .await
        {
            let _ = self.delete_iron_proxy_resources(&id).await;
            return Err(err);
        }
        let sandbox = build_agent_sandbox(&id, &spec, &self.config)?;
        let created = match self
            .sandboxes()
            .create(&PostParams::default(), &sandbox)
            .await
        {
            Ok(created) => created,
            Err(err) => {
                let _ = self.delete_iron_proxy_resources(&id).await;
                return Err(map_kube_error("create sandbox", err));
            }
        };
        // The proxy resources are created before the Sandbox CR (the egress
        // policies must exist before the pod starts), so bind them to it here
        // for cascade deletion. Failure leaves them cleanable by stop() only.
        if let Err(error) = self.adopt_iron_proxy_resources(&id, &created).await {
            tracing::warn!(
                sandbox_id = id.as_str(),
                %error,
                "failed to set ownerReferences on iron-proxy resources"
            );
        }
        if let Err(err) = self.wait_until_running(&id).await {
            let _ = self.stop(&id).await;
            return Err(err);
        }
        Ok(SandboxHandle::new(id, BACKEND_NAME))
    }

    async fn open_io(&self, id: &SandboxId) -> SandboxResult<SandboxIo> {
        self.attach_io(id).await
    }

    /// Replays the workload container's stdout from the kubelet's log files.
    /// Unlike an attach stream, this includes output emitted while no reader
    /// was attached, which is what makes orphaned-execution adoption possible.
    async fn read_output_since(
        &self,
        id: &SandboxId,
        since: Option<std::time::SystemTime>,
    ) -> SandboxResult<Vec<String>> {
        let mut params = LogParams {
            container: Some(self.config.container_name.clone()),
            ..LogParams::default()
        };
        if let Some(since) = since {
            params.since_time = Some(
                jiff::Timestamp::try_from(since)
                    .map_err(|error| SandboxError::io_source("invalid log since time", error))?,
            );
        }
        let text = self
            .pods()
            .logs(id.as_str(), &params)
            .await
            .map_err(|err| map_kube_error("read sandbox pod logs", err))?;
        Ok(text.lines().map(str::to_owned).collect())
    }

    async fn status(&self, id: &SandboxId) -> SandboxResult<SandboxStatus> {
        let Some(sandbox) = self.get_sandbox(id).await? else {
            return Ok(SandboxStatus::Gone);
        };
        let replicas = sandbox.spec.replicas.unwrap_or(1);
        let pod = self.get_pod(id).await?;
        Ok(sandbox_status_from_pod(replicas, pod.as_ref()))
    }

    async fn observe(&self, id: &SandboxId) -> SandboxResult<ObservedSandbox> {
        let Some(sandbox) = self.get_sandbox(id).await? else {
            return Ok(ObservedSandbox::new(
                id.clone(),
                BACKEND_NAME,
                SandboxStatus::Gone,
            ));
        };
        self.observed_from_sandbox(id, &sandbox).await
    }

    async fn list_observed(&self) -> SandboxResult<Vec<ObservedSandbox>> {
        let params =
            ListParams::default().labels(&format!("{MANAGED_BY_LABEL}={MANAGED_BY_VALUE}"));
        let sandboxes = self
            .sandboxes()
            .list(&params)
            .await
            .map_err(|err| map_kube_error("list sandboxes", err))?;
        let mut observed = Vec::with_capacity(sandboxes.items.len());
        for sandbox in sandboxes.items {
            let Some(name) = sandbox.metadata.name.clone() else {
                continue;
            };
            let id = SandboxId::new(name);
            observed.push(self.observed_from_sandbox(&id, &sandbox).await?);
        }
        Ok(observed)
    }

    async fn stop(&self, id: &SandboxId) -> SandboxResult<()> {
        let proxy_result = self.delete_iron_proxy_resources(id).await;
        match self
            .sandboxes()
            .delete(id.as_str(), &DeleteParams::default())
            .await
        {
            Ok(_) => {
                proxy_result?;
                self.delete_state_pvc(id).await
            }
            Err(err) if is_not_found(&err) => {
                proxy_result?;
                self.delete_state_pvc(id).await
            }
            Err(err) => Err(map_kube_error("delete sandbox", err)),
        }
    }

    async fn assign_iron_control_proxy_principal(
        &self,
        id: &SandboxId,
        principal_id: &str,
    ) -> SandboxResult<()> {
        self.assign_proxy_principal(id, principal_id).await
    }

    async fn set_runtime_context(
        &self,
        id: &SandboxId,
        thread_key: &str,
        execution_id: &str,
    ) -> SandboxResult<()> {
        let patch = json!({
            "metadata": {
                "annotations": {
                    RUNTIME_THREAD_KEY_ANNOTATION: thread_key,
                    RUNTIME_EXECUTION_ID_ANNOTATION: execution_id,
                },
            },
        });
        self.pods()
            .patch(
                id.as_str(),
                &PatchParams::apply(&self.config.field_manager),
                &Patch::Merge(&patch),
            )
            .await
            .map(|_| ())
            .map_err(|err| map_kube_error("patch sandbox runtime context", err))
    }

    async fn pause(&self, id: &SandboxId) -> SandboxResult<()> {
        self.patch_sandbox_merge(id, sandbox_pause_patch(jiff::Timestamp::now()))
            .await
    }

    async fn resume(&self, id: &SandboxId) -> SandboxResult<()> {
        // Resume only has the sandbox id, not the spec, so rebind the proxy to
        // the principal recorded at create rather than re-resolving from spec.
        let resolved_iron_proxy = self.resolve_iron_proxy_for_resume(id).await?;
        self.create_iron_proxy_resources(id, resolved_iron_proxy.as_ref())
            .await?;
        // The proxy resources were recreated, so re-bind them to the sandbox
        // for cascade deletion.
        if let Some(sandbox) = self.get_sandbox(id).await?
            && let Err(error) = self.adopt_iron_proxy_resources(id, &sandbox).await
        {
            tracing::warn!(
                sandbox_id = id.as_str(),
                %error,
                "failed to set ownerReferences on resumed iron-proxy resources"
            );
        }
        self.patch_sandbox_merge(id, sandbox_resume_patch()).await?;
        self.wait_until_running(id).await
    }
}

fn sandbox_pause_patch(paused_at: jiff::Timestamp) -> Value {
    json!({
        "spec": { "replicas": 0 },
        "metadata": { "annotations": { PAUSED_AT_ANNOTATION: paused_at.to_string() } },
    })
}

fn sandbox_resume_patch() -> Value {
    // A JSON merge patch null removes the annotation.
    json!({
        "spec": { "replicas": 1 },
        "metadata": { "annotations": { PAUSED_AT_ANNOTATION: null } },
    })
}

fn sandbox_creation_time(sandbox: &crd::Sandbox) -> Option<SystemTime> {
    sandbox
        .metadata
        .creation_timestamp
        .as_ref()
        .map(|time| SystemTime::from(time.0))
}

fn sandbox_paused_at(sandbox: &crd::Sandbox) -> Option<SystemTime> {
    let raw = sandbox
        .metadata
        .annotations
        .as_ref()?
        .get(PAUSED_AT_ANNOTATION)?;
    let timestamp = raw.parse::<jiff::Timestamp>().ok()?;
    Some(SystemTime::from(timestamp))
}

fn sandbox_status_from_pod(replicas: i32, pod: Option<&Pod>) -> SandboxStatus {
    if replicas == 0 {
        return SandboxStatus::Suspended;
    }
    // The backing Pod Ready condition is the attach boundary; phase alone can be Running while
    // the sandbox is still not ready for I/O.
    let Some(pod) = pod else {
        return SandboxStatus::Created;
    };
    if pod.metadata.deletion_timestamp.is_some() {
        return SandboxStatus::Created;
    }

    let phase = pod
        .status
        .as_ref()
        .and_then(|status| status.phase.as_deref())
        .unwrap_or("unknown")
        .to_ascii_lowercase();
    match phase.as_str() {
        "running" if pod_ready(pod) => SandboxStatus::Running,
        "running" | "pending" => SandboxStatus::Created,
        "succeeded" | "failed" => SandboxStatus::Stopped,
        "unknown" => SandboxStatus::Unknown("unknown".to_owned()),
        other => SandboxStatus::Unknown(other.to_owned()),
    }
}

fn pod_ready(pod: &Pod) -> bool {
    pod.status
        .as_ref()
        .and_then(|status| status.conditions.as_ref())
        .is_some_and(|conditions| {
            conditions
                .iter()
                .any(|condition| condition.type_ == "Ready" && condition.status == "True")
        })
}

fn build_agent_sandbox(
    id: &SandboxId,
    spec: &SandboxSpec,
    config: &AgentSandboxConfig,
) -> SandboxResult<crd::Sandbox> {
    let mut labels = config.labels.clone();
    labels.extend(spec.labels.clone());
    labels.insert(MANAGED_BY_LABEL.to_owned(), MANAGED_BY_VALUE.to_owned());
    labels.insert(SANDBOX_ID_LABEL.to_owned(), id.as_str().to_owned());

    let mut pod_labels = labels.clone();
    pod_labels.insert(
        "app.kubernetes.io/name".to_owned(),
        "centaur-sandbox".to_owned(),
    );

    let mut container = json!({
        "name": config.container_name,
        "image": spec.image,
        "stdin": true,
        "stdinOnce": false,
        "tty": false,
    });
    insert_optional(
        &mut container,
        "imagePullPolicy",
        config.image_pull_policy.clone(),
    );
    insert_optional(&mut container, "command", spec.command.clone());
    insert_optional(
        &mut container,
        "args",
        (!spec.args.is_empty()).then(|| spec.args.clone()),
    );
    // Agent container env: spec env + tools wiring (deduped). `TOOL_DIRS`
    // is set deterministically here (not via passthrough) so it always matches
    // the path the bootstrap init container actually populates in this pod.
    let mut agent_env: Vec<(String, String)> = spec
        .env
        .iter()
        .map(|env| (env.name.clone(), env.value.clone()))
        .collect();
    if config.tools.is_some() {
        for (name, value) in tools::agent_env(config.tools.as_ref()) {
            upsert_env(&mut agent_env, &name, value);
        }
    }
    if let Some(overlay) = &config.overlay {
        upsert_env(&mut agent_env, "CENTAUR_OVERLAY_ENABLED", "1".to_string());
        if overlay.flat_home {
            upsert_env(&mut agent_env, "CENTAUR_FLAT_HOME", "1".to_string());
        }
    }
    insert_optional(
        &mut container,
        "env",
        (!agent_env.is_empty()).then(|| {
            agent_env
                .iter()
                .map(|(name, value)| json!({ "name": name, "value": value }))
                .collect::<Vec<_>>()
        }),
    );
    insert_optional(&mut container, "workingDir", spec.working_dir.clone());
    insert_optional(&mut container, "resources", resources_json(spec));

    let (mut volumes, mut volume_mounts) = mount_json(spec);
    let mut init_containers = Vec::new();
    if let Some(state_volume) = &config.state_volume {
        volume_mounts.push(json!({
            "name": "state",
            "mountPath": state_volume.mount_path,
        }));
    }
    if let Some(iron_proxy) = &config.iron_proxy {
        volume_mounts.push(iron_proxy::sandbox_ca_volume_mount_json());
        volumes.push(iron_proxy::sandbox_ca_volume_json(iron_proxy));
    }
    // Tool sources are bootstrapped into an emptyDir by an init container and
    // mounted into the agent at the same path `TOOL_DIRS` points at. The mount is
    // writable so `centaur-tools refresh` can fetch and republish the tree.
    if config.tools.is_some() {
        volume_mounts.extend(tools::agent_volume_mounts_json(config.tools.as_ref()));
        volumes.extend(tools::volumes_json(config.tools.as_ref()));
    }
    if let Some(overlay) = &config.overlay {
        let agent_uid = agent_run_as_user(&container).unwrap_or(overlay.agent_uid);
        let metadata = overlay::OverlayMetadata::from_sandbox_spec(spec, agent_uid);
        container["workingDir"] = if overlay.flat_home {
            json!(overlay::DEFAULT_HOME_MOUNT_PATH)
        } else {
            json!(overlay.workspace_mount_path.clone())
        };
        volume_mounts.push(overlay::overlay_agent_volume_mount_json(
            overlay,
            id.as_str(),
        ));
        volume_mounts.push(overlay::atrium_agent_volume_mount_json(overlay));
        volumes.extend(overlay::overlay_volumes_json(overlay, id.as_str()));
        volumes.push(overlay::atrium_volume_json(id.as_str()));
        init_containers.push(overlay::overlay_manifest_init_container_json(
            overlay,
            id.as_str(),
            &metadata,
        ));
        init_containers.push(overlay::overlay_readiness_init_container_json(
            overlay,
            id.as_str(),
        ));
    }
    volume_mounts.push(json!({
        "name": RUNTIME_CONTEXT_VOLUME,
        "mountPath": RUNTIME_CONTEXT_MOUNT_PATH,
        "readOnly": true,
    }));
    volumes.push(json!({
        "name": RUNTIME_CONTEXT_VOLUME,
        "downwardAPI": {
            "items": [
                {
                    "path": "thread_key",
                    "fieldRef": {
                        "fieldPath": format!("metadata.annotations['{RUNTIME_THREAD_KEY_ANNOTATION}']"),
                    },
                },
                {
                    "path": "execution_id",
                    "fieldRef": {
                        "fieldPath": format!("metadata.annotations['{RUNTIME_EXECUTION_ID_ANNOTATION}']"),
                    },
                },
            ],
        },
    }));
    insert_optional(
        &mut container,
        "volumeMounts",
        (!volume_mounts.is_empty()).then_some(volume_mounts),
    );

    // tools-bootstrap publishes the tools repo into /app/tools.
    if let Some(tools) = &config.tools {
        // The sandbox NetworkPolicy only allows egress to the per-sandbox proxy
        // (plus api-rs and DNS), so when iron-proxy is on the clone must ride it.
        // `apply_proxy_env` ran before this builder, so the resolved proxy URL is
        // on the spec env; absent (proxy disabled/unresolved) the clone goes direct.
        let clone_proxy = config.iron_proxy.as_ref().and_then(|_| {
            spec.env
                .iter()
                .find(|env| env.name == "HTTPS_PROXY")
                .map(|env| tools::CloneProxy {
                    https_proxy: env.value.clone(),
                    ca_cert_path: iron_proxy::FIREWALL_CA_CERT_PATH.to_owned(),
                    ca_volume_mount: iron_proxy::sandbox_ca_volume_mount_json(),
                })
        });
        init_containers.push(tools::tools_init_container_json(
            tools,
            clone_proxy.as_ref(),
        ));
    }

    let mut pod_spec = json!({
        "containers": [container],
        "restartPolicy": "Never",
        "automountServiceAccountToken": false,
        "enableServiceLinks": false,
    });
    if config.tools.is_some() {
        pod_spec["securityContext"] = tools::pod_security_context_json();
    }
    insert_optional(
        &mut pod_spec,
        "initContainers",
        (!init_containers.is_empty()).then_some(init_containers),
    );
    insert_optional(
        &mut pod_spec,
        "volumes",
        (!volumes.is_empty()).then(|| std::mem::take(&mut volumes)),
    );
    insert_optional(
        &mut pod_spec,
        "imagePullSecrets",
        (!config.image_pull_secrets.is_empty()).then(|| {
            config
                .image_pull_secrets
                .iter()
                .map(|name| json!({ "name": name }))
                .collect::<Vec<_>>()
        }),
    );

    let mut agent_spec = json!({
        "replicas": 1,
        "service": false,
        "shutdownPolicy": "Retain",
        "podTemplate": {
            "metadata": {
                "labels": pod_labels,
                "annotations": config.annotations,
            },
            "spec": pod_spec,
        },
    });
    insert_optional(
        &mut agent_spec,
        "volumeClaimTemplates",
        config.state_volume.as_ref().map(state_volume_claim_json),
    );

    let mut annotations = config.annotations.clone();
    if let Some(principal) = &spec.iron_control_principal {
        annotations.insert(
            IRON_CONTROL_PRINCIPAL_ANNOTATION.to_owned(),
            principal.clone(),
        );
    }

    let crd_spec = serde_json::from_value(agent_spec)
        .map_err(|err| SandboxError::InvalidSpec(format!("invalid Agent Sandbox spec: {err}")))?;
    let mut sandbox = crd::Sandbox::new(id.as_str(), crd_spec);
    sandbox.metadata.labels = Some(labels);
    sandbox.metadata.annotations = Some(annotations);
    Ok(sandbox)
}

fn mount_json(spec: &SandboxSpec) -> (Vec<Value>, Vec<Value>) {
    let mut volumes = Vec::with_capacity(spec.mounts.len());
    let mut mounts = Vec::with_capacity(spec.mounts.len());
    for (index, mount) in spec.mounts.iter().enumerate() {
        let name = format!("mount-{index}");
        mounts.push(json!({
            "name": name,
            "mountPath": mount.target_path,
            "readOnly": mount.read_only,
        }));
        volumes.push(match &mount.kind {
            MountKind::EmptyDir => json!({
                "name": name,
                "emptyDir": {},
            }),
            MountKind::NamedVolume(claim_name) => json!({
                "name": name,
                "persistentVolumeClaim": {
                    "claimName": claim_name,
                    "readOnly": mount.read_only,
                },
            }),
            MountKind::Bind { source_path } => json!({
                "name": name,
                "hostPath": {
                    "path": source_path,
                },
            }),
        });
    }
    (volumes, mounts)
}

fn resources_json(spec: &SandboxSpec) -> Option<Value> {
    let resources = spec.resources.as_ref()?;
    let mut limits = serde_json::Map::new();
    if let Some(cpu_millis) = resources.cpu_millis {
        limits.insert("cpu".to_owned(), json!(format!("{cpu_millis}m")));
    }
    if let Some(memory_bytes) = resources.memory_bytes {
        limits.insert("memory".to_owned(), json!(format!("{memory_bytes}")));
    }
    (!limits.is_empty()).then(|| json!({ "limits": limits }))
}

fn agent_run_as_user(container: &Value) -> Option<u32> {
    container
        .get("securityContext")
        .and_then(|security_context| security_context.get("runAsUser"))
        .and_then(Value::as_u64)
        .and_then(|uid| u32::try_from(uid).ok())
}

fn state_volume_claim_json(state_volume: &StateVolumeConfig) -> Vec<Value> {
    let mut pvc_spec = json!({
        "accessModes": ["ReadWriteOnce"],
        "resources": {
            "requests": {
                "storage": state_volume.size,
            },
        },
    });
    insert_optional(
        &mut pvc_spec,
        "storageClassName",
        state_volume.storage_class_name.clone(),
    );
    vec![json!({
        "metadata": {
            "name": "state",
        },
        "spec": pvc_spec,
    })]
}

fn state_pvc_name(id: &SandboxId) -> String {
    format!("state-{}", id.as_str())
}

fn insert_optional<T>(target: &mut Value, key: &str, value: Option<T>)
where
    T: serde::Serialize,
{
    if let Some(value) = value {
        target[key] = json!(value);
    }
}

/// Override-or-append an env entry, so the agent container never emits a
/// duplicate env name when we layer tools/overlay wiring over `spec.env`.
fn upsert_env(env: &mut Vec<(String, String)>, name: &str, value: String) {
    if let Some(entry) = env.iter_mut().find(|(existing, _)| existing == name) {
        entry.1 = value;
    } else {
        env.push((name.to_owned(), value));
    }
}

fn next_sandbox_name() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("asbx-{millis}-{sequence}")
}

fn is_not_found(err: &Error) -> bool {
    matches!(err, Error::Api(api_error) if api_error.code == 404)
}

fn map_kube_error(operation: &str, err: Error) -> SandboxError {
    if is_not_found(&err) {
        SandboxError::NotFound(operation.to_owned())
    } else {
        SandboxError::backend_source(operation, err)
    }
}

#[cfg(test)]
mod tests {
    use centaur_sandbox_core::{ResourceLimits, SandboxSpec};
    use k8s_openapi::api::core::v1::{PodCondition, PodStatus};

    use super::*;

    #[test]
    fn builds_agent_sandbox_spec_with_state_volume_and_limits() {
        let spec = SandboxSpec::new("centaur-agent:latest")
            .command(["/bin/sh", "-lc"])
            .args(["cat"])
            .env("CENTAUR_API_URL", "http://api:8000")
            .mount(centaur_sandbox_core::Mount::new(
                MountKind::EmptyDir,
                "/workspace",
            ))
            .resources(
                ResourceLimits::new()
                    .cpu_millis(500)
                    .memory_bytes(512 * 1024 * 1024),
            );
        let config = AgentSandboxConfig::new("centaur")
            .state_volume(StateVolumeConfig::new("/home/agent/state", "10Gi"));

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();

        assert_eq!(sandbox.metadata.name.as_deref(), Some("asbx-test"));
        assert_eq!(sandbox.spec.replicas, Some(1));
        assert_eq!(
            sandbox.spec.shutdown_policy,
            Some(crd::SandboxShutdownPolicy::Retain)
        );
        assert_eq!(
            sandbox.spec.volume_claim_templates.as_ref().unwrap().len(),
            1
        );
        let container = &sandbox.spec.pod_template.spec.containers[0];
        assert_eq!(
            sandbox.spec.pod_template.spec.enable_service_links,
            Some(false)
        );
        assert_eq!(container.image.as_deref(), Some("centaur-agent:latest"));
        assert_eq!(container.stdin, Some(true));
        assert_eq!(container.volume_mounts.as_ref().unwrap().len(), 3);
        assert!(
            container
                .volume_mounts
                .as_ref()
                .unwrap()
                .iter()
                .any(|mount| mount.name == RUNTIME_CONTEXT_VOLUME
                    && mount.mount_path == RUNTIME_CONTEXT_MOUNT_PATH)
        );
        assert!(
            sandbox
                .spec
                .pod_template
                .spec
                .volumes
                .as_ref()
                .unwrap()
                .iter()
                .any(|volume| volume.name == RUNTIME_CONTEXT_VOLUME)
        );
        assert!(container.resources.as_ref().unwrap().limits.is_some());
    }

    #[test]
    fn tools_clone_rides_iron_proxy_when_enabled() {
        // apply_proxy_env runs before build_agent_sandbox in create(), so the
        // resolved per-sandbox proxy URL arrives on the spec env.
        let spec = SandboxSpec::new("centaur-agent:latest")
            .env("HTTPS_PROXY", "http://asbx-test-iron-proxy:8080");
        let config = AgentSandboxConfig::new("centaur")
            .tools(ToolsConfig::new("paradigmxyz/centaur", "api:test"))
            .iron_proxy(IronProxyConfig::new("proxy:test", "ca-cert", "ca-key"));

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();
        let pod_spec = &sandbox.spec.pod_template.spec;
        let bootstrap = &pod_spec.init_containers.as_ref().unwrap()[0];
        assert_eq!(bootstrap.name, "tools-bootstrap");
        let script = &bootstrap.command.as_ref().unwrap()[2];
        assert!(script.contains("export HTTPS_PROXY=\"http://asbx-test-iron-proxy:8080\""));
        assert!(script.contains("export GIT_SSL_CAINFO=\"/firewall-certs/ca-cert.pem\""));
        assert!(
            bootstrap
                .volume_mounts
                .as_ref()
                .unwrap()
                .iter()
                .any(|mount| mount.name == "firewall-ca")
        );

        // Without iron-proxy the clone goes direct: no proxy exports, no CA mount.
        let spec = SandboxSpec::new("centaur-agent:latest");
        let config = AgentSandboxConfig::new("centaur")
            .tools(ToolsConfig::new("paradigmxyz/centaur", "api:test"));
        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();
        let bootstrap = &sandbox
            .spec
            .pod_template
            .spec
            .init_containers
            .as_ref()
            .unwrap()[0];
        let script = &bootstrap.command.as_ref().unwrap()[2];
        assert!(!script.contains("HTTPS_PROXY"));
        assert!(
            !bootstrap
                .volume_mounts
                .as_ref()
                .unwrap()
                .iter()
                .any(|mount| mount.name == "firewall-ca")
        );
    }

    #[test]
    fn overlay_enabled_renders_manifest_wait_and_workspace_mount() {
        let spec = SandboxSpec::new("centaur-agent:latest")
            .label("centaur.ai/harness", "codex")
            .env("CENTAUR_RESUME_THREAD_ID", "thread-1")
            .env("CODEX_HOME", "/home/agent/.codex")
            .env("AGENT_REPO", "gbasin/centaur");
        let mut overlay = OverlayConfig::new("centaur-node-sync:test");
        overlay.agent_uid = 4242;
        let config = AgentSandboxConfig::new("centaur").overlay(overlay);

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();
        let pod_spec = &sandbox.spec.pod_template.spec;
        let init_containers = pod_spec.init_containers.as_ref().unwrap();
        assert!(
            init_containers
                .iter()
                .all(|container| container.name != "overlay-setup")
        );
        assert!(init_containers.iter().all(|container| {
            container
                .security_context
                .as_ref()
                .and_then(|context| context.privileged)
                != Some(true)
        }));
        let manifest_writer = init_containers
            .iter()
            .find(|container| container.name == "overlay-manifest-writer")
            .expect("overlay-manifest-writer init container");
        let readiness_wait = init_containers
            .iter()
            .find(|container| container.name == "overlay-readiness-wait")
            .expect("overlay-readiness-wait init container");

        assert_eq!(
            manifest_writer.command.as_ref().unwrap(),
            &vec!["/usr/local/bin/provision-overlay".to_owned()]
        );
        assert_eq!(
            manifest_writer.image.as_deref(),
            Some("centaur-node-sync:test")
        );
        assert_eq!(
            manifest_writer
                .args
                .as_ref()
                .unwrap()
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec![
                "--manifest-only",
                "--session",
                "asbx-test",
                "--overlays-root",
                "/var/lib/centaur/overlays",
                "--merged-root",
                "/run/centaur/merged",
                "--agent-uid",
                "4242",
                "--harness",
                "codex",
                "--harness-thread-id",
                "thread-1",
                "--harness-home",
                "/home/agent/.codex",
                "--repo",
                "gbasin/centaur",
            ]
        );
        assert_eq!(
            manifest_writer
                .security_context
                .as_ref()
                .and_then(|context| context.privileged),
            Some(false)
        );
        let manifest_mounts = manifest_writer.volume_mounts.as_ref().unwrap();
        assert!(manifest_mounts.iter().any(|mount| {
            mount.name == "session-upper"
                && mount.mount_path == "/var/lib/centaur/overlays"
                && mount.mount_propagation.is_none()
        }));

        assert_eq!(
            readiness_wait.image.as_deref(),
            Some("centaur-node-sync:test")
        );
        assert_eq!(
            readiness_wait
                .security_context
                .as_ref()
                .and_then(|context| context.privileged),
            Some(false)
        );
        let readiness_command = readiness_wait.command.as_ref().unwrap().join(" ");
        assert!(
            readiness_command.contains("/run/centaur/merged/asbx-test/.centaur-workspace-ready")
        );
        let readiness_mounts = readiness_wait.volume_mounts.as_ref().unwrap();
        assert!(readiness_mounts.iter().any(|mount| {
            mount.name == "workspace"
                && mount.mount_path == "/run/centaur/merged/asbx-test"
                && mount.mount_propagation.as_deref() == Some("HostToContainer")
        }));

        let volumes = pod_spec.volumes.as_ref().unwrap();
        let session_upper = volumes
            .iter()
            .find(|volume| volume.name == "session-upper")
            .expect("session-upper volume");
        let session_upper_host_path = session_upper.host_path.as_ref().unwrap();
        assert_eq!(session_upper_host_path.path, "/var/lib/centaur/overlays");
        assert_eq!(
            session_upper_host_path.r#type.as_deref(),
            Some("DirectoryOrCreate")
        );
        let workspace = volumes
            .iter()
            .find(|volume| volume.name == "workspace")
            .expect("workspace volume");
        let workspace_host_path = workspace.host_path.as_ref().unwrap();
        assert_eq!(workspace_host_path.path, "/run/centaur/merged/asbx-test");
        assert_eq!(
            workspace_host_path.r#type.as_deref(),
            Some("DirectoryOrCreate")
        );

        let agent_mounts = pod_spec.containers[0].volume_mounts.as_ref().unwrap();
        assert_eq!(
            pod_spec.containers[0].working_dir.as_deref(),
            Some("/workspace")
        );
        assert!(agent_mounts.iter().any(|mount| {
            mount.name == "workspace"
                && mount.mount_path == "/workspace"
                && mount.mount_propagation.as_deref() == Some("HostToContainer")
        }));
    }

    #[test]
    fn overlay_enabled_renders_session_scoped_read_only_atrium_mount() {
        let spec = SandboxSpec::new("centaur-agent:latest");
        let config = AgentSandboxConfig::new("centaur")
            .overlay(OverlayConfig::new("centaur-node-sync:test"));

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();
        let pod_spec = &sandbox.spec.pod_template.spec;

        let volumes = pod_spec.volumes.as_ref().unwrap();
        let atrium = volumes
            .iter()
            .find(|volume| volume.name == "atrium-context")
            .expect("atrium-context volume");
        let atrium_host_path = atrium.host_path.as_ref().unwrap();
        assert_eq!(atrium_host_path.path, "/var/lib/centaur/atrium/asbx-test");
        assert_eq!(
            atrium_host_path.r#type.as_deref(),
            Some("DirectoryOrCreate")
        );

        let agent_mounts = pod_spec.containers[0].volume_mounts.as_ref().unwrap();
        let atrium_mount = agent_mounts
            .iter()
            .find(|mount| mount.name == "atrium-context")
            .expect("atrium-context mount");
        assert_eq!(atrium_mount.mount_path, "/atrium");
        assert_eq!(atrium_mount.read_only, Some(true));
        assert_eq!(atrium_mount.mount_propagation, None);
    }

    #[test]
    fn overlay_enabled_flat_home_renders_home_workspace_and_context_mounts() {
        let spec = SandboxSpec::new("centaur-agent:latest");
        let mut overlay = OverlayConfig::new("centaur-node-sync:test");
        overlay.flat_home = true;
        let config = AgentSandboxConfig::new("centaur").overlay(overlay);

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();
        let pod_spec = &sandbox.spec.pod_template.spec;
        assert_eq!(
            pod_spec.containers[0].working_dir.as_deref(),
            Some("/home/agent")
        );

        let agent_mounts = pod_spec.containers[0].volume_mounts.as_ref().unwrap();
        let workspace_mount = agent_mounts
            .iter()
            .find(|mount| mount.name == "workspace")
            .expect("workspace mount");
        assert_eq!(workspace_mount.mount_path, "/home/agent");
        assert_eq!(
            workspace_mount.mount_propagation.as_deref(),
            Some("HostToContainer")
        );

        let context_mount = agent_mounts
            .iter()
            .find(|mount| mount.name == "atrium-context")
            .expect("atrium-context mount");
        assert_eq!(context_mount.mount_path, "/home/agent/context");
        assert_eq!(context_mount.read_only, Some(true));
        assert_eq!(context_mount.mount_propagation, None);
    }

    #[test]
    fn overlay_env_flags_match_overlay_mode() {
        let spec = SandboxSpec::new("centaur-agent:latest");

        let mut flat_overlay = OverlayConfig::new("centaur-node-sync:test");
        flat_overlay.flat_home = true;
        let flat_home = build_agent_sandbox(
            &SandboxId::new("asbx-flat-home"),
            &spec,
            &AgentSandboxConfig::new("centaur").overlay(flat_overlay),
        )
        .unwrap();
        let flat_home_container = &flat_home.spec.pod_template.spec.containers[0];
        assert_eq!(
            container_env_value(flat_home_container, "CENTAUR_OVERLAY_ENABLED"),
            Some("1".to_owned())
        );
        assert_eq!(
            container_env_value(flat_home_container, "CENTAUR_FLAT_HOME"),
            Some("1".to_owned())
        );

        let overlay_workspace = build_agent_sandbox(
            &SandboxId::new("asbx-workspace"),
            &spec,
            &AgentSandboxConfig::new("centaur")
                .overlay(OverlayConfig::new("centaur-node-sync:test")),
        )
        .unwrap();
        let overlay_workspace_container = &overlay_workspace.spec.pod_template.spec.containers[0];
        assert_eq!(
            container_env_value(overlay_workspace_container, "CENTAUR_OVERLAY_ENABLED"),
            Some("1".to_owned())
        );
        assert_eq!(
            container_env_value(overlay_workspace_container, "CENTAUR_FLAT_HOME"),
            None
        );

        let no_overlay = build_agent_sandbox(
            &SandboxId::new("asbx-no-overlay"),
            &spec,
            &AgentSandboxConfig::new("centaur"),
        )
        .unwrap();
        let no_overlay_container = &no_overlay.spec.pod_template.spec.containers[0];
        assert_eq!(
            container_env_value(no_overlay_container, "CENTAUR_OVERLAY_ENABLED"),
            None
        );
        assert_eq!(
            container_env_value(no_overlay_container, "CENTAUR_FLAT_HOME"),
            None
        );
    }

    #[test]
    fn overlay_manifest_writer_threads_multi_repo_json() {
        let repos_json = r#"[{"repo":"acme/foo","ref":"main"},{"repo":"acme/bar","subdir":"bar"}]"#;
        let spec = SandboxSpec::new("centaur-agent:latest").env("AGENT_REPOS_JSON", repos_json);
        let config = AgentSandboxConfig::new("centaur")
            .overlay(OverlayConfig::new("centaur-node-sync:test"));

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();
        let manifest_writer = sandbox
            .spec
            .pod_template
            .spec
            .init_containers
            .as_ref()
            .unwrap()
            .iter()
            .find(|container| container.name == "overlay-manifest-writer")
            .expect("overlay-manifest-writer init container");
        let args = manifest_writer.args.as_ref().unwrap();

        assert!(
            args.windows(2)
                .any(|pair| pair[0] == "--repos-json" && pair[1] == repos_json)
        );
    }

    #[test]
    fn overlay_disabled_renders_no_overlay_wiring() {
        let spec = SandboxSpec::new("centaur-agent:latest");
        let config = AgentSandboxConfig::new("centaur");

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();
        let pod_spec = &sandbox.spec.pod_template.spec;
        assert!(
            pod_spec
                .init_containers
                .as_ref()
                .map(|containers| containers
                    .iter()
                    .all(|container| container.name != "overlay-setup"
                        && container.name != "overlay-manifest-writer"
                        && container.name != "overlay-readiness-wait"))
                .unwrap_or(true)
        );
        assert!(
            pod_spec
                .volumes
                .as_ref()
                .unwrap()
                .iter()
                .all(|volume| volume.name != "session-upper"
                    && volume.name != "workspace"
                    && volume.name != "atrium-context")
        );
        assert!(
            pod_spec.containers[0]
                .volume_mounts
                .as_ref()
                .unwrap()
                .iter()
                .all(|mount| mount.name != "workspace"
                    && mount.name != "atrium-context"
                    && mount.mount_propagation.is_none())
        );
    }

    #[test]
    fn overlay_agent_uid_prefers_agent_run_as_user_when_present() {
        assert_eq!(
            agent_run_as_user(&serde_json::json!({
                "securityContext": {
                    "runAsUser": 2002,
                },
            })),
            Some(2002)
        );
        assert_eq!(
            agent_run_as_user(&serde_json::json!({
                "securityContext": {
                    "runAsUser": u64::from(u32::MAX) + 1,
                },
            })),
            None
        );
        assert_eq!(agent_run_as_user(&serde_json::json!({})), None);
    }

    fn container_env_value(container: &impl serde::Serialize, name: &str) -> Option<String> {
        let container = serde_json::to_value(container).ok()?;
        container.get("env")?.as_array()?.iter().find_map(|env| {
            (env.get("name")?.as_str()? == name)
                .then(|| env.get("value")?.as_str().map(ToOwned::to_owned))
                .flatten()
        })
    }

    #[test]
    fn bootstrap_empty_dirs_are_writable_by_agent_uid() {
        let spec = SandboxSpec::new("centaur-agent:latest");
        let config = AgentSandboxConfig::new("centaur")
            .tools(ToolsConfig::new("paradigmxyz/centaur", "api:test"));

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();
        let pod_spec = &sandbox.spec.pod_template.spec;

        let security_context = pod_spec.security_context.as_ref().unwrap();
        assert_eq!(security_context.fs_group, Some(1001));
        assert_eq!(
            security_context.fs_group_change_policy.as_deref(),
            Some("OnRootMismatch")
        );
    }

    #[test]
    fn maps_agent_sandbox_replicas_and_pod_readiness_to_status() {
        let ready_pod = pod_with_phase_and_ready("Running", true);
        assert_eq!(
            sandbox_status_from_pod(0, Some(&ready_pod)),
            SandboxStatus::Suspended
        );
        assert_eq!(
            sandbox_status_from_pod(1, Some(&ready_pod)),
            SandboxStatus::Running
        );

        let unready_pod = pod_with_phase_and_ready("Running", false);
        assert_eq!(
            sandbox_status_from_pod(1, Some(&unready_pod)),
            SandboxStatus::Created
        );
        assert_eq!(sandbox_status_from_pod(1, None), SandboxStatus::Created);

        let failed_pod = pod_with_phase_and_ready("Failed", false);
        assert_eq!(
            sandbox_status_from_pod(1, Some(&failed_pod)),
            SandboxStatus::Stopped
        );
    }

    #[test]
    fn state_pvc_name_matches_agent_sandbox_template() {
        assert_eq!(
            state_pvc_name(&SandboxId::new("asbx-test")),
            "state-asbx-test"
        );
    }

    fn pod_with_phase_and_ready(phase: &str, ready: bool) -> Pod {
        Pod {
            status: Some(PodStatus {
                phase: Some(phase.to_owned()),
                conditions: Some(vec![PodCondition {
                    type_: "Ready".to_owned(),
                    status: if ready { "True" } else { "False" }.to_owned(),
                    ..PodCondition::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        }
    }
}
