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
const STALE_DRAINED_WARM_SANDBOX_AGE: Duration = Duration::from_secs(300);

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
    pub max_running_sandboxes: Option<usize>,
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
            match self.manager.stop(&id).await {
                Ok(()) | Err(SandboxError::NotFound(_)) => {
                    info!(%sandbox_id, thread_key, "reaped failed claimed warm sandbox");
                }
                Err(error) => {
                    warn!(
                        %sandbox_id,
                        thread_key,
                        %error,
                        "failed to reap failed claimed warm sandbox"
                    );
                }
            }
        }
    }

    async fn replenish_once(&self) -> Result<(), WarmPoolError> {
        self.prune_stale_ready_sandboxes().await?;
        self.prune_stale_drained_sandboxes().await?;

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
        let needed = self
            .config
            .target_size
            .saturating_sub(ready)
            .min(self.available_running_slots().await?);
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

    async fn prune_stale_ready_sandboxes(&self) -> Result<(), WarmPoolError> {
        for sandbox_id in self.store.list_ready_warm_sandbox_ids().await? {
            let id = SandboxId::new(sandbox_id.as_str());
            let failure = match self.manager.status(&id).await {
                Ok(SandboxStatus::Running) => continue,
                Ok(status) => format!("ready warm sandbox was not running: {status:?}"),
                Err(SandboxError::NotFound(_)) => "ready warm sandbox was not found".to_owned(),
                Err(error) => {
                    let error_message = error.to_string();
                    warn!(%sandbox_id, error = %error_message);
                    return Err(WarmPoolError::Sandbox(error));
                }
            };
            warn!(%sandbox_id, error = %failure, "marking stale ready warm sandbox failed");
            self.store
                .mark_warm_sandbox_failed(&sandbox_id, &failure)
                .await?;
            match self.manager.stop(&id).await {
                Ok(()) | Err(SandboxError::NotFound(_)) => {
                    info!(%sandbox_id, "reaped failed ready warm sandbox");
                }
                Err(error) => {
                    warn!(%sandbox_id, %error, "failed to reap failed ready warm sandbox");
                }
            }
        }
        Ok(())
    }

    async fn prune_stale_drained_sandboxes(&self) -> Result<(), WarmPoolError> {
        for sandbox_id in self
            .store
            .list_stale_drained_warm_sandbox_ids(STALE_DRAINED_WARM_SANDBOX_AGE)
            .await?
        {
            let id = SandboxId::new(sandbox_id.as_str());
            let failure = match self.manager.status(&id).await {
                Ok(status) if status_consumes_running_slot(&status) => {
                    match self.manager.stop(&id).await {
                        Ok(()) | Err(SandboxError::NotFound(_)) => {
                            "stale drained warm sandbox stopped".to_owned()
                        }
                        Err(error) => {
                            let error_message = error.to_string();
                            warn!(%sandbox_id, error = %error_message);
                            return Err(WarmPoolError::Sandbox(error));
                        }
                    }
                }
                Ok(status) => format!("stale drained warm sandbox was not running: {status:?}"),
                Err(SandboxError::NotFound(_)) => {
                    "stale drained warm sandbox was not found".to_owned()
                }
                Err(error) => {
                    let error_message = error.to_string();
                    warn!(%sandbox_id, error = %error_message);
                    return Err(WarmPoolError::Sandbox(error));
                }
            };
            warn!(%sandbox_id, reason = %failure, "marking stale drained warm sandbox failed");
            self.store
                .mark_warm_sandbox_failed(&sandbox_id, &failure)
                .await?;
        }
        Ok(())
    }

    async fn available_running_slots(&self) -> Result<usize, WarmPoolError> {
        let Some(max_running) = self.config.max_running_sandboxes else {
            return Ok(usize::MAX);
        };
        let running = self
            .manager
            .list_observed()
            .await?
            .into_iter()
            .filter(|observed| status_consumes_running_slot(&observed.status))
            .count();
        Ok(max_running.saturating_sub(running))
    }
}

fn status_consumes_running_slot(status: &SandboxStatus) -> bool {
    matches!(
        status,
        SandboxStatus::Created | SandboxStatus::Running | SandboxStatus::Unknown(_)
    )
}

