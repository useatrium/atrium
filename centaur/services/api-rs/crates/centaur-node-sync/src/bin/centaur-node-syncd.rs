//! centaur-node-syncd -- the per-node sync daemon (Track C4), stateful and
//! multi-session aware.
//!
//! In multi-session mode (`--overlays-root <path>`), one daemon scans every
//! direct child directory under the overlays root whose name does not start with
//! `.`. Each child is a session upper and must have a sidecar manifest at
//! `<overlays-root>/.sessions/<session>.json`.
//!
//! In single-session fallback mode (`--overlays-root` absent), the daemon keeps
//! the original `NODE_SYNC_*` env contract.
//!
//! Global env: ATRIUM_BASE_URL, ATRIUM_CAPTURE_API_KEY, optional
//!      NODE_SYNC_ATRIUM_ROOT, NODE_SYNC_INTERVAL_SECS, NODE_SYNC_DIRTY_BUDGET,
//!      NODE_SYNC_LARGE_FILE_BYTES, NODE_SYNC_EVICT_HEARTBEAT_STALE_SECS,
//!      NODE_SYNC_EVICT_NO_HEARTBEAT_GRACE_SECS, NODE_SYNC_EVICT_GRACE_SECS,
//!      NODE_SYNC_EVICT_RECHECK_SECS, NODE_SYNC_GC_DIRS,
//!      NODE_SYNC_RECONCILE_SECS, NODE_SYNC_STREAM_ENABLED.
//! Single-session env: NODE_SYNC_SESSION, NODE_SYNC_UPPER, NODE_SYNC_MERGED,
//!      optional NODE_SYNC_HARNESS, NODE_SYNC_HARNESS_THREAD_ID,
//!      NODE_SYNC_HARNESS_HOME, NODE_SYNC_REPO, NODE_SYNC_STATE.
//! Flags: --once, --interval <secs>, --overlays-root <path>.

#[cfg(any(target_os = "linux", test))]
fn scoped_atrium_root(atrium_root: &std::path::Path, session: &str) -> std::path::PathBuf {
    atrium_root.join(session)
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone)]
struct SessionConfig {
    session: String,
    atrium_session: String,
    upper: std::path::PathBuf,
    merged: std::path::PathBuf,
    harness: Option<centaur_node_sync::runtime::HarnessTranscriptKind>,
    harness_thread_id: String,
    harness_home: String,
    flat_home: bool,
    repo_subdirs: Vec<std::path::PathBuf>,
    repo_worktrees: Vec<RepoWorktree>,
    state_file: std::path::PathBuf,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct RepoWorktree {
    key: String,
    path: std::path::PathBuf,
}

#[cfg(any(target_os = "linux", test))]
fn session_config_from_discovered(
    discovered: &centaur_node_sync::session_manifest::DiscoveredSession,
    mounted: &centaur_node_sync::overlay_mount::OverlayMountPlan,
) -> SessionConfig {
    let repo = discovered.manifest.repo.clone();
    let merged = discovered.manifest.merged.clone();
    SessionConfig {
        session: discovered.session.clone(),
        atrium_session: discovered.atrium_session.clone(),
        upper: mounted.upper.clone(),
        merged: merged.clone(),
        harness: discovered
            .manifest
            .harness
            .as_deref()
            .and_then(centaur_node_sync::runtime::HarnessTranscriptKind::parse),
        harness_thread_id: discovered.manifest.harness_thread_id.clone(),
        harness_home: discovered.manifest.harness_home.clone(),
        flat_home: discovered.manifest.flat_home,
        repo_subdirs: repo_lane_subdirs(&discovered.manifest.repos),
        repo_worktrees: repo_worktrees(&repo, &discovered.manifest.repos, &merged),
        state_file: discovered.state_file.clone(),
    }
}

#[cfg(any(target_os = "linux", test))]
fn repo_lane_subdirs(
    repos: &[centaur_node_sync::session_manifest::RepoMount],
) -> Vec<std::path::PathBuf> {
    repos
        .iter()
        .filter_map(|repo| centaur_node_sync::overlay_mount::repo_target_subdir(repo).ok())
        .map(std::path::PathBuf::from)
        .collect()
}

#[cfg(any(target_os = "linux", test))]
fn repo_worktrees(
    repo: &str,
    repos: &[centaur_node_sync::session_manifest::RepoMount],
    merged: &std::path::Path,
) -> Vec<RepoWorktree> {
    if !repos.is_empty() {
        return repos
            .iter()
            .filter_map(|repo| {
                let target = centaur_node_sync::overlay_mount::repo_target_subdir(repo).ok()?;
                Some(RepoWorktree {
                    key: centaur_node_sync::wip::sanitize_repo_key(&target),
                    path: merged.join(&target),
                })
            })
            .collect();
    }
    if repo.trim().is_empty() {
        return Vec::new();
    }
    vec![RepoWorktree {
        key: centaur_node_sync::wip::sanitize_repo_key(&repo_name(repo)),
        path: merged.to_path_buf(),
    }]
}

#[cfg(any(target_os = "linux", test))]
fn repo_name(repo: &str) -> String {
    if repo.is_empty() {
        String::new()
    } else {
        std::path::Path::new(repo)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "repo".to_string())
    }
}

/// Reconstruct a session's per-path sync state (base seqs/shas) from the
/// change feed, once. Runs before inbound adoption; a failed drain leaves
/// `hydrated` unset so it RESUMES next tick (the cursor already covers
/// whatever landed). Marking hydrated on a failed drain would permanently
/// forfeit the seeding: every pre-existing artifact would then look like an
/// unknown local to `decide_adopt` — re-downloaded + copied up on adopt, and
/// a locally edited one would capture with base 0 forever (server rejects
/// with 409 base_required).
#[cfg(any(target_os = "linux", test))]
fn hydrate_state_if_needed(
    session: &SessionConfig,
    state: &mut centaur_node_sync::state::DaemonState,
    client: &mut dyn centaur_node_sync::runtime::AtriumClient,
) {
    if state.hydrated {
        return;
    }
    loop {
        match client.poll_changes(&state.cursor) {
            Ok((rows, next)) => {
                if rows.is_empty() {
                    break;
                }
                for (path, rc) in &rows {
                    state.note_hydrated_version(path, rc.seq, rc.sha.clone());
                }
                state.cursor = next;
            }
            Err(e) => {
                eprintln!(
                    "session {}: hydrate poll: {e} (will retry next tick)",
                    session.session
                );
                return;
            }
        }
    }
    state.hydrated = true;
    let _ = state.save(&session.state_file);
    println!(
        "session {}: hydrated {} paths, cursor={}",
        session.session,
        state.paths.len(),
        state.cursor
    );
}

#[cfg(any(target_os = "linux", test))]
fn warmcache_capture_if_needed(
    client: &mut dyn centaur_node_sync::runtime::AtriumClient,
    session: &SessionConfig,
    state: &mut centaur_node_sync::state::DaemonState,
    depcache_root: &std::path::Path,
) {
    let receipt = match centaur_node_sync::warmcache::read_warmcache_receipt(
        depcache_root,
        &session.atrium_session,
    ) {
        Ok(Some(receipt)) => receipt,
        Ok(None) => return,
        Err(e) => {
            eprintln!("session {}: warmcache receipt: {e}", session.session);
            return;
        }
    };

    for entry in receipt.entries {
        if entry.hit || entry.errors > 0 {
            continue;
        }
        let capture_key =
            warmcache_capture_key(&session.atrium_session, &entry.kind, &entry.lockfile_hash);
        if state.warmcache_captured.contains(&capture_key) {
            continue;
        }
        let snapshot_key = warmcache_snapshot_key(&entry.kind, &entry.dest_subdir);
        let snapshot = match warmcache_store_snapshot(depcache_root, &entry.dest_subdir) {
            Ok(Some(snapshot)) => snapshot,
            Ok(None) => {
                state.warmcache_store_snapshots.remove(&snapshot_key);
                continue;
            }
            Err(e) => {
                eprintln!(
                    "session {}: warmcache snapshot kind={} dest_subdir={}: {e}",
                    session.session, entry.kind, entry.dest_subdir
                );
                continue;
            }
        };
        let previous = state
            .warmcache_store_snapshots
            .insert(snapshot_key, snapshot.clone());
        if snapshot.file_count == 0 || previous.as_ref() != Some(&snapshot) {
            continue;
        }

        let stats = centaur_node_sync::warmcache::capture_depcache(
            client,
            depcache_root,
            &entry.dest_subdir,
            &entry.lockfile_hash,
            &entry.kind,
        );
        eprintln!(
            "event=warmcache_capture session={} kind={} lockfile_hash={} entries={} uploaded={} errors={}",
            session.atrium_session,
            stats.kind,
            entry.lockfile_hash,
            stats.entries,
            stats.uploaded,
            stats.errors
        );
        if let Some(error) = stats.error {
            eprintln!(
                "session {}: warmcache capture kind={} lockfile_hash={}: {error}",
                session.atrium_session, entry.kind, entry.lockfile_hash
            );
        }
        if stats.errors == 0 {
            state.warmcache_captured.insert(capture_key);
        }
    }
}

#[cfg(any(target_os = "linux", test))]
fn warmcache_capture_key(session: &str, kind: &str, lockfile_hash: &str) -> String {
    format!("{session}|{kind}|{lockfile_hash}")
}

#[cfg(any(target_os = "linux", test))]
fn warmcache_snapshot_key(kind: &str, dest_subdir: &str) -> String {
    format!("{kind}|{dest_subdir}")
}

#[cfg(any(target_os = "linux", test))]
fn warmcache_store_snapshot(
    depcache_root: &std::path::Path,
    dest_subdir: &str,
) -> Result<Option<centaur_node_sync::state::WarmcacheStoreSnapshot>, String> {
    if dest_subdir.starts_with('/') || dest_subdir.contains("..") {
        return Err(format!("unsafe dest_subdir {dest_subdir:?}"));
    }
    let store = depcache_root.join(dest_subdir);
    if !store.exists() {
        return Ok(None);
    }
    let mut snapshot = centaur_node_sync::state::WarmcacheStoreSnapshot {
        file_count: 0,
        total_size: 0,
        max_mtime_nanos: 0,
    };
    collect_warmcache_store_snapshot(&store, &mut snapshot)?;
    Ok(Some(snapshot))
}

