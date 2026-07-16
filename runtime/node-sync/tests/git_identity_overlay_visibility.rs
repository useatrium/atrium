//! Pins the one thing a tempdir test can never see: the git author identity has to
//! be visible to the AGENT, which reads it through the overlay's merged view.
//!
//! We shipped this wrong once. The daemon wrote the identity into the overlay's
//! upperdir before mounting, which is fine for a cold create but silently useless
//! for a warm claim: a warm pod's overlay is already mounted minutes before the
//! claim that gives it an identity, and modifying an upperdir behind a live mount
//! is undefined behaviour. The file landed on disk, `ls` on the upper showed it,
//! every unit test passed — and the agent still committed as "Centaur AI", because
//! the merged view kept serving its cached negative dentry. The upper was left so
//! incoherent that a later mkdir through the mount failed with ESTALE.
//!
//! So: assert against the MERGED path, on a real overlay, with the mount already
//! established — the warm-claim shape. A unit test on a plain tempdir passes either
//! way and proves nothing.
//!
//! Needs Linux + root + a non-overlayfs TMPDIR (overlay upperdirs cannot live on
//! overlayfs; in a container, mount a tmpfs and point TMPDIR at it). Skips silently
//! otherwise, same as the other privileged on-node validations.

#![cfg(target_os = "linux")]

use std::fs;
use std::process::Command;

use centaur_node_sync::http_client::GitIdentity;
use centaur_node_sync::materializer::{GIT_IDENTITY_RELATIVE_PATH, materialize_git_identity};
use centaur_node_sync::overlay_mount::{mount_overlay, plan_overlay_mount, unmount_overlay};

fn identity() -> GitIdentity {
    // `source` rides the wire for observability but the daemon is a tolerant reader
    // and never needs it, so it is deliberately absent from this struct.
    GitIdentity {
        author_name: "Gary".to_string(),
        author_email: "10901359+gbasin@users.noreply.github.com".to_string(),
        session_id: "2f30f3db-e964-4e25-9371-7d323836c1c7".to_string(),
        harness: "codex".to_string(),
    }
}

fn git_get(file: &std::path::Path, key: &str) -> String {
    let out = Command::new("git")
        .current_dir("/")
        .args(["config", "--file"])
        .arg(file)
        .args(["--get", key])
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

/// The warm-claim shape: overlay ALREADY mounted, then the identity arrives.
#[test]
fn identity_written_after_mount_is_visible_through_the_merged_view() {
    if unsafe { libc::geteuid() } != 0 {
        eprintln!(
            "SKIP: identity_written_after_mount_is_visible_through_the_merged_view requires root"
        );
        return;
    }

    let session = "git-identity-visibility-it";
    let root = std::env::temp_dir().join(format!("gid-it-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let overlays_root = root.join("overlays");
    let merged = root.join("merged").join(session);
    fs::create_dir_all(&overlays_root).unwrap();
    fs::create_dir_all(&merged).unwrap();

    let plan = plan_overlay_mount(&overlays_root, session, &merged, "", &[], None).unwrap();
    let mounted = mount_overlay(plan, None).expect("overlay must mount");

    // The agent is already live against this mount at this point — exactly the warm
    // pod that has been sitting in the pool. NOW the claim's identity shows up.
    materialize_git_identity(&mounted, Some(&identity()), None).expect("materialize");

    let seen_by_agent = mounted.merged.join(GIT_IDENTITY_RELATIVE_PATH);
    assert!(
        seen_by_agent.exists(),
        "identity is invisible through the merged view — the agent would commit as the baked \
         image identity. This is the exact bug that shipped: writing via the upperdir of a live \
         overlay leaves the file on disk but out of the agent's view."
    );
    assert_eq!(
        git_get(&seen_by_agent, "user.email"),
        "10901359+gbasin@users.noreply.github.com"
    );
    assert_eq!(git_get(&seen_by_agent, "user.name"), "Gary");
    // The [atrium] block feeds the commit-msg hook's provenance trailers; it travels
    // in the same file, so emit both or neither.
    assert_eq!(
        git_get(&seen_by_agent, "atrium.sessionId"),
        "2f30f3db-e964-4e25-9371-7d323836c1c7"
    );
    assert_eq!(git_get(&seen_by_agent, "atrium.harness"), "codex");

    // A 204 must clear it through the same view, so a revoked identity cannot linger
    // and keep authoring as someone who no longer resolves.
    materialize_git_identity(&mounted, None, None).expect("204 removes");
    assert!(
        !seen_by_agent.exists(),
        "a 204 must remove the identity through the merged view, not just the upper"
    );

    unmount_overlay(&mounted).unwrap();
    let _ = fs::remove_dir_all(&root);
}
