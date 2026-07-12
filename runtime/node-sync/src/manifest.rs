//! Atomic multi-file tree-manifest apply (H10 / §8B #13) — the inbound mirror of
//! the Atrium ledger commit-group. Inbound change-feed rows that share a non-null
//! `group_id` form one [`TreeManifest`]; the node applies the WHOLE group or none
//! of it, so the agent's working tree never observes a half-applied coherent change.
//!
//! Strict, like the producer side:
//!   - **Completeness**: a manifest is only formed when ALL its members are
//!     adopt-ready this sweep. If any member instead needs write-back/conflict (or
//!     was deferred), the whole group is deferred — its ready writes are held, never
//!     half-applied, and reconsidered on a later sweep once the laggard resolves.
//!   - **Atomicity**: every entry's path is quiesce-gated up front (any busy →
//!     defer the whole group); then all entries are staged to temp; only if every
//!     stage succeeds are they committed (renamed). A crash mid-commit is recoverable
//!     via the staged marker (the live writer drops a `.commit` sentinel).
//!
//! Pure + dependency-injected (gate + stage/commit/abort closures) so the all-or-
//! nothing control flow is unit-tested without a real FS.

use std::collections::HashMap;

use crate::quiesce::QuiesceGate;

/// One file in an atomic group: the path, the version it reaches, its content sha
/// (for state advance) and the bytes to write through `merged`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestEntry {
    pub path: String,
    pub seq: u64,
    pub sha: Option<String>,
    pub bytes: Vec<u8>,
}

/// A logically-atomic set of inbound writes sharing one producer `group_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeManifest {
    pub group_id: String,
    pub entries: Vec<ManifestEntry>,
}

/// An adopt-ready inbound write tagged with its producer group (None = ungrouped
/// single write): `(path, seq, group_id, sha, bytes)`.
pub type TaggedWrite = (String, u64, Option<String>, Option<String>, Vec<u8>);

/// The result of partitioning adopt-ready writes by their producer group.
pub struct Partitioned {
    /// Complete atomic groups (all members present this sweep) — apply all-or-none.
    pub manifests: Vec<TreeManifest>,
    /// Ungrouped single writes — apply via the normal per-path quiesce path.
    pub loose: Vec<(String, u64, Vec<u8>)>,
    /// Ready writes belonging to an INCOMPLETE group — held (never half-applied),
    /// retried next sweep once the lagging member resolves.
    pub deferred_incomplete: Vec<(String, u64, Vec<u8>)>,
}

/// Partition adopt-ready writes into complete atomic manifests + loose singles.
/// `group_size` is each group's TOTAL member count (from the change rows); a group
/// is only formed when its ready members reach that count, so a coherent change
/// never lands partially.
pub fn partition_manifests(
    writes: Vec<TaggedWrite>,
    group_size: &HashMap<String, usize>,
) -> Partitioned {
    let mut by_group: HashMap<String, Vec<ManifestEntry>> = HashMap::new();
    let mut loose = Vec::new();
    for (path, seq, gid, sha, bytes) in writes {
        match gid {
            Some(g) => by_group.entry(g).or_default().push(ManifestEntry {
                path,
                seq,
                sha,
                bytes,
            }),
            None => loose.push((path, seq, bytes)),
        }
    }
    let mut manifests = Vec::new();
    let mut deferred_incomplete = Vec::new();
    for (group_id, mut entries) in by_group {
        let expected = group_size.get(&group_id).copied().unwrap_or(entries.len());
        if entries.len() >= expected {
            // stable order so staging/commit is deterministic
            entries.sort_by(|a, b| a.path.cmp(&b.path));
            manifests.push(TreeManifest { group_id, entries });
        } else {
            for e in entries.drain(..) {
                deferred_incomplete.push((e.path, e.seq, e.bytes));
            }
        }
    }
    Partitioned {
        manifests,
        loose,
        deferred_incomplete,
    }
}

/// The outcome of applying one manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestApply {
    /// All entries landed — `(path, seq, sha)` for the caller's state advance.
    Applied(Vec<(String, u64, Option<String>)>),
    /// Nothing landed (or was rolled back) — retry the whole group next sweep.
    Deferred(String),
}