#[derive(Debug, Error)]
pub enum WarmPoolError {
    #[error(transparent)]
    Store(#[from] SessionStoreError),
    #[error(transparent)]
    Sandbox(#[from] SandboxError),
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        sync::{Arc, Mutex},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    use async_trait::async_trait;
    use centaur_sandbox_core::{
        ObservedSandbox, SandboxBackend, SandboxError, SandboxHandle, SandboxId, SandboxIo,
        SandboxResult, SandboxSpec, SandboxStatus,
    };
    use centaur_session_core::{HarnessType, ThreadKey, empty_object};

    use super::*;

    /// The DB-backed tests here share the `session_warm_sandboxes` table, and
    /// `replenish_once` prunes every ready row whose sandbox its own backend
    /// does not observe — so two of these tests running concurrently prune
    /// each other's rows. Serialize them.
    static DB_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn pruner_marks_stopped_ready_warm_sandbox_failed_and_stops_it() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = DB_TEST_LOCK.lock().await;
        let suffix = unique_suffix();
        let workload_key = format!("test-stopped-ready-{suffix}");
        let stopped_sandbox = format!("stopped-ready-{suffix}");

        store
            .insert_ready_warm_sandbox(&stopped_sandbox, &workload_key)
            .await
            .expect("insert stopped ready warm sandbox row");

        let backend = Arc::new(TestBackend::new(format!("unused-{suffix}")));
        backend.set_status(&stopped_sandbox, SandboxStatus::Stopped);
        let pool = WarmPoolManager::new(
            Arc::new(SandboxManager::new(backend.clone())),
            store.clone(),
            Arc::new({
                let workload_key = workload_key.clone();
                move || WarmSandboxWorkload {
                    spec: SandboxSpec::new("image"),
                    workload_key: workload_key.clone(),
                }
            }),
            WarmPoolConfig {
                target_size: 0,
                replenish_interval: Duration::from_secs(60),
                bootstrap_iron_control_principal: None,
                max_running_sandboxes: None,
            },
        );

        pool.prune_stale_ready_sandboxes()
            .await
            .expect("prune stopped ready warm sandbox");

        let status: String =
            sqlx::query_scalar("select status from session_warm_sandboxes where sandbox_id = $1")
                .bind(&stopped_sandbox)
                .fetch_one(store.pool())
                .await
                .expect("read stopped ready warm sandbox status");
        assert_eq!(status, "failed");
        assert_eq!(backend.stopped(), vec![stopped_sandbox]);
    }

    #[tokio::test]
    async fn replenisher_prunes_missing_ready_rows_before_counting() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = DB_TEST_LOCK.lock().await;
        let suffix = unique_suffix();
        let workload_key = format!("test-prune-{suffix}");
        let old_workload_key = format!("test-prune-old-{suffix}");
        let stale_sandbox = format!("stale-{suffix}");
        let old_stale_sandbox = format!("old-stale-{suffix}");
        let fresh_sandbox = format!("fresh-{suffix}");
        let claim_thread = format!("test:thread-{suffix}");
        ensure_session(&store, &claim_thread).await;

        store
            .insert_ready_warm_sandbox(&stale_sandbox, &workload_key)
            .await
            .expect("insert stale warm sandbox row");
        store
            .insert_ready_warm_sandbox(&old_stale_sandbox, &old_workload_key)
            .await
            .expect("insert stale warm sandbox row for old workload");
        assert_eq!(
            store
                .count_ready_warm_sandboxes(&workload_key)
                .await
                .expect("count ready warm sandboxes"),
            1
        );
        assert_eq!(
            store
                .count_ready_warm_sandboxes(&old_workload_key)
                .await
                .expect("count ready warm sandboxes for old workload"),
            1
        );

        let backend = Arc::new(TestBackend::new(fresh_sandbox.clone()));
        let pool = WarmPoolManager::new(
            Arc::new(SandboxManager::new(backend.clone())),
            store.clone(),
            Arc::new({
                let workload_key = workload_key.clone();
                move || WarmSandboxWorkload {
                    spec: SandboxSpec::new("image"),
                    workload_key: workload_key.clone(),
                }
            }),
            WarmPoolConfig {
                target_size: 1,
                replenish_interval: Duration::from_secs(60),
                bootstrap_iron_control_principal: None,
                max_running_sandboxes: None,
            },
        );

        pool.replenish_once().await.expect("replenish warm pool");

        assert_eq!(backend.created(), vec![fresh_sandbox.clone()]);
        assert_eq!(
            store
                .count_ready_warm_sandboxes(&workload_key)
                .await
                .expect("count ready warm sandboxes"),
            1
        );
        assert_eq!(
            store
                .claim_ready_warm_sandbox(&workload_key, &claim_thread)
                .await
                .expect("claim ready warm sandbox"),
            Some(fresh_sandbox)
        );
        assert_eq!(
            store
                .count_ready_warm_sandboxes(&old_workload_key)
                .await
                .expect("count ready warm sandboxes for old workload"),
            0
        );
    }

    #[tokio::test]
    async fn replenisher_prunes_stale_drained_rows() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = DB_TEST_LOCK.lock().await;
        let suffix = unique_suffix();
        let workload_key = format!("test-drained-{suffix}");
        let stale_sandbox = format!("stale-drained-{suffix}");

        store
            .insert_ready_warm_sandbox(&stale_sandbox, &workload_key)
            .await
            .expect("insert stale drained warm sandbox row");
        sqlx::query(
            r#"
            update session_warm_sandboxes
            set status = 'drained', updated_at = now() - interval '10 minutes'
            where sandbox_id = $1
            "#,
        )
        .bind(&stale_sandbox)
        .execute(store.pool())
        .await
        .expect("make warm sandbox drain stale");

