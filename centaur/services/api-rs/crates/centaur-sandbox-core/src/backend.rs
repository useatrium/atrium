use async_trait::async_trait;

use crate::{
    ObservedSandbox, SandboxHandle, SandboxId, SandboxIo, SandboxResult, SandboxSpec, SandboxStatus,
};

#[derive(Clone, Copy)]
pub struct PrepareClaimedOverlayHome<'a> {
    pub thread_key: &'a str,
    pub execution_id: &'a str,
    pub repos_json: &'a str,
    pub precomposed: bool,
    pub harness: Option<&'a str>,
    pub harness_thread_id: Option<&'a str>,
    pub harness_home: Option<&'a str>,
}

#[derive(Clone, Copy)]
pub struct FinalizeClaimedSession<'a> {
    pub thread_key: &'a str,
    pub execution_id: &'a str,
    pub harness: Option<&'a str>,
    pub harness_thread_id: Option<&'a str>,
    pub harness_home: Option<&'a str>,
}

#[async_trait]
/// Backend-neutral lifecycle and byte-I/O operations for one sandbox runtime.
///
/// This trait intentionally models only the isolated workload primitive. Higher
/// layers decide why the sandbox exists and how stdin/stdout bytes should be
/// framed.
pub trait SandboxBackend: Send + Sync {
    /// Stable backend name used in handles, observations, and diagnostics.
    fn name(&self) -> &'static str;

    /// Create a sandbox from the supplied workload spec and return its handle.
    async fn create(&self, spec: SandboxSpec) -> SandboxResult<SandboxHandle>;

    /// Open owned stdin/stdout/stderr handles for a running sandbox.
    async fn open_io(&self, id: &SandboxId) -> SandboxResult<SandboxIo>;

    /// Read the sandbox workload's recorded stdout history since `since`.
    ///
    /// Live io streams only deliver output from attach time forward; output
    /// emitted while no reader was attached (for example across a control
    /// plane restart) is otherwise lost. Backends whose runtime records the
    /// workload's stdout (such as Kubernetes pod logs) can replay it here so
    /// orphaned executions can be adopted instead of failed.
    async fn read_output_since(
        &self,
        _id: &SandboxId,
        _since: Option<std::time::SystemTime>,
    ) -> SandboxResult<Vec<String>> {
        Err(crate::SandboxError::Unsupported {
            backend: self.name(),
            operation: "read_output_since",
        })
    }

    /// Return the portable, cheap lifecycle status for a sandbox.
    async fn status(&self, id: &SandboxId) -> SandboxResult<SandboxStatus>;

    /// Return the full observed runtime snapshot for one sandbox.
    ///
    /// Unlike [`SandboxBackend::status`], this can include backend-owned
    /// diagnostic context used by reconcilers.
    async fn observe(&self, id: &SandboxId) -> SandboxResult<ObservedSandbox>;

    /// List all sandbox observations owned by this backend/control plane.
    async fn list_observed(&self) -> SandboxResult<Vec<ObservedSandbox>>;

    /// Stop the sandbox and clean up backend-owned runtime resources.
    async fn stop(&self, id: &SandboxId) -> SandboxResult<()>;

    /// Rebind a running sandbox's managed iron-proxy to a different
    /// iron-control principal.
    async fn assign_iron_control_proxy_principal(
        &self,
        _id: &SandboxId,
        _principal_id: &str,
    ) -> SandboxResult<()> {
        Err(crate::SandboxError::Unsupported {
            backend: self.name(),
            operation: "assign_iron_control_proxy_principal",
        })
    }

    /// Publish the active Centaur execution context to an already-running
    /// sandbox. Backends that can patch runtime metadata use this to update
    /// downward-API files for background helpers in warm sandboxes.
    async fn set_runtime_context(
        &self,
        _id: &SandboxId,
        _thread_key: &str,
        _execution_id: &str,
    ) -> SandboxResult<()> {
        Err(crate::SandboxError::Unsupported {
            backend: self.name(),
            operation: "set_runtime_context",
        })
    }

    /// Return true when this backend can prepare an already-running warm pod's
    /// `/home/agent` for a claimed repo-bearing session.
    fn supports_claimed_overlay_home(&self) -> bool {
        false
    }

    /// Compose and bind a claimed warm pod's HOME for a repo-bearing session
    /// before the control plane opens the session pipe and sends the first turn.
    async fn prepare_claimed_overlay_home(
        &self,
        _id: &SandboxId,
        _request: PrepareClaimedOverlayHome<'_>,
    ) -> SandboxResult<()> {
        Err(crate::SandboxError::Unsupported {
            backend: self.name(),
            operation: "prepare_claimed_overlay_home",
        })
    }

    /// Stamp a claimed warm sandbox's session identity into whatever runtime
    /// metadata the backend maintains for it (for Kubernetes, the node-sync
    /// overlay manifest), independent of any repo-home preparation. Runs on
    /// every warm claim that does not go through
    /// [`SandboxBackend::prepare_claimed_overlay_home`], which stamps the same
    /// identity as part of its home rewrite. Backends that keep no such
    /// metadata have nothing to finalize and inherit this no-op.
    async fn finalize_claimed_session(
        &self,
        _id: &SandboxId,
        _request: FinalizeClaimedSession<'_>,
    ) -> SandboxResult<()> {
        Ok(())
    }

    /// Ensure a running sandbox's managed iron-proxy resources are present and
    /// usable for the supplied iron-control principal without otherwise
    /// changing the sandbox lifecycle.
    async fn ensure_iron_control_proxy_resources(
        &self,
        _id: &SandboxId,
        _principal_id: &str,
    ) -> SandboxResult<()> {
        Ok(())
    }

    /// Suspend the sandbox while preserving any backend-supported runtime state.
    async fn pause(&self, id: &SandboxId) -> SandboxResult<()>;

    /// Resume a previously suspended sandbox and wait until it can serve I/O.
    async fn resume(&self, id: &SandboxId) -> SandboxResult<()>;
}