/// Apply a manifest atomically. `stage` writes a temp copy, `commit` renames it into
/// place, `abort` removes a staged temp. Gate ALL paths first (any busy → defer);
/// stage ALL (any failure → abort the staged + defer); then commit ALL.
pub fn apply_manifest_atomic(
    manifest: &TreeManifest,
    gate: &dyn QuiesceGate,
    mut stage: impl FnMut(&str, &[u8]) -> Result<(), String>,
    mut commit: impl FnMut(&str) -> Result<(), String>,
    mut abort: impl FnMut(&str),
) -> ManifestApply {
    // 1. Quiesce-gate every path before touching anything.
    for e in &manifest.entries {
        if !gate.can_write(&e.path) {
            return ManifestApply::Deferred(format!("path busy: {}", e.path));
        }
    }
    // 2. Stage every entry to temp; on the first failure, abort all staged + defer.
    let mut staged: Vec<&str> = Vec::new();
    for e in &manifest.entries {
        match stage(&e.path, &e.bytes) {
            Ok(()) => staged.push(&e.path),
            Err(err) => {
                for p in &staged {
                    abort(p);
                }
                return ManifestApply::Deferred(format!("stage {}: {err}", e.path));
            }
        }
    }
    // 3. Commit (rename) every staged entry — the fast phase; a crash here is
    //    recoverable from the staged marker, so it degrades to a re-applied group.
    for e in &manifest.entries {
        if let Err(err) = commit(&e.path) {
            return ManifestApply::Deferred(format!("commit {}: {err}", e.path));
        }
    }
    ManifestApply::Applied(
        manifest
            .entries
            .iter()
            .map(|e| (e.path.clone(), e.seq, e.sha.clone()))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quiesce::LeaseGate;

    fn w(path: &str, seq: u64, gid: Option<&str>) -> TaggedWrite {
        (
            path.to_string(),
            seq,
            gid.map(|s| s.to_string()),
            Some(format!("sha-{path}")),
            path.as_bytes().to_vec(),
        )
    }

    #[test]
    fn partition_forms_complete_groups_and_keeps_singles_loose() {
        let writes = vec![
            w("proj-x/a.md", 5, Some("g1")),
            w("proj-x/b.md", 5, Some("g1")),
            w("notes.md", 9, None),
        ];
        let mut sizes = HashMap::new();
        sizes.insert("g1".to_string(), 2);
        let p = partition_manifests(writes, &sizes);
        assert_eq!(p.manifests.len(), 1);
        assert_eq!(p.manifests[0].group_id, "g1");
        assert_eq!(p.manifests[0].entries.len(), 2);
        // sorted by path
        assert_eq!(p.manifests[0].entries[0].path, "proj-x/a.md");
        assert_eq!(p.loose.len(), 1);
        assert_eq!(p.loose[0].0, "notes.md");
        assert!(p.deferred_incomplete.is_empty());
    }

    #[test]
    fn partition_defers_an_incomplete_group() {
        // g1 has 3 members upstream but only 2 are adopt-ready this sweep (the third
        // went to write-back) → defer the whole group, half-apply nothing.
        let writes = vec![w("a", 5, Some("g1")), w("b", 5, Some("g1"))];
        let mut sizes = HashMap::new();
        sizes.insert("g1".to_string(), 3);
        let p = partition_manifests(writes, &sizes);
        assert!(p.manifests.is_empty());
        assert_eq!(p.deferred_incomplete.len(), 2);
    }

    #[test]
    fn apply_lands_all_entries_atomically() {
        let manifest = TreeManifest {
            group_id: "g1".into(),
            entries: vec![
                ManifestEntry {
                    path: "a".into(),
                    seq: 5,
                    sha: Some("sa".into()),
                    bytes: b"A".to_vec(),
                },
                ManifestEntry {
                    path: "b".into(),
                    seq: 5,
                    sha: Some("sb".into()),
                    bytes: b"B".to_vec(),
                },
            ],
        };
        let gate = LeaseGate::new();
        let mut staged = Vec::new();
        let mut committed = Vec::new();
        let out = apply_manifest_atomic(
            &manifest,
            &gate,
            |p, _b| {
                staged.push(p.to_string());
                Ok(())
            },
            |p| {
                committed.push(p.to_string());
                Ok(())
            },
            |_p| panic!("must not abort on the happy path"),
        );
        match out {
            ManifestApply::Applied(v) => assert_eq!(v.len(), 2),
            other => panic!("expected Applied, got {other:?}"),
        }
        assert_eq!(staged, vec!["a", "b"]);
        assert_eq!(committed, vec!["a", "b"]);
    }

    #[test]
    fn apply_defers_the_whole_group_if_any_path_is_busy() {
        let manifest = TreeManifest {
            group_id: "g1".into(),
            entries: vec![
                ManifestEntry {
                    path: "a".into(),
                    seq: 5,
                    sha: None,
                    bytes: b"A".to_vec(),
                },
                ManifestEntry {
                    path: "busy".into(),
                    seq: 5,
                    sha: None,
                    bytes: b"B".to_vec(),
                },
            ],
        };
        let mut gate = LeaseGate::new();
        gate.acquire("busy");
        let mut staged = 0;
        let out = apply_manifest_atomic(
            &manifest,
            &gate,
            |_p, _b| {
                staged += 1;
                Ok(())
            },
            |_p| Ok(()),
            |_p| {},
        );
        assert!(matches!(out, ManifestApply::Deferred(_)));
        assert_eq!(staged, 0, "nothing is staged when any path is busy");
    }

    #[test]
    fn apply_rolls_back_staged_entries_on_a_stage_failure() {
        let manifest = TreeManifest {
            group_id: "g1".into(),
            entries: vec![
                ManifestEntry {
                    path: "ok".into(),
                    seq: 5,
                    sha: None,
                    bytes: b"A".to_vec(),
                },
                ManifestEntry {
                    path: "boom".into(),
                    seq: 5,
                    sha: None,
                    bytes: b"B".to_vec(),
                },
            ],
        };
        let gate = LeaseGate::new();
        let mut aborted = Vec::new();
        let mut committed = 0;
        let out = apply_manifest_atomic(
            &manifest,
            &gate,
            |p, _b| {
                if p == "boom" {
                    Err("disk full".into())
                } else {
                    Ok(())
                }
            },
            |_p| {
                committed += 1;
                Ok(())
            },
            |p| aborted.push(p.to_string()),
        );
        assert!(matches!(out, ManifestApply::Deferred(_)));
        assert_eq!(
            aborted,
            vec!["ok"],
            "the already-staged entry is rolled back"
        );
        assert_eq!(committed, 0, "nothing commits when staging fails");
    }
}
