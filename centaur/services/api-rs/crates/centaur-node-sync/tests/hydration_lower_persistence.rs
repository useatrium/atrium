//! Replays the daemon's per-tick overlay maintenance for a hydrated session and
//! asserts the hydrated artifact lower SURVIVES the second tick.
//!
//! This is the on-node repro of the pod-native e2e step [8/9] failure: the daemon
//! hydrates the artifact lower only on FIRST mount (centaur-node-syncd.rs,
//! `!mounted_overlays.contains_key(...)` — re-hydrating would `remove_dir_all` a
//! live lowerdir), while the overlay signature covers extra lowers. Every later
//! tick therefore has to RE-ATTACH the hydrated lower to the rebuilt plan; a
//! bare rebuilt plan mismatches the signature and remounts the session without
//! its hydrated artifacts (see the companion test below, which pins that
//! remount-on-change semantic on purpose — warm claims rely on it).
//!
//! Needs Linux + root + a non-overlayfs TMPDIR (overlay upperdirs cannot live on
//! overlayfs; in a container, mount a tmpfs and point TMPDIR at it). Skips
//! silently otherwise, same as the other privileged on-node validations.

#![cfg(target_os = "linux")]

use std::collections::HashMap;
use std::fs;

use centaur_node_sync::cas::{
    CasHydrateEntry, hydrate_artifact_lower_into_plan, reattach_artifact_lower_into_plan,
};
use centaur_node_sync::overlay_mount::{mount_overlay, plan_overlay_mount, unmount_overlay};
use centaur_node_sync::runtime::AtriumClient;

const HYDRATED_BODY: &[u8] = b"hydrated by atrium\n";

struct FakeAtriumClient {
    entries: Vec<CasHydrateEntry>,
    bytes: HashMap<(String, u64), Vec<u8>>,
}

impl AtriumClient for FakeAtriumClient {
    fn post_capture(&mut self, _path: &str, _base_seq: u64, _bytes: &[u8]) -> Result<u64, String> {
        unreachable!("hydration repro does not capture artifacts")
    }

    fn post_delete(&mut self, _path: &str, _base_seq: u64) -> Result<u64, String> {
        unreachable!("hydration repro does not delete artifacts")
    }

    fn fetch_bytes(&mut self, path: &str, seq: u64) -> Result<Vec<u8>, String> {
        self.bytes
            .get(&(path.to_string(), seq))
            .cloned()
            .ok_or_else(|| format!("missing bytes for {path}@{seq}"))
    }

    fn hydration_scope(&self) -> Result<Vec<CasHydrateEntry>, String> {
        Ok(self.entries.clone())
    }

    fn atrium_changes(&self, since: &str) -> Result<(Vec<String>, String), String> {
        Ok((vec![], since.to_string()))
    }

    fn atrium_doc(&self, target_id: &str, doc: &str) -> Result<Vec<u8>, String> {
        Ok(format!("{target_id}/{doc}").into_bytes())
    }
}

fn test_root(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("hydration-it-{tag}-{}", std::process::id()))
}

#[test]
fn hydrated_artifact_lower_survives_subsequent_ticks() {
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("SKIP: hydrated_artifact_lower_survives_subsequent_ticks requires root");
        return;
    }

    let session = "hydration-persistence-it";
    let root = test_root("survives");
    let _ = fs::remove_dir_all(&root);
    let overlays_root = root.join("overlays");
    let merged = root.join("merged").join(session);
    fs::create_dir_all(&overlays_root).unwrap();
    fs::create_dir_all(&merged).unwrap();
    let cas_dir = root.join("cas");

    // Tick 1 — session first seen: the daemon hydrates the artifact lower into the
    // plan, then mounts (centaur-node-syncd.rs run loop).
    let mut plan = plan_overlay_mount(&overlays_root, session, &merged, "", &[], None).unwrap();
    let mut client = FakeAtriumClient {
        entries: vec![CasHydrateEntry {
            path: "shared/hydrated.md".to_string(),
            seq: 1,
            sha: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
        }],
        bytes: HashMap::from([(
            ("shared/hydrated.md".to_string(), 1),
            HYDRATED_BODY.to_vec(),
        )]),
    };
    let outcome =
        hydrate_artifact_lower_into_plan(&mut client, &cas_dir, &overlays_root, session, &mut plan)
            .unwrap();
    assert!(
        outcome.errors.is_empty(),
        "hydrate errors: {:?}",
        outcome.errors
    );
    let mounted = mount_overlay(plan, None).unwrap();
    assert_eq!(
        fs::read(merged.join("shared/hydrated.md")).unwrap(),
        HYDRATED_BODY,
        "tick 1: hydrated artifact must be visible after the first mount"
    );

    // Tick 2 — the session is now in the daemon's process-local mounted_overlays
    // map, so hydration is skipped, the plan is rebuilt from the manifest, and
    // the already-hydrated artifact lower is re-attached (centaur-node-syncd.rs
    // run loop, the `mounted_overlays.contains_key` else-branch). The mount must
    // stay idempotent: same session, same lowers on disk, nothing changed.
    let mut plan2 = plan_overlay_mount(&overlays_root, session, &merged, "", &[], None).unwrap();
    assert!(
        reattach_artifact_lower_into_plan(&overlays_root, session, &mut plan2),
        "tick 2: the hydrated artifact lower must re-attach to the rebuilt plan"
    );
    let remounted = mount_overlay(plan2, None).unwrap();

    let seen = fs::read(merged.join("shared/hydrated.md"));
    let _ = unmount_overlay(&remounted);
    let _ = unmount_overlay(&mounted);
    let _ = fs::remove_dir_all(&root);

    assert!(
        seen.is_ok(),
        "tick 2 dropped the hydrated artifact lower out of the live overlay: {}",
        seen.unwrap_err()
    );
    assert_eq!(seen.unwrap(), HYDRATED_BODY);
}

