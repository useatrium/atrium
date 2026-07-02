//! Node-local CAS cache + reflink materialization (Phase 5 scale layer, §8B #18).
//!
//! Hydrating a lower is a CAS checkout: per artifact path, materialize one blob.
//! At scale we don't re-download or byte-copy per pod — blobs are content-addressed
//! in a node-local cache (`/var/lib/centaur/cas/<sha>`, immutable) and **reflinked**
//! (FICLONE, copy-on-write) into each pod's lower tree → near-zero time + disk, free
//! dedup across pods. Reflink requires XFS/btrfs (#18); on other FS the clone
//! ioctl returns EOPNOTSUPP and we fall back to a full copy (safe, just not shared —
//! NEVER a hardlink, which would share the inode and let one pod corrupt the CAS).

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::overlay_mount::OverlayMountPlan;
use crate::runtime::AtriumClient;

/// One hydration entry resolved to its content hash.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CasHydrateEntry {
    pub path: String,
    pub seq: u64,
    pub sha: String,
}

/// One warm-cache manifest entry: a dependency-store file path + its content hash.
/// Returned by Atrium's `/api/internal/sessions/:id/cache/hydration` route, and
/// sent back (capture) to `.../cache/manifest`.
#[derive(Debug, Clone, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct WarmcacheManifestEntry {
    pub path: String,
    pub sha256: String,
    #[serde(default)]
    pub size_bytes: u64,
}

pub struct MaterializeOutcome {
    pub base_seqs: HashMap<String, u64>,
    pub reflinked: u64,
    pub copied: u64,
    pub fetched: u64,
    pub errors: Vec<(String, String)>,
}

/// Reflink `src` → `dst` (FICLONE), falling back to a full copy when the FS
/// doesn't support it. Never hardlinks.
pub fn reflink_or_copy(src: &Path, dst: &Path) -> io::Result<bool> {
    #[cfg(target_os = "linux")]
    {
        match try_ficlone(src, dst) {
            Ok(()) => return Ok(true),
            Err(_) => { /* fall through to copy */ }
        }
    }
    if dst.exists() {
        fs::remove_file(dst)?;
    }
    fs::copy(src, dst)?;
    Ok(false)
}

#[cfg(target_os = "linux")]
fn try_ficlone(src: &Path, dst: &Path) -> io::Result<()> {
    use std::os::unix::io::AsRawFd;
    // FICLONE = _IOW(0x94, 9, int) == 0x40049409 on all arches.
    const FICLONE: libc::c_ulong = 0x40049409;
    let s = fs::File::open(src)?;
    if dst.exists() {
        fs::remove_file(dst)?;
    }
    let d = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(dst)?;
    let ret = unsafe { libc::ioctl(d.as_raw_fd(), FICLONE, s.as_raw_fd()) };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Probe whether the directory's filesystem supports reflink (FICLONE). Writes two
/// tiny temp files, clones one to the other, cleans up. Used at node admission to
/// refuse a non-reflink node (#18) — or to decide copy-fallback up front.
pub fn probe_reflink(dir: &Path) -> bool {
    let a = dir.join(".reflink-probe-src");
    let b = dir.join(".reflink-probe-dst");
    let _ = fs::write(&a, b"probe");
    let ok = reflink_or_copy(&a, &b).unwrap_or(false);
    let _ = fs::remove_file(&a);
    let _ = fs::remove_file(&b);
    ok
}

fn cas_path(cas_dir: &Path, sha: &str) -> std::path::PathBuf {
    // shard by first 2 hex chars (matches the Atrium cas/<2>/<sha> layout)
    cas_dir.join(&sha[..sha.len().min(2)]).join(sha)
}

/// Ensure a blob is in the node-local CAS (atomic temp+rename; immutable 0444).
/// Returns true if it had to be written (a cache miss → the caller fetched it).
pub fn ensure_cas_blob(
    cas_dir: &Path,
    sha: &str,
    fetch: impl FnOnce() -> Result<Vec<u8>, String>,
) -> Result<bool, String> {
    let target = cas_path(cas_dir, sha);
    if target.exists() {
        return Ok(false);
    }
    let bytes = fetch()?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = target.with_extension("tmp");
    fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o444));
    }
    fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Materialize the artifact lower from the CAS: for each entry, ensure its blob is
