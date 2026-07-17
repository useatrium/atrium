//! Agent Sandbox Kubernetes backend.
//!
//! The Agent Sandbox CRD types are generated from the upstream CRD with
//! `just codegen-agent-sandbox-crd`.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use centaur_iron_control::IronControlClient;
use centaur_sandbox_core::{
    FinalizeClaimedSession, MountKind, ObservedSandbox, PrepareClaimedOverlayHome, SandboxBackend,
    SandboxError, SandboxHandle, SandboxId, SandboxIo, SandboxResult, SandboxSpec, SandboxStatus,
};
use k8s_openapi::api::core::v1::{
    ContainerStatus, PersistentVolumeClaim, Pod, ResourceRequirements,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use kube::api::{
    AttachParams, DeleteParams, ListParams, LogParams, Patch, PatchParams, PostParams,
};
use kube::{Api, Client, Error};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
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
const OBSERVABILITY_ENABLED_LABEL: &str = "centaur.ai/observability-enabled";
const API_SERVER_ENABLED_LABEL: &str = "centaur.ai/api-server-enabled";
const MANAGED_BY_VALUE: &str = "api-rs";
const NODE_SYNC_COMPONENT_LABEL: &str = "app.kubernetes.io/component";
const NODE_SYNC_COMPONENT_VALUE: &str = "node-sync";
// Container name inside the node-sync DaemonSet pod (exec target for
// post-claim home preparation). Part of the node-sync seam contract.
const NODE_SYNC_CONTAINER_NAME: &str = "node-sync";
// iron-control principal OID the sandbox's proxy binds to, stamped at create
// so resume (which has only the sandbox id) can rebind without the spec or any
// in-memory state. Survives pause and api-rs restarts.
const IRON_CONTROL_PRINCIPAL_ANNOTATION: &str = "centaur.ai/iron-control-principal";
const RUNTIME_THREAD_KEY_ANNOTATION: &str = "centaur.ai/thread-key";
const RUNTIME_EXECUTION_ID_ANNOTATION: &str = "centaur.ai/execution-id";
const RUNTIME_CONTEXT_VOLUME: &str = "runtime-context";
const RUNTIME_CONTEXT_MOUNT_PATH: &str = "/etc/centaur/runtime-context";
const WARMCACHE_CAS_VOLUME: &str = "warmcache-cas";
const CLAIMED_HOME_HELPER_CONTAINER: &str = "overlay-claim-home";
// RFC 3339 instant stamped when the sandbox is paused for idleness and cleared
// on resume. This keeps suspended status observable across api-rs restarts.
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
    pub resources: Option<ResourceRequirements>,
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
    /// When set, repo-backed sandboxes with a dep-cache mount get a best-effort
    /// `warmcache-hydrate` init container before the agent starts.
    pub warmcache_hydrate: Option<WarmcacheHydrateConfig>,
    /// In-cluster OTLP collector (e.g. Laminar) used for observability-capable
    /// sandboxes. Sandbox pod egress is granted by chart-level label policy;
    /// the per-sandbox proxy uses this target for its own explicit egress.
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
            resources: sandbox_resources_from_env(),
            state_volume: None,
            iron_proxy: None,
            iron_control: None,
            tools: None,
            overlay: None,
            warmcache_hydrate: None,
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

    pub fn warmcache_hydrate(mut self, warmcache_hydrate: WarmcacheHydrateConfig) -> Self {
        self.warmcache_hydrate = Some(warmcache_hydrate);
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WarmcacheHydrateConfig {
    pub repo_cache_mount_path: String,
    pub depcache_mount_path: String,
    pub cas_host_path: String,
    pub cas_mount_path: String,
    pub atrium_base_url: Option<String>,
    pub atrium_capture_api_key: Option<String>,
    pub toolchain_id: Option<String>,
}

impl WarmcacheHydrateConfig {
    pub fn new(
        repo_cache_mount_path: impl Into<String>,
        depcache_mount_path: impl Into<String>,
        cas_host_path: impl Into<String>,
        cas_mount_path: impl Into<String>,
    ) -> Self {
        Self {
            repo_cache_mount_path: repo_cache_mount_path.into(),
            depcache_mount_path: depcache_mount_path.into(),
            cas_host_path: cas_host_path.into(),
            cas_mount_path: cas_mount_path.into(),
            atrium_base_url: None,
            atrium_capture_api_key: None,
            toolchain_id: None,
        }
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

    fn claim_overlay_config(&self, operation: &'static str) -> SandboxResult<&OverlayConfig> {
        let overlay = self
            .config
            .overlay
            .as_ref()
            .ok_or(SandboxError::Unsupported {
                backend: BACKEND_NAME,
                operation,
            })?;
        if !overlay.flat_home {
            return Err(SandboxError::Unsupported {
                backend: BACKEND_NAME,
                operation,
            });
        }
        Ok(overlay)
    }

    async fn run_claim_provision_helper(
        &self,
        id: &SandboxId,
        overlay: &OverlayConfig,
        script: &str,
        ctx: ClaimProvisionContext<'_>,
    ) -> SandboxResult<()> {
        let total_started = Instant::now();
        let pod = self
            .get_pod(id)
            .await?
            .ok_or_else(|| SandboxError::NotFound(id.as_str().to_owned()))?;
        let node_name = pod
            .spec
            .as_ref()
            .and_then(|spec| spec.node_name.as_deref())
            .filter(|node| !node.trim().is_empty())
            .ok_or_else(|| {
                SandboxError::NotReady(format!("sandbox {} is not assigned to a node", id.as_str()))
            })?;
        let helper_name = claimed_overlay_home_helper_name(id);
        let helper = build_claimed_overlay_home_helper_pod(
            &helper_name,
            id,
            node_name,
            overlay,
            &self.config,
            script,
            ctx,
        )?;
        match self
            .run_claimed_overlay_home_in_node_sync(id, node_name, script, ctx)
            .await
        {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(error) => return Err(error),
        }
        let pods = self.pods();
        let delete_started = Instant::now();
        match pods.delete(&helper_name, &DeleteParams::default()).await {
            Ok(_) => {}
            Err(err) if is_not_found(&err) => {}
            Err(err) => {
                return Err(map_kube_error(
                    "delete stale claimed overlay home helper pod",
                    err,
                ));
            }
        }
        self.wait_for_helper_pod_absent(&helper_name).await?;
        let stale_delete_duration = delete_started.elapsed();
        let create_started = Instant::now();
        pods.create(&PostParams::default(), &helper)
            .await
            .map_err(|err| map_kube_error("create claimed overlay home helper pod", err))?;
        let create_duration = create_started.elapsed();

        let wait_started = Instant::now();
        let wait_result = self.wait_for_helper_pod(&helper_name).await;
        let wait_duration = wait_started.elapsed();
        let delete_result = pods.delete(&helper_name, &DeleteParams::default()).await;
        if let Err(err) = delete_result
            && !is_not_found(&err)
        {
            tracing::warn!(
                helper_pod = %helper_name,
                error = %err,
                "failed to delete claimed overlay home helper pod"
            );
        }
        tracing::info!(
            sandbox_id = id.as_str(),
            helper_pod = %helper_name,
            stale_delete_duration_ms = stale_delete_duration.as_millis() as u64,
            create_duration_ms = create_duration.as_millis() as u64,
            wait_duration_ms = wait_duration.as_millis() as u64,
            total_duration_ms = total_started.elapsed().as_millis() as u64,
            "claimed overlay home helper pod completed"
        );
        wait_result
    }

    async fn run_claimed_overlay_home_in_node_sync(
        &self,
        id: &SandboxId,
        node_name: &str,
        script: &str,
        ctx: ClaimProvisionContext<'_>,
    ) -> SandboxResult<bool> {
        let Some(pod_name) = self.node_sync_pod_on_node(node_name).await? else {
            tracing::info!(
                sandbox_id = id.as_str(),
                node_name,
                operation = ctx.operation,
                "node-sync pod not found on sandbox node; falling back to claimed overlay helper pod"
            );
            return Ok(false);
        };
        let started = Instant::now();
        let params = AttachParams::default()
            .container(NODE_SYNC_CONTAINER_NAME)
            .stdin(false)
            .stdout(true)
            .stderr(true);
        let mut attached = match self
            .pods()
            .exec(&pod_name, ["/bin/sh", "-ceu", script], &params)
            .await
        {
            Ok(attached) => attached,
            Err(error) => {
                tracing::warn!(
                    sandbox_id = id.as_str(),
                    node_name,
                    node_sync_pod = %pod_name,
                    operation = ctx.operation,
                    error = %error,
                    "failed to exec claimed overlay provisioning in node-sync; falling back to helper pod"
                );
                return Ok(false);
            }
        };
        let status = attached.take_status();
        let mut stdout = attached.stdout();
        let mut stderr = attached.stderr();
        let stdout_task = async {
            let mut buf = String::new();
            if let Some(reader) = stdout.as_mut() {
                reader.read_to_string(&mut buf).await.map_err(|err| {
                    SandboxError::io(format!("read node-sync exec stdout: {err}"))
                })?;
            }
            Ok::<_, SandboxError>(buf)
        };
        let stderr_task = async {
            let mut buf = String::new();
            if let Some(reader) = stderr.as_mut() {
                reader.read_to_string(&mut buf).await.map_err(|err| {
                    SandboxError::io(format!("read node-sync exec stderr: {err}"))
                })?;
            }
            Ok::<_, SandboxError>(buf)
        };
        let status_task = async {
            match status {
                Some(status) => status.await,
                None => None,
            }
        };
        let (stdout, stderr, status, join_result) =
            tokio::join!(stdout_task, stderr_task, status_task, attached.join());
        join_result.map_err(|err| {
            SandboxError::backend(format!("exec claimed overlay home in node-sync: {err}"))
        })?;
        let stdout = stdout?;
        let stderr = stderr?;
        let status_ok = status
            .as_ref()
            .and_then(|status| status.status.as_deref())
            .is_none_or(|status| status.eq_ignore_ascii_case("success"));
        if !status_ok {
            return Err(SandboxError::backend(format!(
                "{} in node-sync pod {pod_name} failed: status={status:?} stdout={} stderr={}",
                ctx.operation,
                stdout.trim(),
                stderr.trim()
            )));
        }
        tracing::info!(
            sandbox_id = id.as_str(),
            node_name,
            node_sync_pod = %pod_name,
            operation = ctx.operation,
            duration_ms = started.elapsed().as_millis() as u64,
            stdout = %stdout.trim(),
            stderr = %stderr.trim(),
            "claimed overlay provisioning completed via node-sync exec"
        );
        Ok(true)
    }

    async fn node_sync_pod_on_node(&self, node_name: &str) -> SandboxResult<Option<String>> {
        let selector = format!("{NODE_SYNC_COMPONENT_LABEL}={NODE_SYNC_COMPONENT_VALUE}");
        let field_selector = format!("spec.nodeName={node_name}");
        let pods = self
            .pods()
            .list(
                &ListParams::default()
                    .labels(&selector)
                    .fields(&field_selector),
            )
            .await
            .map_err(|err| map_kube_error("list node-sync pods", err))?;
        Ok(pods.items.into_iter().find_map(|pod| {
            if pod.metadata.deletion_timestamp.is_some() {
                return None;
            }
            let running = pod
                .status
                .as_ref()
                .and_then(|status| status.phase.as_deref())
                .is_some_and(|phase| phase.eq_ignore_ascii_case("running"));
            if !running {
                return None;
            }
            pod.metadata.name
        }))
    }

    async fn wait_for_helper_pod_absent(&self, name: &str) -> SandboxResult<()> {
        let deadline = Instant::now() + self.config.ready_timeout;
        loop {
            match self.pods().get(name).await {
                Ok(_) if Instant::now() >= deadline => {
                    return Err(SandboxError::NotReady(format!(
                        "stale claimed overlay home helper pod {name} was not deleted before timeout"
                    )));
                }
                Ok(_) => sleep(Duration::from_millis(250)).await,
                Err(err) if is_not_found(&err) => return Ok(()),
                Err(err) => return Err(map_kube_error("get claimed overlay home helper pod", err)),
            }
        }
    }

    async fn wait_for_helper_pod(&self, name: &str) -> SandboxResult<()> {
        let pods = self.pods();
        let deadline = Instant::now() + self.config.ready_timeout;
        loop {
            let pod = match pods.get(name).await {
                Ok(pod) => pod,
                Err(err) if is_not_found(&err) => {
                    return Err(SandboxError::NotFound(name.to_owned()));
                }
                Err(err) => return Err(map_kube_error("get claimed overlay home helper pod", err)),
            };
            let phase = pod
                .status
                .as_ref()
                .and_then(|status| status.phase.as_deref())
                .unwrap_or("unknown");
            match phase {
                "Succeeded" => return Ok(()),
                "Failed" => {
                    let logs = pods
                        .logs(
                            name,
                            &LogParams {
                                container: Some(CLAIMED_HOME_HELPER_CONTAINER.to_owned()),
                                ..LogParams::default()
                            },
                        )
                        .await
                        .unwrap_or_default();
                    return Err(SandboxError::backend(format!(
                        "claimed overlay home helper pod {name} failed: {}",
                        logs.trim()
                    )));
                }
                _ if Instant::now() >= deadline => {
                    return Err(SandboxError::NotReady(format!(
                        "claimed overlay home helper pod {name} did not finish before timeout; latest phase: {phase}"
                    )));
                }
                _ => sleep(Duration::from_millis(500)).await,
            }
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
        let reason = sandbox_reason_from_pod(&status, pod.as_ref());
        Ok(ObservedSandbox::new(id.clone(), BACKEND_NAME, status)
            .with_reason(reason)
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

    fn supports_claimed_overlay_home(&self) -> bool {
        self.config
            .overlay
            .as_ref()
            .is_some_and(|overlay| overlay.flat_home)
    }

    async fn prepare_claimed_overlay_home(
        &self,
        id: &SandboxId,
        request: PrepareClaimedOverlayHome<'_>,
    ) -> SandboxResult<()> {
        let overlay = self.claim_overlay_config("prepare_claimed_overlay_home")?;
        let script = claimed_overlay_home_script(id, overlay, &self.config, request);
        self.run_claim_provision_helper(
            id,
            overlay,
            &script,
            ClaimProvisionContext {
                operation: "prepare_claimed_overlay_home",
                thread_key: request.thread_key,
                execution_id: request.execution_id,
            },
        )
        .await
    }

    async fn finalize_claimed_session(
        &self,
        id: &SandboxId,
        request: FinalizeClaimedSession<'_>,
    ) -> SandboxResult<()> {
        // Without overlay provisioning there is no manifest carrying session
        // identity, so there is nothing to finalize. Legacy non-flat-home
        // overlays have no warm claim slot either.
        let Ok(overlay) = self.claim_overlay_config("finalize_claimed_session") else {
            return Ok(());
        };
        let script = finalize_claimed_session_script(id, overlay, &self.config, request);
        self.run_claim_provision_helper(
            id,
            overlay,
            &script,
            ClaimProvisionContext {
                operation: "finalize_claimed_session",
                thread_key: request.thread_key,
                execution_id: request.execution_id,
            },
        )
        .await
    }

    async fn ensure_iron_control_proxy_resources(
        &self,
        id: &SandboxId,
        principal_id: &str,
    ) -> SandboxResult<()> {
        self.ensure_proxy_resources_for_principal(id, principal_id)
            .await
    }

    async fn pause(&self, id: &SandboxId) -> SandboxResult<()> {
        self.patch_sandbox_merge(id, sandbox_pause_patch(jiff::Timestamp::now()))
            .await
    }

    async fn resume(&self, id: &SandboxId) -> SandboxResult<()> {
        // Resume only has the sandbox id, not the spec, so rebind the proxy to
        // the principal recorded at create rather than re-resolving from spec.
        let resolved_iron_proxy = self.resolve_iron_proxy_for_resume(id).await?;
        if let Err(err) = self
            .create_iron_proxy_resources(id, resolved_iron_proxy.as_ref())
            .await
        {
            let _ = self.delete_iron_proxy_resources(id).await;
            return Err(err);
        }
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

fn sandbox_reason_from_pod(status: &SandboxStatus, pod: Option<&Pod>) -> Option<String> {
    if status.can_open_io() || matches!(status, SandboxStatus::Suspended) {
        return None;
    }
    let pod_status = pod?.status.as_ref()?;
    let mut parts = Vec::new();

    // The agent pod holds only the `agent` container; iron-proxy runs in a
    // separate `<id>-proxy-*` pod with its own lifecycle (capture its logs via
    // `just debug-sandbox`), so the only main-container state available here is
    // the agent's. Init-container failures (overlay/hydrate/tools setup) are in
    // this pod and are a common reason a sandbox dies before the agent runs.
    if let Some(reason) = pod_status
        .container_statuses
        .as_deref()
        .and_then(|statuses| {
            container_reason(statuses, DEFAULT_CONTAINER_NAME, DEFAULT_CONTAINER_NAME)
        })
    {
        parts.push(reason);
    }

    if let Some(init_statuses) = pod_status.init_container_statuses.as_deref() {
        for container in init_statuses {
            let display_name = format!("init {}", container.name);
            if let Some(reason) = container_reason(
                std::slice::from_ref(container),
                &container.name,
                &display_name,
            ) {
                parts.push(reason);
            }
        }
    }

    (!parts.is_empty()).then(|| parts.join("; "))
}

fn container_reason(
    statuses: &[ContainerStatus],
    container_name: &str,
    display_name: &str,
) -> Option<String> {
    let state = statuses
        .iter()
        .find(|status| status.name == container_name)?
        .state
        .as_ref()?;
    if let Some(terminated) = state.terminated.as_ref() {
        let reason = terminated
            .reason
            .as_deref()
            .map(clean_status_text)
            .filter(|reason| !reason.is_empty());
        let message = terminated
            .message
            .as_deref()
            .map(clean_status_text)
            .filter(|message| !message.is_empty());
        let mut detail = reason.unwrap_or_else(|| format!("exit {}", terminated.exit_code));
        if !detail.contains("exit ") {
            detail = format!("{detail} (exit {})", terminated.exit_code);
        }
        if let Some(message) = message {
            detail = format!("{detail}: {message}");
        }
        return Some(format!("{display_name} terminated: {detail}"));
    }
    if let Some(waiting) = state.waiting.as_ref() {
        let reason = waiting
            .reason
            .as_deref()
            .map(clean_status_text)
            .filter(|reason| !reason.is_empty());
        let message = waiting
            .message
            .as_deref()
            .map(clean_status_text)
            .filter(|message| !message.is_empty());
        return match (reason, message) {
            (Some(reason), Some(message)) => {
                Some(format!("{display_name} waiting: {reason}: {message}"))
            }
            (Some(reason), None) => Some(format!("{display_name} waiting: {reason}")),
            (None, Some(message)) => Some(format!("{display_name} waiting: {message}")),
            (None, None) => None,
        };
    }
    None
}

fn clean_status_text(value: &str) -> String {
    const MAX_LEN: usize = 300;
    let mut text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > MAX_LEN {
        text = text.chars().take(MAX_LEN).collect();
        text.push_str("...");
    }
    text
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
    if spec.capabilities.observability_enabled {
        labels.insert(OBSERVABILITY_ENABLED_LABEL.to_owned(), "true".to_owned());
    }
    if spec.capabilities.api_server_enabled {
        labels.insert(API_SERVER_ENABLED_LABEL.to_owned(), "true".to_owned());
    }

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
    let repo_cache_enabled = spec.capabilities.repo_cache.enabled();
    let scoped_tools = config
        .tools
        .as_ref()
        .filter(|_| repo_cache_enabled)
        .map(|tools| tools.scoped_for_repo_cache_access(&spec.capabilities.repo_cache));
    let repo_cache_tools = scoped_tools.as_ref().filter(|tools| tools.has_sources());
    let baked_base_tools = config.tools.is_some() && repo_cache_tools.is_none();

    if repo_cache_tools.is_some() {
        for (name, value) in tools::agent_env(repo_cache_tools) {
            upsert_env(&mut agent_env, &name, value);
        }
    } else if baked_base_tools {
        for (name, value) in tools::baked_base_agent_env() {
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
    insert_optional(
        &mut container,
        "resources",
        resources_json(spec, config.resources.as_ref()),
    );

    let (mut volumes, mut volume_mounts) = mount_json(spec);
    let mut init_containers = Vec::new();
    // hostPath dirs the kubelet creates (DirectoryOrCreate) are root:root, and
    // fsGroup is not applied to hostPath volumes — so a mount flagged
    // `ensure_writable` gets a root init container that chmods the mount point
    // for the non-root agent (UID 1001). mount_json names volumes `mount-{index}`
    // in spec order, so the same index reaches the same volume here.
    for (index, mount) in spec.mounts.iter().enumerate() {
        if mount.ensure_writable {
            init_containers.push(json!({
                "name": format!("ensure-writable-{index}"),
                "image": spec.image.clone(),
                "imagePullPolicy": "IfNotPresent",
                "command": ["sh", "-c", format!("chmod 0777 '{}'", mount.target_path)],
                "securityContext": {
                    "runAsUser": 0,
                    "privileged": false,
                    "allowPrivilegeEscalation": false,
                    "seccompProfile": { "type": "RuntimeDefault" },
                },
                "volumeMounts": [{
                    "name": format!("mount-{index}"),
                    "mountPath": mount.target_path.clone(),
                }],
            }));
        }
    }
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
    if repo_cache_tools.is_some() {
        volume_mounts.extend(tools::agent_volume_mounts_json(repo_cache_tools));
        volumes.extend(tools::volumes_json(repo_cache_tools));
    }
    if let Some(overlay) = &config.overlay {
        let agent_uid = agent_run_as_user(&container).unwrap_or(overlay.agent_uid);
        let metadata = overlay::OverlayMetadata::from_sandbox_spec(spec, agent_uid);
        let warm_flat_home = overlay.flat_home && metadata.warm_sandbox;
        let warm_flat_home_precomposed = warm_flat_home && metadata.repos_json.is_some();
        container["workingDir"] = if overlay.flat_home {
            json!(overlay::DEFAULT_HOME_MOUNT_PATH)
        } else {
            json!(overlay.workspace_mount_path.clone())
        };
        volume_mounts.push(overlay::overlay_agent_volume_mount_json(
            overlay,
            id.as_str(),
            &metadata,
        ));
        volume_mounts.push(overlay::atrium_agent_volume_mount_json(overlay));
        volumes.extend(overlay::overlay_volumes_json(overlay, id.as_str()));
        volumes.push(overlay::atrium_volume_json(id.as_str()));
        if warm_flat_home && !warm_flat_home_precomposed {
            init_containers.push(overlay::warm_flat_home_init_container_json(
                overlay,
                id.as_str(),
                &metadata,
            ));
        } else {
            if warm_flat_home_precomposed {
                tracing::info!(
                    sandbox_id = id.as_str(),
                    "pre-composing warm flat-home sandbox from default repo overlay"
                );
            }
            if let Some(private_repo_hydrate) = private_repo_hydrate_wiring(spec)? {
                init_containers.push(overlay::private_repo_hydrate_init_container_json(
                    overlay,
                    overlay::PrivateRepoHydrateInitContainer {
                        repos_json: &private_repo_hydrate.repos_json,
                        repo_cache_root: &private_repo_hydrate.repo_cache_mount_path,
                        repo_cache_volume: &private_repo_hydrate.repo_cache_volume,
                        https_proxy: &private_repo_hydrate.https_proxy,
                        git_ca_info: iron_proxy::FIREWALL_CA_CERT_PATH,
                        ca_volume_mount: iron_proxy::sandbox_ca_volume_mount_json(),
                    },
                ));
            }
            init_containers.push(overlay::overlay_manifest_init_container_json(
                overlay,
                id.as_str(),
                &metadata,
            ));
            init_containers.push(overlay::overlay_readiness_init_container_json(
                overlay,
                id.as_str(),
                &metadata,
            ));
        }
        if let Some(warmcache) = config
            .warmcache_hydrate
            .as_ref()
            .and_then(|warmcache| warmcache_hydrate_wiring(id, spec, warmcache))
        {
            volumes.push(warmcache_cas_volume_json(&warmcache.cas_host_path));
            init_containers.push(overlay::warmcache_hydrate_init_container_json(
                overlay,
                overlay::WarmcacheHydrateInitContainer {
                    session: &warmcache.atrium_session,
                    repos_json: &warmcache.repos_json,
                    repo_cache_root: &warmcache.repo_cache_mount_path,
                    depcache_root: &warmcache.depcache_mount_path,
                    cas_dir: &warmcache.cas_mount_path,
                    repo_cache_volume: &warmcache.repo_cache_volume,
                    depcache_volume: &warmcache.depcache_volume,
                    cas_volume: WARMCACHE_CAS_VOLUME,
                    atrium_url: config
                        .warmcache_hydrate
                        .as_ref()
                        .and_then(|config| config.atrium_base_url.as_deref()),
                    atrium_key: config
                        .warmcache_hydrate
                        .as_ref()
                        .and_then(|config| config.atrium_capture_api_key.as_deref()),
                    toolchain_id: config
                        .warmcache_hydrate
                        .as_ref()
                        .and_then(|config| config.toolchain_id.as_deref()),
                },
            ));
        }
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
    if let Some(tools) = repo_cache_tools {
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
    if repo_cache_tools.is_some() {
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

/// Identifying context shared by the claim-time provisioning operations that
/// run through the node-sync exec / helper-pod machinery.
#[derive(Clone, Copy)]
struct ClaimProvisionContext<'a> {
    operation: &'static str,
    thread_key: &'a str,
    execution_id: &'a str,
}

fn build_claimed_overlay_home_helper_pod(
    name: &str,
    id: &SandboxId,
    node_name: &str,
    overlay: &OverlayConfig,
    config: &AgentSandboxConfig,
    script: &str,
    ctx: ClaimProvisionContext<'_>,
) -> SandboxResult<Pod> {
    let merged_slot = overlay.merged_root.join(id.as_str());

    let mut pod_spec = json!({
        "restartPolicy": "Never",
        "automountServiceAccountToken": false,
        "enableServiceLinks": false,
        "nodeName": node_name,
        "containers": [{
            "name": CLAIMED_HOME_HELPER_CONTAINER,
            "image": overlay.image,
            "imagePullPolicy": "IfNotPresent",
            "command": ["/bin/sh", "-ceu"],
            "args": [script],
            "securityContext": {
                "privileged": true,
                "allowPrivilegeEscalation": true,
                "runAsUser": 0,
            },
            "volumeMounts": [
                {
                    "name": "session-upper",
                    "mountPath": path_string(&overlay.overlays_root),
                    "mountPropagation": "Bidirectional",
                },
                {
                    "name": "workspace",
                    "mountPath": path_string(&merged_slot),
                    "mountPropagation": "Bidirectional",
                }
            ],
        }],
        "volumes": [
            {
                "name": "session-upper",
                "hostPath": {
                    "path": path_string(&overlay.overlays_root),
                    "type": "DirectoryOrCreate",
                },
            },
            {
                "name": "workspace",
                "hostPath": {
                    "path": path_string(&merged_slot),
                    "type": "DirectoryOrCreate",
                },
            },
        ],
    });
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

    serde_json::from_value(json!({
        "metadata": {
            "name": name,
            "labels": {
                MANAGED_BY_LABEL: MANAGED_BY_VALUE,
                SANDBOX_ID_LABEL: id.as_str(),
                "app.kubernetes.io/name": "centaur-sandbox-claim-home",
            },
            "annotations": {
                RUNTIME_THREAD_KEY_ANNOTATION: ctx.thread_key,
                RUNTIME_EXECUTION_ID_ANNOTATION: ctx.execution_id,
            },
        },
        "spec": pod_spec,
    }))
    .map_err(|err| {
        SandboxError::InvalidSpec(format!("invalid claimed overlay home helper pod: {err}"))
    })
}

/// Session-identity and harness fields the claim-time manifest rewrite stamps
/// into the overlay manifest. This is the single arg-builder both claim
/// provisioning scripts go through, so the manifest can never gain a second,
/// diverging identity-write path.
struct ClaimManifestIdentity<'a> {
    thread_key: &'a str,
    harness: Option<&'a str>,
    harness_thread_id: Option<&'a str>,
    harness_home: Option<&'a str>,
}

fn claim_manifest_provision_args(
    id: &SandboxId,
    overlay: &OverlayConfig,
    merged_home: &Path,
    identity: ClaimManifestIdentity<'_>,
    repos_json: Option<&str>,
    generic_home_lower: Option<&Path>,
) -> Vec<String> {
    let context_source = overlay::atrium_context_host_path(id.as_str());
    let mut provision_args = vec![
        "--manifest-only".to_owned(),
        "--session".to_owned(),
        id.as_str().to_owned(),
        "--atrium-session".to_owned(),
        identity.thread_key.to_owned(),
        "--overlays-root".to_owned(),
        path_string(&overlay.overlays_root),
        "--merged-root".to_owned(),
        path_string(&overlay.merged_root),
        "--merged-path".to_owned(),
        path_string(merged_home),
        "--agent-uid".to_owned(),
        overlay.agent_uid.to_string(),
        "--flat-home".to_owned(),
        "--context-source".to_owned(),
        context_source,
    ];
    if let Some(repos_json) = repos_json {
        provision_args.push("--repos-json".to_owned());
        provision_args.push(repos_json.to_owned());
    }
    if let Some(generic_home_lower) = generic_home_lower {
        provision_args.push("--generic-home-lower".to_owned());
        provision_args.push(path_string(generic_home_lower));
    }
    push_optional_arg(&mut provision_args, "--harness", identity.harness);
    push_optional_arg(
        &mut provision_args,
        "--harness-thread-id",
        identity.harness_thread_id,
    );
    push_optional_arg(&mut provision_args, "--harness-home", identity.harness_home);
    provision_args
}

fn claimed_overlay_home_script(
    id: &SandboxId,
    overlay: &OverlayConfig,
    config: &AgentSandboxConfig,
    request: PrepareClaimedOverlayHome<'_>,
) -> String {
    let merged_slot = overlay.merged_root.join(id.as_str());
    let merged_home = merged_slot.join("agent");
    let ready_marker = merged_home.join(overlay::READY_MARKER_FILE);
    let manifest_path = overlay
        .overlays_root
        .join(overlay::SESSIONS_DIR)
        .join(format!("{}.json", id.as_str()));
    let generic_home_lower = (!request.precomposed).then(|| {
        overlay
            .overlays_root
            .join(overlay::WARM_HOME_LOWER_DIR)
            .join(id.as_str())
    });
    let provision_args = claim_manifest_provision_args(
        id,
        overlay,
        &merged_home,
        ClaimManifestIdentity {
            thread_key: request.thread_key,
            harness: request.harness,
            harness_thread_id: request.harness_thread_id,
            harness_home: request.harness_home,
        },
        Some(request.repos_json),
        generic_home_lower.as_deref(),
    );

    let mut parts = Vec::new();
    if let Some(generic_home_lower) = &generic_home_lower {
        parts.push(snapshot_generic_home_script(
            &merged_home,
            generic_home_lower,
        ));
    }
    parts.push(shell_join_provision_overlay(&provision_args));
    parts.push(readiness_wait_script(
        &path_string(&ready_marker),
        config.ready_timeout,
        Some(&path_string(&manifest_path)),
    ));
    parts.join("\n")
}

/// Manifest-only rewrite for a repo-less warm claim: stamp the claimed
/// session's identity into the warm pod's overlay manifest without touching
/// its already-mounted flat home. The node-sync daemon picks up the new
/// `atrium_session` and materializes `~/context` for it; without this rewrite
/// a repo-less claim would keep the identity-less warm manifest and the
/// sandbox would never receive context documents.
fn finalize_claimed_session_script(
    id: &SandboxId,
    overlay: &OverlayConfig,
    config: &AgentSandboxConfig,
    request: FinalizeClaimedSession<'_>,
) -> String {
    let merged_home = overlay.merged_root.join(id.as_str()).join("agent");
    let ready_marker = merged_home.join(overlay::READY_MARKER_FILE);
    let manifest_path = overlay
        .overlays_root
        .join(overlay::SESSIONS_DIR)
        .join(format!("{}.json", id.as_str()));
    let provision_args = claim_manifest_provision_args(
        id,
        overlay,
        &merged_home,
        ClaimManifestIdentity {
            thread_key: request.thread_key,
            harness: request.harness,
            harness_thread_id: request.harness_thread_id,
            harness_home: request.harness_home,
        },
        None,
        None,
    );
    [
        shell_join_provision_overlay(&provision_args),
        readiness_wait_script(
            &path_string(&ready_marker),
            config.ready_timeout,
            Some(&path_string(&manifest_path)),
        ),
    ]
    .join("\n")
}

fn snapshot_generic_home_script(source_home: &Path, generic_home_lower: &Path) -> String {
    format!(
        "src={src:?}\n\
         dst={dst:?}\n\
         rm -rf \"$dst\"\n\
         mkdir -p \"$dst\"\n\
         if [ -d \"$src\" ]; then\n\
         \tfor entry in \"$src\"/.[!.]* \"$src\"/..?* \"$src\"/*; do\n\
         \t\t[ -e \"$entry\" ] || continue\n\
         \t\tname=${{entry##*/}}\n\
         \t\tcase \"$name\" in context|{ready_marker}) continue ;; esac\n\
         \t\tcp -a \"$entry\" \"$dst/\"\n\
         \tdone\n\
         fi",
        src = path_string(source_home),
        dst = path_string(generic_home_lower),
        ready_marker = overlay::READY_MARKER_FILE,
    )
}

fn claimed_overlay_home_helper_name(id: &SandboxId) -> String {
    let mut name = format!("{}-claim-home", id.as_str());
    name.truncate(63);
    name.trim_end_matches('-').to_owned()
}

fn readiness_wait_script(
    marker: &str,
    timeout: Duration,
    cleanup_manifest: Option<&str>,
) -> String {
    let cleanup = cleanup_manifest
        .map(|path| format!("rm -f {path:?}\n"))
        .unwrap_or_default();
    format!(
        "marker={marker:?}\n\
         deadline=$(( $(date +%s) + {} ))\n\
         while [ ! -f \"$marker\" ]; do\n\
         \tif [ \"$(date +%s)\" -ge \"$deadline\" ]; then\n\
         \t\techo \"timed out waiting for $marker\" >&2\n\
         \t\t{cleanup}\
         \t\texit 1\n\
         \tfi\n\
         \tsleep 0.2\n\
         done",
        timeout.as_secs().max(1)
    )
}

fn shell_join_provision_overlay(args: &[String]) -> String {
    let mut command = overlay::PROVISION_OVERLAY_BIN.to_owned();
    for arg in args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    command
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn path_string(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

fn push_optional_arg(args: &mut Vec<String>, flag: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        args.push(flag.to_owned());
        args.push(value.to_owned());
    }
}

fn mount_json(spec: &SandboxSpec) -> (Vec<Value>, Vec<Value>) {
    let mut volumes = Vec::with_capacity(spec.mounts.len());
    let mut mounts = Vec::with_capacity(spec.mounts.len());
    for (index, mount) in spec.mounts.iter().enumerate() {
        let name = format!("mount-{index}");
        let mut volume_mount = json!({
            "name": name,
            "mountPath": mount.target_path,
            "readOnly": mount.read_only,
        });
        if let Some(sub_path) = &mount.sub_path {
            volume_mount["subPath"] = Value::String(sub_path.clone());
        }
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
            MountKind::PersistentVolumeClaim {
                claim_name,
                sub_path,
            } => {
                if let Some(sub_path) = sub_path {
                    volume_mount["subPath"] = Value::String(sub_path.clone());
                }
                json!({
                    "name": name,
                    "persistentVolumeClaim": {
                        "claimName": claim_name,
                        "readOnly": mount.read_only,
                    },
                })
            }
            MountKind::Bind { source_path } => json!({
                "name": name,
                "hostPath": {
                    "path": source_path,
                    // Create the node dir if missing (the dep-cache starts empty
                    // and is populated by the agent; repo-cache already exists).
                    "type": "DirectoryOrCreate",
                },
            }),
        });
        mounts.push(volume_mount);
    }
    (volumes, mounts)
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct WarmcacheHydrateWiring {
    atrium_session: String,
    repos_json: String,
    repo_cache_mount_path: String,
    depcache_mount_path: String,
    cas_host_path: String,
    cas_mount_path: String,
    repo_cache_volume: String,
    depcache_volume: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PrivateRepoHydrateWiring {
    repos_json: String,
    repo_cache_mount_path: String,
    repo_cache_volume: String,
    https_proxy: String,
}

fn private_repo_hydrate_wiring(
    spec: &SandboxSpec,
) -> SandboxResult<Option<PrivateRepoHydrateWiring>> {
    let Some(repos_json) = spec_env_value(spec, "AGENT_REPOS_JSON") else {
        return Ok(None);
    };
    if !repos_json_has_private_repo(repos_json)? {
        return Ok(None);
    }
    let repo_cache_volume = mount_volume_name_for_target(spec, "/cache").ok_or_else(|| {
        SandboxError::InvalidSpec(
            "private repo checkout requires the repo cache mounted at /cache".to_owned(),
        )
    })?;
    let https_proxy = spec_env_value(spec, "HTTPS_PROXY")
        .or_else(|| spec_env_value(spec, "https_proxy"))
        .ok_or_else(|| {
            SandboxError::InvalidSpec(
                "private repo checkout requires iron-proxy HTTPS_PROXY env".to_owned(),
            )
        })?
        .to_owned();
    Ok(Some(PrivateRepoHydrateWiring {
        repos_json: repos_json.to_owned(),
        repo_cache_mount_path: "/cache".to_owned(),
        repo_cache_volume,
        https_proxy,
    }))
}

fn repos_json_has_private_repo(repos_json: &str) -> SandboxResult<bool> {
    let value = serde_json::from_str::<Value>(repos_json)
        .map_err(|err| SandboxError::InvalidSpec(format!("invalid AGENT_REPOS_JSON: {err}")))?;
    let Some(repos) = value.as_array() else {
        return Err(SandboxError::InvalidSpec(
            "AGENT_REPOS_JSON must be an array".to_owned(),
        ));
    };
    Ok(repos.iter().any(|repo| {
        repo.get("private")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || repo
                .get("visibility")
                .and_then(Value::as_str)
                .is_some_and(|visibility| visibility.eq_ignore_ascii_case("private"))
    }))
}

fn warmcache_hydrate_wiring(
    id: &SandboxId,
    spec: &SandboxSpec,
    config: &WarmcacheHydrateConfig,
) -> Option<WarmcacheHydrateWiring> {
    let repos_json = spec_env_value(spec, "AGENT_REPOS_JSON")?;
    if repos_json.trim().is_empty() {
        return None;
    }
    let repo_cache_volume = mount_volume_name_for_target(spec, &config.repo_cache_mount_path)?;
    let depcache_volume = mount_volume_name_for_target(spec, &config.depcache_mount_path)?;
    let atrium_session = spec_env_value(spec, "CENTAUR_THREAD_KEY")
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        // TODO: Warm-cache hydration routes resolve on the Atrium session ref.
        // Normal session sandboxes carry it in CENTAUR_THREAD_KEY; only manual
        // specs without that env fall back to the Centaur sandbox id.
        .unwrap_or_else(|| id.as_str().to_owned());

    Some(WarmcacheHydrateWiring {
        atrium_session,
        repos_json: repos_json.to_owned(),
        repo_cache_mount_path: config.repo_cache_mount_path.clone(),
        depcache_mount_path: config.depcache_mount_path.clone(),
        cas_host_path: config.cas_host_path.clone(),
        cas_mount_path: config.cas_mount_path.clone(),
        repo_cache_volume,
        depcache_volume,
    })
}

fn mount_volume_name_for_target(spec: &SandboxSpec, target_path: &str) -> Option<String> {
    spec.mounts
        .iter()
        .position(|mount| mount.target_path == target_path)
        .map(|index| format!("mount-{index}"))
}

fn spec_env_value<'a>(spec: &'a SandboxSpec, name: &str) -> Option<&'a str> {
    spec.env
        .iter()
        .find(|env| env.name == name)
        .map(|env| env.value.as_str())
}

fn warmcache_cas_volume_json(cas_host_path: &str) -> Value {
    json!({
        "name": WARMCACHE_CAS_VOLUME,
        "hostPath": {
            "path": cas_host_path,
            "type": "DirectoryOrCreate",
        },
    })
}

fn sandbox_resources_from_env() -> Option<ResourceRequirements> {
    sandbox_resources_from_values(|name| std::env::var(name).ok())
}

fn sandbox_resources_from_values(
    value_for: impl Fn(&str) -> Option<String>,
) -> Option<ResourceRequirements> {
    let mut requests = BTreeMap::new();
    let mut limits = BTreeMap::new();
    let clean_value = |name| {
        value_for(name)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    if let Some(value) = clean_value("SESSION_SANDBOX_CPU_REQUEST") {
        requests.insert("cpu".to_owned(), Quantity(value));
    }
    if let Some(value) = clean_value("SESSION_SANDBOX_MEMORY_REQUEST") {
        requests.insert("memory".to_owned(), Quantity(value));
    }
    if let Some(value) = clean_value("SESSION_SANDBOX_CPU_LIMIT") {
        limits.insert("cpu".to_owned(), Quantity(value));
    }
    if let Some(value) = clean_value("SESSION_SANDBOX_MEMORY_LIMIT") {
        limits.insert("memory".to_owned(), Quantity(value));
    }
    if requests.is_empty() && limits.is_empty() {
        return None;
    }
    Some(ResourceRequirements {
        requests: (!requests.is_empty()).then_some(requests),
        limits: (!limits.is_empty()).then_some(limits),
        ..ResourceRequirements::default()
    })
}

fn resources_json(spec: &SandboxSpec, configured: Option<&ResourceRequirements>) -> Option<Value> {
    let mut requirements = ResourceRequirements::default();
    let resources = spec.resources.as_ref();
    if let Some(cpu_millis) = resources.and_then(|resources| resources.cpu_millis) {
        requirements
            .limits
            .get_or_insert_default()
            .insert("cpu".to_owned(), Quantity(format!("{cpu_millis}m")));
    }
    if let Some(memory_bytes) = resources.and_then(|resources| resources.memory_bytes) {
        requirements
            .limits
            .get_or_insert_default()
            .insert("memory".to_owned(), Quantity(format!("{memory_bytes}")));
    }
    if let Some(configured) = configured {
        if let Some(requests) = &configured.requests {
            requirements
                .requests
                .get_or_insert_default()
                .extend(requests.clone());
        }
        if let Some(limits) = &configured.limits {
            requirements
                .limits
                .get_or_insert_default()
                .extend(limits.clone());
        }
    }
    (requirements.requests.is_some() || requirements.limits.is_some()).then(|| json!(requirements))
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
    use centaur_sandbox_core::{
        Mount, MountKind, RepoCacheAccess, ResourceLimits, SandboxCapabilities, SandboxSpec,
    };
    use k8s_openapi::api::core::v1::{
        ContainerState, ContainerStateTerminated, ContainerStateWaiting, PodCondition, PodStatus,
    };

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
    fn builds_agent_sandbox_with_configured_resources_and_omits_unset_resources() {
        let spec = SandboxSpec::new("centaur-agent:latest");
        let mut config = AgentSandboxConfig::new("centaur");
        config.resources = sandbox_resources_from_values(|name| {
            match name {
                "SESSION_SANDBOX_CPU_REQUEST" => Some("250m"),
                "SESSION_SANDBOX_MEMORY_REQUEST" => Some("1Gi"),
                "SESSION_SANDBOX_CPU_LIMIT" => Some("4"),
                "SESSION_SANDBOX_MEMORY_LIMIT" => Some("6Gi"),
                _ => None,
            }
            .map(str::to_owned)
        });

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-resources"), &spec, &config)
            .expect("sandbox with configured resources");
        let resources = sandbox.spec.pod_template.spec.containers[0]
            .resources
            .as_ref()
            .expect("agent resources");
        assert_eq!(
            serde_json::to_value(resources).unwrap(),
            json!({
                "requests": { "cpu": "250m", "memory": "1Gi" },
                "limits": { "cpu": "4", "memory": "6Gi" },
            })
        );

        config.resources = sandbox_resources_from_values(|_| Some("  ".to_owned()));
        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-no-resources"), &spec, &config)
            .expect("sandbox without configured resources");
        assert!(
            sandbox.spec.pod_template.spec.containers[0]
                .resources
                .is_none()
        );
    }

    #[test]
    fn ensure_writable_mount_gets_a_root_chmod_init_container() {
        let spec = SandboxSpec::new("centaur-agent:test").mount(
            Mount::new(
                MountKind::Bind {
                    source_path: "/var/lib/centaur/depcache".to_owned(),
                },
                "/var/cache/centaur/depcache",
            )
            .ensure_writable(),
        );
        let config = AgentSandboxConfig::new("centaur");

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();
        let init_containers = sandbox
            .spec
            .pod_template
            .spec
            .init_containers
            .as_ref()
            .unwrap();
        let chmod = init_containers
            .iter()
            .find(|c| c.name.starts_with("ensure-writable-"))
            .expect("ensure-writable init container");
        // Runs from the agent image and chmods the mount point so the non-root
        // agent can populate the kubelet-created root:root hostPath.
        assert_eq!(chmod.image.as_deref(), Some("centaur-agent:test"));
        let cmd = chmod.command.as_ref().unwrap();
        assert!(
            cmd.iter()
                .any(|s| s.contains("chmod 0777") && s.contains("/var/cache/centaur/depcache")),
            "expected chmod of the dep-cache mount, got {cmd:?}"
        );

        // A plain (non-ensure_writable) mount must NOT get a chmod init container.
        let plain = SandboxSpec::new("centaur-agent:test").mount(Mount::new(
            MountKind::Bind {
                source_path: "/var/lib/centaur/repos".to_owned(),
            },
            "/cache",
        ));
        let plain_sandbox =
            build_agent_sandbox(&SandboxId::new("asbx-test"), &plain, &config).unwrap();
        let has_chmod = plain_sandbox
            .spec
            .pod_template
            .spec
            .init_containers
            .as_ref()
            .is_some_and(|cs| cs.iter().any(|c| c.name.starts_with("ensure-writable-")));
        assert!(
            !has_chmod,
            "non-ensure_writable mount should not get a chmod init container"
        );
    }

    #[test]
    fn labels_observability_enabled_sandboxes_for_chart_policy() {
        let spec = SandboxSpec::new("centaur-agent:latest").capabilities(SandboxCapabilities {
            repo_cache: RepoCacheAccess::All,
            observability_enabled: true,
            api_server_enabled: true,
        });
        let config = AgentSandboxConfig::new("centaur");

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();

        assert_eq!(
            sandbox
                .metadata
                .labels
                .as_ref()
                .and_then(|labels| labels.get(OBSERVABILITY_ENABLED_LABEL))
                .map(String::as_str),
            Some("true")
        );
        assert_eq!(
            sandbox
                .spec
                .pod_template
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.labels.as_ref())
                .and_then(|labels| labels.get(OBSERVABILITY_ENABLED_LABEL))
                .map(String::as_str),
            Some("true")
        );
        assert_eq!(
            sandbox
                .metadata
                .labels
                .as_ref()
                .and_then(|labels| labels.get(API_SERVER_ENABLED_LABEL))
                .map(String::as_str),
            Some("true")
        );
        assert_eq!(
            sandbox
                .spec
                .pod_template
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.labels.as_ref())
                .and_then(|labels| labels.get(API_SERVER_ENABLED_LABEL))
                .map(String::as_str),
            Some("true")
        );
    }

    #[test]
    fn omits_api_server_label_for_restricted_sandboxes() {
        let spec = SandboxSpec::new("centaur-agent:latest").capabilities(SandboxCapabilities {
            repo_cache: RepoCacheAccess::All,
            observability_enabled: false,
            api_server_enabled: false,
        });
        let config = AgentSandboxConfig::new("centaur");

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();

        assert!(
            sandbox
                .metadata
                .labels
                .as_ref()
                .is_none_or(|labels| !labels.contains_key(OBSERVABILITY_ENABLED_LABEL))
        );
        assert!(
            sandbox
                .spec
                .pod_template
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.labels.as_ref())
                .is_none_or(|labels| !labels.contains_key(OBSERVABILITY_ENABLED_LABEL))
        );
        assert!(
            sandbox
                .metadata
                .labels
                .as_ref()
                .is_none_or(|labels| !labels.contains_key(API_SERVER_ENABLED_LABEL))
        );
        assert!(
            sandbox
                .spec
                .pod_template
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.labels.as_ref())
                .is_none_or(|labels| !labels.contains_key(API_SERVER_ENABLED_LABEL))
        );
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
    fn disabled_repo_cache_uses_baked_base_tools_without_bootstrap() {
        let spec = SandboxSpec::new("centaur-agent:latest").capabilities(SandboxCapabilities {
            repo_cache: RepoCacheAccess::None,
            observability_enabled: true,
            api_server_enabled: true,
        });
        let mut tools = ToolsConfig::new("paradigmxyz/centaur", "api:test");
        tools.repo_cache_path = Some("/var/lib/centaur/repos".to_owned());
        let config = AgentSandboxConfig::new("centaur").tools(tools);

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();
        let pod_spec = &sandbox.spec.pod_template.spec;
        let tool_dirs = pod_spec.containers[0]
            .env
            .as_ref()
            .and_then(|env| env.iter().find(|env| env.name == "TOOL_DIRS"))
            .and_then(|env| env.value.as_deref());
        assert_eq!(tool_dirs, Some("/opt/centaur/tools"));
        assert!(
            pod_spec
                .init_containers
                .as_ref()
                .is_none_or(|containers| containers.iter().all(|container| {
                    container.name != "tools-bootstrap" && container.name != "tools-sync"
                }))
        );
        assert!(
            pod_spec.containers[0]
                .volume_mounts
                .as_ref()
                .is_none_or(|mounts| {
                    !mounts.iter().any(|mount| {
                        mount.name == "tools-root"
                            || mount.name == "tools-repo-cache"
                            || mount.mount_path == "/app/tools"
                            || mount.mount_path == "/var/lib/centaur/repos"
                    })
                })
        );
        assert!(pod_spec.volumes.as_ref().is_none_or(|volumes| {
            !volumes
                .iter()
                .any(|volume| volume.name == "tools-root" || volume.name == "tools-repo-cache")
        }));
    }

    #[test]
    fn overlay_enabled_renders_manifest_wait_and_workspace_mount() {
        let spec = SandboxSpec::new("centaur-agent:latest")
            .label("centaur.ai/harness", "codex")
            .env("CENTAUR_THREAD_KEY", "surface:session-1")
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
                "--atrium-session",
                "surface:session-1",
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
    fn warm_flat_home_mounts_shared_home_parent_and_targets_agent_subpath() {
        let spec = SandboxSpec::new("centaur-agent:latest").env("CENTAUR_WARM_SANDBOX", "1");
        let mut overlay = OverlayConfig::new("centaur-node-sync:test");
        overlay.flat_home = true;
        let config = AgentSandboxConfig::new("centaur").overlay(overlay);

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-warm"), &spec, &config).unwrap();
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
        assert_eq!(workspace_mount.mount_path, "/home");
        assert_eq!(
            workspace_mount.mount_propagation.as_deref(),
            Some("HostToContainer")
        );

        let workspace_volume = pod_spec
            .volumes
            .as_ref()
            .unwrap()
            .iter()
            .find(|volume| volume.name == "workspace")
            .expect("workspace volume");
        assert_eq!(
            workspace_volume
                .host_path
                .as_ref()
                .expect("workspace hostPath")
                .path,
            "/run/centaur/merged/asbx-warm"
        );

        let init_containers = pod_spec.init_containers.as_ref().unwrap();
        assert!(
            init_containers
                .iter()
                .all(|container| container.name != "overlay-manifest-writer")
        );
        assert!(
            init_containers
                .iter()
                .all(|container| container.name != "overlay-readiness-wait")
        );
        let placeholder = init_containers
            .iter()
            .find(|container| container.name == "warm-home-placeholder")
            .expect("warm home placeholder");
        let placeholder_command = placeholder.command.as_ref().unwrap().join(" ");
        assert!(placeholder_command.contains("/run/centaur/merged/asbx-warm/agent"));
        assert!(placeholder_command.contains("chown 1001:1001"));
        assert_eq!(
            placeholder
                .security_context
                .as_ref()
                .and_then(|ctx| ctx.capabilities.as_ref())
                .and_then(|caps| caps.add.as_ref())
                .cloned(),
            Some(vec!["CHOWN".to_owned(), "FOWNER".to_owned()])
        );
        assert!(
            placeholder
                .volume_mounts
                .as_ref()
                .unwrap()
                .iter()
                .any(|mount| mount.name == "workspace"
                    && mount.mount_path == "/run/centaur/merged/asbx-warm")
        );
    }

    #[test]
    fn warm_flat_home_with_default_repos_precomposes_overlay_before_agent_start() {
        let spec = SandboxSpec::new("centaur-agent:latest")
            .env("CENTAUR_WARM_SANDBOX", "1")
            .env(
                "AGENT_REPOS_JSON",
                r#"[{"repo":"acme/default","ref":"main"}]"#,
            );
        let mut overlay = OverlayConfig::new("centaur-node-sync:test");
        overlay.flat_home = true;
        let config = AgentSandboxConfig::new("centaur").overlay(overlay);

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-warm"), &spec, &config).unwrap();
        let pod_spec = &sandbox.spec.pod_template.spec;
        let init_containers = pod_spec.init_containers.as_ref().unwrap();
        assert!(
            init_containers
                .iter()
                .all(|container| container.name != "warm-home-placeholder")
        );
        let manifest = init_containers
            .iter()
            .find(|container| container.name == "overlay-manifest-writer")
            .expect("overlay manifest writer");
        let args = manifest.args.as_ref().unwrap();
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--merged-path", "/run/centaur/merged/asbx-warm/agent"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--repos-json", r#"[{"repo":"acme/default","ref":"main"}]"#])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--context-source", "/var/lib/centaur/atrium/asbx-warm"])
        );

        let readiness = init_containers
            .iter()
            .find(|container| container.name == "overlay-readiness-wait")
            .expect("overlay readiness wait");
        let readiness_command = readiness.command.as_ref().unwrap().join(" ");
        assert!(
            readiness_command
                .contains("/run/centaur/merged/asbx-warm/agent/.centaur-workspace-ready")
        );
    }

    #[test]
    fn precomposed_claimed_overlay_script_finalizes_manifest_without_snapshotting_home() {
        let mut overlay = OverlayConfig::new("centaur-node-sync:test");
        overlay.flat_home = true;
        let config = AgentSandboxConfig::new("centaur").overlay(overlay.clone());

        let script = claimed_overlay_home_script(
            &SandboxId::new("asbx-test"),
            &overlay,
            &config,
            PrepareClaimedOverlayHome {
                thread_key: "thread-1",
                execution_id: "exec-1",
                repos_json: r#"[{"repo":"acme/widget","ref":"main"}]"#,
                precomposed: true,
                harness: Some("codex"),
                harness_thread_id: None,
                harness_home: Some("/home/agent/.codex"),
            },
        );

        assert!(script.contains("'--atrium-session' 'thread-1'"));
        assert!(script.contains("'--context-source' '/var/lib/centaur/atrium/asbx-test'"));
        assert!(script.contains("'--repos-json' '[{\"repo\":\"acme/widget\",\"ref\":\"main\"}]'"));
        assert!(!script.contains("--generic-home-lower"));
        assert!(!script.contains("rm -rf \"$dst\""));
        assert!(script.contains("/run/centaur/merged/asbx-test/agent/.centaur-workspace-ready"));
    }

    #[test]
    fn finalize_claimed_session_script_rewrites_manifest_without_repos_or_snapshot() {
        let mut overlay = OverlayConfig::new("centaur-node-sync:test");
        overlay.flat_home = true;
        let config = AgentSandboxConfig::new("centaur").overlay(overlay.clone());

        let script = finalize_claimed_session_script(
            &SandboxId::new("asbx-test"),
            &overlay,
            &config,
            FinalizeClaimedSession {
                thread_key: "thread-1",
                execution_id: "exec-1",
                harness: Some("codex"),
                harness_thread_id: None,
                harness_home: Some("/home/agent/.codex"),
            },
        );

        assert!(script.contains("'--manifest-only'"));
        assert!(script.contains("'--atrium-session' 'thread-1'"));
        assert!(script.contains("'--merged-path' '/run/centaur/merged/asbx-test/agent'"));
        assert!(script.contains("'--flat-home'"));
        assert!(script.contains("'--context-source' '/var/lib/centaur/atrium/asbx-test'"));
        assert!(script.contains("'--harness' 'codex'"));
        assert!(script.contains("'--harness-home' '/home/agent/.codex'"));
        assert!(!script.contains("--repos-json"));
        assert!(!script.contains("--generic-home-lower"));
        assert!(!script.contains("rm -rf \"$dst\""));
        assert!(script.contains("/run/centaur/merged/asbx-test/agent/.centaur-workspace-ready"));
    }

    #[test]
    fn prepare_and_finalize_share_one_manifest_identity_arg_path() {
        let mut overlay = OverlayConfig::new("centaur-node-sync:test");
        overlay.flat_home = true;
        let config = AgentSandboxConfig::new("centaur").overlay(overlay.clone());
        let id = SandboxId::new("asbx-test");

        let prepare = claimed_overlay_home_script(
            &id,
            &overlay,
            &config,
            PrepareClaimedOverlayHome {
                thread_key: "thread-1",
                execution_id: "exec-1",
                repos_json: r#"[{"repo":"acme/widget","ref":"main"}]"#,
                precomposed: true,
                harness: Some("codex"),
                harness_thread_id: Some("t-abc"),
                harness_home: Some("/home/agent/.codex"),
            },
        );
        let finalize = finalize_claimed_session_script(
            &id,
            &overlay,
            &config,
            FinalizeClaimedSession {
                thread_key: "thread-1",
                execution_id: "exec-1",
                harness: Some("codex"),
                harness_thread_id: Some("t-abc"),
                harness_home: Some("/home/agent/.codex"),
            },
        );

        // Removing the repos pair from the precomposed prepare invocation must
        // yield exactly the finalize invocation — the identity args cannot
        // drift between the two claim paths.
        let stripped = prepare.replace(
            " '--repos-json' '[{\"repo\":\"acme/widget\",\"ref\":\"main\"}]'",
            "",
        );
        assert_eq!(stripped, finalize);
    }

    #[test]
    fn claimed_overlay_home_helper_rewrites_manifest_and_waits_for_remount() {
        let mut overlay = OverlayConfig::new("centaur-node-sync:test");
        overlay.flat_home = true;
        let mut config = AgentSandboxConfig::new("centaur").overlay(overlay.clone());
        config
            .image_pull_secrets
            .push("sandbox-registry".to_owned());

        let pod = build_claimed_overlay_home_helper_pod(
            "asbx-test-claim-home",
            &SandboxId::new("asbx-test"),
            "node-a",
            &overlay,
            &config,
            &claimed_overlay_home_script(
                &SandboxId::new("asbx-test"),
                &overlay,
                &config,
                PrepareClaimedOverlayHome {
                    thread_key: "thread-1",
                    execution_id: "exec-1",
                    repos_json: r#"[{"repo":"acme/widget","ref":"main"}]"#,
                    precomposed: false,
                    harness: Some("codex"),
                    harness_thread_id: Some("codex-thread"),
                    harness_home: Some("/home/agent/.codex"),
                },
            ),
            ClaimProvisionContext {
                operation: "prepare_claimed_overlay_home",
                thread_key: "thread-1",
                execution_id: "exec-1",
            },
        )
        .unwrap();

        let spec = pod.spec.as_ref().unwrap();
        assert_eq!(spec.node_name.as_deref(), Some("node-a"));
        assert_eq!(spec.restart_policy.as_deref(), Some("Never"));
        assert_eq!(
            spec.image_pull_secrets.as_ref().unwrap()[0].name,
            "sandbox-registry"
        );

        let container = &spec.containers[0];
        assert_eq!(container.name, CLAIMED_HOME_HELPER_CONTAINER);
        assert_eq!(container.image.as_deref(), Some("centaur-node-sync:test"));
        assert_eq!(
            container
                .security_context
                .as_ref()
                .and_then(|security| security.privileged),
            Some(true)
        );
        let script = container.args.as_ref().unwrap()[0].as_str();
        assert!(script.contains("/usr/local/bin/provision-overlay"));
        assert!(script.contains("'--manifest-only'"));
        assert!(!script.contains("'--replace'"));
        assert!(script.contains("'--atrium-session' 'thread-1'"));
        assert!(script.contains("'--merged-path' '/run/centaur/merged/asbx-test/agent'"));
        assert!(script.contains(
            "'--generic-home-lower' '/var/lib/centaur/overlays/.warm-home-lower/asbx-test'"
        ));
        assert!(script.contains("'--context-source' '/var/lib/centaur/atrium/asbx-test'"));
        assert!(script.contains("'--repos-json' '[{\"repo\":\"acme/widget\",\"ref\":\"main\"}]'"));
        assert!(script.contains("name=${entry##*/}"));
        assert!(script.contains("case \"$name\" in context|.centaur-workspace-ready)"));
        assert!(script.contains("rm -rf \"$dst\""));
        assert!(script.contains("/run/centaur/merged/asbx-test/agent/.centaur-workspace-ready"));
        assert!(script.contains("rm -f \"/var/lib/centaur/overlays/.sessions/asbx-test.json\""));

        let mounts = container.volume_mounts.as_ref().unwrap();
        assert!(mounts.iter().any(|mount| {
            mount.name == "workspace"
                && mount.mount_path == "/run/centaur/merged/asbx-test"
                && mount.mount_propagation.as_deref() == Some("Bidirectional")
        }));
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
    fn private_repo_hydrate_runs_before_overlay_manifest_writer() {
        let repos_json = r#"[{"repo":"acme/private","private":true,"cache_scope":{"kind":"principal","principal_id":"prn_user"}}]"#;
        let spec = SandboxSpec::new("centaur-agent:latest")
            .env("AGENT_REPOS_JSON", repos_json)
            .env("HTTPS_PROXY", "http://asbx-test-iron-proxy:8080")
            .mount(
                Mount::new(
                    MountKind::Bind {
                        source_path: "/var/lib/centaur/repos".to_owned(),
                    },
                    "/cache",
                )
                .read_only(),
            );
        let config = AgentSandboxConfig::new("centaur")
            .overlay(OverlayConfig::new("centaur-node-sync:test"))
            .iron_proxy(IronProxyConfig::new("proxy:test", "ca-cert", "ca-key"));

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();
        let init_containers = sandbox
            .spec
            .pod_template
            .spec
            .init_containers
            .as_ref()
            .unwrap();
        let private_hydrate = init_containers
            .iter()
            .position(|container| container.name == "private-repo-cache-hydrate")
            .expect("private hydrate init container");
        let manifest_writer = init_containers
            .iter()
            .position(|container| container.name == "overlay-manifest-writer")
            .expect("manifest writer init container");
        assert!(private_hydrate < manifest_writer);

        let hydrate = &init_containers[private_hydrate];
        let args = hydrate.args.as_ref().unwrap();
        assert!(args.iter().any(|arg| arg == "--hydrate-private-repos"));
        assert!(args.windows(2).any(
            |pair| pair[0] == "--https-proxy" && pair[1] == "http://asbx-test-iron-proxy:8080"
        ));
        assert!(hydrate.volume_mounts.as_ref().unwrap().iter().any(|mount| {
            mount.name == "mount-0" && mount.mount_path == "/cache" && mount.read_only != Some(true)
        }));
        assert!(
            hydrate
                .volume_mounts
                .as_ref()
                .unwrap()
                .iter()
                .any(|mount| mount.name == "firewall-ca")
        );
        let hydrate_json = serde_json::to_string(hydrate).unwrap();
        assert!(!hydrate_json.contains("tools-github-token"));
        assert!(!hydrate_json.contains("/tools-github-token"));
        assert!(!hydrate_json.contains("CENTAUR_TOOLS_GITHUB_TOKEN_FILE"));
    }

    #[test]
    fn private_repo_hydrate_requires_repo_cache_mount() {
        let repos_json = r#"[{"repo":"acme/private","private":true,"cache_scope":{"kind":"principal","principal_id":"prn_user"}}]"#;
        let spec = SandboxSpec::new("centaur-agent:latest")
            .env("AGENT_REPOS_JSON", repos_json)
            .env("HTTPS_PROXY", "http://asbx-test-iron-proxy:8080");
        let config = AgentSandboxConfig::new("centaur")
            .overlay(OverlayConfig::new("centaur-node-sync:test"))
            .iron_proxy(IronProxyConfig::new("proxy:test", "ca-cert", "ca-key"));

        let err = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap_err();
        assert!(err.to_string().contains("repo cache mounted at /cache"));
    }

    #[test]
    fn warmcache_hydrate_init_container_inserted_when_gated() {
        let repos_json = r#"[{"repo":"acme/foo","ref":"main"}]"#;
        let mut warmcache = WarmcacheHydrateConfig::new(
            "/cache",
            "/var/cache/centaur/depcache",
            "/var/lib/centaur/cas",
            "/var/lib/centaur/cas",
        );
        warmcache.atrium_base_url = Some("http://atrium-server.atrium.svc:8080".to_owned());
        warmcache.atrium_capture_api_key = Some("server-side-key".to_owned());
        let spec = SandboxSpec::new("centaur-agent:latest")
            .env("CENTAUR_THREAD_KEY", "surface:session-1")
            .env("AGENT_REPOS_JSON", repos_json)
            .mount(
                Mount::new(
                    MountKind::Bind {
                        source_path: "/var/lib/centaur/repos".to_owned(),
                    },
                    "/cache",
                )
                .read_only(),
            )
            .mount(
                Mount::new(
                    MountKind::Bind {
                        source_path: "/var/lib/centaur/depcache".to_owned(),
                    },
                    "/var/cache/centaur/depcache",
                )
                .ensure_writable(),
            );
        let config = AgentSandboxConfig::new("centaur")
            .overlay(OverlayConfig::new("centaur-node-sync:test"))
            .warmcache_hydrate(warmcache)
            .tools(ToolsConfig::new("paradigmxyz/centaur", "api:test"));

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();
        let pod_spec = &sandbox.spec.pod_template.spec;
        let init_containers = pod_spec.init_containers.as_ref().unwrap();
        let names = init_containers
            .iter()
            .map(|container| container.name.as_str())
            .collect::<Vec<_>>();
        let readiness_index = names
            .iter()
            .position(|name| *name == "overlay-readiness-wait")
            .expect("overlay-readiness-wait");
        let warmcache_index = names
            .iter()
            .position(|name| *name == "warmcache-hydrate")
            .expect("warmcache-hydrate");
        let tools_index = names
            .iter()
            .position(|name| *name == "tools-bootstrap")
            .expect("tools-bootstrap");
        assert!(readiness_index < warmcache_index);
        assert!(warmcache_index < tools_index);

        let warmcache = &init_containers[warmcache_index];
        assert_eq!(warmcache.image.as_deref(), Some("centaur-node-sync:test"));
        assert_eq!(
            warmcache.command.as_ref().unwrap(),
            &vec!["/usr/local/bin/warmcache-hydrate".to_owned()]
        );
        assert_eq!(
            warmcache
                .args
                .as_ref()
                .unwrap()
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec![
                "--session",
                "surface:session-1",
                "--repos-json",
                repos_json,
                "--repo-cache-root",
                "/cache",
                "--depcache-root",
                "/var/cache/centaur/depcache",
                "--cas-dir",
                "/var/lib/centaur/cas",
            ]
        );
        assert_eq!(
            container_env_value(warmcache, "ATRIUM_URL"),
            Some("http://atrium-server.atrium.svc:8080".to_owned())
        );
        assert_eq!(
            container_env_value(warmcache, "ARTIFACT_CAPTURE_API_KEY"),
            Some("server-side-key".to_owned())
        );
        assert_eq!(
            warmcache
                .security_context
                .as_ref()
                .and_then(|context| context.privileged),
            Some(false)
        );

        let mounts = warmcache.volume_mounts.as_ref().unwrap();
        assert!(mounts.iter().any(|mount| {
            mount.name == "mount-0" && mount.mount_path == "/cache" && mount.read_only == Some(true)
        }));
        assert!(mounts.iter().any(|mount| {
            mount.name == "mount-1" && mount.mount_path == "/var/cache/centaur/depcache"
        }));
        assert!(mounts.iter().any(|mount| {
            mount.name == WARMCACHE_CAS_VOLUME && mount.mount_path == "/var/lib/centaur/cas"
        }));

        let cas_volume = pod_spec
            .volumes
            .as_ref()
            .unwrap()
            .iter()
            .find(|volume| volume.name == WARMCACHE_CAS_VOLUME)
            .expect("warmcache CAS volume");
        let cas_host_path = cas_volume.host_path.as_ref().unwrap();
        assert_eq!(cas_host_path.path, "/var/lib/centaur/cas");
        assert_eq!(cas_host_path.r#type.as_deref(), Some("DirectoryOrCreate"));
        assert!(
            pod_spec.containers[0]
                .volume_mounts
                .as_ref()
                .unwrap()
                .iter()
                .all(|mount| mount.name != WARMCACHE_CAS_VOLUME)
        );
    }

    #[test]
    fn warmcache_hydrate_init_container_includes_toolchain_id_when_configured() {
        let repos_json = r#"[{"repo":"acme/foo","ref":"main"}]"#;
        let mut warmcache = WarmcacheHydrateConfig::new(
            "/cache",
            "/var/cache/centaur/depcache",
            "/var/lib/centaur/cas",
            "/var/lib/centaur/cas",
        );
        warmcache.toolchain_id = Some("node24-rust1.88".to_owned());
        let spec = SandboxSpec::new("centaur-agent:latest")
            .env("CENTAUR_THREAD_KEY", "surface:session-1")
            .env("AGENT_REPOS_JSON", repos_json)
            .mount(Mount::new(
                MountKind::Bind {
                    source_path: "/var/lib/centaur/repos".to_owned(),
                },
                "/cache",
            ))
            .mount(Mount::new(
                MountKind::Bind {
                    source_path: "/var/lib/centaur/depcache".to_owned(),
                },
                "/var/cache/centaur/depcache",
            ));
        let config = AgentSandboxConfig::new("centaur")
            .overlay(OverlayConfig::new("centaur-node-sync:test"))
            .warmcache_hydrate(warmcache);

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();
        let warmcache = sandbox
            .spec
            .pod_template
            .spec
            .init_containers
            .as_ref()
            .unwrap()
            .iter()
            .find(|container| container.name == "warmcache-hydrate")
            .expect("warmcache-hydrate");

        let args = warmcache
            .args
            .as_ref()
            .unwrap()
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--toolchain-id", "node24-rust1.88"])
        );
    }

    #[test]
    fn warmcache_hydrate_init_container_omitted_without_repos() {
        let spec = SandboxSpec::new("centaur-agent:latest")
            .env("CENTAUR_THREAD_KEY", "surface:session-1")
            .mount(
                Mount::new(
                    MountKind::Bind {
                        source_path: "/var/lib/centaur/repos".to_owned(),
                    },
                    "/cache",
                )
                .read_only(),
            )
            .mount(
                Mount::new(
                    MountKind::Bind {
                        source_path: "/var/lib/centaur/depcache".to_owned(),
                    },
                    "/var/cache/centaur/depcache",
                )
                .ensure_writable(),
            );
        let config = AgentSandboxConfig::new("centaur")
            .overlay(OverlayConfig::new("centaur-node-sync:test"))
            .warmcache_hydrate(WarmcacheHydrateConfig::new(
                "/cache",
                "/var/cache/centaur/depcache",
                "/var/lib/centaur/cas",
                "/var/lib/centaur/cas",
            ))
            .tools(ToolsConfig::new("paradigmxyz/centaur", "api:test"));

        let sandbox = build_agent_sandbox(&SandboxId::new("asbx-test"), &spec, &config).unwrap();
        let pod_spec = &sandbox.spec.pod_template.spec;
        let init_names = pod_spec
            .init_containers
            .as_ref()
            .unwrap()
            .iter()
            .map(|container| container.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            init_names,
            vec![
                "ensure-writable-1",
                "overlay-manifest-writer",
                "overlay-readiness-wait",
                "tools-bootstrap",
            ]
        );
        assert!(
            pod_spec
                .volumes
                .as_ref()
                .unwrap()
                .iter()
                .all(|volume| volume.name != WARMCACHE_CAS_VOLUME)
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
    fn extracts_pod_container_state_reason() {
        let mut pod = pod_with_phase_and_ready("Failed", false);
        let status = sandbox_status_from_pod(1, Some(&pod));
        pod.status.as_mut().unwrap().container_statuses = Some(vec![ContainerStatus {
            name: DEFAULT_CONTAINER_NAME.to_owned(),
            state: Some(ContainerState {
                terminated: Some(ContainerStateTerminated {
                    exit_code: 1,
                    reason: Some("Error".to_owned()),
                    message: Some("missing credentials".to_owned()),
                    ..ContainerStateTerminated::default()
                }),
                ..ContainerState::default()
            }),
            ..ContainerStatus::default()
        }]);
        // An init-container failure lives in the same (agent) pod and should also
        // surface — this is a common "died before the agent ran" cause.
        pod.status.as_mut().unwrap().init_container_statuses = Some(vec![ContainerStatus {
            name: "overlay-claim-home".to_owned(),
            state: Some(ContainerState {
                waiting: Some(ContainerStateWaiting {
                    reason: Some("CrashLoopBackOff".to_owned()),
                    message: Some("back-off restarting failed container".to_owned()),
                }),
                ..ContainerState::default()
            }),
            ..ContainerStatus::default()
        }]);

        assert_eq!(
            sandbox_reason_from_pod(&status, Some(&pod)).as_deref(),
            Some(
                "agent terminated: Error (exit 1): missing credentials; init overlay-claim-home waiting: CrashLoopBackOff: back-off restarting failed container"
            )
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
