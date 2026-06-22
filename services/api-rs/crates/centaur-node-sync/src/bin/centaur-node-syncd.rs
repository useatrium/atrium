//! centaur-node-syncd — the per-node sync daemon (Track C4), now STATEFUL (F1).
//!
//! Per session it runs two sweeps: scan the overlay `upper` → BASE-AWARE capture
//! to Atrium; poll the gap-free change-feed → adopt remote advances by writing
//! through `merged` at a quiesce point. The per-path sync-state + feed cursor are
//! persisted to a node-local JSON file, so capture passes the real `base_seq`
//! (Atrium OCC/diff3 → real cross-agent conflict detection) and the daemon resumes
//! without re-scanning history. Egress-only (x-api-key to Atrium's internal node
//! endpoints).
//!
//! Env: ATRIUM_BASE_URL, ATRIUM_CAPTURE_API_KEY, NODE_SYNC_SESSION,
//!      NODE_SYNC_UPPER, NODE_SYNC_MERGED, optional NODE_SYNC_HARNESS,
//!      optional NODE_SYNC_HARNESS_THREAD_ID, optional NODE_SYNC_HARNESS_HOME,
//!      NODE_SYNC_STATE
//!      (default /var/lib/centaur/sync-state/<session>.json),
//!      NODE_SYNC_INTERVAL_SECS (2).
//! Flags: --once (hydrate if needed + one capture + one inbound sweep, then exit),
//!        --interval <secs> (overrides NODE_SYNC_INTERVAL_SECS),
//!        --overlays-root <path> (chart contract; per-session env still required).