#[cfg(any(target_os = "linux", test))]
fn collect_warmcache_store_snapshot(
    dir: &std::path::Path,
    snapshot: &mut centaur_node_sync::state::WarmcacheStoreSnapshot,
) -> Result<(), String> {
    let rd = std::fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in rd {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let path = entry.path();
        if ft.is_dir() {
            collect_warmcache_store_snapshot(&path, snapshot)?;
        } else if ft.is_file() {
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            snapshot.file_count += 1;
            snapshot.total_size = snapshot.total_size.saturating_add(meta.len());
            snapshot.max_mtime_nanos = snapshot.max_mtime_nanos.max(warmcache_mtime_nanos(&meta));
        }
    }
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn warmcache_mtime_nanos(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

#[cfg(any(target_os = "linux", test))]
fn should_run_local_capture(
    always_scan: bool,
    dirty: bool,
    remounted: bool,
    restored: bool,
    reconcile_due: bool,
    just_attached: bool,
) -> bool {
    always_scan || dirty || remounted || restored || reconcile_due || just_attached
}

#[cfg(target_os = "linux")]
fn main() {
    linux_daemon::main();
}

#[cfg(target_os = "linux")]
mod linux_daemon {
    use super::{
        SessionConfig, hydrate_state_if_needed, repo_worktrees, session_config_from_discovered,
        warmcache_capture_if_needed,
    };
    use centaur_node_sync::backpressure;
    use centaur_node_sync::backpressure::Budget;
    use centaur_node_sync::batch::{
        BatchEndpointState, BatchFeeds, BatchHttpClient, BatchPollError, BatchRequestSession,
        BatchSessionOutcome,
    };
    use centaur_node_sync::cas::{
        hydrate_artifact_lower_into_plan, reattach_artifact_lower_into_plan,
    };
    use centaur_node_sync::depcache::{EvictStats, evict_depcache_lru};
    use centaur_node_sync::echo::EchoGuard;
    use centaur_node_sync::eviction::{
        DEFAULT_EVICT_GRACE_SECS, DEFAULT_EVICT_HEARTBEAT_STALE_SECS,
        DEFAULT_EVICT_NO_HEARTBEAT_GRACE_SECS, DEFAULT_EVICT_RECHECK_SECS, EvictionSignals,
        EvictionThresholds, SessionEvictionState, heartbeat_mtime_nanos, manifest_age,
        manifest_mtime_nanos,
    };
    use centaur_node_sync::feeds::{ArtifactFeed, AtriumFeed};
    use centaur_node_sync::fs_linux;
    use centaur_node_sync::http_client::HttpAtriumClient;
    use centaur_node_sync::materializer::materialize_changed_sessions;
    use centaur_node_sync::overlay::RawEntry;
    use centaur_node_sync::overlay_mount::{
        OverlayMountPlan, READY_MARKER_FILE, mount_overlay, plan_overlay_mount,
        session_sibling_dirs, unmount_overlay,
    };
    use centaur_node_sync::pacing::{TickPacer, TickPacerAction};
    use centaur_node_sync::quiesce::{LeaseGate, apply_quiesced_writes};
    use centaur_node_sync::runtime::{
        AtriumClient, HarnessTranscriptKind, UpperReader, capture_sweep, credential_refresh_sweep,
        harness_transcript_sweep, inbound_sweep, materialize_profile_bundles,
        materialize_profile_bundles_from_refs, partition_entries_by_lane, profile_baseline_sweep,
        profile_candidate_sweep, sha_hex,
    };
    use centaur_node_sync::session_manifest::{
        DiscoveredSession, discover_sessions, manifest_path, state_path,
    };
    use centaur_node_sync::sse::{ChangedEvent, DirtySet, SseOutput, SseParser};
    use centaur_node_sync::state::DaemonState;
    use centaur_node_sync::watch::{DirtySessions, UpperWatcher, WatchMessage};
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::io::Read;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::time::{Duration, Instant, SystemTime};

    const WIP_FORCE_INTERVAL: Duration = Duration::from_secs(30);

    /// In-memory WIP-gate state, keyed by `(session, repo_key)`. Deliberately
    /// not persisted: losing it on restart just forces one WIP run.
    #[derive(Default)]
    struct WipGateState {
        signatures: HashMap<(String, String), u64>,
        active: HashMap<(String, String), bool>,
    }

    impl WipGateState {
        fn retain_sessions(&mut self, keep: impl Fn(&str) -> bool) {
            self.signatures.retain(|(session, _), _| keep(session));
            self.active.retain(|(session, _), _| keep(session));
        }
    }

    #[derive(Default)]
    struct DaemonArgs {
        once: bool,
        interval_secs: Option<u64>,
        overlays_root: Option<PathBuf>,
    }

    struct GlobalConfig {
        base_url: String,
        api_key: String,
        atrium_root: PathBuf,
        hydrate_artifacts: bool,
        cas_dir: PathBuf,
        depcache_root: PathBuf,
        depcache_max_bytes: u64,
        depcache_evict_enabled: bool,
        depcache_evict_every_n_ticks: u64,
        budget: Budget,
        large_threshold: u64,
        evict_heartbeat_stale: Duration,
        evict_no_heartbeat_grace: Duration,
        evict_grace: Duration,
        evict_recheck: Duration,
        gc_dirs: bool,
        stream_enabled: bool,
        reconcile_interval: Duration,
    }

    struct HardenedReader {
        upper: PathBuf,
    }

    impl UpperReader for HardenedReader {
        fn read(&self, rel: &Path) -> Option<Vec<u8>> {
            fs_linux::read_file_safe(&self.upper, rel, 3).ok()
        }

        fn open_stream<'a>(&'a self, rel: &Path) -> Option<Box<dyn std::io::Read + 'a>> {
            fs_linux::open_file_stream(&self.upper, rel)
                .ok()
                .map(|f| Box::new(f) as Box<dyn std::io::Read + 'a>)
        }
    }

    pub fn main() {
        let args = match parse_args() {
            Ok(args) => args,
            Err(error) => {
                eprintln!("centaur-node-syncd argument error: {error}");
                std::process::exit(2);
            }
        };

        let env = |k: &str| std::env::var(k).unwrap_or_default();
        let overlays_root_for_defaults = args
            .overlays_root
            .clone()
            .unwrap_or_else(|| PathBuf::from("/var/lib/centaur/overlays"));
        let interval_secs = args
            .interval_secs
            .unwrap_or_else(|| env("NODE_SYNC_INTERVAL_SECS").parse::<u64>().unwrap_or(2));
        let global = GlobalConfig {
            base_url: env("ATRIUM_BASE_URL"),
            api_key: env("ATRIUM_CAPTURE_API_KEY"),
            atrium_root: non_empty_path(&env("NODE_SYNC_ATRIUM_ROOT"), "/atrium"),
            hydrate_artifacts: env_truthy(&env("NODE_SYNC_HYDRATE_ARTIFACTS")),
            cas_dir: non_empty_pathbuf(
                &env("NODE_SYNC_CAS_DIR"),
                overlays_root_for_defaults.join("cas"),
            ),
            depcache_root: non_empty_pathbuf(
                &env("NODE_SYNC_DEPCACHE_ROOT"),
                PathBuf::from("/var/lib/centaur/depcache"),
            ),
            depcache_max_bytes: env("NODE_SYNC_DEPCACHE_MAX_BYTES")
                .parse::<u64>()
                .unwrap_or(10 * 1024 * 1024 * 1024),
            depcache_evict_enabled: env_truthy(&env("NODE_SYNC_DEPCACHE_EVICT_ENABLED")),
            depcache_evict_every_n_ticks: env("NODE_SYNC_DEPCACHE_EVICT_EVERY_N")
                .parse::<u64>()
                .unwrap_or(30)
                .max(1),
            budget: Budget {
                max_dirty_bytes: env("NODE_SYNC_DIRTY_BUDGET")
                    .parse::<u64>()
                    .unwrap_or(2 * 1024 * 1024 * 1024),
            },
            large_threshold: env("NODE_SYNC_LARGE_FILE_BYTES")
                .parse::<u64>()
                .unwrap_or(centaur_node_sync::runtime::DEFAULT_LARGE_FILE_BYTES),
            evict_heartbeat_stale: Duration::from_secs(
                env("NODE_SYNC_EVICT_HEARTBEAT_STALE_SECS")
                    .parse::<u64>()
                    .unwrap_or(DEFAULT_EVICT_HEARTBEAT_STALE_SECS),
            ),
            evict_no_heartbeat_grace: Duration::from_secs(
                env("NODE_SYNC_EVICT_NO_HEARTBEAT_GRACE_SECS")
                    .parse::<u64>()
                    .unwrap_or(DEFAULT_EVICT_NO_HEARTBEAT_GRACE_SECS),
            ),
            evict_grace: Duration::from_secs(
                env("NODE_SYNC_EVICT_GRACE_SECS")
                    .parse::<u64>()
                    .unwrap_or(DEFAULT_EVICT_GRACE_SECS),
            ),
            evict_recheck: Duration::from_secs(
                env("NODE_SYNC_EVICT_RECHECK_SECS")
                    .parse::<u64>()
                    .unwrap_or(DEFAULT_EVICT_RECHECK_SECS),
            ),
            gc_dirs: env_truthy(&env("NODE_SYNC_GC_DIRS")),
            stream_enabled: env("NODE_SYNC_STREAM_ENABLED").trim() != "0",
            reconcile_interval: Duration::from_secs(
                env("NODE_SYNC_RECONCILE_SECS").parse::<u64>().unwrap_or(15),
            ),
        };

        if let Some(overlays_root) = args.overlays_root {
            require_global_config(&global, "multi-session --overlays-root mode");
            run_multi_session(global, overlays_root, args.once, interval_secs);
        } else {
            let session = single_session_config(&global).unwrap_or_else(|missing| {
                fail_config(
                    &missing,
                    "single-session NODE_SYNC_* mode requires ATRIUM_BASE_URL, ATRIUM_CAPTURE_API_KEY, NODE_SYNC_SESSION, NODE_SYNC_UPPER, and NODE_SYNC_MERGED",
                )
            });
            require_global_config(&global, "single-session NODE_SYNC_* mode");
            run_single_session(global, session, args.once, interval_secs);
        }
    }

    fn parse_args() -> Result<DaemonArgs, String> {
        let mut parsed = DaemonArgs::default();
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--once" => parsed.once = true,
                "--interval" => {
                    let value = args
                        .next()
                        .ok_or_else(|| "--interval requires a seconds value".to_string())?;
                    parsed.interval_secs = Some(value.parse::<u64>().map_err(|_| {
                        format!(
                            "--interval requires an unsigned integer seconds value, got {value}"
                        )
                    })?);
                }
                "--overlays-root" => {
                    let value = args
                        .next()
                        .ok_or_else(|| "--overlays-root requires a path value".to_string())?;
                    if value.trim().is_empty() {
                        return Err("--overlays-root requires a non-empty path value".to_string());
                    }
                    parsed.overlays_root = Some(PathBuf::from(value));
                }
                _ => {
                    return Err(format!(
                        "unknown argument {arg}; supported flags: --once, --interval <secs>, --overlays-root <path>"
                    ));
                }
            }
        }
        Ok(parsed)
    }

    fn require_global_config(global: &GlobalConfig, mode: &str) {
        let mut missing = Vec::new();
        if global.base_url.is_empty() {
            missing.push("ATRIUM_BASE_URL".to_string());
        }
        if global.api_key.is_empty() {
            missing.push("ATRIUM_CAPTURE_API_KEY".to_string());
        }
        if !missing.is_empty() {
            fail_config(&missing, mode);
        }
    }

    fn fail_config(missing: &[String], mode: &str) -> ! {
        eprintln!(
            "centaur-node-syncd configuration error: missing {}. {mode}.",
            missing.join(", ")
        );
        std::process::exit(2);
    }

    fn non_empty_path(value: &str, default: &str) -> PathBuf {
        if value.is_empty() {
            PathBuf::from(default)
        } else {
            PathBuf::from(value)
        }
    }

    fn non_empty_pathbuf(value: &str, default: PathBuf) -> PathBuf {
        if value.is_empty() {
            default
        } else {
            PathBuf::from(value)
        }
    }

    fn env_truthy(value: &str) -> bool {
        matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true")
    }

    fn single_session_config(global: &GlobalConfig) -> Result<SessionConfig, Vec<String>> {
        let env = |k: &str| std::env::var(k).unwrap_or_default();
        let session = env("NODE_SYNC_SESSION");
        let upper_env = env("NODE_SYNC_UPPER");
        let merged_env = env("NODE_SYNC_MERGED");
        let mut missing = Vec::new();
        if global.base_url.is_empty() {
            missing.push("ATRIUM_BASE_URL".to_string());
        }
        if global.api_key.is_empty() {
            missing.push("ATRIUM_CAPTURE_API_KEY".to_string());
        }
        if session.is_empty() {
            missing.push("NODE_SYNC_SESSION".to_string());
        }
        if upper_env.is_empty() {
            missing.push("NODE_SYNC_UPPER".to_string());
        }
        if merged_env.is_empty() {
            missing.push("NODE_SYNC_MERGED".to_string());
        }
        if !missing.is_empty() {
            return Err(missing);
        }

        let state_file = {
            let configured = env("NODE_SYNC_STATE");
            if configured.is_empty() {
                PathBuf::from(format!("/var/lib/centaur/sync-state/{session}.json"))
            } else {
                PathBuf::from(configured)
            }
        };
        let repo = env("NODE_SYNC_REPO");
        let merged = PathBuf::from(merged_env);
        Ok(SessionConfig {
            atrium_session: session.clone(),
            session,
            upper: PathBuf::from(upper_env),
            merged: merged.clone(),
            harness: HarnessTranscriptKind::parse(&env("NODE_SYNC_HARNESS")),
            harness_thread_id: env("NODE_SYNC_HARNESS_THREAD_ID"),
            harness_home: env("NODE_SYNC_HARNESS_HOME"),
            flat_home: false,
            repo_worktrees: repo_worktrees(&repo, &[], &merged),
            repo_subdirs: Vec::new(),
            state_file,
        })
    }

    fn run_single_session(
        global: GlobalConfig,
        session: SessionConfig,
        once: bool,
        interval_secs: u64,
    ) {
        let lease = LeaseGate::new();
        let mut echo = EchoGuard::new();
        let mut state = DaemonState::load(&session.state_file);
        let mut wip_gate = WipGateState::default();
        let mut last_forced_wip: Option<Instant> = None;
        let mut tick: u64 = 0;

        loop {
            tick = tick.saturating_add(1);
            if let Err(e) = run_one_session(
                &global,
                &session,
                &mut state,
                &mut echo,
                &lease,
                &mut wip_gate,
                &mut last_forced_wip,
            ) {
                eprintln!("session {}: {e}", session.session);
            }
            maybe_evict_depcache(&global, tick);
            if once {
                break;
            }
            std::thread::sleep(std::time::Duration::from_secs(interval_secs));
        }
    }

    #[derive(Clone)]
    struct ActiveSession {
        config: SessionConfig,
        wip_remounted: bool,
        wip_restored: bool,
    }

    #[derive(Clone)]
    struct ProbeSession {
        session: String,
        atrium_session: String,
        profile_harness: HarnessTranscriptKind,
    }

    #[derive(Debug)]
    enum RemotePollOutcome {
        Found(RemoteFeeds),
        NotFound,
        Error,
    }

    #[derive(Debug)]
    struct RemoteFeeds {
        profile_harness: HarnessTranscriptKind,
        artifacts: Option<ArtifactFeed>,
        atrium: Option<AtriumFeed>,
        profile_bundles: Option<Vec<centaur_node_sync::runtime::BundleRef>>,
    }

    #[derive(Clone)]
    struct PollTarget {
        session: String,
        atrium_session: String,
        artifacts_since: String,
        atrium_since: String,
        profile_harness: HarnessTranscriptKind,
    }

    fn run_multi_session(
        global: GlobalConfig,
        overlays_root: PathBuf,
        once: bool,
        interval_secs: u64,
    ) {
        let lease = LeaseGate::new();
        let mut states: HashMap<String, DaemonState> = HashMap::new();
        let mut echoes: HashMap<String, EchoGuard> = HashMap::new();
        let mut mounted_overlays: HashMap<String, OverlayMountPlan> = HashMap::new();
        let mut evictions: HashMap<String, SessionEvictionState> = HashMap::new();
        let mut wip_gate = WipGateState::default();
        let mut last_forced_wip: HashMap<String, Instant> = HashMap::new();
        let batch_client = BatchHttpClient::new(&global.base_url, &global.api_key);
        let mut batch_endpoint = BatchEndpointState::default();
        let (wake_tx, wake_rx) = mpsc::channel();
        if global.stream_enabled {
            start_change_stream(&global.base_url, &global.api_key, wake_tx.clone());
        }
        let (watch_tx, watch_rx) = mpsc::channel();
        let watcher = UpperWatcher::from_env(watch_tx);
        start_watch_bridge(watch_rx, wake_tx.clone());
        let mut stream_healthy = false;
        let mut pending_wake_messages = VecDeque::new();
        let mut dirty = DirtySet::default();
        let mut local_dirty = DirtySessions::default();
        let mut watched_sessions = HashSet::new();
        let mut just_attached_sessions = HashSet::new();
        let mut last_reconcile: Option<Instant> = None;
        let mut last_local_reconcile: Option<Instant> = None;
        let mut tick: u64 = 0;

        loop {
            tick = tick.saturating_add(1);
            let now = Instant::now();
            let tick_start = now;
            let system_now = SystemTime::now();
            let mut active_sessions = Vec::new();
            let mut probe_sessions = Vec::new();
            let mut current_atrium_keys = HashSet::new();
            just_attached_sessions.clear();

            match discover_sessions(&overlays_root) {
                Ok(discovery) => {
                    for warning in discovery.warnings {
                        eprintln!("session discovery: {warning}");
                    }
                    let active: HashSet<String> = discovery
                        .sessions
                        .iter()
                        .map(|session| session.session.clone())
                        .collect();
                    cleanup_removed_overlays(&active, &mut mounted_overlays);
                    cleanup_removed_watches(&active, &mut watched_sessions, &watcher);
                    states.retain(|session, _| active.contains(session));
                    echoes.retain(|session, _| active.contains(session));
                    evictions.retain(|session, _| active.contains(session));
                    wip_gate.retain_sessions(|session| active.contains(session));
                    last_forced_wip.retain(|session, _| active.contains(session));
                    local_dirty.retain_sessions(|session| active.contains(session));

                    for discovered in discovery.sessions {
                        current_atrium_keys.insert(discovered.atrium_session.clone());
                        let manifest_path = manifest_path(&overlays_root, &discovered.session);
                        let mtime_nanos = manifest_mtime_nanos(&manifest_path);
                        let heartbeat_mtime = heartbeat_mtime_nanos(&discovered.upper);
                        let eviction = evictions.entry(discovered.session.clone()).or_default();
                        if eviction.observe_manifest_mtime(mtime_nanos) {
                            eprintln!(
                                "event=node_sync_un_evict session={} reason=manifest_mtime_changed",
                                discovered.session
                            );
                        }
                        if eviction.observe_heartbeat_mtime(heartbeat_mtime) {
                            eprintln!(
                                "event=node_sync_un_evict session={} reason=heartbeat_mtime_changed",
                                discovered.session
                            );
                        }
                        if let Some(reason) = eviction.maybe_evict(
                            EvictionSignals {
                                now,
                                heartbeat_age: manifest_age(system_now, heartbeat_mtime),
                                heartbeat_mtime_nanos: heartbeat_mtime,
                                manifest_age: manifest_age(system_now, mtime_nanos),
                                manifest_mtime_nanos: mtime_nanos,
                            },
                            EvictionThresholds {
                                heartbeat_stale: global.evict_heartbeat_stale,
                                no_heartbeat_grace: global.evict_no_heartbeat_grace,
                            },
                        ) {
                            eprintln!(
                                "event=node_sync_evict session={} reason={} heartbeat_stale_secs={} no_heartbeat_grace_secs={}",
                                discovered.session,
                                reason.as_str(),
                                global.evict_heartbeat_stale.as_secs(),
                                global.evict_no_heartbeat_grace.as_secs()
                            );
                        }
                        if eviction.is_evicted() {
                            watcher.remove_session(&discovered.session);
                            watched_sessions.remove(&discovered.session);
                            local_dirty.clear_for_scan(&discovered.session);
                            if eviction.should_probe(now, global.evict_recheck) {
                                eviction.mark_probe(now);
                                states
                                    .entry(discovered.session.clone())
                                    .or_insert_with(|| DaemonState::load(&discovered.state_file));
                                probe_sessions.push(ProbeSession {
                                    session: discovered.session.clone(),
                                    atrium_session: discovered.atrium_session.clone(),
                                    profile_harness: profile_harness_for_discovered(&discovered),
                                });
                            }
                            maybe_gc_evicted_session(
                                &global,
                                &overlays_root,
                                &discovered,
                                eviction,
                                GcSignals {
                                    now,
                                    manifest_mtime_nanos: mtime_nanos,
                                    heartbeat_mtime_nanos: heartbeat_mtime,
                                },
                                &mut mounted_overlays,
                            );
                            continue;
                        }

                        let has_active_mount = has_active_overlay_mount(
                            &discovered.manifest.merged,
                        )
                        .unwrap_or_else(|error| {
                            eprintln!("session {}: mount guard: {error}", discovered.session);
                            true
                        });
                        let mut plan =
                            match build_overlay_plan_for_discovered(&overlays_root, &discovered) {
                                Ok(plan) => plan,
                                Err(e) => {
                                    eprintln!("session {}: overlay plan: {e}", discovered.session);
                                    continue;
                                }
                            };
                        // Hydrate the artifact lower only on FIRST mount. Re-hydrating
                        // an ACTIVE lowerdir would `remove_dir_all` it out from under the
                        // live overlay: the mount keeps the old dir inode pinned, so the
                        // agent's readdir goes empty, re-materialized files never become
                        // visible, and stale content serves until the dcache drops. The
                        // mount is idempotent; the hydration must not be.
                        // "First mount" must survive a daemon restart: mounted_overlays
                        // is process-local, so a restarted daemon sees live sessions as
                        // first-seen — the node-level mount check is what protects them.
                        // On later ticks the hydrated lower must still be part of the
                        // plan: the overlay signature covers extra lowers, so a plan
                        // rebuilt without it would mismatch and remount the session
                        // WITHOUT its hydrated artifacts.
                        let hydrated_entries = if !has_active_mount
                            && !mounted_overlays.contains_key(&discovered.session)
                        {
                            hydrate_artifacts_if_enabled(
                                &global,
                                &overlays_root,
                                &discovered.session,
                                &discovered.atrium_session,
                                &mut plan,
                            )
                        } else {
                            reattach_artifact_lower_into_plan(
                                &overlays_root,
                                &discovered.session,
                                &mut plan,
                            );
                            Vec::new()
                        };
                        let wip_remounted = !has_active_mount
                            || mounted_overlays.get(&discovered.session) != Some(&plan);
                        let mounted = match mount_overlay(plan, Some(discovered.manifest.agent_uid))
                        {
                            Ok(plan) => plan,
                            Err(e) => {
                                eprintln!("session {}: overlay mount: {e}", discovered.session);
                                continue;
                            }
                        };
                        let session = session_config_from_discovered(&discovered, &mounted);
                        mounted_overlays.insert(discovered.session.clone(), mounted);
                        if watcher.is_enabled()
                            && (wip_remounted || !watched_sessions.contains(&session.session))
                        {
                            let result = watcher.add_session(&session.session, &session.upper);
                            watched_sessions.insert(session.session.clone());
                            if result.attached {
                                just_attached_sessions.insert(session.session.clone());
                            }
                        }
                        let first_seen = !states.contains_key(&session.session);
                        if first_seen {
                            eprintln!(
                                "session {}: scan upper={}",
                                session.session,
                                session.upper.display()
                            );
                        }
                        let state = states
                            .entry(session.session.clone())
                            .or_insert_with(|| DaemonState::load(&session.state_file));
                        // Seed sync state from what hydration just materialized: the
                        // lower holds exactly these ledger versions, so record them
                        // BEFORE the agent (or the first feed poll) can act on the
                        // paths. Idempotent vs the feed-driven seeding — keeps newest.
                        for entry in &hydrated_entries {
                            state.note_hydrated_version(
                                &entry.path,
                                entry.seq,
                                Some(entry.sha.clone()),
                            );
                        }
                        let wip_restored = prepare_session_before_remote(&global, &session, state);
                        active_sessions.push(ActiveSession {
                            config: session,
                            wip_remounted,
                            wip_restored,
                        });
                    }
                }
                Err(e) => eprintln!("session discovery: {e}"),
            }

            drain_wake_messages(
                &wake_rx,
                &mut pending_wake_messages,
                &mut stream_healthy,
                &mut dirty,
                &mut local_dirty,
                &current_atrium_keys,
            );
            let dirty_by_key = dirty.drain_for(current_atrium_keys.iter().map(String::as_str));
            let reconcile_due = stream_healthy
                && last_reconcile
                    .is_none_or(|last| now.duration_since(last) >= global.reconcile_interval);
            let local_reconcile_due = last_local_reconcile
                .is_none_or(|last| now.duration_since(last) >= global.reconcile_interval);
            let full_remote_poll = !global.stream_enabled || !stream_healthy || reconcile_due;
            if reconcile_due {
                last_reconcile = Some(now);
            }
            if local_reconcile_due {
                last_local_reconcile = Some(now);
            }
            let poll_targets = select_poll_targets(
                &active_sessions,
                &probe_sessions,
                &states,
                &dirty_by_key,
                full_remote_poll,
            );
            let remote_outcomes = poll_remote_targets(
                &global,
                &batch_client,
                &mut batch_endpoint,
                now,
                &poll_targets,
            );

            for probe in probe_sessions {
                apply_probe_outcome(
                    &probe,
                    remote_outcomes.get(&probe.atrium_session),
                    evictions.entry(probe.session.clone()).or_default(),
                );
            }

            for active in active_sessions {
                let ActiveSession {
                    config: session,
                    wip_remounted,
                    wip_restored,
                } = active;
                let state = states
                    .entry(session.session.clone())
                    .or_insert_with(|| DaemonState::load(&session.state_file));
                let echo = echoes.entry(session.session.clone()).or_default();
                let eviction = evictions.entry(session.session.clone()).or_default();
                let mut client = HttpAtriumClient::new(
                    &global.base_url,
                    &global.api_key,
                    &session.atrium_session,
                );
                let wip_backstop_elapsed = last_forced_wip
                    .get(&session.session)
                    .is_none_or(|last| now.duration_since(*last) >= WIP_FORCE_INTERVAL);
                let mut atrium_feed = None;
                match remote_outcomes.get(&session.atrium_session) {
                    Some(RemotePollOutcome::Found(feeds)) => {
                        if eviction.record_found() {
                            eprintln!(
                                "event=node_sync_un_evict session={} reason=server_found",
                                session.session
                            );
                        }
                        apply_profile_feed(&session, state, &client, feeds);
                        if let Some(artifacts) = feeds.artifacts.as_ref() {
                            apply_inbound_feed(
                                &session,
                                state,
                                echo,
                                &lease,
                                &mut client,
                                artifacts,
                            );
                        }
                        atrium_feed = feeds.atrium.clone();
                    }
                    Some(RemotePollOutcome::NotFound) => {
                        eviction.record_not_found();
                    }
                    Some(RemotePollOutcome::Error) | None => {}
                }

                let force_wip = centaur_node_sync::wip::should_force_wip(
                    wip_remounted,
                    wip_restored,
                    wip_backstop_elapsed,
                );
                let had_local_dirty = local_dirty.contains(&session.session);
                // force_wip participates in the scan gate, and the WIP force
                // timer only resets when the scan (and thus WIP) actually ran —
                // otherwise an event-quiet session would reset the 30s backstop
                // forever without ever running it.
                let should_scan = super::should_run_local_capture(
                    watcher.is_always_scan(&session.session),
                    had_local_dirty,
                    wip_remounted,
                    wip_restored,
                    local_reconcile_due,
                    just_attached_sessions.contains(&session.session),
                ) || force_wip;
                if should_scan {
                    let cleared_dirty = local_dirty.clear_for_scan(&session.session);
                    let scan_ok = run_local_capture(
                        &global,
                        &session,
                        state,
                        echo,
                        &mut client,
                        force_wip,
                        &mut wip_gate,
                    );
                    if !scan_ok && cleared_dirty {
                        local_dirty.mark(session.session.clone());
                    }
                    if force_wip {
                        last_forced_wip.insert(session.session.clone(), now);
                    }
                }
                if let Some(atrium) = atrium_feed.as_ref() {
                    apply_atrium_feed(&global, &session, state, &client, atrium);
                }
                if let Err(e) = state.save(&session.state_file) {
                    eprintln!(
                        "session {}: save state {}: {e}",
                        session.session,
                        session.state_file.display()
                    );
                }
            }

            maybe_evict_depcache(&global, tick);
            if once {
                break;
            }
            if wait_for_next_tick(
                &wake_rx,
                &mut pending_wake_messages,
                &mut stream_healthy,
                &mut local_dirty,
                &current_atrium_keys,
                tick_start,
                Duration::from_secs(interval_secs),
            ) {
                stream_healthy = false;
            }
        }
    }

    fn profile_harness_for_session(session: &SessionConfig) -> HarnessTranscriptKind {
        session.harness.unwrap_or(HarnessTranscriptKind::Codex)
    }

    fn profile_harness_for_discovered(discovered: &DiscoveredSession) -> HarnessTranscriptKind {
        discovered
            .manifest
            .harness
            .as_deref()
            .and_then(HarnessTranscriptKind::parse)
            .unwrap_or(HarnessTranscriptKind::Codex)
    }

    fn prepare_session_before_remote(
        global: &GlobalConfig,
        session: &SessionConfig,
        state: &mut DaemonState,
    ) -> bool {
        let mut client =
            HttpAtriumClient::new(&global.base_url, &global.api_key, &session.atrium_session);
        hydrate_state_if_needed(session, state, &mut client);
        refresh_upper_sha(session, state);
        restore_repo_wip(session, state)
    }

    fn run_local_capture(
        global: &GlobalConfig,
        session: &SessionConfig,
        state: &mut DaemonState,
        echo: &mut EchoGuard,
        client: &mut HttpAtriumClient,
        force_wip: bool,
        wip_gate: &mut WipGateState,
    ) -> bool {
        let raw_entries = outbound(global, session, state, echo, client);
        let scan_ok = raw_entries.is_some();
        warmcache_capture_if_needed(client, session, state, &global.depcache_root);
        capture_repo_wip(
            session,
            state,
            client,
            raw_entries.as_deref(),
            force_wip,
            wip_gate,
        );
        scan_ok
    }

    fn apply_profile_feed(
        session: &SessionConfig,
        state: &mut DaemonState,
        client: &HttpAtriumClient,
        feeds: &RemoteFeeds,
    ) {
        let Some(bundles) = feeds.profile_bundles.clone() else {
            return;
        };
        let harness = feeds.profile_harness;
        let harness_home = if session.harness_home.is_empty() {
            PathBuf::from(harness.default_home_rel())
        } else {
            PathBuf::from(&session.harness_home)
        };
        let out = materialize_profile_bundles_from_refs(
            client,
            harness,
            &harness_home,
            &session.merged,
            &mut state.materialized_profile_bundles,
            bundles,
            write_profile_bundle_file,
        );
        if out.written > 0 {
            println!(
                "session {}: profile bundles: materialized {} files for {}",
                session.session,
                out.written,
                harness.atrium_harness()
            );
        }
        for (path, error) in &out.errors {
            eprintln!(
                "session {}: profile bundle materialize {path}: {error}",
                session.session
            );
        }
    }

    fn apply_inbound_feed(
        session: &SessionConfig,
        state: &mut DaemonState,
        echo: &mut EchoGuard,
        lease: &LeaseGate,
        client: &mut HttpAtriumClient,
        feed: &ArtifactFeed,
    ) {
        if !feed.changes.is_empty() {
            apply_inbound_changes(session, state, echo, lease, client, &feed.changes);
        }
        state.cursor = feed.next_cursor.clone();
    }

    fn apply_atrium_feed(
        global: &GlobalConfig,
        session: &SessionConfig,
        state: &mut DaemonState,
        client: &HttpAtriumClient,
        feed: &AtriumFeed,
    ) {
        let atrium_root = super::scoped_atrium_root(&global.atrium_root, &session.session);
        match materialize_changed_sessions(
            client,
            &atrium_root,
            &state.atrium_cursor,
            feed.session_ids.clone(),
            feed.next_cursor.clone(),
        ) {
            Ok(next) => {
                if next != state.atrium_cursor {
                    println!("atrium materializer: cursor={next}");
                }
                state.atrium_cursor = next;
            }
            Err(e) => eprintln!("atrium materializer: {e}"),
        }
    }

    fn select_poll_targets(
        active_sessions: &[ActiveSession],
        probe_sessions: &[ProbeSession],
        states: &HashMap<String, DaemonState>,
        dirty_by_key: &HashMap<String, centaur_node_sync::sse::DirtyFeeds>,
        full_remote_poll: bool,
    ) -> Vec<PollTarget> {
        let mut out = Vec::new();
        for active in active_sessions {
            let session = &active.config;
            if !full_remote_poll && !dirty_by_key.contains_key(&session.atrium_session) {
                continue;
            }
            let Some(state) = states.get(&session.session) else {
                continue;
            };
            out.push(PollTarget {
                session: session.session.clone(),
                atrium_session: session.atrium_session.clone(),
                artifacts_since: state.cursor.clone(),
                atrium_since: state.atrium_cursor.clone(),
                profile_harness: profile_harness_for_session(session),
            });
        }
        for probe in probe_sessions {
            let Some(state) = states.get(&probe.session) else {
                continue;
            };
            out.push(PollTarget {
                session: probe.session.clone(),
                atrium_session: probe.atrium_session.clone(),
                artifacts_since: state.cursor.clone(),
                atrium_since: state.atrium_cursor.clone(),
                profile_harness: probe.profile_harness,
            });
        }
        out
    }

    fn poll_remote_targets(
        global: &GlobalConfig,
        batch_client: &BatchHttpClient,
        batch_endpoint: &mut BatchEndpointState,
        now: Instant,
        targets: &[PollTarget],
    ) -> HashMap<String, RemotePollOutcome> {
        if targets.is_empty() {
            return HashMap::new();
        }
        if batch_endpoint.should_try(now) {
            match poll_batch_targets(batch_client, targets) {
                Ok(outcomes) => {
                    batch_endpoint.record_success();
                    return outcomes;
                }
                Err(BatchPollError::Unsupported(_)) => {
                    batch_endpoint.record_unsupported(now);
                    eprintln!(
                        "node-sync batch changes endpoint unsupported; falling back to legacy GETs"
                    );
                }
                Err(error) => {
                    eprintln!("node-sync batch poll: {error}");
                    return targets
                        .iter()
                        .map(|target| (target.atrium_session.clone(), RemotePollOutcome::Error))
                        .collect();
                }
            }
        }
        poll_legacy_targets(global, targets)
    }

    fn poll_batch_targets(
        batch_client: &BatchHttpClient,
        targets: &[PollTarget],
    ) -> Result<HashMap<String, RemotePollOutcome>, BatchPollError> {
        let requests = targets
            .iter()
            .map(|target| BatchRequestSession {
                key: target.atrium_session.clone(),
                artifacts_since: target.artifacts_since.clone(),
                atrium_since: target.atrium_since.clone(),
                profile_harness: target.profile_harness.atrium_harness().to_string(),
            })
            .collect::<Vec<_>>();
        let mut out = HashMap::new();
        for outcome in batch_client.poll(&requests)? {
            match outcome {
                BatchSessionOutcome::Found(feeds) => {
                    out.insert(
                        feeds.key.clone(),
                        RemotePollOutcome::Found(batch_feeds(feeds)),
                    );
                }
                BatchSessionOutcome::NotFound { key } => {
                    out.insert(key, RemotePollOutcome::NotFound);
                }
            }
        }
        Ok(out)
    }

    fn batch_feeds(feeds: BatchFeeds) -> RemoteFeeds {
        RemoteFeeds {
            profile_harness: HarnessTranscriptKind::parse(&feeds.profile_harness)
                .unwrap_or(HarnessTranscriptKind::Codex),
            artifacts: Some(feeds.artifacts),
            atrium: Some(feeds.atrium),
            profile_bundles: Some(feeds.profile_bundles),
        }
    }

    fn poll_legacy_targets(
        global: &GlobalConfig,
        targets: &[PollTarget],
    ) -> HashMap<String, RemotePollOutcome> {
        let mut out = HashMap::new();
        for target in targets {
            out.insert(
                target.atrium_session.clone(),
                poll_legacy_target(global, target),
            );
        }
        out
    }

    fn poll_legacy_target(global: &GlobalConfig, target: &PollTarget) -> RemotePollOutcome {
        let mut client =
            HttpAtriumClient::new(&global.base_url, &global.api_key, &target.atrium_session);
        let mut not_found = 0usize;
        let mut successes = 0usize;

        let artifacts = match client.poll_changes_feed(&target.artifacts_since) {
            Ok(feed) => {
                successes += 1;
                Some(feed)
            }
            Err(error) if error.is_not_found() => {
                not_found += 1;
                None
            }
            Err(error) => {
                eprintln!("session {}: poll: {error}", target.session);
                None
            }
        };
        let atrium = match client.atrium_changes_feed(&target.atrium_since) {
            Ok(feed) => {
                successes += 1;
                Some(feed)
            }
            Err(error) if error.is_not_found() => {
                not_found += 1;
                None
            }
            Err(error) => {
                eprintln!("session {}: atrium changes: {error}", target.session);
                None
            }
        };
        let profile_bundles =
            match client.get_profile_bundles_feed(target.profile_harness.atrium_harness()) {
                Ok(feed) => {
                    successes += 1;
                    Some(feed)
                }
                Err(error) if error.is_not_found() => {
                    not_found += 1;
                    None
                }
                Err(error) => {
                    eprintln!("session {}: profile bundles: {error}", target.session);
                    None
                }
            };

        if not_found == 3 {
            RemotePollOutcome::NotFound
        } else if successes > 0 {
            RemotePollOutcome::Found(RemoteFeeds {
                profile_harness: target.profile_harness,
                artifacts,
                atrium,
                profile_bundles,
            })
        } else {
            RemotePollOutcome::Error
        }
    }

    fn apply_probe_outcome(
        probe: &ProbeSession,
        outcome: Option<&RemotePollOutcome>,
        eviction: &mut SessionEvictionState,
    ) {
        match outcome {
            Some(RemotePollOutcome::Found(_)) => {
                if eviction.record_found() {
                    eprintln!(
                        "event=node_sync_un_evict session={} reason=server_found",
                        probe.session
                    );
                }
            }
            Some(RemotePollOutcome::NotFound) => {
                eviction.record_not_found();
            }
            Some(RemotePollOutcome::Error) | None => {}
        }
    }

    /// The liveness observations GC needs, bundled to keep the helper's
    /// signature within clippy's argument budget.
    struct GcSignals {
        now: Instant,
        manifest_mtime_nanos: Option<u128>,
        heartbeat_mtime_nanos: Option<u128>,
    }

    #[derive(Clone, Copy)]
    enum PathKind {
        Dir,
        File,
    }

    fn maybe_gc_evicted_session(
        global: &GlobalConfig,
        overlays_root: &Path,
        discovered: &DiscoveredSession,
        eviction: &SessionEvictionState,
        signals: GcSignals,
        mounted_overlays: &mut HashMap<String, OverlayMountPlan>,
    ) {
        if !global.gc_dirs
            || !eviction.gc_eligible(
                signals.now,
                signals.manifest_mtime_nanos,
                signals.heartbeat_mtime_nanos,
                global.evict_grace,
            )
        {
            return;
        }
        if let Err(error) =
            unmount_evicted_overlay_if_needed(overlays_root, discovered, mounted_overlays)
        {
            eprintln!("session {}: gc unmount: {error}", discovered.session);
            return;
        }
        // Reclaim every path the session created. Removing only `overlays/<session>`
        // + its manifest leaked the overlayfs work/lower siblings — which live under
        // the host root, outside `overlays_root` — forever; the composed-repos lower
        // holds MB–GB of materialized checkouts. `session_sibling_dirs` is the single
        // source of truth shared with `plan_overlay_mount`, so cleanup can't drift
        // from creation again. NotFound is expected (unused lower layout, already-gone
        // state file) and silently ignored.
        let session = &discovered.session;
        let remove = |kind: PathKind, path: &Path| {
            let result = match kind {
                PathKind::Dir => std::fs::remove_dir_all(path),
                PathKind::File => std::fs::remove_file(path),
            };
            match result {
                Ok(()) => eprintln!(
                    "event=node_sync_gc session={session} path={} reason=evicted_grace_elapsed",
                    path.display()
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    eprintln!("session {session}: gc remove {}: {error}", path.display())
                }
            }
        };
        remove(PathKind::Dir, &overlays_root.join(session));
        for sibling in session_sibling_dirs(overlays_root, session) {
            remove(PathKind::Dir, &sibling);
        }
        remove(PathKind::File, &manifest_path(overlays_root, session));
        remove(PathKind::File, &state_path(overlays_root, session));
    }

    fn unmount_evicted_overlay_if_needed(
        overlays_root: &Path,
        discovered: &DiscoveredSession,
        mounted_overlays: &mut HashMap<String, OverlayMountPlan>,
    ) -> Result<(), String> {
        if let Some(plan) = mounted_overlays.remove(&discovered.session) {
            return unmount_overlay(&plan);
        }
        if !has_active_overlay_mount(&discovered.manifest.merged)? {
            return Ok(());
        }
        let plan = build_overlay_plan_for_discovered(overlays_root, discovered)?;
        unmount_overlay(&plan)
    }

    fn has_active_overlay_mount(merged: &Path) -> Result<bool, String> {
        let target = merged
            .canonicalize()
            .unwrap_or_else(|_| merged.to_path_buf())
            .to_string_lossy()
            .into_owned();
        let mounts = match std::fs::read_to_string("/proc/mounts") {
            Ok(mounts) => mounts,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(format!("read /proc/mounts: {error}")),
        };
        for line in mounts.lines() {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 3 {
                continue;
            }
            if fields[2] == "overlay" && unescape_proc_mounts(fields[1]) == target {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn unescape_proc_mounts(value: &str) -> String {
        let mut out = String::with_capacity(value.len());
        let bytes = value.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'\\'
                && i + 3 < bytes.len()
                && let Ok(octal) = u8::from_str_radix(&value[i + 1..i + 4], 8)
            {
                out.push(octal as char);
                i += 4;
                continue;
            }
            out.push(bytes[i] as char);
            i += 1;
        }
        out
    }

    #[derive(Debug)]
    enum StreamMessage {
        Healthy,
        Unhealthy,
        Changed(ChangedEvent),
    }

    #[derive(Debug)]
    enum WakeMessage {
        Stream(StreamMessage),
        LocalDirty(String),
    }

    fn start_change_stream(base_url: &str, api_key: &str, tx: mpsc::Sender<WakeMessage>) {
        let base_url = base_url.trim_end_matches('/').to_string();
        let api_key = api_key.to_string();
        std::thread::spawn(move || stream_reader_loop(base_url, api_key, tx));
    }

    fn start_watch_bridge(rx: mpsc::Receiver<WatchMessage>, tx: mpsc::Sender<WakeMessage>) {
        std::thread::spawn(move || {
            while let Ok(message) = rx.recv() {
                match message {
                    WatchMessage::Dirty(session) => {
                        if tx.send(WakeMessage::LocalDirty(session)).is_err() {
                            return;
                        }
                    }
                }
            }
        });
    }

    fn stream_reader_loop(base_url: String, api_key: String, tx: mpsc::Sender<WakeMessage>) {
        let url = format!("{base_url}/api/internal/changes/stream");
        let agent = ureq::AgentBuilder::new()
            .timeout_read(Duration::from_secs(46))
            .build();
        let mut backoff = Duration::from_secs(1);
        loop {
            let response = agent.get(&url).set("x-api-key", &api_key).call();
            match response {
                Ok(response) => {
                    let _ = tx.send(WakeMessage::Stream(StreamMessage::Healthy));
                    backoff = Duration::from_secs(1);
                    let mut parser = SseParser::default();
                    let mut reader = response.into_reader();
                    let mut buf = [0u8; 4096];
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                for output in parser.push(&buf[..n]) {
                                    forward_sse_output(&tx, output);
                                }
                            }
                            Err(error) => {
                                eprintln!("node-sync changes stream read: {error}");
                                break;
                            }
                        }
                    }
                    for output in parser.finish() {
                        forward_sse_output(&tx, output);
                    }
                    let _ = tx.send(WakeMessage::Stream(StreamMessage::Unhealthy));
                }
                Err(error) => {
                    eprintln!("node-sync changes stream connect: {error}");
                    let _ = tx.send(WakeMessage::Stream(StreamMessage::Unhealthy));
                }
            }
            std::thread::sleep(backoff);
            backoff = (backoff * 2).min(Duration::from_secs(15));
        }
    }

    fn forward_sse_output(tx: &mpsc::Sender<WakeMessage>, output: SseOutput) {
        match output {
            SseOutput::Hello { .. } => {
                let _ = tx.send(WakeMessage::Stream(StreamMessage::Healthy));
            }
            SseOutput::Changed(event) => {
                let _ = tx.send(WakeMessage::Stream(StreamMessage::Changed(event)));
            }
            SseOutput::Malformed { event, error } => {
                eprintln!("node-sync changes stream malformed {event}: {error}");
            }
        }
    }

    fn drain_wake_messages(
        rx: &mpsc::Receiver<WakeMessage>,
        pending: &mut VecDeque<WakeMessage>,
        stream_healthy: &mut bool,
        dirty: &mut DirtySet,
        local_dirty: &mut DirtySessions,
        current_atrium_keys: &HashSet<String>,
    ) {
        while let Some(message) = pending.pop_front() {
            handle_wake_message(
                message,
                stream_healthy,
                dirty,
                local_dirty,
                current_atrium_keys,
            );
        }
        while let Ok(message) = rx.try_recv() {
            handle_wake_message(
                message,
                stream_healthy,
                dirty,
                local_dirty,
                current_atrium_keys,
            );
        }
    }

    fn handle_wake_message(
        message: WakeMessage,
        stream_healthy: &mut bool,
        dirty: &mut DirtySet,
        local_dirty: &mut DirtySessions,
        current_atrium_keys: &HashSet<String>,
    ) {
        match message {
            WakeMessage::Stream(StreamMessage::Healthy) => *stream_healthy = true,
            WakeMessage::Stream(StreamMessage::Unhealthy) => *stream_healthy = false,
            WakeMessage::Stream(StreamMessage::Changed(event)) => {
                dirty.mark_changed(&event, current_atrium_keys.iter().map(String::as_str));
            }
            WakeMessage::LocalDirty(session) => {
                local_dirty.mark(session);
            }
        }
    }

    fn wait_for_next_tick(
        rx: &mpsc::Receiver<WakeMessage>,
        pending: &mut VecDeque<WakeMessage>,
        stream_healthy: &mut bool,
        local_dirty: &mut DirtySessions,
        current_atrium_keys: &HashSet<String>,
        tick_start: Instant,
        interval: Duration,
    ) -> bool {
        let deadline = tick_start + interval;
        let mut pacer = TickPacer::default();
        loop {
            let decision = pacer.next(Instant::now(), tick_start, deadline);
            let TickPacerAction::WaitMore(timeout) = decision.action else {
                return false;
            };
            match rx.recv_timeout(timeout) {
                Ok(message) => {
                    let made_dirty = handle_wait_wake_message(
                        message,
                        pending,
                        stream_healthy,
                        local_dirty,
                        current_atrium_keys,
                    );
                    let decision =
                        pacer.observe_message(Instant::now(), tick_start, deadline, made_dirty);
                    if matches!(decision.action, TickPacerAction::TickNow) {
                        return false;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let decision = pacer.observe_timeout(Instant::now(), tick_start, deadline);
                    if matches!(decision.action, TickPacerAction::TickNow) {
                        return false;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    *stream_healthy = false;
                    let decision = pacer.observe_disconnected(Instant::now(), deadline);
                    if let TickPacerAction::WaitMore(timeout) = decision.action {
                        std::thread::sleep(timeout);
                    }
                    return decision.stream_disconnected;
                }
            }
        }
    }

    fn handle_wait_wake_message(
        message: WakeMessage,
        pending: &mut VecDeque<WakeMessage>,
        stream_healthy: &mut bool,
        local_dirty: &mut DirtySessions,
        current_atrium_keys: &HashSet<String>,
    ) -> bool {
        match message {
            WakeMessage::Stream(StreamMessage::Healthy) => {
                *stream_healthy = true;
                false
            }
            WakeMessage::Stream(StreamMessage::Unhealthy) => {
                *stream_healthy = false;
                false
            }
            WakeMessage::Stream(StreamMessage::Changed(event)) => {
                let made_dirty = changed_event_targets_current_session(&event, current_atrium_keys);
                pending.push_back(WakeMessage::Stream(StreamMessage::Changed(event)));
                made_dirty
            }
            WakeMessage::LocalDirty(session) => local_dirty.mark(session),
        }
    }

    fn changed_event_targets_current_session(
        event: &ChangedEvent,
        current_atrium_keys: &HashSet<String>,
    ) -> bool {
        if let Some(key) = event.key.as_deref().filter(|key| !key.trim().is_empty()) {
            current_atrium_keys.contains(key)
        } else {
            !current_atrium_keys.is_empty()
        }
    }

    fn maybe_evict_depcache(global: &GlobalConfig, tick: u64) {
        if !global.depcache_evict_enabled
            || !tick.is_multiple_of(global.depcache_evict_every_n_ticks)
        {
            return;
        }
        let stats = evict_depcache_lru(&global.depcache_root, global.depcache_max_bytes);
        log_depcache_evict_if_deleted(stats, global.depcache_max_bytes);
    }

    fn log_depcache_evict_if_deleted(stats: EvictStats, cap: u64) {
        if stats.deleted_files == 0 {
            return;
        }
        eprintln!(
            "event=depcache_evict scanned_bytes={} cap={} deleted_files={} freed_bytes={}",
            stats.scanned_bytes, cap, stats.deleted_files, stats.freed_bytes
        );
    }

    /// Returns the (path, seq, sha) entries that actually materialized so the
    /// caller can seed the session's sync state once it is loaded.
    fn hydrate_artifacts_if_enabled(
        global: &GlobalConfig,
        overlays_root: &Path,
        session: &str,
        atrium_session: &str,
        plan: &mut OverlayMountPlan,
    ) -> Vec<centaur_node_sync::cas::CasHydrateEntry> {
        if !global.hydrate_artifacts || global.base_url.is_empty() || global.api_key.is_empty() {
            return Vec::new();
        }

        let mut client = HttpAtriumClient::new(&global.base_url, &global.api_key, atrium_session);
        match hydrate_artifact_lower_into_plan(
            &mut client,
            &global.cas_dir,
            overlays_root,
            session,
            plan,
        ) {
            Ok(outcome) => {
                println!(
                    "session {session}: hydrate: {} reflinked, {} fetched, {} errors",
                    outcome.reflinked,
                    outcome.fetched,
                    outcome.errors.len()
                );
                outcome.hydrated
            }
            Err(e) => {
                eprintln!("session {session}: hydrate error: {e}");
                Vec::new()
            }
        }
    }

    fn build_overlay_plan_for_discovered(
        overlays_root: &Path,
        discovered: &DiscoveredSession,
    ) -> Result<OverlayMountPlan, String> {
        let mut plan = plan_overlay_mount(
            overlays_root,
            &discovered.session,
            &discovered.manifest.merged,
            &discovered.manifest.repo,
            &discovered.manifest.repos,
            None,
        )?;
        if !discovered
            .manifest
            .generic_home_lower
            .as_os_str()
            .is_empty()
        {
            plan.extra_lowers
                .push(discovered.manifest.generic_home_lower.clone());
        }
        if !discovered.manifest.context_source.as_os_str().is_empty() {
            plan.context_source = Some(discovered.manifest.context_source.clone());
        }
        Ok(plan)
    }

    fn cleanup_removed_overlays(
        active: &HashSet<String>,
        mounted_overlays: &mut HashMap<String, OverlayMountPlan>,
    ) {
        let removed = mounted_overlays
            .keys()
            .filter(|session| !active.contains(*session))
            .cloned()
            .collect::<Vec<_>>();
        for session in removed {
            if let Some(plan) = mounted_overlays.remove(&session)
                && let Err(e) = unmount_overlay(&plan)
            {
                eprintln!("session {session}: overlay unmount: {e}");
            }
        }
    }

    fn cleanup_removed_watches(
        active: &HashSet<String>,
        watched_sessions: &mut HashSet<String>,
        watcher: &UpperWatcher,
    ) {
        let removed = watched_sessions
            .iter()
            .filter(|session| !active.contains(*session))
            .cloned()
            .collect::<Vec<_>>();
        for session in removed {
            watcher.remove_session(&session);
            watched_sessions.remove(&session);
        }
    }

    fn run_one_session(
        global: &GlobalConfig,
        session: &SessionConfig,
        state: &mut DaemonState,
        echo: &mut EchoGuard,
        lease: &LeaseGate,
        wip_gate: &mut WipGateState,
        last_forced_wip: &mut Option<Instant>,
    ) -> Result<(), String> {
        let now = Instant::now();
        let mut client =
            HttpAtriumClient::new(&global.base_url, &global.api_key, &session.atrium_session);

        materialize_profile_bundles_for_session(session, state, &client);
        hydrate_state_if_needed(session, state, &mut client);
        refresh_upper_sha(session, state);
        let wip_restored = restore_repo_wip(session, state);
        // Inbound adoption needs seeded state: without it every remote row looks
        // like an unknown local and gets adopted (re-downloaded + copied up).
        // Outbound stays on — new-file captures are safe unseeded, and an edited
        // pre-existing path is server-guarded (409 base_required) until seeded.
        if state.hydrated {
            inbound(session, state, echo, lease, &mut client);
        }
        let raw_entries = outbound(global, session, state, echo, &mut client);
        warmcache_capture_if_needed(&mut client, session, state, &global.depcache_root);
        let wip_backstop_elapsed =
            last_forced_wip.is_none_or(|last| now.duration_since(last) >= WIP_FORCE_INTERVAL);
        let force_wip =
            centaur_node_sync::wip::should_force_wip(false, wip_restored, wip_backstop_elapsed);
        capture_repo_wip(
            session,
            state,
            &mut client,
            raw_entries.as_deref(),
            force_wip,
            wip_gate,
        );
        if force_wip {
            *last_forced_wip = Some(now);
        }
        materialize_atrium(global, session, state, &client);
        state
            .save(&session.state_file)
            .map_err(|e| format!("save state {}: {e}", session.state_file.display()))
    }

    fn refresh_upper_sha(session: &SessionConfig, state: &mut DaemonState) {
        let reader = HardenedReader {
            upper: session.upper.clone(),
        };
        for (path, ls) in state.paths.iter_mut() {
            ls.upper_sha = match reader.read(&PathBuf::from(path)) {
                Some(bytes) => Some(sha_hex(&bytes)),
                None => ls.base_sha.clone(),
            };
        }
    }

    fn inbound(
        session: &SessionConfig,
        state: &mut DaemonState,
        echo: &mut EchoGuard,
        lease: &LeaseGate,
        client: &mut HttpAtriumClient,
    ) {
        match client.poll_changes(&state.cursor) {
            Ok((changes, next)) => {
                apply_inbound_changes(session, state, echo, lease, client, &changes);
                state.cursor = next;
            }
            Err(e) => eprintln!("session {}: poll: {e}", session.session),
        }
    }

    fn apply_inbound_changes(
        session: &SessionConfig,
        state: &mut DaemonState,
        echo: &mut EchoGuard,
        lease: &LeaseGate,
        client: &mut HttpAtriumClient,
        changes: &[(String, centaur_node_sync::adopt::RemoteChange)],
    ) {
        if changes.is_empty() {
            return;
        }
        use centaur_node_sync::manifest::{
            ManifestApply, apply_manifest_atomic, partition_manifests,
        };

        let plan = inbound_sweep(changes, state.locals(), echo, client);

        let mut group_size: HashMap<String, usize> = HashMap::new();
        for (_p, rc) in changes {
            if let Some(group_id) = &rc.group_id {
                *group_size.entry(group_id.clone()).or_default() += 1;
            }
        }
        let tagged = plan
            .to_write
            .into_iter()
            .map(|(path, seq, bytes)| {
                let (group_id, sha) = changes
                    .iter()
                    .find(|(p, rc)| p == &path && rc.seq == seq)
                    .map(|(_, rc)| (rc.group_id.clone(), rc.sha.clone()))
                    .unwrap_or((None, None));
                (path, seq, group_id, sha, bytes)
            })
            .collect();
        let part = partition_manifests(tagged, &group_size);

        let mut adopted = 0usize;
        let (written, loose_deferred) = apply_quiesced_writes(part.loose, lease, |rel, bytes| {
            write_through_merged(&session.merged, rel, bytes)
        });
        for (path, seq) in &written {
            let sha = changes
                .iter()
                .find(|(p, rc)| p == path && rc.seq == *seq)
                .and_then(|(_, rc)| rc.sha.clone());
            state.sync_to(path, *seq, sha, true);
            adopted += 1;
        }

        let mut group_deferred = 0usize;
        for manifest in &part.manifests {
            match apply_manifest_atomic(
                manifest,
                lease,
                |rel, bytes| stage_through_merged(&session.merged, rel, bytes),
                |rel| commit_through_merged(&session.merged, rel),
                |rel| abort_staged(&session.merged, rel),
            ) {
                ManifestApply::Applied(entries) => {
                    for (path, seq, sha) in entries {
                        state.sync_to(&path, seq, sha, true);
                        adopted += 1;
                    }
                }
                ManifestApply::Deferred(reason) => {
                    group_deferred += 1;
                    eprintln!(
                        "session {}: group {} deferred: {reason}",
                        session.session, manifest.group_id
                    );
                }
            }
        }
        println!(
            "session {}: inbound: {adopted} adopted ({} groups), {} loose-deferred, {group_deferred} group-deferred, {} incomplete, {} reconcile, {} conflicts",
            session.session,
            part.manifests.len(),
            loose_deferred.len(),
            part.deferred_incomplete.len(),
            plan.to_reconcile.len(),
            plan.conflicts.len()
        );
        for (path, seq) in &plan.conflicts {
            eprintln!(
                "session {}: CONFLICT at {path} seq {seq} -- needs resolution",
                session.session
            );
        }
    }

    fn outbound(
        global: &GlobalConfig,
        session: &SessionConfig,
        state: &mut DaemonState,
        echo: &mut EchoGuard,
        client: &mut HttpAtriumClient,
    ) -> Option<Vec<RawEntry>> {
        match fs_linux::read_upper_entries(&session.upper) {
            Ok(entries) => {
                let entries = entries
                    .into_iter()
                    .filter(|entry| entry.rel_path.as_path() != Path::new(READY_MARKER_FILE))
                    .collect::<Vec<_>>();
                let reader = HardenedReader {
                    upper: session.upper.clone(),
                };
                let harness_lane_homes = harness_lane_homes(&session.harness_home);
                let partitioned =
                    partition_entries_by_lane(&entries, &harness_lane_homes, &session.repo_subdirs);
                eprintln!(
                    "session {}: entry lanes: artifact={}, harness_state={}, denied_dropped={}, total={}",
                    session.session,
                    partitioned.artifact_entries.len(),
                    partitioned.harness_entries.len(),
                    partitioned.denied_count,
                    entries.len()
                );
                let dirty =
                    backpressure::dirty_bytes_excluding_large(&entries, global.large_threshold);
                if global.budget.over(dirty) {
                    eprintln!(
                        "session {}: BACKPRESSURE: upper dirty {dirty}B OVER budget {}B -- harness should pause the agent",
                        session.session, global.budget.max_dirty_bytes
                    );
                } else if global.budget.near(dirty) {
                    eprintln!(
                        "session {}: backpressure: upper dirty {dirty}B near budget {}B (headroom {}B)",
                        session.session,
                        global.budget.max_dirty_bytes,
                        global.budget.headroom(dirty)
                    );
                }

                let base_seqs = state.base_seqs();
                let out = capture_sweep(
                    &partitioned.artifact_entries,
                    &base_seqs,
                    &reader,
                    echo,
                    client,
                    global.large_threshold,
                );
                for (path, seq, sha) in out.captured.iter().chain(out.streamed.iter()) {
                    state.sync_to(path, *seq, Some(sha.clone()), false);
                }
                println!(
                    "session {}: capture: {} upserts ({} streamed), {} deletes, {} echo-skipped, {} secret-skipped, {} errors",
                    session.session,
                    out.captured.len() + out.streamed.len(),
                    out.streamed.len(),
                    out.deleted.len(),
                    out.skipped_echo.len(),
                    out.skipped_secret,
                    out.errors.len()
                );
                for (path, error) in &out.errors {
                    eprintln!("session {}: capture error {path}: {error}", session.session);
                }

                for (harness, harness_home) in harnesses_to_capture(session) {
                    let harness_key = harness.atrium_harness().to_string();
                    if !state
                        .profile_baseline_sent
                        .get(&harness_key)
                        .copied()
                        .unwrap_or(false)
                    {
                        let out = profile_baseline_sweep(
                            &partitioned.harness_entries,
                            &reader,
                            client,
                            harness,
                            &harness_home,
                        );
                        for warning in &out.warnings {
                            eprintln!(
                                "session {}: profile baseline warning: {warning}",
                                session.session
                            );
                        }
                        if out.uploaded {
                            state
                                .profile_baseline_sent
                                .insert(harness_key.clone(), true);
                            println!(
                                "session {}: profile baseline: uploaded {} candidates, {} bundles for {}",
                                session.session,
                                out.candidate_count,
                                out.bundle_count,
                                harness.atrium_harness()
                            );
                        } else if let Some(error) = out.error {
                            eprintln!("session {}: profile baseline: {error}", session.session);
                        }
                    }

                    let out = harness_transcript_sweep(
                        &partitioned.harness_entries,
                        &reader,
                        client,
                        harness,
                        &harness_home,
                        &session.harness_thread_id,
                        session.flat_home,
                    );
                    if let Some((path, bytes)) = out.captured {
                        println!(
                            "session {}: harness transcript: captured {} bytes from {}",
                            session.session,
                            bytes,
                            path.display()
                        );
                        if out.state_bundle_files > 0 {
                            println!(
                                "session {}: harness state bundle: uploaded {} files for {}",
                                session.session,
                                out.state_bundle_files,
                                harness.atrium_harness()
                            );
                        }
                    }
                    if let Some(error) = out.error {
                        eprintln!("session {}: harness transcript: {error}", session.session);
                    }

                    let out = profile_candidate_sweep(
                        &partitioned.harness_entries,
                        &reader,
                        client,
                        harness,
                        &harness_home,
                    );
                    for warning in &out.warnings {
                        eprintln!(
                            "session {}: profile candidates warning: {warning}",
                            session.session
                        );
                    }
                    if out.uploaded {
                        println!(
                            "session {}: profile candidates: uploaded {} candidates, {} exclusions for {}",
                            session.session,
                            out.candidate_count,
                            out.excluded_count,
                            harness.atrium_harness()
                        );
                    } else if let Some(error) = out.error {
                        eprintln!("session {}: profile candidates: {error}", session.session);
                    }

                    let out = credential_refresh_sweep(
                        &reader,
                        client,
                        harness,
                        &harness_home,
                        state
                            .provider_credential_hashes
                            .get(&harness_key)
                            .map(String::as_str),
                    );
                    if out.uploaded {
                        if let Some(hash) = out.current_hash {
                            state.provider_credential_hashes.insert(harness_key, hash);
                        }
                        println!(
                            "session {}: provider credential refresh: uploaded for {}",
                            session.session,
                            harness.atrium_harness()
                        );
                    } else if let Some(error) = out.error {
                        eprintln!(
                            "session {}: provider credential refresh for {}: {error}",
                            session.session,
                            harness.atrium_harness()
                        );
                    }
                }
                Some(entries)
            }
            Err(e) => {
                eprintln!(
                    "session {}: scan {}: {e}",
                    session.session,
                    session.upper.display()
                );
                None
            }
        }
    }

    fn materialize_profile_bundles_for_session(
        session: &SessionConfig,
        state: &mut DaemonState,
        client: &HttpAtriumClient,
    ) {
        for (harness, harness_home) in harnesses_to_capture(session) {
            let out = materialize_profile_bundles(
                client,
                harness,
                &harness_home,
                &session.merged,
                &mut state.materialized_profile_bundles,
                write_profile_bundle_file,
            );
            if out.written > 0 {
                println!(
                    "session {}: profile bundles: materialized {} files for {}",
                    session.session,
                    out.written,
                    harness.atrium_harness()
                );
            }
            for (path, error) in &out.errors {
                eprintln!(
                    "session {}: profile bundle materialize {path}: {error}",
                    session.session
                );
            }
        }
    }

    fn harness_lane_homes(configured_harness_home: &str) -> Vec<PathBuf> {
        let mut homes = vec![
            PathBuf::from(HarnessTranscriptKind::Claude.default_home_rel()),
            PathBuf::from(HarnessTranscriptKind::Codex.default_home_rel()),
        ];
        if !configured_harness_home.is_empty() {
            let configured = PathBuf::from(configured_harness_home);
            if !homes.iter().any(|home| home == &configured) {
                homes.push(configured);
            }
        }
        homes
    }

    fn harnesses_to_capture(session: &SessionConfig) -> Vec<(HarnessTranscriptKind, PathBuf)> {
        match session.harness {
            Some(kind) => vec![(
                kind,
                if session.harness_home.is_empty() {
                    PathBuf::from(kind.default_home_rel())
                } else {
                    PathBuf::from(&session.harness_home)
                },
            )],
            None => [HarnessTranscriptKind::Claude, HarnessTranscriptKind::Codex]
                .into_iter()
                .map(|kind| (kind, PathBuf::from(kind.default_home_rel())))
                .collect(),
        }
    }

    fn restore_repo_wip(session: &SessionConfig, state: &mut DaemonState) -> bool {
        let mut attempted = false;
        for repo in &session.repo_worktrees {
            let latest_path = centaur_node_sync::wip::latest_path(&repo.key);
            let latest_file = session.merged.join(&latest_path);
            let bytes = match std::fs::read(&latest_file) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            let manifest =
                match serde_json::from_slice::<centaur_node_sync::wip::WipSnapshotManifest>(&bytes)
                {
                    Ok(manifest) => manifest,
                    Err(e) => {
                        eprintln!(
                            "session {}: wip restore {}: parse latest {}: {e}",
                            session.session,
                            repo.key,
                            latest_file.display()
                        );
                        continue;
                    }
                };
            if state
                .wip_restore_attempted
                .get(&repo.key)
                .is_some_and(|snapshot| snapshot == &manifest.snapshot_id)
            {
                continue;
            }
            attempted = true;
            match centaur_node_sync::wip::restore_snapshot(&repo.path, &session.merged, &manifest) {
                Ok(()) => println!(
                    "session {}: wip restore: applied {} snapshot {}",
                    session.session, repo.key, manifest.snapshot_id
                ),
                Err(e) => eprintln!("session {}: wip restore {}: {e}", session.session, repo.key),
            }
            state
                .wip_restore_attempted
                .insert(repo.key.clone(), manifest.snapshot_id);
        }
        attempted
    }

    fn capture_repo_wip(
        session: &SessionConfig,
        state: &mut DaemonState,
        client: &mut HttpAtriumClient,
        raw_entries: Option<&[RawEntry]>,
        force_wip: bool,
        wip_gate: &mut WipGateState,
    ) {
        for repo in &session.repo_worktrees {
            let gate_key = (session.session.clone(), repo.key.clone());
            let current_signature = raw_entries.and_then(|entries| {
                let prefix = repo.path.strip_prefix(&session.merged).ok()?;
                Some(centaur_node_sync::wip::repo_signature(entries, prefix))
            });
            let decision = centaur_node_sync::wip::decide_wip_capture(
                wip_gate.signatures.get(&gate_key).copied(),
                current_signature,
                force_wip,
            );
            let active = decision.should_capture;
            if let Some(previous_active) = wip_gate.active.insert(gate_key.clone(), active)
                && previous_active != active
            {
                eprintln!(
                    "session {}: wip gate {} for {} ({:?})",
                    session.session,
                    if active { "active" } else { "idle" },
                    repo.key,
                    decision.reason
                );
            }
            if !decision.should_capture {
                continue;
            }
            match centaur_node_sync::wip::capture_wip(&repo.path) {
                Ok(patch) => {
                    let out = centaur_node_sync::runtime::wip_sweep(
                        &repo.key,
                        &patch,
                        &state.base_seqs(),
                        client,
                    );
                    for (path, seq, sha) in &out.captured {
                        state.sync_to(path, *seq, Some(sha.clone()), false);
                    }
                    for (path, seq) in &out.deleted {
                        state.sync_to(path, *seq, None, false);
                    }
                    if !out.captured.is_empty() || !out.deleted.is_empty() {
                        println!(
                            "session {}: wip: {} captured, {} deleted for {}",
                            session.session,
                            out.captured.len(),
                            out.deleted.len(),
                            repo.key
                        );
                    }
                    for (path, error) in &out.errors {
                        eprintln!("session {}: wip error {path}: {error}", session.session);
                    }
                    // Record the signature only on success: a failed capture_wip must
                    // keep retrying every tick (today's behavior), not wait for the
                    // next repo change or the 30s backstop.
                    if let Some(signature) = current_signature {
                        wip_gate.signatures.insert(gate_key, signature);
                    }
                }
                Err(e) => eprintln!(
                    "session {}: wip {}: {e}",
                    session.session,
                    repo.path.display()
                ),
            }
        }
    }

    fn materialize_atrium(
        global: &GlobalConfig,
        session: &SessionConfig,
        state: &mut DaemonState,
        client: &HttpAtriumClient,
    ) {
        let atrium_root = super::scoped_atrium_root(&global.atrium_root, &session.session);
        match centaur_node_sync::materialize_once(client, &atrium_root, &state.atrium_cursor) {
            Ok(next) => {
                if next != state.atrium_cursor {
                    println!("atrium materializer: cursor={next}");
                }
                state.atrium_cursor = next;
            }
            Err(e) => eprintln!("atrium materializer: {e}"),
        }
    }

    fn write_through_merged(merged: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
        use std::os::unix::fs::chown;
        let dst = merged.join(rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = dst.with_extension("nodesync.tmp");
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        let _ = chown(&tmp, Some(1001), Some(1001));
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o664));
        }
        std::fs::rename(&tmp, &dst).map_err(|e| e.to_string())
    }

    fn write_profile_bundle_file(dst: &Path, bytes: &[u8], executable: bool) -> Result<(), String> {
        use std::os::unix::fs::chown;
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = dst.with_extension("profile-bundle.tmp");
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        let _ = chown(&tmp, Some(1001), Some(1001));
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if executable { 0o775 } else { 0o664 };
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode));
        }
        std::fs::rename(&tmp, dst).map_err(|e| e.to_string())
    }

    fn staged_tmp(merged: &Path, rel: &str) -> PathBuf {
        let mut s = merged.join(rel).into_os_string();
        s.push(".nodesync.tmp");
        PathBuf::from(s)
    }

    fn stage_through_merged(merged: &Path, rel: &str, bytes: &[u8]) -> Result<(), String> {
        use std::os::unix::fs::chown;
        let tmp = staged_tmp(merged, rel);
        if let Some(parent) = tmp.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        let _ = chown(&tmp, Some(1001), Some(1001));
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o664));
        }
        Ok(())
    }

    fn commit_through_merged(merged: &Path, rel: &str) -> Result<(), String> {
        std::fs::rename(staged_tmp(merged, rel), merged.join(rel)).map_err(|e| e.to_string())
    }

    fn abort_staged(merged: &Path, rel: &str) {
        let _ = std::fs::remove_file(staged_tmp(merged, rel));
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("centaur-node-syncd runs on linux nodes only");
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;
    use centaur_node_sync::adopt::{RemoteChange, RemoteStatus};
    use centaur_node_sync::cas::WarmcacheManifestEntry;
    use centaur_node_sync::overlay_mount::{LowerKind, LowerSource, plan_overlay_mount};
    use centaur_node_sync::runtime::AtriumClient;
    use centaur_node_sync::session_manifest::{DiscoveredSession, RepoMount, SessionManifest};
    use centaur_node_sync::state::DaemonState;
    use centaur_node_sync::warmcache::{
        WarmcacheReceipt, WarmcacheReceiptEntry, warmcache_receipt_path, write_warmcache_receipt,
    };
    use std::path::{Path, PathBuf};

    #[derive(Default)]
    struct FakeWarmcacheCaptureClient {
        uploaded: Vec<String>,
        registered: Vec<(String, String, Vec<WarmcacheManifestEntry>)>,
    }

    impl AtriumClient for FakeWarmcacheCaptureClient {
        fn post_capture(&mut self, _: &str, _: u64, _: &[u8]) -> Result<u64, String> {
            unreachable!()
        }

        fn post_delete(&mut self, _: &str, _: u64) -> Result<u64, String> {
            unreachable!()
        }

        fn fetch_bytes(&mut self, _: &str, _: u64) -> Result<Vec<u8>, String> {
            unreachable!()
        }

        fn put_cache_blob(&mut self, sha: &str, _: &[u8]) -> Result<(), String> {
            self.uploaded.push(sha.to_string());
            Ok(())
        }

        fn register_cache_manifest(
            &mut self,
            hash: &str,
            kind: &str,
            entries: &[WarmcacheManifestEntry],
        ) -> Result<(), String> {
            self.registered
                .push((hash.to_string(), kind.to_string(), entries.to_vec()));
            Ok(())
        }

        fn atrium_changes(&self, since: &str) -> Result<(Vec<String>, String), String> {
            Ok((vec![], since.to_string()))
        }

        fn atrium_doc(&self, _: &str, _: &str) -> Result<Vec<u8>, String> {
            unreachable!()
        }
    }

    struct FlakyFeedClient {
        fail: bool,
        rows: Vec<(String, RemoteChange)>,
    }

    impl AtriumClient for FlakyFeedClient {
        fn post_capture(&mut self, _: &str, _: u64, _: &[u8]) -> Result<u64, String> {
            unreachable!("state-hydration tests do not capture")
        }

        fn post_delete(&mut self, _: &str, _: u64) -> Result<u64, String> {
            unreachable!("state-hydration tests do not delete")
        }

        fn fetch_bytes(&mut self, _: &str, _: u64) -> Result<Vec<u8>, String> {
            unreachable!("state-hydration tests do not fetch bytes")
        }

        fn poll_changes(
            &mut self,
            cursor: &str,
        ) -> Result<(Vec<(String, RemoteChange)>, String), String> {
            if self.fail {
                return Err("simulated feed outage (429)".to_string());
            }
            if self.rows.is_empty() {
                return Ok((vec![], cursor.to_string()));
            }
            Ok((std::mem::take(&mut self.rows), "9.9".to_string()))
        }

        fn atrium_changes(&self, since: &str) -> Result<(Vec<String>, String), String> {
            Ok((vec![], since.to_string()))
        }

        fn atrium_doc(&self, _: &str, _: &str) -> Result<Vec<u8>, String> {
            Ok(Vec::new())
        }
    }

    #[test]
    fn hydrate_state_retries_after_poll_error_instead_of_forfeiting_seeding() {
        let dir = std::env::temp_dir().join(format!("hydrate-state-it-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut session = warmcache_test_session();
        session.state_file = dir.join("state.json");
        let mut state = DaemonState::load(&session.state_file);
        let mut client = FlakyFeedClient {
            fail: true,
            rows: vec![(
                "shared/doc.md".to_string(),
                RemoteChange {
                    seq: 5,
                    sha: Some("sha5".to_string()),
                    status: RemoteStatus::Normal,
                    group_id: None,
                },
            )],
        };

        // Feed outage on the first tick: seeding must NOT be forfeited.
        hydrate_state_if_needed(&session, &mut state, &mut client);
        assert!(
            !state.hydrated,
            "a failed drain must not mark the state hydrated"
        );
        assert!(state.locals().is_empty());

        // Next tick the feed recovers: the drain resumes and seeds.
        client.fail = false;
        hydrate_state_if_needed(&session, &mut state, &mut client);
        assert!(state.hydrated);
        assert_eq!(state.locals().get("shared/doc.md").unwrap().base_seq, 5);
        assert_eq!(state.cursor, "9.9");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn warmcache_test_session() -> SessionConfig {
        SessionConfig {
            session: "local-session".to_string(),
            atrium_session: "surface:atrium-session".to_string(),
            upper: PathBuf::from("/upper"),
            merged: PathBuf::from("/merged"),
            harness: None,
            harness_thread_id: String::new(),
            harness_home: String::new(),
            flat_home: false,
            repo_subdirs: Vec::new(),
            repo_worktrees: Vec::new(),
            state_file: PathBuf::from("/state.json"),
        }
    }

    fn write_test_receipt(depcache: &Path, session: &SessionConfig, hit: bool) {
        write_warmcache_receipt(
            depcache,
            &WarmcacheReceipt {
                session: session.atrium_session.clone(),
                entries: vec![WarmcacheReceiptEntry {
                    repo: "acme/app".to_string(),
                    git_ref: "main".to_string(),
                    kind: "pnpm".to_string(),
                    dest_subdir: "pnpm-store".to_string(),
                    lockfile_hash: "lock123".to_string(),
                    hit,
                    errors: 0,
                }],
            },
        )
        .unwrap();
    }

    #[test]
    fn scoped_atrium_root_is_scoped_under_viewer_session() {
        assert_eq!(
            scoped_atrium_root(Path::new("/var/lib/centaur/atrium"), "asbx-test"),
            PathBuf::from("/var/lib/centaur/atrium/asbx-test")
        );
    }

    #[test]
    fn local_capture_gate_scans_on_any_backstop_or_dirty_reason() {
        assert!(!should_run_local_capture(
            false, false, false, false, false, false
        ));
        for reason in 0..6 {
            let mut flags = [false; 6];
            flags[reason] = true;
            assert!(should_run_local_capture(
                flags[0], flags[1], flags[2], flags[3], flags[4], flags[5]
            ));
        }
    }

    #[test]
    fn multi_repo_scan_upper_comes_from_overlay_plan_not_composed_lower() {
        let overlays_root = Path::new("/var/lib/centaur/overlays");
        let session = "sess-multi";
        let repos = vec![
            RepoMount {
                repo: "acme/foo".to_string(),
                r#ref: None,
                subdir: None,
                resolved_sha: None,
                cache_path: None,
                private: false,
                cache_scope: None,
            },
            RepoMount {
                repo: "acme/bar".to_string(),
                r#ref: None,
                subdir: None,
                resolved_sha: None,
                cache_path: None,
                private: false,
                cache_scope: None,
            },
        ];
        let mounted = plan_overlay_mount(
            overlays_root,
            session,
            Path::new("/run/centaur/merged/sess-multi"),
            "",
            &repos,
            None,
        )
        .unwrap();

        assert_eq!(
            mounted.lower,
            LowerSource {
                path: PathBuf::from("/var/lib/centaur/overlay-lower/sess-multi.repos"),
                kind: LowerKind::ComposedRepos,
            }
        );

        let discovered = DiscoveredSession {
            session: session.to_string(),
            atrium_session: "surface:sess-multi".to_string(),
            upper: mounted.lower.path.clone(),
            state_file: PathBuf::from("/var/lib/centaur/overlays/.sessions/sess-multi.state.json"),
            manifest: SessionManifest {
                session: session.to_string(),
                atrium_session: "surface:sess-multi".to_string(),
                merged: PathBuf::from("/run/centaur/merged/sess-multi"),
                harness: Some("codex".to_string()),
                harness_thread_id: "thread-123".to_string(),
                harness_home: ".codex".to_string(),
                flat_home: false,
                generic_home_lower: PathBuf::new(),
                context_source: PathBuf::new(),
                repo: String::new(),
                repos,
                agent_uid: 1001,
            },
        };

        let session_config = session_config_from_discovered(&discovered, &mounted);

        assert_eq!(session_config.session, session);
        assert_eq!(session_config.atrium_session, "surface:sess-multi");
        assert_eq!(
            session_config.upper,
            PathBuf::from("/var/lib/centaur/overlays/sess-multi")
        );
        assert_ne!(session_config.upper, mounted.lower.path);
        assert_eq!(
            session_config.merged,
            PathBuf::from("/run/centaur/merged/sess-multi")
        );
        assert_eq!(
            session_config.harness,
            Some(centaur_node_sync::runtime::HarnessTranscriptKind::Codex)
        );
        assert_eq!(session_config.harness_thread_id, "thread-123");
        assert_eq!(session_config.harness_home, ".codex");
        assert!(!session_config.flat_home);
        // Repos now nest owner-scoped under repos/<owner>/<repo>.
        assert_eq!(
            session_config.repo_subdirs,
            vec![
                PathBuf::from("repos/acme/foo"),
                PathBuf::from("repos/acme/bar")
            ]
        );
        assert_eq!(
            session_config.repo_worktrees,
            vec![
                RepoWorktree {
                    key: "repos_acme_foo".to_string(),
                    path: PathBuf::from("/run/centaur/merged/sess-multi/repos/acme/foo"),
                },
                RepoWorktree {
                    key: "repos_acme_bar".to_string(),
                    path: PathBuf::from("/run/centaur/merged/sess-multi/repos/acme/bar"),
                },
            ]
        );
        assert_eq!(
            session_config.state_file,
            PathBuf::from("/var/lib/centaur/overlays/.sessions/sess-multi.state.json")
        );
    }

    #[test]
    fn single_repo_wip_uses_merged_workspace_not_lower_repo() {
        let overlays_root = Path::new("/var/lib/centaur/overlays");
        let session = "sess-single";
        let mounted = plan_overlay_mount(
            overlays_root,
            session,
            Path::new("/run/centaur/merged/sess-single"),
            "/var/lib/centaur/repos/sess-single",
            &[],
            None,
        )
        .unwrap();
        let discovered = DiscoveredSession {
            session: session.to_string(),
            atrium_session: String::new(),
            upper: mounted.lower.path.clone(),
            state_file: PathBuf::from("/var/lib/centaur/overlays/.sessions/sess-single.state.json"),
            manifest: SessionManifest {
                session: session.to_string(),
                atrium_session: String::new(),
                merged: PathBuf::from("/run/centaur/merged/sess-single"),
                harness: Some("codex".to_string()),
                harness_thread_id: String::new(),
                harness_home: ".codex".to_string(),
                flat_home: false,
                generic_home_lower: PathBuf::new(),
                context_source: PathBuf::new(),
                repo: "/var/lib/centaur/repos/sess-single".to_string(),
                repos: vec![],
                agent_uid: 1001,
            },
        };

        let session_config = session_config_from_discovered(&discovered, &mounted);

        assert_eq!(
            session_config.repo_worktrees,
            vec![RepoWorktree {
                key: "sess-single".to_string(),
                path: PathBuf::from("/run/centaur/merged/sess-single"),
            }]
        );
    }

    #[test]
    fn warmcache_capture_fires_for_miss_once_store_settles_and_records_key() {
        let tmp = tempfile::tempdir().unwrap();
        let depcache = tmp.path().join("depcache");
        std::fs::create_dir_all(depcache.join("pnpm-store/react")).unwrap();
        std::fs::write(depcache.join("pnpm-store/react/package.json"), b"react").unwrap();
        let session = warmcache_test_session();
        write_test_receipt(&depcache, &session, false);
        let mut state = centaur_node_sync::state::DaemonState::default();
        let mut client = FakeWarmcacheCaptureClient::default();

        warmcache_capture_if_needed(&mut client, &session, &mut state, &depcache);
        assert!(client.registered.is_empty(), "first snapshot only observes");

        warmcache_capture_if_needed(&mut client, &session, &mut state, &depcache);
        assert_eq!(client.registered.len(), 1);
        assert_eq!(client.uploaded.len(), 1);
        assert!(state.warmcache_captured.contains(&warmcache_capture_key(
            &session.atrium_session,
            "pnpm",
            "lock123"
        )));

        warmcache_capture_if_needed(&mut client, &session, &mut state, &depcache);
        assert_eq!(client.registered.len(), 1, "captured key is not retried");
    }

    #[test]
    fn warmcache_capture_does_not_fire_while_store_is_changing() {
        let tmp = tempfile::tempdir().unwrap();
        let depcache = tmp.path().join("depcache");
        std::fs::create_dir_all(depcache.join("pnpm-store")).unwrap();
        std::fs::write(depcache.join("pnpm-store/pkg.tgz"), b"v1").unwrap();
        let session = warmcache_test_session();
        write_test_receipt(&depcache, &session, false);
        let mut state = centaur_node_sync::state::DaemonState::default();
        let mut client = FakeWarmcacheCaptureClient::default();

        warmcache_capture_if_needed(&mut client, &session, &mut state, &depcache);
        std::fs::write(depcache.join("pnpm-store/pkg.tgz"), b"v2 changed").unwrap();
        warmcache_capture_if_needed(&mut client, &session, &mut state, &depcache);

        assert!(client.registered.is_empty());
        assert!(client.uploaded.is_empty());
    }

    #[test]
    fn warmcache_capture_does_not_fire_for_hit_receipt_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let depcache = tmp.path().join("depcache");
        std::fs::create_dir_all(depcache.join("pnpm-store")).unwrap();
        std::fs::write(depcache.join("pnpm-store/pkg.tgz"), b"already cached").unwrap();
        let session = warmcache_test_session();
        write_test_receipt(&depcache, &session, true);
        let mut state = centaur_node_sync::state::DaemonState::default();
        let mut client = FakeWarmcacheCaptureClient::default();

        warmcache_capture_if_needed(&mut client, &session, &mut state, &depcache);
        warmcache_capture_if_needed(&mut client, &session, &mut state, &depcache);

        assert!(client.registered.is_empty());
        assert!(client.uploaded.is_empty());
    }

    #[test]
    fn warmcache_capture_missing_or_garbage_receipt_is_safe_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let depcache = tmp.path().join("depcache");
        let session = warmcache_test_session();
        let mut state = centaur_node_sync::state::DaemonState::default();
        let mut client = FakeWarmcacheCaptureClient::default();

        warmcache_capture_if_needed(&mut client, &session, &mut state, &depcache);
        assert!(client.registered.is_empty());

        let receipt_path = warmcache_receipt_path(&depcache, &session.atrium_session);
        std::fs::create_dir_all(receipt_path.parent().unwrap()).unwrap();
        std::fs::write(receipt_path, b"{not-json").unwrap();
        warmcache_capture_if_needed(&mut client, &session, &mut state, &depcache);

        assert!(client.registered.is_empty());
        assert!(client.uploaded.is_empty());
    }
}