/// cached (fetch on miss), then reflink it into `lower_root/<path>`. Returns the
/// per-path base_seqs (the sync-state seed) + reflink/copy/fetch counters.
pub fn materialize_cached(
    entries: &[CasHydrateEntry],
    cas_dir: &Path,
    lower_root: &Path,
    mut fetch: impl FnMut(&str, u64) -> Result<Vec<u8>, String>,
) -> MaterializeOutcome {
    let mut out = MaterializeOutcome {
        base_seqs: HashMap::new(),
        reflinked: 0,
        copied: 0,
        fetched: 0,
        errors: vec![],
    };
    for e in entries {
        let r: Result<(), String> = (|| {
            let miss = ensure_cas_blob(cas_dir, &e.sha, || fetch(&e.path, e.seq))?;
            if miss {
                out.fetched += 1;
            }
            let dst = lower_root.join(&e.path);
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).map_err(|err| err.to_string())?;
            }
            let reflinked =
                reflink_or_copy(&cas_path(cas_dir, &e.sha), &dst).map_err(|err| err.to_string())?;
            if reflinked {
                out.reflinked += 1;
            } else {
                out.copied += 1;
            }
            Ok(())
        })();
        match r {
            Ok(()) => {
                out.base_seqs.insert(e.path.clone(), e.seq);
            }
            Err(err) => out.errors.push((e.path.clone(), err)),
        }
    }
    out
}

pub fn hydrate_artifact_lower(
    client: &mut dyn AtriumClient,
    cas_dir: &Path,
    artifact_lower_root: &Path,
) -> Result<MaterializeOutcome, String> {
    let entries = client.hydration_scope()?;
    Ok(materialize_cached(
        &entries,
        cas_dir,
        artifact_lower_root,
        |path, seq| client.fetch_bytes(path, seq),
    ))
}

/// Where a session's hydrated artifact lower lives under the overlays root.
pub fn artifact_lower_path(overlays_root: &Path, session: &str) -> PathBuf {
    overlays_root.join("artifact-lower").join(session)
}

/// Re-attach an already-hydrated artifact lower to a rebuilt mount plan.
///
/// Hydration runs only on a session's first mount (re-running it would
/// `remove_dir_all` an active lowerdir), but the daemon rebuilds the plan from
/// the manifest every tick. The overlay signature covers extra lowers, so a
/// rebuilt plan that omits the artifact lower would mismatch and remount the
/// session WITHOUT its hydrated artifacts. Returns whether the lower was
/// attached.
pub fn reattach_artifact_lower_into_plan(
    overlays_root: &Path,
    session: &str,
    plan: &mut OverlayMountPlan,
) -> bool {
    let artifact_lower = artifact_lower_path(overlays_root, session);
    if artifact_lower.is_dir() {
        plan.extra_lowers.push(artifact_lower);
        return true;
    }
    false
}