/// Daemon-RESTART regression: the process-local `mounted_overlays` map is empty
/// after a restart, so a live session looks first-seen. Re-running hydration
/// there would `remove_dir_all` an ACTIVE lowerdir — the mount keeps the old dir
/// inode pinned, so readdir goes empty, re-materialized files never appear, and
/// stale content serves until the dcache drops (characterized on real overlayfs;
/// see PR). The daemon therefore gates hydration on the NODE-level mount check
/// (`has_active_overlay_mount`), not just the map, and re-attaches instead:
/// this test replays that restart tick and asserts the agent's view is
/// untouched, with no re-fetch.
#[test]
fn daemon_restart_reattaches_live_mount_instead_of_rehydrating() {
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("SKIP: restart regression test requires root");
        return;
    }

    let session = "hydration-restart-it";
    let root = test_root("restart");
    let _ = fs::remove_dir_all(&root);
    let overlays_root = root.join("overlays");
    let merged = root.join("merged").join(session);
    fs::create_dir_all(&overlays_root).unwrap();
    fs::create_dir_all(&merged).unwrap();
    let cas_dir = root.join("cas");

    // Pre-restart life: hydrate v1 + mount (same as the daemon's first tick).
    let mut plan = plan_overlay_mount(&overlays_root, session, &merged, "", &[], None).unwrap();
    let mut client_v1 = FakeAtriumClient {
        entries: vec![CasHydrateEntry {
            path: "shared/hydrated.md".to_string(),
            seq: 1,
            sha: "1111111111111111111111111111111111111111111111111111111111111111".to_string(),
        }],
        bytes: HashMap::from([(
            ("shared/hydrated.md".to_string(), 1),
            HYDRATED_BODY.to_vec(),
        )]),
    };
    hydrate_artifact_lower_into_plan(&mut client_v1, &cas_dir, &overlays_root, session, &mut plan)
        .unwrap();
    let mounted = mount_overlay(plan, None).unwrap();
    assert_eq!(
        fs::read(merged.join("shared/hydrated.md")).unwrap(),
        HYDRATED_BODY
    );

    // --- daemon restarts: map empty, but the node-level mount is live, so the
    // daemon's tick takes the re-attach branch (centaur-node-syncd.rs,
    // `!has_active_mount && !mounted_overlays.contains_key(...)`). No hydration,
    // no fetches — just the rebuilt plan with the on-disk lower re-attached.
    let mut plan_restart =
        plan_overlay_mount(&overlays_root, session, &merged, "", &[], None).unwrap();
    assert!(
        reattach_artifact_lower_into_plan(&overlays_root, session, &mut plan_restart),
        "restart tick: the on-disk artifact lower must re-attach to the rebuilt plan"
    );
    let remounted = mount_overlay(plan_restart, None).unwrap();

    // The agent's view is untouched: same content, and readdir still works
    // (the destructive re-hydrate left readdir EMPTY while stale paths kept
    // serving — the worst kind of half-broken).
    assert_eq!(
        fs::read(merged.join("shared/hydrated.md")).unwrap(),
        HYDRATED_BODY,
        "restart must not disturb the hydrated artifact"
    );
    let listing: Vec<String> = fs::read_dir(merged.join("shared"))
        .unwrap()
        .filter_map(|entry| Some(entry.ok()?.file_name().to_string_lossy().into_owned()))
        .collect();
    let ok = listing == vec!["hydrated.md".to_string()];

    let _ = unmount_overlay(&remounted);
    let _ = unmount_overlay(&mounted);
    let _ = fs::remove_dir_all(&root);

    assert!(ok, "restart must keep readdir intact, got {listing:?}");
}

/// The companion invariant: a rebuilt plan that OMITS an extra lower is a real
/// signature change and MUST remount without it (this is how warm-claim manifest
/// rewrites re-compose a session's home). This is exactly why the daemon has to
/// re-attach the hydrated artifact lower on every tick — and it is the mechanism
/// that silently dropped hydrated artifacts before the re-attach existed.
#[test]
fn bare_rebuilt_plan_remounts_without_stale_extra_lowers() {
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("SKIP: bare_rebuilt_plan_remounts_without_stale_extra_lowers requires root");
        return;
    }

    let session = "hydration-bare-replan-it";
    let root = test_root("bare");
    let _ = fs::remove_dir_all(&root);
    let overlays_root = root.join("overlays");
    let merged = root.join("merged").join(session);
    fs::create_dir_all(&overlays_root).unwrap();
    fs::create_dir_all(&merged).unwrap();

    let extra = overlays_root.join("artifact-lower").join(session);
    fs::create_dir_all(extra.join("shared")).unwrap();
    fs::write(extra.join("shared/hydrated.md"), HYDRATED_BODY).unwrap();

    let mut plan = plan_overlay_mount(&overlays_root, session, &merged, "", &[], None).unwrap();
    plan.extra_lowers.push(extra);
    let mounted = mount_overlay(plan, None).unwrap();
    assert!(merged.join("shared/hydrated.md").exists());

    let bare = plan_overlay_mount(&overlays_root, session, &merged, "", &[], None).unwrap();
    let remounted = mount_overlay(bare, None).unwrap();

    let gone = !merged.join("shared/hydrated.md").exists();
    let _ = unmount_overlay(&remounted);
    let _ = unmount_overlay(&mounted);
    let _ = fs::remove_dir_all(&root);

    assert!(
        gone,
        "a plan omitting an extra lower must remount without it (signature change)"
    );
}
