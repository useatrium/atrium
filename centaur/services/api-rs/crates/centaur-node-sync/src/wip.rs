//! WIP capture for uncommitted repo work (§5A, DECIDED: pure-read patch-artifact,
//! NOT a git ref). Repo files are excluded from the shared artifact lane (branch-
//! incoherent), so git only makes work durable at commit. The node captures a
//! session-scoped **read-only** recovery snapshot: `git diff --binary HEAD` plus
//! non-ignored untracked files under `scratch/wip/<repo-key>/...`, creating ZERO
//! git objects or refs other agents could trip over. Recovery = re-clone at
//! `base_head_sha`, `git apply` the diff, drop in the untracked files.
//!
//! Trade-off (accepted): a recovery point, not a faithful clone — in-progress
//! rebase/merge, staged-vs-unstaged, and submodule state aren't captured.

use crate::overlay::{RawEntry, RawFileType};
use crate::secret;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::process::Command;

pub const WIP_SCRATCH_ROOT: &str = "scratch/wip";
pub const DEFAULT_MAX_UNTRACKED_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct WipPatch {
    pub base_head_sha: String,
    /// `git diff HEAD` (tracked changes, binary-safe).
    pub diff: String,
    /// Untracked, .gitignore-respected files: (relpath, bytes).
    pub untracked: Vec<(String, Vec<u8>)>,
}

