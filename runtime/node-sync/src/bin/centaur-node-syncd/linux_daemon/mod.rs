//! Linux daemon entry point and orchestration over mount, watch, scan, feed,
//! materialization, WIP, and garbage-collection helpers.

mod feeds;
mod gc;
mod scan;
mod wake;

use self::feeds::{
    RemotePollOutcome, apply_atrium_feed, apply_inbound_feed, apply_probe_outcome,
    apply_profile_feed, poll_remote_targets,
};
use self::gc::{
    GcSignals, cleanup_removed_overlays, cleanup_removed_watches, has_active_overlay_mount,
    maybe_evict_depcache, maybe_gc_evicted_session,
};
use self::scan::{ScanPlan, outbound, run_local_capture};
use self::wake::{
    drain_wake_messages, start_change_stream, start_watch_bridge, wait_for_next_tick,
};

use centaur_node_sync::backpressure::Budget;
use centaur_node_sync::batch::{BatchEndpointState, BatchHttpClient};
use centaur_node_sync::cas::{hydrate_artifact_lower_into_plan, reattach_artifact_lower_into_plan};
use centaur_node_sync::daemon::config::{
    GlobalConfig, env_truthy, env_with_fallback, fail_config, non_empty_path, non_empty_pathbuf,
    parse_args, require_global_config, single_session_config,
};
use centaur_node_sync::daemon::loop_state::DirtySessions;
use centaur_node_sync::daemon::session::{
    ActiveSession, ProbeSession, SessionConfig, hydrate_state_if_needed, normalized_harness_home,
    probe_unclaimed_session_if_due, profile_harness_for_discovered, scoped_atrium_root,
    select_poll_targets, session_config_from_discovered, should_eager_poll_atrium,
    should_run_local_capture, warmcache_capture_if_needed,
};
use centaur_node_sync::echo::EchoGuard;
use centaur_node_sync::eviction::{
    DEFAULT_EVICT_GRACE_SECS, DEFAULT_EVICT_HEARTBEAT_STALE_SECS,
    DEFAULT_EVICT_NO_HEARTBEAT_GRACE_SECS, DEFAULT_EVICT_RECHECK_SECS, EvictionSignals,
    EvictionThresholds, SessionEvictionState, heartbeat_mtime_nanos, manifest_age,
    manifest_mtime_nanos,
};
use centaur_node_sync::fs_linux;
use centaur_node_sync::http_client::HttpAtriumClient;
use centaur_node_sync::materializer::write_mount_readme;
use centaur_node_sync::overlay::RawEntry;
use centaur_node_sync::overlay_mount::{OverlayMountPlan, mount_overlay, plan_overlay_mount};
use centaur_node_sync::quiesce::{LeaseGate, apply_quiesced_writes};
use centaur_node_sync::runtime::{
    AtriumClient, CaptureStamp, HarnessTranscriptKind, UpperReader, inbound_sweep,
    materialize_profile_bundles, sha_hex,
};
use centaur_node_sync::seam;
use centaur_node_sync::session_manifest::{DiscoveredSession, discover_sessions, manifest_path};
use centaur_node_sync::sse::DirtySet;
use centaur_node_sync::state::DaemonState;
use centaur_node_sync::watch::MergedTreeWatcher;
use std::collections::{HashMap, HashSet, VecDeque};
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

