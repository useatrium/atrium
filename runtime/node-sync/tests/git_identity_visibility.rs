//! Pins the property the git-identity design rests on: the agent must SEE the identity
//! after its own earlier lookup already missed.
//!
//! This is not a hypothetical ordering. `entrypoint.sh` runs `git config` at POD
//! CREATION; git reads /opt/centaur/gitconfig, resolves the `[include]` target, gets
//! ENOENT, and the kernel caches a NEGATIVE dentry for that path — minutes before the
//! claim that even knows who the user is. So by the time node-sync writes the identity,
//! the lookup has ALREADY missed. Whether the agent ever sees the file is decided
//! entirely by whether that negative entry gets invalidated.
//!
//! It does not on the agent's overlay home: overlay mount INSTANCES keep independent
//! dentry trees, so a create from the node side (upper OR merged — both were shipped,
//! both failed) leaves the pod's negative entry intact. The forensic signature is
//! readdir listing the file while lookup returns ENOENT.
//!
//! It does on a bind mount of a single ext4 superblock, which shares one dentry tree —
//! and that is exactly what `~/context` is. Hence the identity lives in the context
//! root. Measured on a live prod pod, both ways, before this was written.
//!
//! So the assertion here is deliberately shaped like the bug: mount, MISS, write, hit.
//! A test that writes before looking up passes on both the broken and fixed designs and
//! proves nothing — that is precisely how this shipped twice.
//!
//! Needs Linux + root (bind mounts). Skips silently otherwise, same as the other
//! privileged on-node validations. CI runs it under sudo — see centaur-ci.yml; the
//! unprivileged `cargo test` lane reports this file as "ok" while skipping every case.

#![cfg(target_os = "linux")]

use std::fs;
use std::path::Path;
use std::process::Command;

use centaur_node_sync::http_client::GitIdentity;
use centaur_node_sync::materializer::{GIT_IDENTITY_FILE, materialize_git_identity};

fn identity() -> GitIdentity {
    GitIdentity {
        author_name: "Gary".to_string(),
        author_email: "10901359+gbasin@users.noreply.github.com".to_string(),
        session_id: "a5aabc97-3382-4ab8-b84c-1a1c2a4f7013".to_string(),
        harness: "codex".to_string(),
    }
}

fn git_get(file: &Path, key: &str) -> String {
    let out = Command::new("git")
        .current_dir("/")
        .args(["config", "--file"])
        .arg(file)
        .args(["--get", key])
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn is_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

/// node-sync writes into the context root; the agent reads the same bytes through the
/// bind mount at ~/context — even though it already looked and found nothing.
#[test]
fn identity_is_visible_through_the_bind_mount_after_a_failed_lookup() {
    if !is_root() {
        eprintln!(
            "SKIP: identity_is_visible_through_the_bind_mount_after_a_failed_lookup requires root"
        );
        return;
    }

    let root = std::env::temp_dir().join(format!("gid-bind-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    // `node_side` is what the daemon writes (scoped_atrium_root); `pod_side` is what the
    // agent reads (~/context). One superblock, two mount points — the real topology.
    let node_side = root.join("var-lib-centaur-atrium-sess");
    let pod_side = root.join("home-agent-context");
    fs::create_dir_all(&node_side).unwrap();
    fs::create_dir_all(&pod_side).unwrap();

    let status = Command::new("mount")
        .args(["--bind"])
        .arg(&node_side)
        .arg(&pod_side)
        .status()
        .unwrap();
    assert!(status.success(), "bind mount must succeed");

    let seen_by_agent = pod_side.join(GIT_IDENTITY_FILE);

    // THE POISON STEP: the agent (via git's include resolution at pod creation) looks
    // first and misses. Everything after this is only meaningful because of this line.
    assert!(
        !seen_by_agent.exists(),
        "precondition: the agent's lookup must miss before the identity is written"
    );

    materialize_git_identity(&node_side, Some(&identity()), None).expect("materialize");

    assert!(
        seen_by_agent.exists(),
        "identity written to the context root is invisible through the bind mount after a \
         failed lookup — the agent would commit as the baked image identity. If this fails, \
         the identity was moved onto a mount whose dentry tree the agent does not share \
         (an overlay home); see the doc comment on materialize_git_identity."
    );
    assert_eq!(
        git_get(&seen_by_agent, "user.email"),
        "10901359+gbasin@users.noreply.github.com"
    );
    assert_eq!(git_get(&seen_by_agent, "user.name"), "Gary");
    // The [atrium] block feeds the commit-msg hook's provenance trailers; same file, so
    // emit both or neither.
    assert_eq!(
        git_get(&seen_by_agent, "atrium.sessionId"),
        "a5aabc97-3382-4ab8-b84c-1a1c2a4f7013"
    );
    assert_eq!(git_get(&seen_by_agent, "atrium.harness"), "codex");

    // A 204 must clear it through the same view, so a revoked identity cannot keep
    // authoring as someone who no longer resolves.
    materialize_git_identity(&node_side, None, None).expect("204 removes");
    assert!(
        !seen_by_agent.exists(),
        "a 204 must remove the identity as the agent sees it, not just on the node"
    );

    let _ = Command::new("umount").arg(&pod_side).status();
    let _ = fs::remove_dir_all(&root);
}
