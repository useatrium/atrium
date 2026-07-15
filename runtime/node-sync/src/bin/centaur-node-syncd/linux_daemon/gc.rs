//! Linux session eviction and local storage garbage collection.
//!
//! Owns mount-aware cleanup plus periodic dependency-cache eviction.

use super::build_overlay_plan_for_discovered;
use centaur_node_sync::daemon::config::GlobalConfig;
use centaur_node_sync::depcache::{EvictStats, evict_depcache_lru};
use centaur_node_sync::eviction::SessionEvictionState;
use centaur_node_sync::overlay_mount::{OverlayMountPlan, session_sibling_dirs, unmount_overlay};
use centaur_node_sync::session_manifest::{DiscoveredSession, manifest_path, state_path};
use centaur_node_sync::watch::MergedTreeWatcher;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Instant;

/// The liveness observations GC needs, bundled to keep the helper's
/// signature within clippy's argument budget.
pub(super) struct GcSignals {
    pub(super) now: Instant,
    pub(super) manifest_mtime_nanos: Option<u128>,
    pub(super) heartbeat_mtime_nanos: Option<u128>,
}

#[derive(Clone, Copy)]
enum PathKind {
    Dir,
    File,
}

pub(super) fn maybe_gc_evicted_session(
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

pub(super) fn has_active_overlay_mount(merged: &Path) -> Result<bool, String> {
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

pub(super) fn maybe_evict_depcache(global: &GlobalConfig, tick: u64) {
    if !global.depcache_evict_enabled || !tick.is_multiple_of(global.depcache_evict_every_n_ticks) {
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

pub(super) fn cleanup_removed_overlays(
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

pub(super) fn cleanup_removed_watches(
    active: &HashSet<String>,
    watched_sessions: &mut HashSet<String>,
    watcher: &MergedTreeWatcher,
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
