//! Warm-cache depcache hydrator (Phase 2.2). Standalone, node-level — it does NOT
//! touch the overlay lower/upper machinery. Given a session's repo + ref, it reads
//! the dependency lockfiles from the node repo-cache (via `git show <ref>:<file>`,
//! no checkout), hashes each, and pulls the matching dependency STORE from Atrium
//! CAS into Phase-1's node depcache (`/var/lib/centaur/depcache/<dest>`), reflinked.
//! Ships relocatable stores (pnpm store, cargo registry) — never node_modules/target
//! (stress-test-validated: see docs/warmcache-tier-design.md).

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use sha2::{Digest, Sha256};

use crate::cas::{CasHydrateEntry, materialize_cached};
use crate::runtime::AtriumClient;

/// Defensive cap on a single warm-cache blob — never buffer an unbounded body into
/// the node daemon (a store file is small; this guards a bad/oversized manifest entry).
pub const MAX_WARMCACHE_BLOB_BYTES: u64 = 256 * 1024 * 1024;

/// A dependency ecosystem: which lockfile keys it, and where its store lands in
/// the node depcache (the `dest_subdir` must match the entrypoint's cache redirects).
pub struct LockfileKind {
    pub kind: &'static str,
    pub lockfile: &'static str,
    pub dest_subdir: &'static str,
}

/// Ecosystems hydrated today — relocatable stores only (NOT node_modules/target).
pub const DEFAULT_KINDS: &[LockfileKind] = &[
    LockfileKind {
        kind: "pnpm",
        lockfile: "pnpm-lock.yaml",
        dest_subdir: "pnpm-store",
    },
    LockfileKind {
        kind: "cargo",
        lockfile: "Cargo.lock",
        dest_subdir: "cargo/registry",
    },
    LockfileKind {
        kind: "uv",
        lockfile: "uv.lock",
        dest_subdir: "uv",
    },
];

#[derive(Debug, Default, PartialEq, Eq)]
pub struct KindStats {
    pub kind: String,
    pub lockfile_hash: String,
    pub entries: usize,
    pub fetched: u64,
    pub reflinked: u64,
    pub copied: u64,
    pub errors: usize,
    /// First error message (manifest fetch or materialize), for diagnostics.
    pub error: Option<String>,
}

#[derive(Debug, Default)]
pub struct HydrateStats {
    pub kinds: Vec<KindStats>,
}

/// Read a file at a git ref from the node repo-cache without checking it out.
/// Tries the ref as given and the `origin/<ref>` remote-tracking form (the cache is
/// populated by `git fetch origin`, so branches live under refs/remotes/origin).
/// Returns None when the ref or file is absent (a cold/uninstalled ecosystem).
fn git_show(repo_dir: &Path, git_ref: &str, file: &str) -> Option<Vec<u8>> {
    // A ref beginning with '-' would be parsed by git as an option (e.g. `-p` →
    // diff output instead of file bytes, or `--output=` → write a file). Never trust one.
    if git_ref.is_empty() || git_ref.starts_with('-') {
        return None;
    }
    for r in [git_ref.to_string(), format!("origin/{git_ref}")] {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo_dir)
            .arg("show")
            .arg(format!("{r}:{file}"))
            .output()
            .ok()?;
        if out.status.success() {
            return Some(out.stdout);
        }
    }
    None
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

