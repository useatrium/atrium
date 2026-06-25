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
//!      NODE_SYNC_LARGE_FILE_BYTES.
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

#[cfg(target_os = "linux")]
fn main() {
    linux_daemon::main();
}

#[cfg(target_os = "linux")]
mod linux_daemon {
    use super::{SessionConfig, repo_name, session_config_from_discovered};
    use centaur_node_sync::backpressure;
    use centaur_node_sync::backpressure::Budget;
    use centaur_node_sync::cas::hydrate_artifact_lower_into_plan;
    use centaur_node_sync::echo::EchoGuard;
    use centaur_node_sync::fs_linux;
    use centaur_node_sync::http_client::HttpAtriumClient;
    use centaur_node_sync::materialize_once;
    use centaur_node_sync::overlay_mount::{
        OverlayMountPlan, READY_MARKER_FILE, mount_overlay, plan_overlay_mount, unmount_overlay,
    };
    use centaur_node_sync::quiesce::{LeaseGate, apply_quiesced_writes};
    use centaur_node_sync::runtime::{
        AtriumClient, HarnessTranscriptKind, UpperReader, capture_sweep, harness_transcript_sweep,
        inbound_sweep, partition_entries_by_lane, sha_hex,
    };
    use centaur_node_sync::session_manifest::discover_sessions;
    use centaur_node_sync::state::DaemonState;
    use std::collections::{HashMap, HashSet};
    use std::path::{Path, PathBuf};

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
        budget: Budget,
        large_threshold: u64,
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
            budget: Budget {
                max_dirty_bytes: env("NODE_SYNC_DIRTY_BUDGET")
                    .parse::<u64>()
                    .unwrap_or(2 * 1024 * 1024 * 1024),
            },
            large_threshold: env("NODE_SYNC_LARGE_FILE_BYTES")
                .parse::<u64>()
                .unwrap_or(centaur_node_sync::runtime::DEFAULT_LARGE_FILE_BYTES),
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

        loop {
            if let Err(e) = run_one_session(&global, &session, &mut state, &mut echo, &lease) {
                eprintln!("session {}: {e}", session.session);
            }
            if once {
                break;
            }
            std::thread::sleep(std::time::Duration::from_secs(interval_secs));
        }
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