impl WipPatch {
    pub fn is_empty(&self) -> bool {
        self.diff.is_empty() && self.untracked.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WipSnapshotManifest {
    pub version: u32,
    pub repo_key: String,
    pub snapshot_id: String,
    pub base_head_sha: String,
    pub patch_path: String,
    pub untracked_prefix: String,
}

#[derive(Debug, Clone)]
pub struct WipSnapshot {
    pub manifest: WipSnapshotManifest,
    /// Files that make up this snapshot, excluding `latest.json`. The caller
    /// should publish these first and `latest.json` last as the commit point.
    pub files: Vec<(String, Vec<u8>, &'static str)>,
    pub latest_path: String,
    pub latest_bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WipGateReason {
    FirstSight,
    Changed,
    Forced,
    FailOpen,
    Unchanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WipGateDecision {
    pub should_capture: bool,
    pub reason: WipGateReason,
}

pub fn repo_signature(entries: &[RawEntry], repo_upper_prefix: &Path) -> u64 {
    let mut items = entries
        .iter()
        .filter_map(|entry| {
            let rel_path = entry.rel_path.strip_prefix(repo_upper_prefix).ok()?;
            // capture_wip's own `git diff` opportunistically refreshes the stat
            // cache, rewriting .git/index (and transient .git lock files) — with
            // those in the signature, a dirty worktree makes every WIP run
            // re-trigger the gate forever (observed live: two stale sessions
            // re-capturing 19 paths every ~1.3s tick). `git diff HEAD` output is
            // independent of staging state, so excluding the index loses no
            // capturable change; commits still land via refs/objects/logs.
            if rel_path == Path::new(".git/index")
                || (rel_path.starts_with(".git")
                    && rel_path.extension().is_some_and(|ext| ext == "lock"))
            {
                return None;
            }
            // Directory entries under .git carry only mtimes, and git bumps
            // them via the index.lock create/rename/delete cycle on every
            // `git diff` that refreshes the stat cache — the second half of
            // the WIP self-trigger loop (child entries still carry every real
            // change: new refs/objects appear as their own file entries).
            if rel_path.starts_with(".git") && matches!(entry.file_type, RawFileType::Dir) {
                return None;
            }
            Some((
                rel_path.to_path_buf(),
                entry.size,
                entry.mtime_ns,
                raw_file_type_discriminant(&entry.file_type),
            ))
        })
        .collect::<Vec<_>>();
    items.sort();

    let mut hasher = DefaultHasher::new();
    items.hash(&mut hasher);
    hasher.finish()
}

fn raw_file_type_discriminant(file_type: &RawFileType) -> u8 {
    match file_type {
        RawFileType::Regular => 0,
        RawFileType::Dir => 1,
        RawFileType::CharDevice => 2,
        RawFileType::Symlink => 3,
        RawFileType::Other => 4,
    }
}

pub fn decide_wip_capture(
    previous_signature: Option<u64>,
    current_signature: Option<u64>,
    force: bool,
) -> WipGateDecision {
    if force {
        return WipGateDecision {
            should_capture: true,
            reason: WipGateReason::Forced,
        };
    }
    let Some(current) = current_signature else {
        return WipGateDecision {
            should_capture: true,
            reason: WipGateReason::FailOpen,
        };
    };
    let Some(previous) = previous_signature else {
        return WipGateDecision {
            should_capture: true,
            reason: WipGateReason::FirstSight,
        };
    };
    if previous != current {
        WipGateDecision {
            should_capture: true,
            reason: WipGateReason::Changed,
        }
    } else {
        WipGateDecision {
            should_capture: false,
            reason: WipGateReason::Unchanged,
        }
    }
}

pub fn should_force_wip(remounted: bool, restored: bool, backstop_elapsed: bool) -> bool {
    remounted || restored || backstop_elapsed
}

fn git(repo: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(args)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(out.stdout)
}

/// Capture the repo's uncommitted working state. PURE READ — runs only `rev-parse`,
/// `diff`, and `ls-files`; never `add`/`commit`/`write`, so it touches no
/// ref/index/object the fleet can see.
pub fn capture_wip(repo: &Path) -> Result<WipPatch, String> {
    capture_wip_with_limits(repo, DEFAULT_MAX_UNTRACKED_BYTES)
}

pub fn capture_wip_with_limits(repo: &Path, max_untracked_bytes: u64) -> Result<WipPatch, String> {
    let base_head_sha = String::from_utf8_lossy(&git(repo, &["rev-parse", "HEAD"])?)
        .trim()
        .to_string();
    let diff = String::from_utf8_lossy(&git(
        repo,
        &["diff", "--binary", "--full-index", "HEAD", "--"],
    )?)
    .into_owned();

    // Untracked, gitignore-respected. -z = NUL-separated (safe for odd names).
    let raw = git(repo, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let mut untracked = Vec::new();
    for name in raw.split(|b| *b == 0).filter(|s| !s.is_empty()) {
        let rel = String::from_utf8_lossy(name).into_owned();
        if let Some(bytes) = read_untracked_file(repo, &rel, max_untracked_bytes) {
            untracked.push((rel, bytes));
        }
    }
    Ok(WipPatch {
        base_head_sha,
        diff,
        untracked,
    })
}

fn read_untracked_file(repo: &Path, rel: &str, max_bytes: u64) -> Option<Vec<u8>> {
    let rel_path = Path::new(rel);
    if !safe_relpath(rel_path) {
        return None;
    }
    let path = repo.join(rel_path);
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.file_type().is_file() || meta.len() > max_bytes {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    if secret::is_secret(rel_path, &bytes[..bytes.len().min(4096)]) {
        return None;
    }
    Some(bytes)
}

fn safe_relpath(path: &Path) -> bool {
    let mut saw_component = false;
    for component in path.components() {
        match component {
            std::path::Component::Normal(_) => saw_component = true,
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => return false,
        }
    }
    saw_component
}

pub fn sanitize_repo_key(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "repo".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn latest_path(repo_key: &str) -> String {
    format!(
        "{WIP_SCRATCH_ROOT}/{}/latest.json",
        sanitize_repo_key(repo_key)
    )
}

pub fn snapshot_from_patch(
    repo_key: &str,
    patch: &WipPatch,
) -> Result<Option<WipSnapshot>, String> {
    if patch.is_empty() {
        return Ok(None);
    }
    let repo_key = sanitize_repo_key(repo_key);
    let snapshot_id = snapshot_id(&repo_key, patch);
    let root = format!("{WIP_SCRATCH_ROOT}/{repo_key}/snapshots/{snapshot_id}");
    let patch_path = format!("{root}/patch.diff");
    let untracked_prefix = format!("{root}/untracked");
    let manifest_path = format!("{root}/manifest.json");
    let latest_path = latest_path(&repo_key);

    let manifest = WipSnapshotManifest {
        version: 1,
        repo_key,
        snapshot_id,
        base_head_sha: patch.base_head_sha.clone(),
        patch_path: patch_path.clone(),
        untracked_prefix: untracked_prefix.clone(),
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    let latest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    let mut files = vec![
        (patch_path, patch.diff.clone().into_bytes(), "text/x-diff"),
        (manifest_path, manifest_bytes, "application/json"),
    ];
    for (rel, bytes) in &patch.untracked {
        if safe_relpath(Path::new(rel)) {
            files.push((
                format!("{untracked_prefix}/{rel}"),
                bytes.clone(),
                "application/octet-stream",
            ));
        }
    }
    Ok(Some(WipSnapshot {
        manifest,
        files,
        latest_path,
        latest_bytes,
    }))
}

fn snapshot_id(repo_key: &str, patch: &WipPatch) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    fn feed(h: &mut u64, bytes: &[u8]) {
        for b in bytes {
            *h ^= *b as u64;
            *h = h.wrapping_mul(0x100000001b3);
        }
    }
    feed(&mut h, repo_key.as_bytes());
    feed(&mut h, patch.base_head_sha.as_bytes());
    feed(&mut h, patch.diff.as_bytes());
    let mut untracked = patch.untracked.clone();
    untracked.sort_by(|a, b| a.0.cmp(&b.0));
    for (rel, bytes) in untracked {
        feed(&mut h, rel.as_bytes());
        feed(&mut h, &bytes);
    }
    format!("{h:016x}")
}

pub fn restore_snapshot(
    repo: &Path,
    scratch_root: &Path,
    manifest: &WipSnapshotManifest,
) -> Result<(), String> {
    validate_manifest_paths(manifest)?;
    let current_head = String::from_utf8_lossy(&git(repo, &["rev-parse", "HEAD"])?)
        .trim()
        .to_string();
    if current_head != manifest.base_head_sha {
        return Err(format!(
            "base HEAD mismatch for {}: have {current_head}, snapshot expects {}",
            manifest.repo_key, manifest.base_head_sha
        ));
    }
    if !git_status_clean(repo)? {
        return Err(format!(
            "repo {} is not clean; refusing WIP restore",
            repo.display()
        ));
    }

    let patch_path = scratch_root.join(&manifest.patch_path);
    let patch = std::fs::read(&patch_path)
        .map_err(|e| format!("read WIP patch {}: {e}", patch_path.display()))?;
    if !patch.is_empty() {
        git_apply(repo, &patch, true)?;
        git_apply(repo, &patch, false)?;
    }
    restore_untracked(repo, scratch_root, manifest)?;
    Ok(())
}

fn validate_manifest_paths(manifest: &WipSnapshotManifest) -> Result<(), String> {
    let repo_key = sanitize_repo_key(&manifest.repo_key);
    if repo_key != manifest.repo_key {
        return Err(format!("invalid WIP repo key {:?}", manifest.repo_key));
    }
    if !safe_path_segment(&manifest.snapshot_id) {
        return Err(format!(
            "invalid WIP snapshot id {:?}",
            manifest.snapshot_id
        ));
    }
    let expected_prefix = format!(
        "{WIP_SCRATCH_ROOT}/{repo_key}/snapshots/{}/",
        manifest.snapshot_id
    );
    for path in [&manifest.patch_path, &manifest.untracked_prefix] {
        if !safe_relpath(Path::new(path)) || !path.starts_with(&expected_prefix) {
            return Err(format!("invalid WIP manifest path {path:?}"));
        }
    }
    if !manifest.patch_path.ends_with("/patch.diff") {
        return Err(format!("invalid WIP patch path {:?}", manifest.patch_path));
    }
    if !manifest.untracked_prefix.ends_with("/untracked") {
        return Err(format!(
            "invalid WIP untracked prefix {:?}",
            manifest.untracked_prefix
        ));
    }
    Ok(())
}

fn safe_path_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-')
}

fn git_status_clean(repo: &Path) -> Result<bool, String> {
    let diff = Command::new("git")
        .arg("-C")
        .arg(repo)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(["diff", "--quiet", "HEAD", "--"])
        .status()
        .map_err(|e| format!("spawn git diff --quiet: {e}"))?;
    if !diff.success() {
        return Ok(false);
    }
    let raw = git(repo, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    Ok(raw.is_empty())
}

fn git_apply(repo: &Path, patch: &[u8], check: bool) -> Result<(), String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(repo)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .arg("apply")
        .arg("--whitespace=nowarn");
    if check {
        cmd.arg("--check");
    }
    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn git apply: {e}"))?;
    {
        use std::io::Write;
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "git apply stdin unavailable".to_string())?;
        stdin.write_all(patch).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "git apply{} failed: {}",
            if check { " --check" } else { "" },
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

fn restore_untracked(
    repo: &Path,
    scratch_root: &Path,
    manifest: &WipSnapshotManifest,
) -> Result<(), String> {
    let prefix = scratch_root.join(&manifest.untracked_prefix);
    if !prefix.exists() {
        return Ok(());
    }
    let mut stack = vec![prefix.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("read {}: {e}", dir.display()))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let file_type = entry.file_type().map_err(|e| e.to_string())?;
            if file_type.is_dir() {
                stack.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(&prefix)
                .map_err(|e| e.to_string())?
                .to_path_buf();
            if !safe_relpath(&rel) {
                continue;
            }
            let dst = repo.join(&rel);
            if dst.exists() {
                return Err(format!("refusing to overwrite untracked {}", dst.display()));
            }
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(entry.path(), &dst)
                .map_err(|e| format!("restore {}: {e}", dst.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    fn sh(repo: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    // A unique temp dir without Date/rand (sandbox bans them): use the test's
    // module path + the repo-relative pid via std::process.
    fn tmp_repo(tag: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!("wip-it-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn raw(path: &str, size: u64, mtime_ns: i64, file_type: RawFileType) -> RawEntry {
        RawEntry {
            rel_path: PathBuf::from(path),
            file_type,
            rdev: 0,
            size,
            mtime_ns,
            xattrs: vec![],
        }
    }

    fn signature_entries() -> Vec<RawEntry> {
        vec![
            raw("repos/acme/app/src/main.rs", 10, 100, RawFileType::Regular),
            raw(
                "repos/acme/app/.git/refs/heads/main",
                20,
                200,
                RawFileType::Regular,
            ),
            raw("repos/acme/app/src", 0, 300, RawFileType::Dir),
            raw(
                "repos/acme/other/src/main.rs",
                999,
                999,
                RawFileType::Regular,
            ),
        ]
    }

    #[test]
    fn repo_signature_ignores_git_index_and_git_lock_files() {
        let prefix = Path::new("repos/acme/app");
        let base = signature_entries();
        let with_index_churn = {
            let mut entries = base.clone();
            entries.push(raw(
                "repos/acme/app/.git/index",
                999,
                12345,
                RawFileType::Regular,
            ));
            entries.push(raw(
                "repos/acme/app/.git/index.lock",
                1,
                1,
                RawFileType::Regular,
            ));
            entries
        };
        // .git/index (rewritten by capture_wip's own git diff) and .git lock
        // files must not perturb the signature — regression pin for the live
        // WIP self-trigger loop.
        assert_eq!(
            repo_signature(&base, prefix),
            repo_signature(&with_index_churn, prefix)
        );
        // .git DIRECTORY entries (mtime bumped by the lock cycle on every
        // git diff) must not perturb it either.
        let with_git_dir_mtime = {
            let mut entries = base.clone();
            entries.push(raw("repos/acme/app/.git", 0, 777, RawFileType::Dir));
            entries.push(raw("repos/acme/app/.git/refs", 0, 888, RawFileType::Dir));
            entries
        };
        assert_eq!(
            repo_signature(&base, prefix),
            repo_signature(&with_git_dir_mtime, prefix)
        );
        // But real .git content (refs/objects) still counts.
        let mut with_new_ref = base.clone();
        with_new_ref.push(raw(
            "repos/acme/app/.git/refs/heads/feature",
            5,
            5,
            RawFileType::Regular,
        ));
        assert_ne!(
            repo_signature(&base, prefix),
            repo_signature(&with_new_ref, prefix)
        );
    }

    #[test]
    fn repo_signature_identical_input_is_identical_and_order_independent() {
        let prefix = Path::new("repos/acme/app");
        let entries = signature_entries();
        let mut reversed = entries.clone();
        reversed.reverse();

        assert_eq!(
            repo_signature(&entries, prefix),
            repo_signature(&reversed, prefix)
        );
    }

    #[test]
    fn repo_signature_differs_on_size_only_change() {
        let prefix = Path::new("repos/acme/app");
        let mut changed = signature_entries();
        changed[0].size += 1;

        assert_ne!(
            repo_signature(&signature_entries(), prefix),
            repo_signature(&changed, prefix)
        );
    }

    #[test]
    fn repo_signature_differs_on_mtime_only_change() {
        let prefix = Path::new("repos/acme/app");
        let mut changed = signature_entries();
        changed[0].mtime_ns += 1;

        assert_ne!(
            repo_signature(&signature_entries(), prefix),
            repo_signature(&changed, prefix)
        );
    }

    #[test]
    fn repo_signature_differs_on_added_deleted_path_and_file_type_change() {
        let prefix = Path::new("repos/acme/app");
        let base = signature_entries();

        let mut added = base.clone();
        added.push(raw("repos/acme/app/new.txt", 1, 1, RawFileType::Regular));
        assert_ne!(
            repo_signature(&base, prefix),
            repo_signature(&added, prefix)
        );

        let deleted = base[1..].to_vec();
        assert_ne!(
            repo_signature(&base, prefix),
            repo_signature(&deleted, prefix)
        );

        let mut type_changed = base.clone();
        type_changed[0].file_type = RawFileType::Symlink;
        assert_ne!(
            repo_signature(&base, prefix),
            repo_signature(&type_changed, prefix)
        );
    }

    #[test]
    fn repo_signature_includes_git_paths_and_ignores_outside_prefix() {
        let prefix = Path::new("repos/acme/app");
        let base = signature_entries();
        let mut git_changed = base.clone();
        git_changed[1].mtime_ns += 1;
        assert_ne!(
            repo_signature(&base, prefix),
            repo_signature(&git_changed, prefix),
            ".git changes must affect the signature"
        );

        let mut outside_changed = base.clone();
        outside_changed[3].size += 1;
        outside_changed.push(raw("repos/acme/other/new.txt", 1, 1, RawFileType::Regular));
        assert_eq!(
            repo_signature(&base, prefix),
            repo_signature(&outside_changed, prefix)
        );
    }

    #[test]
    fn wip_gate_fires_on_first_sight_skips_unchanged_and_fires_on_changed() {
        assert_eq!(
            decide_wip_capture(None, Some(10), false),
            WipGateDecision {
                should_capture: true,
                reason: WipGateReason::FirstSight
            }
        );
        assert_eq!(
            decide_wip_capture(Some(10), Some(10), false),
            WipGateDecision {
                should_capture: false,
                reason: WipGateReason::Unchanged
            }
        );
        assert_eq!(
            decide_wip_capture(Some(10), Some(11), false),
            WipGateDecision {
                should_capture: true,
                reason: WipGateReason::Changed
            }
        );
    }

    #[test]
    fn wip_gate_force_fires_on_remount_restore_or_backstop() {
        assert!(should_force_wip(true, false, false));
        assert!(should_force_wip(false, true, false));
        assert!(should_force_wip(false, false, true));
        assert!(!should_force_wip(false, false, false));
        assert_eq!(
            decide_wip_capture(Some(10), Some(10), true),
            WipGateDecision {
                should_capture: true,
                reason: WipGateReason::Forced
            }
        );
    }

    #[test]
    fn captures_tracked_diff_and_untracked_without_writing_refs() {
        if Command::new("git").arg("--version").output().is_err() {
            eprintln!("git absent; skipping");
            return;
        }
        let repo = tmp_repo("a");
        sh(&repo, &["init", "-q"]);
        sh(&repo, &["config", "user.email", "t@t"]);
        sh(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("tracked.txt"), "v1\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-qm", "init"]);

        // uncommitted work: modify tracked + add untracked
        fs::write(repo.join("tracked.txt"), "v1\nWIP edit\n").unwrap();
        fs::write(repo.join("scratch.txt"), "brand new\n").unwrap();

        let refs_before = git(&repo, &["show-ref"]).unwrap_or_default();
        let wip = capture_wip(&repo).unwrap();
        let refs_after = git(&repo, &["show-ref"]).unwrap_or_default();

        assert_eq!(wip.base_head_sha.len(), 40);
        assert!(
            wip.diff.contains("WIP edit"),
            "diff carries the tracked change"
        );
        assert!(
            wip.untracked
                .iter()
                .any(|(p, b)| p == "scratch.txt" && b == b"brand new\n"),
            "untracked file captured with bytes",
        );
        // the key invariant: capture created NO refs/objects the fleet can see.
        assert_eq!(
            refs_before, refs_after,
            "capture_wip must not write any git ref"
        );

        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn capture_wip_respects_gitignore_and_filters_large_and_secret_untracked() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let repo = tmp_repo("filters");
        sh(&repo, &["init", "-q"]);
        sh(&repo, &["config", "user.email", "t@t"]);
        sh(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join(".gitignore"), "dist/\n*.large\n").unwrap();
        fs::write(repo.join("tracked.txt"), "v1\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-qm", "init"]);

        fs::create_dir_all(repo.join("dist")).unwrap();
        fs::write(repo.join("dist/bundle.js"), "ignored\n").unwrap();
        fs::write(repo.join("keep.txt"), "keep\n").unwrap();
        fs::write(repo.join("skip.large"), "ignored by pattern\n").unwrap();
        fs::write(repo.join("too-big.txt"), "0123456789").unwrap();
        fs::write(
            repo.join("secret.txt"),
            "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
        )
        .unwrap();

        let wip = capture_wip_with_limits(&repo, 6).unwrap();
        let paths: Vec<&str> = wip.untracked.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, vec!["keep.txt"]);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn snapshot_paths_are_session_scratch_and_latest_is_separate() {
        let patch = WipPatch {
            base_head_sha: "abc123".into(),
            diff: "diff --git a/x b/x\n".into(),
            untracked: vec![("new.txt".into(), b"hi".to_vec())],
        };
        let snapshot = snapshot_from_patch("acme/foo", &patch).unwrap().unwrap();
        assert_eq!(snapshot.manifest.repo_key, "acme_foo");
        assert_eq!(snapshot.latest_path, "scratch/wip/acme_foo/latest.json");
        assert!(
            snapshot
                .files
                .iter()
                .any(|(p, _, _)| p.ends_with("/patch.diff"))
        );
        assert!(
            snapshot
                .files
                .iter()
                .any(|(p, _, _)| p.ends_with("/untracked/new.txt"))
        );
        assert!(
            snapshot_from_patch(
                "repo",
                &WipPatch {
                    base_head_sha: "abc123".into(),
                    diff: String::new(),
                    untracked: vec![],
                }
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn restore_snapshot_applies_patch_and_untracked_files() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let repo = tmp_repo("restore");
        let scratch = tmp_repo("scratch");
        sh(&repo, &["init", "-q"]);
        sh(&repo, &["config", "user.email", "t@t"]);
        sh(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("tracked.txt"), "v1\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-qm", "init"]);

        fs::write(repo.join("tracked.txt"), "v1\nWIP edit\n").unwrap();
        fs::write(repo.join("new.txt"), "brand new\n").unwrap();
        let patch = capture_wip(&repo).unwrap();
        let snapshot = snapshot_from_patch("repo", &patch).unwrap().unwrap();
        sh(&repo, &["reset", "--hard", "HEAD"]);
        let _ = fs::remove_file(repo.join("new.txt"));
        for (path, bytes, _) in &snapshot.files {
            let dst = scratch.join(path);
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(dst, bytes).unwrap();
        }

        restore_snapshot(&repo, &scratch, &snapshot.manifest).unwrap();
        assert_eq!(
            fs::read_to_string(repo.join("tracked.txt")).unwrap(),
            "v1\nWIP edit\n"
        );
        assert_eq!(
            fs::read_to_string(repo.join("new.txt")).unwrap(),
            "brand new\n"
        );

        let _ = fs::remove_dir_all(&repo);
        let _ = fs::remove_dir_all(&scratch);
    }

    #[test]
    fn restore_snapshot_rejects_manifest_path_escape() {
        let manifest = WipSnapshotManifest {
            version: 1,
            repo_key: "repo".to_string(),
            snapshot_id: "snap".to_string(),
            base_head_sha: "abc123".to_string(),
            patch_path: "/tmp/evil.patch".to_string(),
            untracked_prefix: "scratch/wip/repo/snapshots/snap/untracked".to_string(),
        };
        let err =
            restore_snapshot(Path::new("/no/repo"), Path::new("/scratch"), &manifest).unwrap_err();
        assert!(err.contains("invalid WIP manifest path"));
    }

    #[test]
    fn clean_repo_yields_empty_patch() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let repo = tmp_repo("b");
        sh(&repo, &["init", "-q"]);
        sh(&repo, &["config", "user.email", "t@t"]);
        sh(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("f.txt"), "x\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-qm", "init"]);

        let wip = capture_wip(&repo).unwrap();
        assert!(wip.is_empty(), "no uncommitted work → empty patch");
        let _ = fs::remove_dir_all(&repo);
    }
}
