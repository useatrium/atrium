//! Portable session configuration, discovery projection, poll-target selection,
//! state hydration, and warm-cache capture decisions used by the daemon.

pub fn scoped_atrium_root(atrium_root: &std::path::Path, session: &str) -> std::path::PathBuf {
    atrium_root.join(session)
}

#[derive(Clone)]
pub struct SessionConfig {
    pub session: String,
    pub atrium_session: String,
    pub manifest_atrium_session_empty: bool,
    pub upper: std::path::PathBuf,
    pub merged: std::path::PathBuf,
    pub harness: Option<crate::runtime::HarnessTranscriptKind>,
    pub harness_thread_id: String,
    pub harness_home: String,
    pub flat_home: bool,
    pub repo_subdirs: Vec<std::path::PathBuf>,
    pub repo_worktrees: Vec<RepoWorktree>,
    pub state_file: std::path::PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoWorktree {
    pub key: String,
    pub path: std::path::PathBuf,
}

pub fn session_config_from_discovered(
    discovered: &crate::session_manifest::DiscoveredSession,
    mounted: &crate::overlay_mount::OverlayMountPlan,
) -> SessionConfig {
    let repo = discovered.manifest.repo.clone();
    let merged = discovered.manifest.merged.clone();
    SessionConfig {
        session: discovered.session.clone(),
        atrium_session: discovered.atrium_session.clone(),
        manifest_atrium_session_empty: discovered.manifest_atrium_session_empty,
        upper: mounted.upper.clone(),
        merged: merged.clone(),
        harness: discovered
            .manifest
            .harness
            .as_deref()
            .and_then(crate::runtime::HarnessTranscriptKind::parse),
        harness_thread_id: discovered.manifest.harness_thread_id.clone(),
        harness_home: discovered.manifest.harness_home.clone(),
        flat_home: discovered.manifest.flat_home,
        repo_subdirs: repo_lane_subdirs(&discovered.manifest.repos),
        repo_worktrees: repo_worktrees(&repo, &discovered.manifest.repos, &merged),
        state_file: discovered.state_file.clone(),
    }
}

pub fn repo_lane_subdirs(repos: &[crate::session_manifest::RepoMount]) -> Vec<std::path::PathBuf> {
    repos
        .iter()
        .filter_map(|repo| crate::overlay_mount::repo_target_subdir(repo).ok())
        .map(std::path::PathBuf::from)
        .collect()
}

pub fn repo_worktrees(
    repo: &str,
    repos: &[crate::session_manifest::RepoMount],
    merged: &std::path::Path,
) -> Vec<RepoWorktree> {
    if !repos.is_empty() {
        return repos
            .iter()
            .filter_map(|repo| {
                let target = crate::overlay_mount::repo_target_subdir(repo).ok()?;
                Some(RepoWorktree {
                    key: crate::wip::sanitize_repo_key(&target),
                    path: merged.join(&target),
                })
            })
            .collect();
    }
    if repo.trim().is_empty() {
        return Vec::new();
    }
    vec![RepoWorktree {
        key: crate::wip::sanitize_repo_key(&repo_name(repo)),
        path: merged.to_path_buf(),
    }]
}

pub fn repo_name(repo: &str) -> String {
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
pub fn hydrate_state_if_needed(
    session: &SessionConfig,
    state: &mut crate::state::DaemonState,
    client: &mut dyn crate::runtime::AtriumClient,
) {
    if session.manifest_atrium_session_empty {
        return;
    }
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

pub fn warmcache_capture_if_needed(
    client: &mut dyn crate::runtime::AtriumClient,
    session: &SessionConfig,
    state: &mut crate::state::DaemonState,
    depcache_root: &std::path::Path,
) {
    let receipt =
        match crate::warmcache::read_warmcache_receipt(depcache_root, &session.atrium_session) {
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

        let stats = crate::warmcache::capture_depcache(
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

pub fn warmcache_capture_key(session: &str, kind: &str, lockfile_hash: &str) -> String {
    format!("{session}|{kind}|{lockfile_hash}")
}

pub fn warmcache_snapshot_key(kind: &str, dest_subdir: &str) -> String {
    format!("{kind}|{dest_subdir}")
}

pub fn warmcache_store_snapshot(
    depcache_root: &std::path::Path,
    dest_subdir: &str,
) -> Result<Option<crate::state::WarmcacheStoreSnapshot>, String> {
    if dest_subdir.starts_with('/') || dest_subdir.contains("..") {
        return Err(format!("unsafe dest_subdir {dest_subdir:?}"));
    }
    let store = depcache_root.join(dest_subdir);
    if !store.exists() {
        return Ok(None);
    }
    let mut snapshot = crate::state::WarmcacheStoreSnapshot {
        file_count: 0,
        total_size: 0,
        max_mtime_nanos: 0,
    };
    collect_warmcache_store_snapshot(&store, &mut snapshot)?;
    Ok(Some(snapshot))
}

pub fn collect_warmcache_store_snapshot(
    dir: &std::path::Path,
    snapshot: &mut crate::state::WarmcacheStoreSnapshot,
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

pub fn warmcache_mtime_nanos(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

pub fn should_run_local_capture(
    always_scan: bool,
    dirty: bool,
    remounted: bool,
    restored: bool,
    reconcile_due: bool,
    just_attached: bool,
) -> bool {
    always_scan || dirty || remounted || restored || reconcile_due || just_attached
}

pub fn normalized_harness_home(
    kind: crate::runtime::HarnessTranscriptKind,
    configured_harness_home: &str,
) -> std::path::PathBuf {
    if configured_harness_home.is_empty() {
        return std::path::PathBuf::from(kind.default_home_rel());
    }
    let configured = std::path::PathBuf::from(configured_harness_home);
    if configured.is_absolute() {
        std::path::PathBuf::from(kind.default_home_rel())
    } else {
        configured
    }
}

#[derive(Clone)]
pub struct ActiveSession {
    pub config: SessionConfig,
    pub wip_remounted: bool,
    pub wip_restored: bool,
}

#[derive(Clone)]
pub struct ProbeSession {
    pub session: String,
    pub atrium_session: String,
    pub profile_harness: crate::runtime::HarnessTranscriptKind,
}

#[derive(Clone)]
pub struct PollTarget {
    pub session: String,
    pub atrium_session: String,
    pub artifacts_since: String,
    pub atrium_since: String,
    pub profile_harness: crate::runtime::HarnessTranscriptKind,
}

pub fn profile_harness_for_session(
    session: &SessionConfig,
) -> crate::runtime::HarnessTranscriptKind {
    session
        .harness
        .unwrap_or(crate::runtime::HarnessTranscriptKind::Codex)
}

pub fn profile_harness_for_discovered(
    discovered: &crate::session_manifest::DiscoveredSession,
) -> crate::runtime::HarnessTranscriptKind {
    discovered
        .manifest
        .harness
        .as_deref()
        .and_then(crate::runtime::HarnessTranscriptKind::parse)
        .unwrap_or(crate::runtime::HarnessTranscriptKind::Codex)
}

pub fn should_eager_poll_atrium(session: &SessionConfig, atrium_root: &std::path::Path) -> bool {
    !session.manifest_atrium_session_empty
        && !atrium_root
            .join(crate::materializer::CONTEXT_READY_MARKER)
            .is_file()
}

pub fn probe_unclaimed_session_if_due(
    discovered: &crate::session_manifest::DiscoveredSession,
    eviction: &mut crate::eviction::SessionEvictionState,
    states: &mut std::collections::HashMap<String, crate::state::DaemonState>,
    now: std::time::Instant,
    recheck: std::time::Duration,
) -> Option<ProbeSession> {
    if !discovered.manifest_atrium_session_empty || !eviction.probe_interval_elapsed(now, recheck) {
        return None;
    }
    eviction.mark_probe(now);
    states
        .entry(discovered.session.clone())
        .or_insert_with(|| crate::state::DaemonState::load(&discovered.state_file));
    Some(ProbeSession {
        session: discovered.session.clone(),
        atrium_session: discovered.atrium_session.clone(),
        profile_harness: profile_harness_for_discovered(discovered),
    })
}

pub fn select_poll_targets(
    active_sessions: &[ActiveSession],
    probe_sessions: &[ProbeSession],
    states: &std::collections::HashMap<String, crate::state::DaemonState>,
    dirty_by_key: &std::collections::HashMap<String, crate::sse::DirtyFeeds>,
    eager_sessions: &std::collections::HashSet<String>,
    full_remote_poll: bool,
) -> Vec<PollTarget> {
    let mut out = Vec::new();
    for active in active_sessions {
        let session = &active.config;
        if session.manifest_atrium_session_empty {
            continue;
        }
        if !full_remote_poll
            && !dirty_by_key.contains_key(&session.atrium_session)
            && !eager_sessions.contains(&session.session)
        {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adopt::{RemoteChange, RemoteStatus};
    use crate::cas::WarmcacheManifestEntry;
    use crate::overlay::{RawEntry, RawFileType};
    use crate::overlay_mount::{LowerKind, LowerSource, plan_overlay_mount};
    use crate::runtime::{AtriumClient, HarnessTranscriptKind, locate_harness_transcript};
    use crate::session_manifest::{DiscoveredSession, RepoMount, SessionManifest};
    use crate::state::DaemonState;
    use crate::warmcache::{
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
        polls: usize,
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
            self.polls += 1;
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
            polls: 0,
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

    #[test]
    fn flagged_session_is_excluded_from_per_tick_poll_targets() {
        let mut session = warmcache_test_session();
        session.session = "warm-pool-dir".to_string();
        session.atrium_session = "warm-pool-dir".to_string();
        session.manifest_atrium_session_empty = true;
        let active_sessions = vec![ActiveSession {
            config: session.clone(),
            wip_remounted: false,
            wip_restored: false,
        }];
        assert!(!active_sessions[0].wip_remounted);
        assert!(!active_sessions[0].wip_restored);
        let mut states = std::collections::HashMap::new();
        states.insert(session.session.clone(), state_with_cursors("7.1", "8.2"));

        let targets = select_poll_targets(
            &active_sessions,
            &[],
            &states,
            &std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
            true,
        );

        assert!(targets.is_empty());
    }

    #[test]
    fn context_not_ready_session_is_polled_without_reconcile_or_sse_dirty_mark() {
        let session = warmcache_test_session();
        let active_sessions = vec![ActiveSession {
            config: session.clone(),
            wip_remounted: false,
            wip_restored: false,
        }];
        let mut states = std::collections::HashMap::new();
        states.insert(session.session.clone(), state_with_cursors("7.1", "8.2"));
        let eager_sessions = std::collections::HashSet::from([session.session.clone()]);

        let targets = select_poll_targets(
            &active_sessions,
            &[],
            &states,
            &std::collections::HashMap::new(),
            &eager_sessions,
            false,
        );

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].session, session.session);
        assert_eq!(targets[0].atrium_session, session.atrium_session);
    }

    #[test]
    fn eager_atrium_poll_tracks_claim_and_context_readiness() {
        let temp = tempfile::tempdir().unwrap();
        let mut session = warmcache_test_session();

        assert!(should_eager_poll_atrium(&session, temp.path()));

        std::fs::write(
            temp.path().join(crate::materializer::CONTEXT_READY_MARKER),
            b"ready\n",
        )
        .unwrap();
        assert!(!should_eager_poll_atrium(&session, temp.path()));

        std::fs::remove_file(temp.path().join(crate::materializer::CONTEXT_READY_MARKER)).unwrap();
        session.manifest_atrium_session_empty = true;
        assert!(!should_eager_poll_atrium(&session, temp.path()));
    }

    #[test]
    fn flagged_session_is_included_only_when_probe_cadence_is_due() {
        let now = std::time::Instant::now();
        let recheck = std::time::Duration::from_secs(300);
        let discovered = discovered_session_fixture("warm-pool-dir", true);
        let mut eviction = crate::eviction::SessionEvictionState::default();
        let mut states = std::collections::HashMap::new();

        let first =
            probe_unclaimed_session_if_due(&discovered, &mut eviction, &mut states, now, recheck)
                .expect("first unclaimed probe should be due");
        assert_eq!(first.session, "warm-pool-dir");
        assert_eq!(first.atrium_session, "warm-pool-dir");
        assert!(states.contains_key("warm-pool-dir"));

        assert!(
            probe_unclaimed_session_if_due(
                &discovered,
                &mut eviction,
                &mut states,
                now + std::time::Duration::from_secs(299),
                recheck,
            )
            .is_none()
        );
        let due = probe_unclaimed_session_if_due(
            &discovered,
            &mut eviction,
            &mut states,
            now + recheck,
            recheck,
        )
        .expect("unclaimed probe should be due at recheck cadence");

        let active_sessions = vec![ActiveSession {
            config: {
                let mut session = warmcache_test_session();
                session.session = discovered.session.clone();
                session.atrium_session = discovered.atrium_session.clone();
                session.manifest_atrium_session_empty = true;
                session
            },
            wip_remounted: false,
            wip_restored: false,
        }];
        let targets = select_poll_targets(
            &active_sessions,
            &[due],
            &states,
            &std::collections::HashMap::new(),
            &std::collections::HashSet::new(),
            true,
        );

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].session, "warm-pool-dir");
        assert_eq!(targets[0].atrium_session, "warm-pool-dir");
        assert_eq!(targets[0].artifacts_since, "0.0");
        assert_eq!(targets[0].atrium_since, "0.0");
        assert_eq!(targets[0].profile_harness, HarnessTranscriptKind::Codex);
    }

    #[test]
    fn hydrate_state_is_skipped_until_manifest_atrium_session_is_claimed() {
        let mut session = warmcache_test_session();
        session.manifest_atrium_session_empty = true;
        let mut state = DaemonState::default();
        let mut client = FlakyFeedClient {
            fail: false,
            polls: 0,
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

        hydrate_state_if_needed(&session, &mut state, &mut client);
        assert_eq!(client.polls, 0);
        assert!(!state.hydrated);
        assert!(state.locals().is_empty());

        session.manifest_atrium_session_empty = false;
        hydrate_state_if_needed(&session, &mut state, &mut client);
        assert_eq!(client.polls, 2);
        assert!(state.hydrated);
        assert_eq!(state.locals().get("shared/doc.md").unwrap().base_seq, 5);
    }

    fn warmcache_test_session() -> SessionConfig {
        SessionConfig {
            session: "local-session".to_string(),
            atrium_session: "surface:atrium-session".to_string(),
            manifest_atrium_session_empty: false,
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

    fn state_with_cursors(cursor: &str, atrium_cursor: &str) -> DaemonState {
        DaemonState {
            cursor: cursor.to_string(),
            atrium_cursor: atrium_cursor.to_string(),
            ..DaemonState::default()
        }
    }

    fn discovered_session_fixture(
        session: &str,
        manifest_atrium_session_empty: bool,
    ) -> DiscoveredSession {
        DiscoveredSession {
            session: session.to_string(),
            atrium_session: if manifest_atrium_session_empty {
                session.to_string()
            } else {
                format!("surface:{session}")
            },
            manifest_atrium_session_empty,
            upper: PathBuf::from(format!("/var/lib/centaur/overlays/{session}")),
            state_file: PathBuf::from(format!(
                "/var/lib/centaur/overlays/.sessions/{session}.state.json"
            )),
            manifest: SessionManifest {
                session: session.to_string(),
                atrium_session: if manifest_atrium_session_empty {
                    String::new()
                } else {
                    format!("surface:{session}")
                },
                merged: PathBuf::from(format!("/run/centaur/merged/{session}")),
                harness: Some("codex".to_string()),
                harness_thread_id: String::new(),
                harness_home: ".codex".to_string(),
                flat_home: false,
                generic_home_lower: PathBuf::new(),
                context_source: PathBuf::new(),
                repo: String::new(),
                repos: Vec::new(),
                agent_uid: 1001,
            },
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
    fn absolute_codex_harness_home_normalizes_before_transcript_lookup() {
        let thread_id = "550e8400-e29b-41d4-a716-446655440000";
        let mut session = warmcache_test_session();
        session.harness = Some(HarnessTranscriptKind::Codex);
        session.harness_thread_id = thread_id.to_string();
        session.harness_home = "/home/agent/.codex".to_string();
        session.flat_home = true;
        let transcript_path = PathBuf::from(
            ".codex/sessions/2026/07/06/rollout-2026-07-06T16-20-40-550e8400-e29b-41d4-a716-446655440000.jsonl",
        );
        let entries = vec![RawEntry {
            rel_path: transcript_path.clone(),
            file_type: RawFileType::Regular,
            rdev: 0,
            size: 4,
            mtime_ns: 0,
            xattrs: vec![],
        }];
        let harness = session.harness.unwrap();
        let harness_home = normalized_harness_home(harness, &session.harness_home);

        assert_eq!(harness_home, PathBuf::from(".codex"));
        assert_eq!(
            locate_harness_transcript(
                &entries,
                harness,
                &harness_home,
                &session.harness_thread_id,
                session.flat_home,
            ),
            Some(transcript_path)
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
            manifest_atrium_session_empty: false,
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
            Some(crate::runtime::HarnessTranscriptKind::Codex)
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
            manifest_atrium_session_empty: true,
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
        let mut state = crate::state::DaemonState::default();
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
        let mut state = crate::state::DaemonState::default();
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
        let mut state = crate::state::DaemonState::default();
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
        let mut state = crate::state::DaemonState::default();
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