        let backend = Arc::new(TestBackend::new(format!("fresh-{suffix}")));
        backend.set_status(&stale_sandbox, SandboxStatus::Running);
        let pool = WarmPoolManager::new(
            Arc::new(SandboxManager::new(backend.clone())),
            store.clone(),
            Arc::new({
                let workload_key = workload_key.clone();
                move || WarmSandboxWorkload {
                    spec: SandboxSpec::new("image"),
                    workload_key: workload_key.clone(),
                }
            }),
            WarmPoolConfig {
                target_size: 0,
                replenish_interval: Duration::from_secs(60),
                bootstrap_iron_control_principal: None,
                max_running_sandboxes: None,
            },
        );

        pool.replenish_once().await.expect("replenish warm pool");

        assert_eq!(
            backend
                .status(&SandboxId::new(&stale_sandbox))
                .await
                .unwrap(),
            SandboxStatus::Stopped
        );
        assert!(
            !store
                .list_referenced_sandbox_ids()
                .await
                .expect("list referenced sandboxes")
                .contains(&stale_sandbox)
        );
    }

    async fn ensure_session(store: &PgSessionStore, thread_key: &str) {
        store
            .create_or_get_session(
                &ThreadKey::parse(thread_key.to_owned()).expect("valid thread key"),
                &HarnessType::Codex,
                None,
                empty_object(),
            )
            .await
            .expect("create warm-pool test session");
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

    fn unique_suffix() -> String {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos()
            .to_string()
    }

    struct TestBackend {
        create_id: String,
        statuses: Mutex<BTreeMap<String, SandboxStatus>>,
        created: Mutex<Vec<String>>,
        stopped: Mutex<Vec<String>>,
    }

    impl TestBackend {
        fn new(create_id: String) -> Self {
            Self {
                create_id,
                statuses: Mutex::new(BTreeMap::new()),
                created: Mutex::new(Vec::new()),
                stopped: Mutex::new(Vec::new()),
            }
        }

        fn created(&self) -> Vec<String> {
            self.created.lock().unwrap().clone()
        }

        fn stopped(&self) -> Vec<String> {
            self.stopped.lock().unwrap().clone()
        }

        fn set_status(&self, sandbox_id: &str, status: SandboxStatus) {
            self.statuses
                .lock()
                .unwrap()
                .insert(sandbox_id.to_owned(), status);
        }
    }

    #[async_trait]
    impl SandboxBackend for TestBackend {
        fn name(&self) -> &'static str {
            "test"
        }

        async fn create(&self, _spec: SandboxSpec) -> SandboxResult<SandboxHandle> {
            self.statuses
                .lock()
                .unwrap()
                .insert(self.create_id.clone(), SandboxStatus::Running);
            self.created.lock().unwrap().push(self.create_id.clone());
            Ok(SandboxHandle::new(
                SandboxId::new(self.create_id.clone()),
                self.name(),
            ))
        }

        async fn open_io(&self, _id: &SandboxId) -> SandboxResult<SandboxIo> {
            Err(SandboxError::Unsupported {
                backend: self.name(),
                operation: "open_io",
            })
        }

        async fn status(&self, id: &SandboxId) -> SandboxResult<SandboxStatus> {
            self.statuses
                .lock()
                .unwrap()
                .get(id.as_str())
                .cloned()
                .ok_or_else(|| SandboxError::NotFound(id.as_str().to_owned()))
        }

        async fn observe(&self, id: &SandboxId) -> SandboxResult<ObservedSandbox> {
            Ok(ObservedSandbox::new(
                id.clone(),
                self.name(),
                self.status(id).await?,
            ))
        }

        async fn list_observed(&self) -> SandboxResult<Vec<ObservedSandbox>> {
            Ok(self
                .statuses
                .lock()
                .unwrap()
                .iter()
                .map(|(id, status)| ObservedSandbox::new(id.clone(), self.name(), status.clone()))
                .collect())
        }

        async fn stop(&self, id: &SandboxId) -> SandboxResult<()> {
            self.stopped.lock().unwrap().push(id.as_str().to_owned());
            self.statuses
                .lock()
                .unwrap()
                .insert(id.as_str().to_owned(), SandboxStatus::Stopped);
            Ok(())
        }

        async fn pause(&self, id: &SandboxId) -> SandboxResult<()> {
            self.statuses
                .lock()
                .unwrap()
                .insert(id.as_str().to_owned(), SandboxStatus::Suspended);
            Ok(())
        }

        async fn resume(&self, id: &SandboxId) -> SandboxResult<()> {
            self.statuses
                .lock()
                .unwrap()
                .insert(id.as_str().to_owned(), SandboxStatus::Running);
            Ok(())
        }
    }
}
