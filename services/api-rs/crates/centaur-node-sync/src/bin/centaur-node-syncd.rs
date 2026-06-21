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
//!      NODE_SYNC_UPPER, NODE_SYNC_MERGED, NODE_SYNC_STATE (default
//!      /var/lib/centaur/sync-state/<session>.json), NODE_SYNC_INTERVAL_SECS (2).
//! Flags: --once (hydrate if needed + one capture + one inbound sweep, then exit).

#[cfg(target_os = "linux")]
fn main() {
    use centaur_node_sync::echo::EchoGuard;
    use centaur_node_sync::fs_linux;
    use centaur_node_sync::http_client::HttpAtriumClient;
    use centaur_node_sync::quiesce::{LeaseGate, apply_quiesced_writes};
    use centaur_node_sync::runtime::{
        AtriumClient, UpperReader, capture_sweep, inbound_sweep, sha_hex,
    };
    use centaur_node_sync::state::DaemonState;
    use std::path::{Path, PathBuf};

    let once = std::env::args().any(|a| a == "--once");
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    let base_url = env("ATRIUM_BASE_URL");
    let api_key = env("ATRIUM_CAPTURE_API_KEY");
    let session = env("NODE_SYNC_SESSION");
    let upper = PathBuf::from(env("NODE_SYNC_UPPER"));
    let merged = PathBuf::from(env("NODE_SYNC_MERGED"));
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
    let interval = env("NODE_SYNC_INTERVAL_SECS").parse::<u64>().unwrap_or(2);
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
    if base_url.is_empty() || session.is_empty() || upper.as_os_str().is_empty() {
        eprintln!("missing ATRIUM_BASE_URL / NODE_SYNC_SESSION / NODE_SYNC_UPPER");
        std::process::exit(2);
    }

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
                    let plan = inbound_sweep(&changes, state.locals(), &mut echo, &mut client);
                    let (written, deferred) =
                        apply_quiesced_writes(plan.to_write, &lease, |rel, bytes| {
                            write_through_merged(&merged, rel, bytes)
                        });
                    for (path, seq) in &written {
                        // the adopted version's sha == the change row's sha → base_sha
                        let sha = changes
                            .iter()
                            .find(|(p, rc)| p == path && rc.seq == *seq)
                            .and_then(|(_, rc)| rc.sha.clone());
                        state.sync_to(path, *seq, sha, true);
                    }
                    println!(
                        "inbound: {} adopted, {} deferred, {} reconcile, {} conflicts",
                        written.len(),
                        deferred.len(),
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
                let out =
                    capture_sweep(&entries, &base_seqs, &reader, &mut echo, &mut client, large);
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