pub fn hydrate_artifact_lower_into_plan(
    client: &mut dyn AtriumClient,
    cas_dir: &Path,
    overlays_root: &Path,
    session: &str,
    plan: &mut OverlayMountPlan,
) -> Result<MaterializeOutcome, String> {
    let artifact_lower = artifact_lower_path(overlays_root, session);
    if artifact_lower.exists() {
        fs::remove_dir_all(&artifact_lower)
            .map_err(|e| format!("reset artifact lower {}: {e}", artifact_lower.display()))?;
    }
    fs::create_dir_all(&artifact_lower)
        .map_err(|e| format!("create artifact lower {}: {e}", artifact_lower.display()))?;

    let outcome = hydrate_artifact_lower(client, cas_dir, &artifact_lower)?;
    plan.extra_lowers.push(artifact_lower);
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overlay_mount::{LowerKind, LowerSource, OverlayMountPlan};
    use std::collections::HashMap;
    use std::path::PathBuf;

    #[derive(Default)]
    struct FakeAtriumClient {
        entries: Vec<CasHydrateEntry>,
        bytes: HashMap<(String, u64), Vec<u8>>,
    }

    impl AtriumClient for FakeAtriumClient {
        fn post_capture(
            &mut self,
            _path: &str,
            _base_seq: u64,
            _bytes: &[u8],
        ) -> Result<u64, String> {
            unreachable!("hydrate tests do not capture artifacts")
        }

        fn post_delete(&mut self, _path: &str, _base_seq: u64) -> Result<u64, String> {
            unreachable!("hydrate tests do not delete artifacts")
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

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("cas-it-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn reflink_or_copy_round_trips_bytes() {
        let d = tmp("rl");
        let src = d.join("src");
        let dst = d.join("dst");
        fs::write(&src, b"hello cas").unwrap();
        reflink_or_copy(&src, &dst).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), b"hello cas");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn materialize_caches_then_reuses_blob_and_lays_out_tree() {
        let root = tmp("mat");
        let cas = root.join("cas");
        let lower = root.join("lower");
        fs::create_dir_all(&cas).unwrap();
        let entries = vec![
            CasHydrateEntry {
                path: "proj-x/a.md".into(),
                seq: 5,
                sha: "aa11".into(),
            },
            CasHydrateEntry {
                path: "proj-x/b.md".into(),
                seq: 6,
                sha: "bb22".into(),
            },
            // same blob as a.md (dedup) under a different path
            CasHydrateEntry {
                path: "shared/copy.md".into(),
                seq: 7,
                sha: "aa11".into(),
            },
        ];
        let mut fetched: Vec<String> = vec![];
        let out = materialize_cached(&entries, &cas, &lower, |path, _seq| {
            fetched.push(path.to_string());
            Ok(format!("bytes for {path}").into_bytes())
        });
        // a.md + b.md fetched; copy.md reused the cached aa11 blob (no 3rd fetch).
        assert_eq!(out.fetched, 2, "shared sha fetched once");
        assert_eq!(out.base_seqs.get("proj-x/a.md"), Some(&5));
        assert!(lower.join("proj-x/a.md").exists());
        assert!(lower.join("shared/copy.md").exists());
        // copy.md materialized from the SAME cached blob as a.md.
        assert_eq!(
            fs::read(lower.join("shared/copy.md")).unwrap(),
            fs::read(lower.join("proj-x/a.md")).unwrap(),
        );
        assert!(out.errors.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn hydrate_artifact_lower_fetches_scope_and_materializes_files() {
        let root = tmp("hydrate");
        let cas = root.join("cas");
        let lower = root.join("lower");
        fs::create_dir_all(&cas).unwrap();

        let entries = vec![
            CasHydrateEntry {
                path: "shared/a.txt".to_string(),
                seq: 11,
                sha: "aa11".to_string(),
            },
            CasHydrateEntry {
                path: "scratch/sess-1/b.txt".to_string(),
                seq: 12,
                sha: "bb22".to_string(),
            },
        ];
        let mut bytes = HashMap::new();
        bytes.insert(("shared/a.txt".to_string(), 11), b"shared bytes".to_vec());
        bytes.insert(
            ("scratch/sess-1/b.txt".to_string(), 12),
            b"scratch bytes".to_vec(),
        );
        let mut client = FakeAtriumClient { entries, bytes };

        let out = hydrate_artifact_lower(&mut client, &cas, &lower).unwrap();

        assert_eq!(out.fetched, 2);
        assert_eq!(out.base_seqs.get("shared/a.txt"), Some(&11));
        assert_eq!(out.base_seqs.get("scratch/sess-1/b.txt"), Some(&12));
        assert_eq!(
            fs::read(lower.join("shared/a.txt")).unwrap(),
            b"shared bytes"
        );
        assert_eq!(
            fs::read(lower.join("scratch/sess-1/b.txt")).unwrap(),
            b"scratch bytes"
        );
        assert!(out.errors.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn hydrate_artifact_lower_into_plan_resets_lower_and_sets_extra_lower() {
        let root = tmp("plan");
        let overlays_root = root.join("overlays");
        let cas = overlays_root.join("cas");
        let stale_lower = overlays_root.join("artifact-lower/sess-1");
        fs::create_dir_all(&stale_lower).unwrap();
        fs::write(stale_lower.join("stale.txt"), b"old").unwrap();

        let mut bytes = HashMap::new();
        bytes.insert(("shared/hydrated.md".to_string(), 1), b"fresh".to_vec());
        let mut client = FakeAtriumClient {
            entries: vec![CasHydrateEntry {
                path: "shared/hydrated.md".to_string(),
                seq: 1,
                sha: "cc33".to_string(),
            }],
            bytes,
        };
        let mut plan = OverlayMountPlan {
            session: "sess-1".to_string(),
            upper: overlays_root.join("sess-1"),
            merged: root.join("merged/sess-1"),
            work: root.join("work/sess-1"),
            lower: LowerSource {
                path: root.join("lower/sess-1"),
                kind: LowerKind::Fixture,
            },
            extra_lowers: Vec::new(),
            context_source: None,
            repo_mounts: Vec::new(),
            repo_cache_root: PathBuf::from("/cache"),
        };

        let out = hydrate_artifact_lower_into_plan(
            &mut client,
            &cas,
            &overlays_root,
            "sess-1",
            &mut plan,
        )
        .unwrap();

        let artifact_lower = overlays_root.join("artifact-lower/sess-1");
        assert_eq!(out.fetched, 1);
        assert_eq!(plan.extra_lowers, vec![artifact_lower.clone()]);
        assert!(!artifact_lower.join("stale.txt").exists());
        assert_eq!(
            fs::read(artifact_lower.join("shared/hydrated.md")).unwrap(),
            b"fresh"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn hydrate_artifact_lower_preserves_existing_extra_lower_precedence() {
        let root = tmp("plan-order");
        let overlays_root = root.join("overlays");
        let cas = overlays_root.join("cas");
        let home_lower = overlays_root.join(".warm-home-lower/sess-1");
        fs::create_dir_all(&home_lower).unwrap();

        let mut client = FakeAtriumClient {
            entries: Vec::new(),
            bytes: HashMap::new(),
        };
        let mut plan = OverlayMountPlan {
            session: "sess-1".to_string(),
            upper: overlays_root.join("sess-1"),
            merged: root.join("merged/sess-1"),
            work: root.join("work/sess-1"),
            lower: LowerSource {
                path: root.join("lower/sess-1"),
                kind: LowerKind::Fixture,
            },
            extra_lowers: vec![home_lower.clone()],
            context_source: None,
            repo_mounts: Vec::new(),
            repo_cache_root: PathBuf::from("/cache"),
        };

        hydrate_artifact_lower_into_plan(&mut client, &cas, &overlays_root, "sess-1", &mut plan)
            .unwrap();

        assert_eq!(
            plan.extra_lowers,
            vec![home_lower, overlays_root.join("artifact-lower/sess-1")]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reattach_artifact_lower_readds_hydrated_lower_to_rebuilt_plan() {
        let root = tmp("reattach");
        let overlays_root = root.join("overlays");
        let home_lower = overlays_root.join(".warm-home-lower/sess-1");
        let mut plan = OverlayMountPlan {
            session: "sess-1".to_string(),
            upper: overlays_root.join("sess-1"),
            merged: root.join("merged/sess-1"),
            work: root.join("work/sess-1"),
            lower: LowerSource {
                path: root.join("lower/sess-1"),
                kind: LowerKind::Fixture,
            },
            extra_lowers: vec![home_lower.clone()],
            context_source: None,
            repo_mounts: Vec::new(),
            repo_cache_root: PathBuf::from("/cache"),
        };

        // No hydrated lower on disk yet -> nothing to re-attach.
        assert!(!reattach_artifact_lower_into_plan(
            &overlays_root,
            "sess-1",
            &mut plan
        ));
        assert_eq!(plan.extra_lowers, vec![home_lower.clone()]);

        // Once hydration has materialized the lower, later ticks re-attach it
        // after the manifest-derived lowers — same order hydration produced.
        let artifact_lower = artifact_lower_path(&overlays_root, "sess-1");
        fs::create_dir_all(&artifact_lower).unwrap();
        assert!(reattach_artifact_lower_into_plan(
            &overlays_root,
            "sess-1",
            &mut plan
        ));
        assert_eq!(plan.extra_lowers, vec![home_lower, artifact_lower]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn probe_reflink_runs_without_panicking() {
        let d = tmp("probe");
        let _ = probe_reflink(&d); // true on xfs/btrfs, false (copy) elsewhere — both fine
        let _ = fs::remove_dir_all(&d);
    }
}
