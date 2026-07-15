//! Linux overlay scanning and outbound capture.
//!
//! Owns full/scoped scan planning, canary checks, and capture sweeps.

use super::{
    HardenedReader, ScanCtx, WipGateState, capture_repo_wip, harness_lane_homes,
    harnesses_to_capture,
};
use centaur_node_sync::backpressure;
use centaur_node_sync::daemon::session::{SessionConfig, warmcache_capture_if_needed};
use centaur_node_sync::overlay::RawEntry;
use centaur_node_sync::overlay_mount::{OVERLAY_SIGNATURE_FILE, READY_MARKER_FILE};
use centaur_node_sync::runtime::{
    AtriumClient, capture_sweep, credential_refresh_sweep, harness_transcript_sweep,
    partition_entries_by_lane, profile_baseline_sweep, profile_candidate_sweep, reconcile_deletes,
};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const MAX_DELETE_RECONCILE_RATIO: f64 = 0.25;

pub(super) fn run_local_capture(
    ctx: &mut ScanCtx<'_>,
    force_wip: bool,
    wip_gate: &mut WipGateState,
    plan: &ScanPlan,
    tree: &mut centaur_node_sync::scoped::TreeState,
) -> Option<Vec<RawEntry>> {
    let raw_entries = outbound(ctx, plan, tree);
    warmcache_capture_if_needed(
        ctx.client,
        ctx.session,
        ctx.state,
        &ctx.global.depcache_root,
    );
    capture_repo_wip(
        ctx.session,
        ctx.state,
        ctx.client,
        raw_entries.as_deref(),
        force_wip,
        wip_gate,
    );
    raw_entries
}

/// How this sweep obtains its entry list. `Full` walks the upper and
/// rebuilds the session's `TreeState`; `Scoped` patches the belief from
/// dirty rel-paths and synthesizes the full list from memory.
pub(super) enum ScanPlan {
    Full,
    Scoped(Vec<PathBuf>),
}

fn is_capture_marker(path: &Path) -> bool {
    path == Path::new(READY_MARKER_FILE) || path == Path::new(OVERLAY_SIGNATURE_FILE)
}

/// Read this sweep's entries per the plan, keeping `tree` current. A
/// scoped failure returns Err so the caller can degrade to full dirt.
fn collect_entries(
    session: &SessionConfig,
    plan: &ScanPlan,
    tree: &mut centaur_node_sync::scoped::TreeState,
    canary: bool,
) -> std::io::Result<Vec<RawEntry>> {
    match plan {
        ScanPlan::Full => {
            let source = centaur_node_sync::scoped::FsEntrySource::new(&session.upper);
            let mut walked = source.walk_all()?;
            walked.retain(|entry| !is_capture_marker(&entry.rel_path));
            if canary && tree.seeded() {
                let divergence = tree.confirm_divergence(&walked);
                if !divergence.is_empty() {
                    let sample: Vec<String> = divergence
                        .iter()
                        .take(5)
                        .map(|rel| rel.display().to_string())
                        .collect();
                    println!(
                        "event=node_sync_scoped_scan_divergence session={} count={} sample={}",
                        session.session,
                        divergence.len(),
                        sample.join(",")
                    );
                }
            }
            tree.rebuild(&walked);
            Ok(walked)
        }
        ScanPlan::Scoped(rels) => {
            let source = centaur_node_sync::scoped::FsEntrySource::new(&session.upper);
            tree.apply_dirty_paths(&source, rels)?;
            let mut entries = tree.synthesized_entries();
            entries.retain(|entry| !is_capture_marker(&entry.rel_path));
            Ok(entries)
        }
    }
}

pub(super) fn outbound(
    ctx: &mut ScanCtx<'_>,
    plan: &ScanPlan,
    tree: &mut centaur_node_sync::scoped::TreeState,
) -> Option<Vec<RawEntry>> {
    let ScanCtx {
        global,
        session,
        state,
        capture_stamps,
        pending_deletes,
        uploaded_profile_bundles,
        echo,
        client,
    } = ctx;
    match collect_entries(session, plan, tree, global.scoped_scan) {
        Ok(entries) => {
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
            let dirty = backpressure::dirty_bytes_excluding_large(&entries, global.large_threshold);
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
            let present = matches!(plan, ScanPlan::Full).then(|| {
                partitioned
                    .artifact_entries
                    .iter()
                    .map(|entry| entry.rel_path.to_string_lossy().into_owned())
                    .collect::<HashSet<_>>()
            });
            let out = capture_sweep(
                &partitioned.artifact_entries,
                &base_seqs,
                capture_stamps,
                &reader,
                echo,
                &mut **client,
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
            if let Some(present) = present {
                let reconcile = reconcile_deletes(
                    capture_stamps,
                    &present,
                    pending_deletes,
                    MAX_DELETE_RECONCILE_RATIO,
                );
                if reconcile.fuse_tripped {
                    println!(
                        "event=node_sync_delete_reconcile_fuse session={} missing={} known={}",
                        session.session, reconcile.missing_count, reconcile.known_count
                    );
                } else {
                    let mut reconciled = 0;
                    for path in reconcile.confirmed {
                        let base = base_seqs.get(&path).copied().unwrap_or(0);
                        match (**client).post_delete(&path, base) {
                            Ok(_) => {
                                capture_stamps.remove(&path);
                                state.paths.remove(&path);
                                reconciled += 1;
                            }
                            Err(error) => eprintln!(
                                "session {}: capture error {path}: {error}",
                                session.session
                            ),
                        }
                    }
                    if reconciled > 0 {
                        println!(
                            "session {}: capture: reconciled {reconciled} deletes",
                            session.session
                        );
                    }
                }
            }

            for (harness, harness_home) in harnesses_to_capture(session) {
                // Unclaimed sessions have no resolvable Atrium ref, so profile
                // baseline/candidate and transcript pushes are guaranteed 404s
                // that retry every cycle. A claim rewrites the manifest and the
                // next cycle uploads normally (profile_baseline_sent stays false).
                if session.manifest_atrium_session_empty {
                    continue;
                }
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
                        &mut **client,
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
                    &mut **client,
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
                } else if out.skipped {
                    let thread_id = session.harness_thread_id.trim();
                    let thread_id = if thread_id.is_empty() {
                        "<empty>"
                    } else {
                        thread_id
                    };
                    eprintln!(
                        "session {}: harness transcript: skipped for {} (harness_home={}, entries={}, thread_id={thread_id})",
                        session.session,
                        harness.atrium_harness(),
                        harness_home.display(),
                        partitioned.harness_entries.len()
                    );
                }
                if let Some(error) = out.error {
                    eprintln!("session {}: harness transcript: {error}", session.session);
                }

                let out = profile_candidate_sweep(
                    &partitioned.harness_entries,
                    &reader,
                    &mut **client,
                    uploaded_profile_bundles,
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
                    &mut **client,
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