/// Hydrate the node depcache for one repo's dependency sets from Atrium CAS. For
/// each ecosystem whose lockfile is present at `git_ref`, hash the lockfile, fetch
/// the warm-cache manifest, and reflink each store blob into `<depcache>/<dest>`.
/// A cold dependency set (no manifest) is skipped — the agent installs normally.
pub fn hydrate_depcache(
    client: &mut dyn AtriumClient,
    repo_cache_root: &Path,
    repo: &str,
    git_ref: &str,
    depcache_root: &Path,
    cas_dir: &Path,
    kinds: &[LockfileKind],
) -> HydrateStats {
    let repo_dir = repo_cache_root.join(repo);
    let mut stats = HydrateStats::default();
    for k in kinds {
        let Some(lockfile_bytes) = git_show(&repo_dir, git_ref, k.lockfile) else {
            continue;
        };
        let lockfile_hash = sha256_hex(&lockfile_bytes);
        let manifest = match client.warmcache_manifest(&lockfile_hash, k.kind) {
            Ok(m) if !m.is_empty() => m,
            Ok(_) => continue, // cold: no cache for this dep set yet
            Err(err) => {
                stats.kinds.push(KindStats {
                    kind: k.kind.to_string(),
                    lockfile_hash,
                    errors: 1,
                    error: Some(err),
                    ..Default::default()
                });
                continue;
            }
        };
        // Dedupe by path (last wins) so the CAS key (entry.sha) and the fetch
        // closure (sha_by_path) can never disagree — Atrium's manifest is already
        // path-unique (PK), but defend independently. Skip oversized blobs up front
        // so a bad/huge entry can't OOM the node daemon.
        let mut oversize = 0usize;
        let mut sha_by_path: HashMap<String, String> = HashMap::new();
        for e in &manifest {
            if e.size_bytes > MAX_WARMCACHE_BLOB_BYTES {
                oversize += 1;
                continue;
            }
            sha_by_path.insert(e.path.clone(), e.sha256.clone());
        }
        let entries: Vec<CasHydrateEntry> = sha_by_path
            .iter()
            .map(|(path, sha)| CasHydrateEntry {
                path: path.clone(),
                seq: 0,
                sha: sha.clone(),
            })
            .collect();
        let dest = depcache_root.join(k.dest_subdir);
        let outcome = materialize_cached(&entries, cas_dir, &dest, |path, _seq| {
            let sha = sha_by_path
                .get(path)
                .ok_or_else(|| format!("warmcache manifest has no sha for {path}"))?;
            let bytes = client.fetch_cache_blob(sha)?;
            // Integrity: never cache bytes that don't match the requested sha — a
            // corrupt/misbehaving response would otherwise poison the node CAS for
            // every future session that shares this blob.
            let actual = sha256_hex(&bytes);
            if &actual != sha {
                return Err(format!(
                    "blob integrity for {path}: expected {sha} got {actual}"
                ));
            }
            Ok(bytes)
        });
        let error = if oversize > 0 {
            Some(format!("{oversize} entr(ies) exceeded the blob size cap"))
        } else {
            outcome.errors.first().map(|(p, e)| format!("{p}: {e}"))
        };
        stats.kinds.push(KindStats {
            kind: k.kind.to_string(),
            lockfile_hash,
            entries: entries.len(),
            fetched: outcome.fetched,
            reflinked: outcome.reflinked,
            copied: outcome.copied,
            errors: outcome.errors.len() + oversize,
            error,
        });
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cas::WarmcacheManifestEntry;
    use std::fs;

    struct FakeWarmcacheClient {
        manifests: HashMap<(String, String), Vec<WarmcacheManifestEntry>>,
        blobs: HashMap<String, Vec<u8>>,
    }

    impl AtriumClient for FakeWarmcacheClient {
        fn post_capture(&mut self, _p: &str, _b: u64, _by: &[u8]) -> Result<u64, String> {
            unreachable!()
        }
        fn post_delete(&mut self, _p: &str, _b: u64) -> Result<u64, String> {
            unreachable!()
        }
        fn fetch_bytes(&mut self, _p: &str, _s: u64) -> Result<Vec<u8>, String> {
            unreachable!()
        }
        fn warmcache_manifest(
            &self,
            hash: &str,
            kind: &str,
        ) -> Result<Vec<WarmcacheManifestEntry>, String> {
            Ok(self
                .manifests
                .get(&(hash.to_string(), kind.to_string()))
                .cloned()
                .unwrap_or_default())
        }
        fn fetch_cache_blob(&mut self, sha: &str) -> Result<Vec<u8>, String> {
            self.blobs
                .get(sha)
                .cloned()
                .ok_or_else(|| format!("no blob {sha}"))
        }
        fn atrium_changes(&self, since: &str) -> Result<(Vec<String>, String), String> {
            Ok((vec![], since.to_string()))
        }
        fn atrium_doc(&self, _target_id: &str, _doc: &str) -> Result<Vec<u8>, String> {
            unreachable!()
        }
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    #[test]
    fn hydrates_present_ecosystem_skips_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let repo_cache = tmp.path().join("repos");
        let repo_dir = repo_cache.join("acme/app");
        fs::create_dir_all(&repo_dir).unwrap();
        run_git(&repo_dir, &["init", "-q", "-b", "main"]);
        run_git(&repo_dir, &["config", "user.email", "t@t"]);
        run_git(&repo_dir, &["config", "user.name", "t"]);
        let lock = b"lockfileVersion: 9\n";
        fs::write(repo_dir.join("pnpm-lock.yaml"), lock).unwrap();
        run_git(&repo_dir, &["add", "-A"]);
        run_git(&repo_dir, &["commit", "-qm", "v1"]);
        let lockfile_hash = sha256_hex(lock);

        let store_bytes = b"react package json bytes".to_vec();
        let store_sha = sha256_hex(&store_bytes);
        let mut manifests = HashMap::new();
        manifests.insert(
            (lockfile_hash.clone(), "pnpm".to_string()),
            vec![WarmcacheManifestEntry {
                path: "react/package.json".to_string(),
                sha256: store_sha.clone(),
                size_bytes: store_bytes.len() as u64,
            }],
        );
        let mut blobs = HashMap::new();
        blobs.insert(store_sha, store_bytes.clone());
        let mut client = FakeWarmcacheClient { manifests, blobs };

        let depcache = tmp.path().join("depcache");
        let cas = tmp.path().join("cas");
        let stats = hydrate_depcache(
            &mut client,
            &repo_cache,
            "acme/app",
            "main",
            &depcache,
            &cas,
            DEFAULT_KINDS,
        );

        let dest = depcache.join("pnpm-store/react/package.json");
        assert!(dest.exists(), "store file should be materialized");
        assert_eq!(fs::read(&dest).unwrap(), store_bytes);
        let pnpm = stats.kinds.iter().find(|k| k.kind == "pnpm").unwrap();
        assert_eq!(pnpm.entries, 1);
        assert_eq!(pnpm.lockfile_hash, lockfile_hash);
        // cargo/uv lockfiles absent → not attempted.
        assert!(stats.kinds.iter().all(|k| k.kind != "cargo"));
    }

    #[test]
    fn rejects_blob_failing_integrity() {
        let tmp = tempfile::tempdir().unwrap();
        let repo_cache = tmp.path().join("repos");
        let repo_dir = repo_cache.join("acme/app");
        fs::create_dir_all(&repo_dir).unwrap();
        run_git(&repo_dir, &["init", "-q", "-b", "main"]);
        run_git(&repo_dir, &["config", "user.email", "t@t"]);
        run_git(&repo_dir, &["config", "user.name", "t"]);
        let lock = b"lockfileVersion: 9\n";
        fs::write(repo_dir.join("pnpm-lock.yaml"), lock).unwrap();
        run_git(&repo_dir, &["add", "-A"]);
        run_git(&repo_dir, &["commit", "-qm", "v1"]);

        // Manifest claims a sha, but the served blob is tampered (hashes elsewhere).
        let claimed_sha = sha256_hex(b"the real store bytes");
        let mut manifests = HashMap::new();
        manifests.insert(
            (sha256_hex(lock), "pnpm".to_string()),
            vec![WarmcacheManifestEntry {
                path: "react/index.js".to_string(),
                sha256: claimed_sha.clone(),
                size_bytes: 16,
            }],
        );
        let mut blobs = HashMap::new();
        blobs.insert(claimed_sha, b"tampered bytes!!".to_vec());
        let mut client = FakeWarmcacheClient { manifests, blobs };

        let depcache = tmp.path().join("depcache");
        let cas = tmp.path().join("cas");
        let stats = hydrate_depcache(
            &mut client,
            &repo_cache,
            "acme/app",
            "main",
            &depcache,
            &cas,
            DEFAULT_KINDS,
        );

        assert!(
            !depcache.join("pnpm-store/react/index.js").exists(),
            "a blob failing integrity must NOT be materialized"
        );
        let pnpm = stats.kinds.iter().find(|k| k.kind == "pnpm").unwrap();
        assert_eq!(pnpm.errors, 1);
        assert!(pnpm.error.as_deref().unwrap_or("").contains("integrity"));
    }

    #[test]
    fn git_show_falls_back_to_origin_ref() {
        let tmp = tempfile::tempdir().unwrap();
        let repo_dir = tmp.path().join("repo");
        fs::create_dir_all(&repo_dir).unwrap();
        run_git(&repo_dir, &["init", "-q", "-b", "main"]);
        run_git(&repo_dir, &["config", "user.email", "t@t"]);
        run_git(&repo_dir, &["config", "user.name", "t"]);
        fs::write(repo_dir.join("Cargo.lock"), b"v1").unwrap();
        run_git(&repo_dir, &["add", "-A"]);
        run_git(&repo_dir, &["commit", "-qm", "v1"]);
        let sha = String::from_utf8(
            Command::new("git")
                .arg("-C")
                .arg(&repo_dir)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        // Simulate a fetch-populated cache: "release" exists ONLY as a remote-tracking
        // ref (no local branch), so `git show release:..` fails and origin/release works.
        run_git(
            &repo_dir,
            &["update-ref", "refs/remotes/origin/release", sha.trim()],
        );
        assert_eq!(
            git_show(&repo_dir, "release", "Cargo.lock").as_deref(),
            Some(&b"v1"[..])
        );
        // A ref starting with '-' is rejected outright (option-injection guard).
        assert!(git_show(&repo_dir, "-p", "Cargo.lock").is_none());
    }
}