#[cfg(target_os = "linux")]
fn main() {
    use centaur_node_sync::echo::EchoGuard;
    use centaur_node_sync::fs_linux;
    use centaur_node_sync::http_client::HttpAtriumClient;
    use centaur_node_sync::quiesce::{LeaseGate, apply_quiesced_writes};
    use centaur_node_sync::runtime::{
        AtriumClient, HarnessTranscriptKind, UpperReader, capture_sweep, harness_transcript_sweep,
        inbound_sweep, partition_entries_by_lane, sha_hex,
    };
    use centaur_node_sync::state::DaemonState;
    use std::path::{Path, PathBuf};

    #[derive(Default)]
    struct DaemonArgs {
        once: bool,
        interval_secs: Option<u64>,
        overlays_root: Option<PathBuf>,
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

    fn fail_config(missing: &[String], overlays_root: Option<&Path>) -> ! {
        let overlays_note = match overlays_root {
            Some(root) => format!(
                "; --overlays-root={} was parsed, but node-level fan-out is not implemented in this binary",
                root.display()
            ),
            None => "; --overlays-root was not provided".to_string(),
        };
        eprintln!(
            "centaur-node-syncd configuration error: missing {}. Required per-session env: ATRIUM_BASE_URL, ATRIUM_CAPTURE_API_KEY, NODE_SYNC_SESSION, NODE_SYNC_UPPER, NODE_SYNC_MERGED{}. The Helm DaemonSet must be paired with runtime-injected per-session NODE_SYNC_* env, or replaced by a node-level supervisor.",
            missing.join(", "),
            overlays_note
        );
        std::process::exit(2);
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

    let args = match parse_args() {
        Ok(args) => args,
        Err(error) => {
            eprintln!("centaur-node-syncd argument error: {error}");
            std::process::exit(2);
        }
    };
    let once = args.once;
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    let base_url = env("ATRIUM_BASE_URL");
    let api_key = env("ATRIUM_CAPTURE_API_KEY");
    let session = env("NODE_SYNC_SESSION");
    let harness = HarnessTranscriptKind::parse(&env("NODE_SYNC_HARNESS"));
    let harness_thread_id = env("NODE_SYNC_HARNESS_THREAD_ID");
    let harness_home = env("NODE_SYNC_HARNESS_HOME");
    let upper_env = env("NODE_SYNC_UPPER");
    let merged_env = env("NODE_SYNC_MERGED");
    let upper = PathBuf::from(&upper_env);
    let merged = PathBuf::from(&merged_env);
    // Optional: a repo working tree whose uncommitted WIP we snapshot to the ledger
    // (pure-read git diff, H6/§5A). Empty = no WIP capture.
    let repo = env("NODE_SYNC_REPO");
    let repo_name = if repo.is_empty() {
        String::new()
    } else {
        std::path::Path::new(&repo)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "repo".to_string())
    };
    let interval = args
        .interval_secs
        .unwrap_or_else(|| env("NODE_SYNC_INTERVAL_SECS").parse::<u64>().unwrap_or(2));
    // Per-session upper dirty-byte budget (#11). Default 2 GiB; the harness pauses
    // the agent before ENOSPC when crossed.
    let budget = centaur_node_sync::backpressure::Budget {
        max_dirty_bytes: env("NODE_SYNC_DIRTY_BUDGET")
            .parse::<u64>()
            .unwrap_or(2 * 1024 * 1024 * 1024),
    };
    let state_file = {
        let s = env("NODE_SYNC_STATE");
        if s.is_empty() {
            PathBuf::from(format!("/var/lib/centaur/sync-state/{session}.json"))
        } else {
            PathBuf::from(s)
        }
    };
    let mut missing = Vec::new();
    if base_url.is_empty() {
        missing.push("ATRIUM_BASE_URL".to_string());
    }
    if api_key.is_empty() {
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
        fail_config(&missing, args.overlays_root.as_deref());
    }
    let harness_lane_homes = harness_lane_homes(&harness_home);

    struct HardenedReader {
        upper: PathBuf,
    }
    impl UpperReader for HardenedReader {
        fn read(&self, rel: &std::path::Path) -> Option<Vec<u8>> {
            fs_linux::read_file_safe(&self.upper, rel, 3).ok()
        }
        fn open_stream<'a>(&'a self, rel: &std::path::Path) -> Option<Box<dyn std::io::Read + 'a>> {
            // Large files stream straight from the hardened fd — never buffered whole.
            fs_linux::open_file_stream(&self.upper, rel)
                .ok()
                .map(|f| Box::new(f) as Box<dyn std::io::Read + 'a>)
        }
    }

    // Write reconciled bytes THROUGH `merged`: atomic temp+rename + agent ownership
    // (uid 1001, 0664). NEVER poke upper/lower.
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
        std::fs::rename(&tmp, &dst).map_err(|e| e.to_string())?;
        Ok(())
    }

    // Two-phase write-through for an ATOMIC manifest (H10): stage all entries to
    // temp, then commit (rename) all — so a multi-file group lands all-or-nothing.
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

    let mut client = HttpAtriumClient::new(&base_url, &api_key, &session);
    let mut echo = EchoGuard::new();
    let lease = LeaseGate::new(); // harness flips this in prod; empty = all quiesced
    let mut state = DaemonState::load(&state_file);

    // HYDRATE (once): reconstruct base_seqs by draining the feed to its head. This
    // is what the lower was materialized from, so it's the correct capture base.
    if !state.hydrated {
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
                    eprintln!("hydrate poll: {e}");
                    break;
                }
            }
        }
        state.hydrated = true;
        let _ = state.save(&state_file);
        println!(
            "hydrated {} paths, cursor={}",
            state.paths.len(),
            state.cursor
        );
    }

    loop {
        // REFRESH upper_sha from the ACTUAL upper before deciding inbound — state's
        // upper_sha is only written on capture, so without this a freshly-edited-but-
        // uncaptured file would look "unedited" and inbound would clobber the agent's
        // work. A file absent from the upper = not copied-up = unedited (resolves to
        // the lower/base), so upper_sha := base_sha there.
        {
            let reader = HardenedReader {
                upper: upper.clone(),
            };
            for (path, ls) in state.paths.iter_mut() {
                ls.upper_sha = match reader.read(&PathBuf::from(path)) {
                    Some(bytes) => Some(sha_hex(&bytes)),
                    None => ls.base_sha.clone(),
                };
            }
        }

        // INBOUND FIRST — adopt remote advances before re-scanning the upper, so a
        // working copy that's stale vs the ledger latest (e.g. after a teammate's
        // resolution) is refreshed; the subsequent capture then sees it's already
        // current and doesn't re-capture stale bytes into churn.
        match client.poll_changes(&state.cursor) {
            Ok((changes, next)) => {
                if !changes.is_empty() {
                    use centaur_node_sync::manifest::{
                        ManifestApply, apply_manifest_atomic, partition_manifests,
                    };
                    use std::collections::HashMap;

                    let plan = inbound_sweep(&changes, state.locals(), &mut echo, &mut client);

                    // H10: re-group adopt-ready writes by their producer commit-group so
                    // a coherent multi-file change lands ALL-OR-NOTHING; ungrouped rows
                    // stay on the existing per-path quiesce path.
                    let mut group_size: HashMap<String, usize> = HashMap::new();
                    for (_p, rc) in &changes {
                        if let Some(g) = &rc.group_id {
                            *group_size.entry(g.clone()).or_default() += 1;
                        }
                    }
                    let tagged = plan
                        .to_write
                        .into_iter()
                        .map(|(path, seq, bytes)| {
                            let (gid, sha) = changes
                                .iter()
                                .find(|(p, rc)| p == &path && rc.seq == seq)
                                .map(|(_, rc)| (rc.group_id.clone(), rc.sha.clone()))
                                .unwrap_or((None, None));
                            (path, seq, gid, sha, bytes)
                        })
                        .collect();
                    let part = partition_manifests(tagged, &group_size);

                    let mut adopted = 0usize;
                    // loose single writes — the existing per-path quiesce path.
                    let (written, loose_deferred) =
                        apply_quiesced_writes(part.loose, &lease, |rel, bytes| {
                            write_through_merged(&merged, rel, bytes)
                        });
                    for (path, seq) in &written {
                        let sha = changes
                            .iter()
                            .find(|(p, rc)| p == path && rc.seq == *seq)
                            .and_then(|(_, rc)| rc.sha.clone());
                        state.sync_to(path, *seq, sha, true);
                        adopted += 1;
                    }
                    // atomic groups — all-or-nothing through the staged two-phase write.
                    let mut group_deferred = 0usize;
                    for m in &part.manifests {
                        match apply_manifest_atomic(
                            m,
                            &lease,
                            |rel, bytes| stage_through_merged(&merged, rel, bytes),
                            |rel| commit_through_merged(&merged, rel),
                            |rel| abort_staged(&merged, rel),
                        ) {
                            ManifestApply::Applied(entries) => {
                                for (path, seq, sha) in entries {
                                    state.sync_to(&path, seq, sha, true);
                                    adopted += 1;
                                }
                            }
                            ManifestApply::Deferred(reason) => {
                                group_deferred += 1;
                                eprintln!("  group {} deferred: {reason}", m.group_id);
                            }
                        }
                    }
                    println!(
                        "inbound: {adopted} adopted ({} groups), {} loose-deferred, {group_deferred} group-deferred, {} incomplete, {} reconcile, {} conflicts",
                        part.manifests.len(),
                        loose_deferred.len(),
                        part.deferred_incomplete.len(),
                        plan.to_reconcile.len(),
                        plan.conflicts.len()
                    );
                    for (path, seq) in &plan.conflicts {
                        eprintln!("  CONFLICT at {path} seq {seq} — needs resolution");
                    }
                }
                state.cursor = next;
            }
            Err(e) => eprintln!("poll: {e}"),
        }

        // OUTBOUND — base-aware capture of genuinely-new local edits
        match fs_linux::read_upper_entries(&upper) {
            Ok(entries) => {
                let reader = HardenedReader {
                    upper: upper.clone(),
                };
                let partitioned = partition_entries_by_lane(&entries, &harness_lane_homes);
                eprintln!(
                    "entry lanes: artifact={}, harness_state={}, denied_dropped={}, total={}",
                    partitioned.artifact_entries.len(),
                    partitioned.harness_entries.len(),
                    partitioned.denied_count,
                    entries.len()
                );
                let base_seqs = state.base_seqs();
                let large = std::env::var("NODE_SYNC_LARGE_FILE_BYTES")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(centaur_node_sync::runtime::DEFAULT_LARGE_FILE_BYTES);
                // Backpressure (#11): the upper is the agent's dirty set; warn the
                // harness before it fills the node volume (ENOSPC mid-write). Large
                // files stream direct (H8) → routed OUT of the dirty-byte budget, so
                // the budget measures only the buffered set.
                let dirty =
                    centaur_node_sync::backpressure::dirty_bytes_excluding_large(&entries, large);
                if budget.over(dirty) {
                    eprintln!(
                        "BACKPRESSURE: upper dirty {dirty}B OVER budget {}B — harness should pause the agent",
                        budget.max_dirty_bytes
                    );
                } else if budget.near(dirty) {
                    eprintln!(
                        "backpressure: upper dirty {dirty}B near budget {}B (headroom {}B)",
                        budget.max_dirty_bytes,
                        budget.headroom(dirty)
                    );
                }
                let out = capture_sweep(
                    &partitioned.artifact_entries,
                    &base_seqs,
                    &reader,
                    &mut echo,
                    &mut client,
                    large,
                );
                for (path, seq, sha) in out.captured.iter().chain(out.streamed.iter()) {
                    state.sync_to(path, *seq, Some(sha.clone()), false);
                }
                println!(
                    "capture: {} upserts ({} streamed), {} deletes, {} echo-skipped, {} errors",
                    out.captured.len() + out.streamed.len(),
                    out.streamed.len(),
                    out.deleted.len(),
                    out.skipped_echo.len(),
                    out.errors.len()
                );
                for (p, e) in &out.errors {
                    eprintln!("  capture error {p}: {e}");
                }
                let harnesses: Vec<(HarnessTranscriptKind, PathBuf)> = match harness {
                    Some(kind) => vec![(
                        kind,
                        if harness_home.is_empty() {
                            PathBuf::from(kind.default_home_rel())
                        } else {
                            PathBuf::from(&harness_home)
                        },
                    )],
                    None => [HarnessTranscriptKind::Claude, HarnessTranscriptKind::Codex]
                        .into_iter()
                        .map(|kind| (kind, PathBuf::from(kind.default_home_rel())))
                        .collect(),
                };
                for (harness, harness_home) in harnesses {
                    let out = harness_transcript_sweep(
                        &partitioned.harness_entries,
                        &reader,
                        &mut client,
                        harness,
                        &harness_home,
                        &harness_thread_id,
                    );
                    if let Some((path, bytes)) = out.captured {
                        println!(
                            "harness transcript: captured {} bytes from {}",
                            bytes,
                            path.display()
                        );
                    } else if let Some(error) = out.error {
                        eprintln!("harness transcript: {error}");
                    }
                }
            }
            Err(e) => eprintln!("scan {}: {e}", upper.display()),
        }

        // WIP — snapshot uncommitted repo work to the ledger (pure-read; H6/§5A)
        if !repo.is_empty() {
            match centaur_node_sync::wip::capture_wip(std::path::Path::new(&repo)) {
                Ok(patch) => {
                    let captured = centaur_node_sync::runtime::wip_sweep(
                        &repo_name,
                        &patch,
                        &state.base_seqs(),
                        &mut client,
                    );
                    for (path, seq, sha) in &captured {
                        state.sync_to(path, *seq, Some(sha.clone()), false);
                    }
                    if !captured.is_empty() {
                        println!(
                            "wip: {} artifacts snapshotted for {repo_name}",
                            captured.len()
                        );
                    }
                }
                Err(e) => eprintln!("wip {repo}: {e}"),
            }
        }

        let _ = state.save(&state_file);

        if once {
            break;
        }
        std::thread::sleep(std::time::Duration::from_secs(interval));
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("centaur-node-syncd runs on linux nodes only");
    std::process::exit(1);
}
