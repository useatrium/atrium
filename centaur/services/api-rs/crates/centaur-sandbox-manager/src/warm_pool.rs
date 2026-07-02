use std::{sync::Arc, time::Duration};

use centaur_sandbox_core::{SandboxError, SandboxId, SandboxSpec, SandboxStatus};
use centaur_session_sqlx::{PgSessionStore, SessionStoreError, WarmPoolState};
use thiserror::Error;
use tokio::{
    sync::Mutex,
    time::{MissedTickBehavior, interval},
};
use tracing::{info, warn};

use crate::SandboxManager;

pub type WarmSandboxSpecFactory = Arc<dyn Fn() -> WarmSandboxWorkload + Send + Sync>;
const DEFAULT_WARM_POOL_NAME: &str = "session-default";
const STALE_WARM_DRAIN_LIMIT: i64 = 16;

#[derive(Clone, Debug)]
pub struct WarmSandboxWorkload {
    pub spec: SandboxSpec,
    pub workload_key: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimedWarmSandbox {
    pub sandbox_id: String,
    pub workload_key: String,
}

pub struct WarmPoolConfig {
    pub target_size: usize,
    pub replenish_interval: Duration,
    pub bootstrap_iron_control_principal: Option<String>,
}

pub struct WarmPoolManager {
    manager: Arc<SandboxManager>,
    store: PgSessionStore,
    spec_factory: WarmSandboxSpecFactory,
    initial_workload_key: String,
    registered_workload_key: Mutex<Option<String>>,
    config: WarmPoolConfig,
}

impl WarmPoolManager {
    pub fn new(
        manager: Arc<SandboxManager>,
        store: PgSessionStore,
        spec_factory: WarmSandboxSpecFactory,
        config: WarmPoolConfig,
    ) -> Self {
        let initial_workload_key = spec_factory().workload_key;
        Self {
            manager,
            store,
            spec_factory,
            initial_workload_key,
            registered_workload_key: Mutex::new(None),
            config,
        }
    }

    pub fn workload_key(&self) -> &str {
        &self.initial_workload_key
    }