struct ScanCtx<'a> {
    global: &'a GlobalConfig,
    session: &'a SessionConfig,
    state: &'a mut DaemonState,
    capture_stamps: &'a mut HashMap<String, CaptureStamp>,
    echo: &'a mut EchoGuard,
    client: &'a mut HttpAtriumClient,
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
    let args = match parse_args(std::env::args().skip(1)) {
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
        // Canonical names first, historical spellings accepted (seam.rs).
        base_url: env_with_fallback(seam::ENV_ATRIUM_BASE_URL, seam::ENV_ATRIUM_URL),
        api_key: env_with_fallback(
            seam::ENV_ATRIUM_CAPTURE_API_KEY,
            seam::ENV_ARTIFACT_CAPTURE_API_KEY,
        ),
        atrium_root: non_empty_path(&env("NODE_SYNC_ATRIUM_ROOT"), "/atrium"),
        hydrate_artifacts: env_truthy(&env("NODE_SYNC_HYDRATE_ARTIFACTS")),
        scoped_scan: env_truthy(&env("NODE_SYNC_SCOPED_SCAN")),
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

fn run_single_session(
    global: GlobalConfig,
    session: SessionConfig,
    once: bool,
    interval_secs: u64,
) {
    let lease = LeaseGate::new();
    let mut echo = EchoGuard::new();
    let mut state = DaemonState::load(&session.state_file);
    let mut capture_stamps = HashMap::new();
    let mut wip_gate = WipGateState::default();
    let mut last_forced_wip: Option<Instant> = None;
    let mut tick: u64 = 0;

    loop {
        tick = tick.saturating_add(1);
        let mut client =
            HttpAtriumClient::new(&global.base_url, &global.api_key, &session.atrium_session);
        let ctx = ScanCtx {
            global: &global,
            session: &session,
            state: &mut state,
            capture_stamps: &mut capture_stamps,
            echo: &mut echo,
            client: &mut client,
        };
        if let Err(e) = run_one_session(ctx, &lease, &mut wip_gate, &mut last_forced_wip) {
            eprintln!("session {}: {e}", session.session);
        }
        maybe_evict_depcache(&global, tick);
        if once {
            break;
        }
        std::thread::sleep(std::time::Duration::from_secs(interval_secs));
    }
}

fn run_multi_session(global: GlobalConfig, overlays_root: PathBuf, once: bool, interval_secs: u64) {
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
    let watcher = MergedTreeWatcher::from_env(watch_tx);
    start_watch_bridge(watch_rx, wake_tx.clone());
    let mut stream_healthy = false;
    let mut pending_wake_messages = VecDeque::new();
    let mut dirty = DirtySet::default();
    let mut local_dirty = DirtySessions::default();
    let mut tree_states: HashMap<String, centaur_node_sync::scoped::TreeState> = HashMap::new();
    let mut capture_stamps: HashMap<String, HashMap<String, CaptureStamp>> = HashMap::new();
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
        let mut eager_poll_sessions = HashSet::new();
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
                tree_states.retain(|session, _| active.contains(session));
                capture_stamps.retain(|session, _| active.contains(session));

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
                    if let Some(probe) = probe_unclaimed_session_if_due(
                        &discovered,
                        eviction,
                        &mut states,
                        now,
                        global.evict_recheck,
                    ) {
                        probe_sessions.push(probe);
                    }

                    let has_active_mount = has_active_overlay_mount(&discovered.manifest.merged)
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
                    let mounted = match mount_overlay(plan, Some(discovered.manifest.agent_uid)) {
                        Ok(plan) => plan,
                        Err(e) => {
                            eprintln!("session {}: overlay mount: {e}", discovered.session);
                            continue;
                        }
                    };
                    let session = session_config_from_discovered(&discovered, &mounted);
                    mounted_overlays.insert(discovered.session.clone(), mounted);
                    let first_seen = !states.contains_key(&session.session);
                    let atrium_root = scoped_atrium_root(&global.atrium_root, &session.session);
                    if should_eager_poll_atrium(&session, &atrium_root) {
                        eager_poll_sessions.insert(session.session.clone());
                    }
                    if first_seen && let Err(error) = write_mount_readme(&atrium_root) {
                        eprintln!(
                            "session {}: seed Atrium context README: {error}",
                            session.session
                        );
                    }
                    if watcher.is_enabled()
                        && (wip_remounted || !watched_sessions.contains(&session.session))
                    {
                        let result = watcher.add_session(&session.session, &session.merged);
                        watched_sessions.insert(session.session.clone());
                        if result.attached {
                            just_attached_sessions.insert(session.session.clone());
                        }
                    }
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
            &eager_poll_sessions,
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
            let mut client =
                HttpAtriumClient::new(&global.base_url, &global.api_key, &session.atrium_session);
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
                        apply_inbound_feed(&session, state, echo, &lease, &mut client, artifacts);
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
            let should_scan = should_run_local_capture(
                watcher.is_always_scan(&session.session),
                had_local_dirty,
                wip_remounted,
                wip_restored,
                local_reconcile_due,
                just_attached_sessions.contains(&session.session),
            ) || force_wip;
            if should_scan {
                let cleared_dirty = local_dirty.clear_for_scan(&session.session);
                let tree = tree_states.entry(session.session.clone()).or_default();
                let stamps = capture_stamps.entry(session.session.clone()).or_default();
                // Scoped scans need: the flag, a seeded belief, a live watch
                // attachment, path-only dirt, and none of the full-scan
                // triggers (backstop reconcile, attach, remount, WIP force).
                let scoped_eligible = global.scoped_scan
                    && tree.seeded()
                    && !cleared_dirty.full
                    && !cleared_dirty.paths.is_empty()
                    && !watcher.is_always_scan(&session.session)
                    && watched_sessions.contains(&session.session)
                    && !local_reconcile_due
                    && !just_attached_sessions.contains(&session.session)
                    && !wip_remounted
                    && !wip_restored
                    && !force_wip;
                let plan = if scoped_eligible {
                    // Dirty paths arrive absolute under the merged root; the
                    // engine patches upper-relative paths (same rel space).
                    let rels: Vec<PathBuf> = cleared_dirty
                        .paths
                        .iter()
                        .filter_map(|path| {
                            path.strip_prefix(&session.merged)
                                .ok()
                                .map(Path::to_path_buf)
                        })
                        .collect();
                    if rels.is_empty() {
                        ScanPlan::Full
                    } else {
                        ScanPlan::Scoped(rels)
                    }
                } else {
                    ScanPlan::Full
                };
                let scan_was_full = matches!(plan, ScanPlan::Full);
                let mut ctx = ScanCtx {
                    global: &global,
                    session: &session,
                    state,
                    capture_stamps: stamps,
                    echo,
                    client: &mut client,
                };
                let scanned_entries =
                    run_local_capture(&mut ctx, force_wip, &mut wip_gate, &plan, tree);
                if scanned_entries.is_none() {
                    // Scan failed: degrade to full dirt so the next tick
                    // retries with a whole-tree walk (a scoped patch may
                    // have partially applied).
                    if cleared_dirty.any() || !scan_was_full {
                        local_dirty.mark(session.session.clone(), None);
                    }
                    if !scan_was_full {
                        tree.clear();
                    }
                }
                if force_wip {
                    last_forced_wip.insert(session.session.clone(), now);
                }
            }
            if let Some(atrium) = atrium_feed.as_ref() {
                let dirty_channel_ids = dirty_by_key
                    .get(&session.atrium_session)
                    .map(|feeds| feeds.channel_ids.iter().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                apply_atrium_feed(
                    &global,
                    &session,
                    state,
                    &client,
                    atrium,
                    &dirty_channel_ids,
                    full_remote_poll,
                );
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

fn run_one_session(
    mut ctx: ScanCtx<'_>,
    lease: &LeaseGate,
    wip_gate: &mut WipGateState,
    last_forced_wip: &mut Option<Instant>,
) -> Result<(), String> {
    let now = Instant::now();

    materialize_profile_bundles_for_session(ctx.session, ctx.state, ctx.client);
    hydrate_state_if_needed(ctx.session, ctx.state, ctx.client);
    refresh_upper_sha(ctx.session, ctx.state);
    let wip_restored = restore_repo_wip(ctx.session, ctx.state);
    // Inbound adoption needs seeded state: without it every remote row looks
    // like an unknown local and gets adopted (re-downloaded + copied up).
    // Outbound stays on — new-file captures are safe unseeded, and an edited
    // pre-existing path is server-guarded (409 base_required) until seeded.
    if ctx.state.hydrated {
        inbound(ctx.session, ctx.state, ctx.echo, lease, ctx.client);
    }
    let mut once_tree = centaur_node_sync::scoped::TreeState::default();
    let raw_entries = outbound(&mut ctx, &ScanPlan::Full, &mut once_tree);
    warmcache_capture_if_needed(
        ctx.client,
        ctx.session,
        ctx.state,
        &ctx.global.depcache_root,
    );
    let wip_backstop_elapsed =
        last_forced_wip.is_none_or(|last| now.duration_since(last) >= WIP_FORCE_INTERVAL);
    let force_wip =
        centaur_node_sync::wip::should_force_wip(false, wip_restored, wip_backstop_elapsed);
    capture_repo_wip(
        ctx.session,
        ctx.state,
        ctx.client,
        raw_entries.as_deref(),
        force_wip,
        wip_gate,
    );
    if force_wip {
        *last_forced_wip = Some(now);
    }
    materialize_atrium(ctx.global, ctx.session, ctx.state, ctx.client);
    ctx.state
        .save(&ctx.session.state_file)
        .map_err(|e| format!("save state {}: {e}", ctx.session.state_file.display()))
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
    use centaur_node_sync::manifest::{ManifestApply, apply_manifest_atomic, partition_manifests};

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
    for kind in [HarnessTranscriptKind::Claude, HarnessTranscriptKind::Codex] {
        let configured = normalized_harness_home(kind, configured_harness_home);
        if !homes.iter().any(|home| home == &configured) {
            homes.push(configured);
        }
    }
    homes
}

fn harnesses_to_capture(session: &SessionConfig) -> Vec<(HarnessTranscriptKind, PathBuf)> {
    match session.harness {
        Some(kind) => vec![(kind, normalized_harness_home(kind, &session.harness_home))],
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
            match serde_json::from_slice::<centaur_node_sync::wip::WipSnapshotManifest>(&bytes) {
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
    let atrium_root = scoped_atrium_root(&global.atrium_root, &session.session);
    if let Err(e) =
        centaur_node_sync::materializer::materialize_channel_docs(client, &atrium_root, None, state)
    {
        eprintln!("atrium channel materializer: {e}");
    }
    let cursor = state.atrium_cursor.clone();
    match centaur_node_sync::materialize_once(client, &atrium_root, &cursor, state) {
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