        loop {
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
                    states.retain(|session, _| active.contains(session));
                    echoes.retain(|session, _| active.contains(session));

                    for discovered in discovery.sessions {
                        let mut plan = match plan_overlay_mount(
                            &overlays_root,
                            &discovered.session,
                            &discovered.manifest.merged,
                            &discovered.manifest.repo,
                            &discovered.manifest.repos,
                            None,
                        ) {
                            Ok(plan) => plan,
                            Err(e) => {
                                eprintln!("session {}: overlay plan: {e}", discovered.session);
                                continue;
                            }
                        };
                        // Hydrate the artifact lower only on FIRST mount. Re-hydrating
                        // every scan would `remove_dir_all` the artifact-lower out from
                        // under the live overlay (it is an active lowerdir), emptying the
                        // agent's view. The mount is idempotent; the hydration must not be.
                        if !mounted_overlays.contains_key(&discovered.session) {
                            hydrate_artifacts_if_enabled(
                                &global,
                                &overlays_root,
                                &discovered.session,
                                &mut plan,
                            );
                        }
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
                        let echo = echoes.entry(session.session.clone()).or_default();
                        if let Err(e) = run_one_session(&global, &session, state, echo, &lease) {
                            eprintln!("session {}: {e}", session.session);
                        }
                    }
                }
                Err(e) => eprintln!("session discovery: {e}"),
            }

            if once {
                break;
            }
            std::thread::sleep(std::time::Duration::from_secs(interval_secs));
        }
    }

    fn hydrate_artifacts_if_enabled(
        global: &GlobalConfig,
        overlays_root: &Path,
        session: &str,
        plan: &mut OverlayMountPlan,
    ) {
        if !global.hydrate_artifacts || global.base_url.is_empty() || global.api_key.is_empty() {
            return;
        }

        let mut client = HttpAtriumClient::new(&global.base_url, &global.api_key, session);
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
            }
            Err(e) => {
                eprintln!("session {session}: hydrate error: {e}");
            }
        }
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

    fn run_one_session(
        global: &GlobalConfig,
        session: &SessionConfig,
        state: &mut DaemonState,
        echo: &mut EchoGuard,
        lease: &LeaseGate,
    ) -> Result<(), String> {
        let mut client = HttpAtriumClient::new(&global.base_url, &global.api_key, &session.session);

        hydrate_state_if_needed(session, state, &mut client);
        refresh_upper_sha(session, state);
        restore_repo_wip(session, state);
        inbound(session, state, echo, lease, &mut client);
        outbound(global, session, state, echo, &mut client);
        capture_repo_wip(session, state, &mut client);
        materialize_atrium(global, session, state, &client);
        state
            .save(&session.state_file)
            .map_err(|e| format!("save state {}: {e}", session.state_file.display()))
    }

    fn hydrate_state_if_needed(
        session: &SessionConfig,
        state: &mut DaemonState,
        client: &mut HttpAtriumClient,
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
                    eprintln!("session {}: hydrate poll: {e}", session.session);
                    break;
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
                if !changes.is_empty() {
                    use centaur_node_sync::manifest::{
                        ManifestApply, apply_manifest_atomic, partition_manifests,
                    };

                    let plan = inbound_sweep(&changes, state.locals(), echo, client);

                    let mut group_size: HashMap<String, usize> = HashMap::new();
                    for (_p, rc) in &changes {
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
                    let (written, loose_deferred) =
                        apply_quiesced_writes(part.loose, lease, |rel, bytes| {
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
                state.cursor = next;
            }
            Err(e) => eprintln!("session {}: poll: {e}", session.session),
        }
    }

    fn outbound(
        global: &GlobalConfig,
        session: &SessionConfig,
        state: &mut DaemonState,
        echo: &mut EchoGuard,
        client: &mut HttpAtriumClient,
    ) {
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
                    } else if let Some(error) = out.error {
                        eprintln!("session {}: harness transcript: {error}", session.session);
                    }
                }
            }
            Err(e) => eprintln!(
                "session {}: scan {}: {e}",
                session.session,
                session.upper.display()
            ),
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

    fn restore_repo_wip(session: &SessionConfig, state: &mut DaemonState) {
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
    }

    fn capture_repo_wip(
        session: &SessionConfig,
        state: &mut DaemonState,
        client: &mut HttpAtriumClient,
    ) {
        for repo in &session.repo_worktrees {
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
        match materialize_once(client, &atrium_root, &state.atrium_cursor) {
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
    use centaur_node_sync::overlay_mount::{LowerKind, LowerSource, plan_overlay_mount};
    use centaur_node_sync::session_manifest::{DiscoveredSession, RepoMount, SessionManifest};
    use std::path::{Path, PathBuf};

    #[test]
    fn scoped_atrium_root_is_scoped_under_viewer_session() {
        assert_eq!(
            scoped_atrium_root(Path::new("/var/lib/centaur/atrium"), "asbx-test"),
            PathBuf::from("/var/lib/centaur/atrium/asbx-test")
        );
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
            },
            RepoMount {
                repo: "acme/bar".to_string(),
                r#ref: None,
                subdir: None,
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
            upper: mounted.lower.path.clone(),
            state_file: PathBuf::from("/var/lib/centaur/overlays/.sessions/sess-multi.state.json"),
            manifest: SessionManifest {
                session: session.to_string(),
                merged: PathBuf::from("/run/centaur/merged/sess-multi"),
                harness: Some("codex".to_string()),
                harness_thread_id: "thread-123".to_string(),
                harness_home: ".codex".to_string(),
                flat_home: false,
                repo: String::new(),
                repos,
                agent_uid: 1001,
            },
        };

        let session_config = session_config_from_discovered(&discovered, &mounted);

        assert_eq!(session_config.session, session);
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
        assert_eq!(
            session_config.repo_subdirs,
            vec![PathBuf::from("foo"), PathBuf::from("bar")]
        );
        assert_eq!(
            session_config.repo_worktrees,
            vec![
                RepoWorktree {
                    key: "foo".to_string(),
                    path: PathBuf::from("/run/centaur/merged/sess-multi/foo"),
                },
                RepoWorktree {
                    key: "bar".to_string(),
                    path: PathBuf::from("/run/centaur/merged/sess-multi/bar"),
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
            upper: mounted.lower.path.clone(),
            state_file: PathBuf::from("/var/lib/centaur/overlays/.sessions/sess-single.state.json"),
            manifest: SessionManifest {
                session: session.to_string(),
                merged: PathBuf::from("/run/centaur/merged/sess-single"),
                harness: Some("codex".to_string()),
                harness_thread_id: String::new(),
                harness_home: ".codex".to_string(),
                flat_home: false,
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
}