    pub fn spawn_replenisher(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut tick = interval(self.config.replenish_interval);
            tick.set_missed_tick_behavior(MissedTickBehavior::Delay);

            loop {
                tick.tick().await;
                if let Err(error) = self.replenish_once().await {
                    warn!(%error, "session sandbox warm pool replenishment failed");
                }
            }
        });
    }

    pub async fn claim(
        &self,
        thread_key: &str,
    ) -> Result<Option<ClaimedWarmSandbox>, WarmPoolError> {
        let workload_key = self.active_workload_key().await?;
        loop {
            let Some(sandbox_id) = self
                .store
                .claim_ready_warm_sandbox(workload_key.as_str(), thread_key)
                .await?
            else {
                return Ok(None);
            };

            let id = SandboxId::new(sandbox_id.as_str());
            let failure = match self.manager.status(&id).await {
                // Only `Running` accepts `open_io`. `Created` means the
                // runtime regressed after the replenisher saw it running
                // (backends wait for readiness before returning from create),
                // so claiming it would fail at I/O attach.
                Ok(SandboxStatus::Running) => {
                    return Ok(Some(ClaimedWarmSandbox {
                        sandbox_id,
                        workload_key,
                    }));
                }
                Ok(status) => format!("claimed warm sandbox was not running: {status:?}"),
                Err(SandboxError::NotFound(_)) => "claimed warm sandbox was not found".to_owned(),
                Err(error) => {
                    let error_message = error.to_string();
                    warn!(%sandbox_id, error = %error_message);
                    let _ = self
                        .store
                        .mark_warm_sandbox_failed(&sandbox_id, &error_message)
                        .await;
                    return Err(WarmPoolError::Sandbox(error));
                }
            };
            warn!(%sandbox_id, error = %failure, thread_key);
            self.store
                .mark_warm_sandbox_failed(&sandbox_id, &failure)
                .await?;
        }
    }

    async fn replenish_once(&self) -> Result<(), WarmPoolError> {
        let desired_workload = (self.spec_factory)();
        let state = self.warm_pool_state_for(&desired_workload).await?;

        if state.active_workload_key.as_deref() == Some(desired_workload.workload_key.as_str())
            || state.pending_workload_key.as_deref() == Some(desired_workload.workload_key.as_str())
        {
            let ready = self.ensure_ready_warm_sandboxes(&desired_workload).await?;
            if state.pending_workload_key.as_deref() == Some(desired_workload.workload_key.as_str())
                && ready >= self.config.target_size
                && let Some(promoted) = self
                    .store
                    .promote_warm_pool_pending(
                        DEFAULT_WARM_POOL_NAME,
                        desired_workload.workload_key.as_str(),
                    )
                    .await?
            {
                self.drain_stale_ready_warm_sandboxes(promoted.protected_workload_keys())
                    .await?;
                return Ok(());
            }
        }

        self.drain_stale_ready_warm_sandboxes(state.protected_workload_keys())
            .await?;
        Ok(())
    }

    async fn ensure_ready_warm_sandboxes(
        &self,
        workload: &WarmSandboxWorkload,
    ) -> Result<usize, WarmPoolError> {
        let ready = self
            .store
            .count_ready_warm_sandboxes(workload.workload_key.as_str())
            .await?
            .max(0) as usize;
        let needed = self.config.target_size.saturating_sub(ready);
        for _ in 0..needed {
            let mut spec = workload.spec.clone();
            if let Some(principal_id) = &self.config.bootstrap_iron_control_principal {
                spec.iron_control_principal = Some(principal_id.clone());
            }
            let handle = self.manager.create_running(spec).await?;
            if let Err(error) = self
                .store
                .insert_ready_warm_sandbox(handle.id.as_str(), workload.workload_key.as_str())
                .await
            {
                let _ = self.manager.stop(&handle.id).await;
                return Err(WarmPoolError::Store(error));
            }
        }

        Ok(ready + needed)
    }

    async fn active_workload_key(&self) -> Result<String, WarmPoolError> {
        let state = self
            .store
            .get_warm_pool_state(DEFAULT_WARM_POOL_NAME)
            .await?;
        Ok(state
            .and_then(|state| state.active_workload_key)
            .unwrap_or_else(|| self.initial_workload_key.clone()))
    }

    async fn warm_pool_state_for(
        &self,
        desired_workload: &WarmSandboxWorkload,
    ) -> Result<WarmPoolState, WarmPoolError> {
        let mut registered = self.registered_workload_key.lock().await;
        if registered.as_deref() != Some(desired_workload.workload_key.as_str()) {
            let state = self
                .store
                .prepare_warm_pool_state(
                    DEFAULT_WARM_POOL_NAME,
                    desired_workload.workload_key.as_str(),
                    self.config.target_size,
                )
                .await?;
            *registered = Some(desired_workload.workload_key.clone());
            return Ok(state);
        }

        if let Some(state) = self
            .store
            .get_warm_pool_state(DEFAULT_WARM_POOL_NAME)
            .await?
        {
            return Ok(state);
        }

        let state = self
            .store
            .prepare_warm_pool_state(
                DEFAULT_WARM_POOL_NAME,
                desired_workload.workload_key.as_str(),
                self.config.target_size,
            )
            .await?;
        Ok(state)
    }

    async fn drain_stale_ready_warm_sandboxes(
        &self,
        active_workload_keys: Vec<String>,
    ) -> Result<(), WarmPoolError> {
        if active_workload_keys.is_empty() {
            return Ok(());
        }
        let reason = format!(
            "drained stale warm workload; protected workload keys are {}",
            active_workload_keys.join(",")
        );
        let sandbox_ids = self
            .store
            .drain_stale_ready_warm_sandboxes(
                &active_workload_keys,
                STALE_WARM_DRAIN_LIMIT,
                &reason,
            )
            .await?;
        for sandbox_id in sandbox_ids {
            let id = SandboxId::new(sandbox_id.as_str());
            match self.manager.stop(&id).await {
                Ok(()) | Err(SandboxError::NotFound(_)) => {
                    info!(
                        sandbox_id,
                        workload_keys = active_workload_keys.join(","),
                        "drained stale warm sandbox"
                    );
                }
                Err(error) => {
                    warn!(
                        sandbox_id,
                        workload_keys = active_workload_keys.join(","),
                        %error,
                        "failed to stop drained stale warm sandbox"
                    );
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum WarmPoolError {
    #[error(transparent)]
    Store(#[from] SessionStoreError),
    #[error(transparent)]
    Sandbox(#[from] SandboxError),
}
