//! Warm-cache depcache hydrator (Phase 2.2). Standalone, node-level — it does NOT
//! touch the overlay lower/upper machinery. Given a session's repo + ref, it reads
//! the dependency lockfiles from the node repo-cache (via `git show <ref>:<file>`,
//! no checkout), hashes each, and pulls the matching dependency STORE from Atrium
//! CAS into Phase-1's node depcache (`/var/lib/centaur/depcache/<dest>`), reflinked.
//! Ships relocatable stores (pnpm store, cargo registry) — never node_modules/target
//! (stress-test-validated: see docs/warmcache-tier-design.md).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha256};

use crate::cas::{CasHydrateEntry, WarmcacheManifestEntry, materialize_cached};
use crate::runtime::AtriumClient;

/// Defensive cap on a single warm-cache blob — never buffer an unbounded body into
/// the node daemon (a store file is small; this guards a bad/oversized manifest entry).
pub const MAX_WARMCACHE_BLOB_BYTES: u64 = 256 * 1024 * 1024;

/// Matches Atrium's `/cache/manifest` entry cap. A store larger than this can't be
/// captured per-file (the register would 413) — bail before uploading anything.
pub const MAX_WARMCACHE_MANIFEST_ENTRIES: usize = 100_000;

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
    pub dest_subdir: String,
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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WarmcacheReceipt {
    pub session: String,
    pub entries: Vec<WarmcacheReceiptEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WarmcacheReceiptEntry {
    pub repo: String,
    pub git_ref: String,
    pub kind: String,
    pub dest_subdir: String,
    pub lockfile_hash: String,
    pub hit: bool,
    #[serde(default)]
    pub errors: usize,
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

pub fn warmcache_effective_lockfile_hash(
    lockfile_hash: &str,
    toolchain_id: Option<&str>,
) -> String {
    let Some(toolchain_id) = toolchain_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return lockfile_hash.to_string();
    };
    let mut h = Sha256::new();
    h.update(b"atrium-warmcache-v2\0");
    h.update(lockfile_hash.as_bytes());
    h.update(b"\0");
    h.update(toolchain_id.as_bytes());
    format!("v2.{}", hex::encode(h.finalize()))
}

/// Hydrate the node depcache for one repo's dependency sets from Atrium CAS. For
/// each ecosystem whose lockfile is present at `git_ref`, hash the lockfile, fetch
/// the warm-cache manifest, and reflink each store blob into `<depcache>/<dest>`.
/// A cold dependency set (no manifest) is skipped — the agent installs normally.
#[allow(clippy::too_many_arguments)]
pub fn hydrate_depcache(
    client: &mut dyn AtriumClient,
    repo_cache_root: &Path,
    repo: &str,
    git_ref: &str,
    depcache_root: &Path,
    cas_dir: &Path,
    kinds: &[LockfileKind],
    toolchain_id: Option<&str>,
) -> HydrateStats {
    let repo_dir = repo_cache_root.join(repo);
    let mut stats = HydrateStats::default();
    for k in kinds {
        let Some(lockfile_bytes) = git_show(&repo_dir, git_ref, k.lockfile) else {
            continue;
        };
        let lockfile_hash =
            warmcache_effective_lockfile_hash(&sha256_hex(&lockfile_bytes), toolchain_id);
        let manifest = match client.warmcache_manifest(&lockfile_hash, k.kind) {
            Ok(m) if !m.is_empty() => m,
            Ok(_) => {
                stats.kinds.push(KindStats {
                    kind: k.kind.to_string(),
                    dest_subdir: k.dest_subdir.to_string(),
                    lockfile_hash,
                    ..Default::default()
                });
                continue;
            } // cold: no cache for this dep set yet
            Err(err) => {
                stats.kinds.push(KindStats {
                    kind: k.kind.to_string(),
                    dest_subdir: k.dest_subdir.to_string(),
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
            dest_subdir: k.dest_subdir.to_string(),
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

pub fn warmcache_receipt_path(depcache_root: &Path, session: &str) -> PathBuf {
    depcache_root
        .join(".warmcache-receipts")
        .join(format!("{}.json", safe_receipt_name(session)))
}

pub fn write_warmcache_receipt(
    depcache_root: &Path,
    receipt: &WarmcacheReceipt,
) -> Result<(), String> {
    let path = warmcache_receipt_path(depcache_root, &receipt.session);
    let parent = path
        .parent()
        .ok_or_else(|| format!("receipt path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(receipt).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn read_warmcache_receipt(
    depcache_root: &Path,
    session: &str,
) -> Result<Option<WarmcacheReceipt>, String> {
    let path = warmcache_receipt_path(depcache_root, session);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("parse {}: {e}", path.display()))
}

fn safe_receipt_name(session: &str) -> String {
    session
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | ':') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct CaptureStats {
    pub kind: String,
    pub entries: usize,
    pub uploaded: u64,
    pub errors: usize,
    pub error: Option<String>,
}

/// Capture one dependency store from the node depcache back to Atrium CAS, keyed by
/// `(lockfile_hash, kind)`. `lockfile_hash` may be the legacy raw lockfile digest
/// or a v2 effective key that also encodes the sandbox toolchain identity. Walks
/// `<depcache>/<dest_subdir>`, uploads each file's bytes (idempotent — the server
/// dedups), and registers the manifest. Intended to run only on a cold miss /
/// changed deps (the caller gates that), so a full upload here is the first
/// population, not a per-session cost.
pub fn capture_depcache(
    client: &mut dyn AtriumClient,
    depcache_root: &Path,
    dest_subdir: &str,
    lockfile_hash: &str,
    kind: &str,
) -> CaptureStats {
    // Defense-in-depth: an absolute or `..` dest_subdir would escape the depcache.
    if dest_subdir.starts_with('/') || dest_subdir.contains("..") {
        return CaptureStats {
            kind: kind.to_string(),
            errors: 1,
            error: Some(format!("unsafe dest_subdir {dest_subdir:?}")),
            ..Default::default()
        };
    }
    let store = depcache_root.join(dest_subdir);
    let mut files = Vec::new();
    collect_files(&store, &mut files); // transient walk errors are skipped, not fatal
    // Bail before N uploads if the store will blow Atrium's manifest cap.
    if files.len() > MAX_WARMCACHE_MANIFEST_ENTRIES {
        return CaptureStats {
            kind: kind.to_string(),
            errors: 1,
            error: Some(format!(
                "store has {} files, exceeds the {MAX_WARMCACHE_MANIFEST_ENTRIES} manifest cap",
                files.len()
            )),
            ..Default::default()
        };
    }
    let mut entries: Vec<WarmcacheManifestEntry> = Vec::new();
    let mut uploaded = 0u64;
    let mut errors = 0usize;
    let mut first_err: Option<String> = None;
    for abs in files {
        // A non-UTF-8 path can't be a manifest key without lossy collisions — skip+err.
        let rel = match abs.strip_prefix(&store).ok().and_then(|p| p.to_str()) {
            Some(s) => s.to_string(),
            None => {
                errors += 1;
                first_err.get_or_insert_with(|| format!("non-UTF-8 path: {}", abs.display()));
                continue;
            }
        };
        let meta = match std::fs::metadata(&abs) {
            Ok(m) => m,
            Err(e) => {
                // Vanished mid-walk (live store); the capture is no longer complete.
                errors += 1;
                first_err.get_or_insert(e.to_string());
                continue;
            }
        };
        if meta.len() > MAX_WARMCACHE_BLOB_BYTES {
            errors += 1;
            first_err.get_or_insert_with(|| format!("oversized store file: {}", abs.display()));
            continue;
        }
        let bytes = match std::fs::read(&abs) {
            Ok(b) => b,
            Err(e) => {
                errors += 1;
                first_err.get_or_insert(e.to_string());
                continue;
            }
        };
        // A concurrent install writing this file non-atomically yields a torn read
        // (size won't match the stat) — never cache partial bytes under a real sha.
        if bytes.len() as u64 != meta.len() {
            errors += 1;
            first_err.get_or_insert_with(|| format!("torn read: {}", abs.display()));
            continue;
        }
        let sha = sha256_hex(&bytes);
        if let Err(e) = client.put_cache_blob(&sha, &bytes) {
            errors += 1;
            first_err.get_or_insert(e);
            continue;
        }
        uploaded += 1;
        entries.push(WarmcacheManifestEntry {
            path: rel,
            sha256: sha,
            size_bytes: meta.len(),
        });
    }
    // Register only when the FULL store was captured cleanly (errors == 0). A partial
    // manifest would point at an incomplete store, so a later `--offline` install fails.
    if !entries.is_empty()
        && errors == 0
        && let Err(e) = client.register_cache_manifest(lockfile_hash, kind, &entries)
    {
        errors += 1;
        first_err.get_or_insert(e);
    }
    CaptureStats {
        kind: kind.to_string(),
        entries: entries.len(),
        uploaded,
        errors,
        error: first_err,
    }
}

/// Collect regular files under `dir` (recursively) as absolute paths. Symlinks are
/// skipped (we capture relocatable store *contents*, not link farms). Transient
/// errors on a live store (a file vanishing mid-walk) are skipped, not fatal.
fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return; // a missing store dir = nothing to capture
    };
    for entry in rd {
        let Ok(entry) = entry else { continue };
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            collect_files(&path, out);
        } else if ft.is_file() {
            out.push(path);
        }
    }
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
    fn effective_lockfile_hash_preserves_legacy_when_toolchain_unset() {
        assert_eq!(warmcache_effective_lockfile_hash("abc123", None), "abc123");
        assert_eq!(
            warmcache_effective_lockfile_hash("abc123", Some("  ")),
            "abc123"
        );
    }

    #[test]
    fn effective_lockfile_hash_uses_stable_v2_toolchain_key() {
        let key = warmcache_effective_lockfile_hash("abc123", Some("node24-rust1.88"));
        assert!(key.starts_with("v2."));
        assert_eq!(key.len(), 67);
        assert_eq!(
            key,
            warmcache_effective_lockfile_hash("abc123", Some("node24-rust1.88"))
        );
        assert_ne!(
            key,
            warmcache_effective_lockfile_hash("abc123", Some("node24-rust1.89"))
        );
        assert_ne!(
            key,
            warmcache_effective_lockfile_hash("def456", Some("node24-rust1.88"))
        );
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
            None,
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
            None,
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
    fn hydrate_uses_effective_toolchain_key_for_manifest_lookup() {
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

        let raw_hash = sha256_hex(lock);
        let effective_key = warmcache_effective_lockfile_hash(&raw_hash, Some("node24-rust1.88"));
        let store_bytes = b"react package json bytes".to_vec();
        let store_sha = sha256_hex(&store_bytes);
        let mut manifests = HashMap::new();
        manifests.insert(
            (effective_key.clone(), "pnpm".to_string()),
            vec![WarmcacheManifestEntry {
                path: "react/package.json".to_string(),
                sha256: store_sha.clone(),
                size_bytes: store_bytes.len() as u64,
            }],
        );
        let mut blobs = HashMap::new();
        blobs.insert(store_sha, store_bytes);
        let mut client = FakeWarmcacheClient { manifests, blobs };

        let stats = hydrate_depcache(
            &mut client,
            &repo_cache,
            "acme/app",
            "main",
            &tmp.path().join("depcache"),
            &tmp.path().join("cas"),
            DEFAULT_KINDS,
            Some("node24-rust1.88"),
        );

        let pnpm = stats.kinds.iter().find(|k| k.kind == "pnpm").unwrap();
        assert_eq!(pnpm.lockfile_hash, effective_key);
        assert_eq!(pnpm.entries, 1);
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

    #[test]
    fn captures_store_uploads_blobs_and_registers_manifest() {
        struct CapturingClient {
            uploaded: Vec<String>,
            registered: Vec<(String, String, Vec<WarmcacheManifestEntry>)>,
        }
        impl AtriumClient for CapturingClient {
            fn post_capture(&mut self, _: &str, _: u64, _: &[u8]) -> Result<u64, String> {
                unreachable!()
            }
            fn post_delete(&mut self, _: &str, _: u64) -> Result<u64, String> {
                unreachable!()
            }
            fn fetch_bytes(&mut self, _: &str, _: u64) -> Result<Vec<u8>, String> {
                unreachable!()
            }
            fn put_cache_blob(&mut self, sha: &str, _bytes: &[u8]) -> Result<(), String> {
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

        let tmp = tempfile::tempdir().unwrap();
        let depcache = tmp.path().join("depcache");
        let store = depcache.join("pnpm-store");
        fs::create_dir_all(store.join("react")).unwrap();
        fs::write(store.join("react/package.json"), b"react pkg").unwrap();
        fs::write(store.join("lodash.js"), b"lodash").unwrap();

        let mut client = CapturingClient {
            uploaded: vec![],
            registered: vec![],
        };
        let stats = capture_depcache(&mut client, &depcache, "pnpm-store", "lock123", "pnpm");

        assert_eq!(stats.uploaded, 2);
        assert_eq!(stats.errors, 0);
        assert_eq!(client.uploaded.len(), 2);
        assert_eq!(client.registered.len(), 1);
        let (hash, kind, entries) = &client.registered[0];
        assert_eq!(hash, "lock123");
        assert_eq!(kind, "pnpm");
        assert_eq!(entries.len(), 2);
        let react = entries
            .iter()
            .find(|e| e.path == "react/package.json")
            .expect("react entry");
        assert_eq!(react.sha256, sha256_hex(b"react pkg"));
        assert!(entries.iter().any(|e| e.path == "lodash.js"));
    }

    #[test]
    fn capture_rejects_unsafe_dest_subdir() {
        struct NoopClient;
        impl AtriumClient for NoopClient {
            fn post_capture(&mut self, _: &str, _: u64, _: &[u8]) -> Result<u64, String> {
                unreachable!()
            }
            fn post_delete(&mut self, _: &str, _: u64) -> Result<u64, String> {
                unreachable!()
            }
            fn fetch_bytes(&mut self, _: &str, _: u64) -> Result<Vec<u8>, String> {
                unreachable!()
            }
            fn put_cache_blob(&mut self, _: &str, _: &[u8]) -> Result<(), String> {
                panic!("must not upload for an unsafe dest_subdir")
            }
            fn atrium_changes(&self, since: &str) -> Result<(Vec<String>, String), String> {
                Ok((vec![], since.to_string()))
            }
            fn atrium_doc(&self, _: &str, _: &str) -> Result<Vec<u8>, String> {
                unreachable!()
            }
        }
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["/etc", "../escape", "a/../../b"] {
            let stats = capture_depcache(&mut NoopClient, tmp.path(), bad, "h", "pnpm");
            assert_eq!(stats.errors, 1, "{bad} should be rejected");
            assert_eq!(stats.entries, 0);
        }
    }
}
