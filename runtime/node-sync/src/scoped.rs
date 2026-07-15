//! Path-scoped capture scanning: an in-memory belief of the upper tree
//! (`TreeState`) patched from watcher-reported dirty paths, so the capture
//! sweep can consume a complete entry list without a full disk walk.
//!
//! The invariants (POC-validated policy "V1/V2"):
//! - a dirty FILE path refreshes that one entry;
//! - a dirty DIRECTORY path rescans its whole subtree (fresh-dir and moved-in
//!   trees carry interior content whose own events raced or never fired);
//! - a dirty path that no longer exists drops the entry and its subtree;
//! - ancestors of a dirty path are re-stat'ed so directory-level overlay
//!   xattrs (opaque/redirect) that classification depends on stay current;
//! - anything stronger (overflow, cap, unmount, reconcile backstop, attach)
//!   is a FULL scan that rebuilds the belief wholesale.
//!
//! Consumers (`capture_sweep`, backpressure budget, WIP capture, lane
//! partitioning) receive the synthesized full list, sorted parent-before-child
//! — byte-identical semantics to a walk, minus the I/O.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use crate::overlay::RawEntry;

/// Reads entries for the scoped patcher. The daemon backs this with the real
/// upper tree; tests back it with temp dirs or in-memory fakes.
pub trait EntrySource {
    /// Stat one entry (rel to the tree root). `Ok(None)` = does not exist.
    fn stat_entry(&self, rel: &Path) -> io::Result<Option<RawEntry>>;
    /// Recursively read the subtree rooted at `rel` (inclusive of `rel`
    /// itself), rel paths relative to the tree root.
    fn walk_subtree(&self, rel: &Path) -> io::Result<Vec<RawEntry>>;
}

/// Files written through mmap (sqlite `-shm` shared memory, and `-wal` under PRAGMA mmap_size — both observed event-silent on prod) generate no
/// inotify events — no watcher can see them. Shadow diffs and the divergence
/// canary treat them as backstop-owned so real event-model gaps stand out.
pub fn is_mmap_pattern_path(rel: &Path) -> bool {
    rel.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with("-shm") || name.ends_with("-wal"))
}

/// Paths whose churn is invisible to the event stream BY DESIGN: mmap files
/// plus the daemon-authored root markers (their events are self-dirty-filtered
/// so the daemon's own per-tick writes don't wake the loop). The divergence
/// canary skips them — they are always stale in the belief and always healed
/// by the backstop rebuild.
pub fn is_event_invisible_path(rel: &Path) -> bool {
    if is_mmap_pattern_path(rel) {
        return true;
    }
    // Unwatched dep/build trees emit no events on purpose — backstop-owned.
    if rel
        .components()
        .any(|component| crate::watch::is_unwatched_dir_name(component.as_os_str()))
    {
        return true;
    }
    rel == Path::new(crate::overlay_mount::OVERLAY_SIGNATURE_FILE)
        || rel == Path::new(crate::overlay_mount::READY_MARKER_FILE)
}

/// The daemon's belief of one session's upper tree.
#[derive(Debug, Default, Clone)]
pub struct TreeState {
    entries: HashMap<PathBuf, RawEntry>,
    seeded: bool,
}

impl TreeState {
    /// Whether a full scan has ever populated this belief. Scoped scans are
    /// only meaningful against a seeded belief.
    pub fn seeded(&self) -> bool {
        self.seeded
    }

    /// Adopt a full walk's result wholesale (full scans, backstops, degrades).
    pub fn rebuild(&mut self, entries: &[RawEntry]) {
        self.entries = entries
            .iter()
            .map(|entry| (entry.rel_path.clone(), entry.clone()))
            .collect();
        self.seeded = true;
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.seeded = false;
    }

    /// The synthesized full entry list, sorted so parents precede children
    /// (lexicographic path order guarantees the prefix property).
    pub fn synthesized_entries(&self) -> Vec<RawEntry> {
        let mut entries: Vec<RawEntry> = self.entries.values().cloned().collect();
        entries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        entries
    }

    /// Count of paths where `walked` disagrees with the belief — the canary
    /// metric compared on every backstop full scan while scoped mode is live.
    pub fn divergence_from(&self, walked: &[RawEntry]) -> Vec<PathBuf> {
        let walked_map: HashMap<&PathBuf, &RawEntry> = walked
            .iter()
            .map(|entry| (&entry.rel_path, entry))
            .collect();
        let mut diverged = Vec::new();
        for (rel, believed) in &self.entries {
            if is_event_invisible_path(rel) {
                continue;
            }
            match walked_map.get(rel) {
                Some(actual)
                    if actual.mtime_ns == believed.mtime_ns
                        && actual.size == believed.size
                        && actual.file_type == believed.file_type => {}
                _ => diverged.push(rel.clone()),
            }
        }
        diverged.extend(
            walked
                .iter()
                .filter(|entry| {
                    !is_event_invisible_path(&entry.rel_path)
                        && !self.entries.contains_key(&entry.rel_path)
                })
                .map(|entry| entry.rel_path.clone()),
        );
        diverged
    }

    fn remove_subtree(&mut self, rel: &Path) {
        self.entries
            .retain(|known, _| !(known == rel || known.starts_with(rel)));
    }

    /// Patch the belief from a drained dirty-path set (paths rel to the tree
    /// root). Paths are coalesced first: a path covered by a dirty ancestor
    /// directory is redundant — the ancestor's recursive rescan visits it.
    pub fn apply_dirty_paths(
        &mut self,
        source: &dyn EntrySource,
        dirty_rels: &[PathBuf],
    ) -> io::Result<()> {
        let mut sorted: Vec<&PathBuf> = dirty_rels.iter().collect();
        sorted.sort();
        let mut scanned_dirs: Vec<PathBuf> = Vec::new();
        for rel in sorted {
            if scanned_dirs.iter().any(|dir| rel.starts_with(dir)) {
                continue;
            }
            self.refresh_ancestors(source, rel)?;
            match source.stat_entry(rel)? {
                None => self.remove_subtree(rel),
                Some(entry) if entry.is_dir() => {
                    let subtree = source.walk_subtree(rel)?;
                    self.remove_subtree(rel);
                    for entry in subtree {
                        self.entries.insert(entry.rel_path.clone(), entry);
                    }
                    scanned_dirs.push(rel.clone());
                }
                Some(entry) => {
                    self.entries.insert(entry.rel_path.clone(), entry);
                }
            }
        }
        Ok(())
    }

    /// Re-stat every ancestor directory of `rel` so their entries (and the
    /// overlay xattrs classification reads from them) exist and are current.
    fn refresh_ancestors(&mut self, source: &dyn EntrySource, rel: &Path) -> io::Result<()> {
        let mut ancestor = rel.parent();
        while let Some(dir) = ancestor {
            if dir.as_os_str().is_empty() {
                break;
            }
            match source.stat_entry(dir)? {
                Some(entry) => {
                    self.entries.insert(entry.rel_path.clone(), entry);
                }
                None => {
                    self.remove_subtree(dir);
                    break;
                }
            }
            ancestor = dir.parent();
        }
        Ok(())
    }
}

impl RawEntry {
    fn is_dir(&self) -> bool {
        matches!(self.file_type, crate::overlay::RawFileType::Dir)
    }
}

/// Cross-platform `EntrySource` over a real directory tree using plain std
/// syscalls (lstat + best-effort overlay xattrs). The daemon uses this against
/// the session upper; tests use it against temp dirs on any OS.
pub struct FsEntrySource {
    root: PathBuf,
}

impl FsEntrySource {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn entry_for(&self, rel: &Path, meta: &std::fs::Metadata) -> RawEntry {
        use crate::overlay::RawFileType;
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        let ft = meta.file_type();
        let file_type = if ft.is_symlink() {
            RawFileType::Symlink
        } else if ft.is_dir() {
            RawFileType::Dir
        } else if is_char_device(&ft) {
            RawFileType::CharDevice
        } else if ft.is_file() {
            RawFileType::Regular
        } else {
            RawFileType::Other
        };
        let path = self.root.join(rel);
        RawEntry {
            rel_path: rel.to_path_buf(),
            file_type,
            #[cfg(unix)]
            rdev: meta.rdev(),
            #[cfg(not(unix))]
            rdev: 0,
            #[cfg(unix)]
            size: meta.size(),
            #[cfg(not(unix))]
            size: meta.len(),
            #[cfg(unix)]
            mtime_ns: meta.mtime() * 1_000_000_000 + meta.mtime_nsec(),
            #[cfg(not(unix))]
            mtime_ns: 0,
            xattrs: read_overlay_xattrs(&path),
        }
    }
}

#[cfg(unix)]
fn is_char_device(ft: &std::fs::FileType) -> bool {
    use std::os::unix::fs::FileTypeExt;
    ft.is_char_device()
}

#[cfg(not(unix))]
fn is_char_device(_ft: &std::fs::FileType) -> bool {
    false
}

fn read_overlay_xattrs(path: &Path) -> Vec<(String, Vec<u8>)> {
    #[cfg(target_os = "linux")]
    use crate::overlay::{XATTR_METACOPY, XATTR_OPAQUE, XATTR_REDIRECT};
    #[allow(unused_mut)]
    let mut out = Vec::new();
    #[cfg(target_os = "linux")]
    for name in [XATTR_OPAQUE, XATTR_REDIRECT, XATTR_METACOPY] {
        if let Ok(Some(val)) = xattr::get(path, name) {
            out.push((name.to_string(), val));
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = path;
    out
}

impl EntrySource for FsEntrySource {
    fn stat_entry(&self, rel: &Path) -> io::Result<Option<RawEntry>> {
        match std::fs::symlink_metadata(self.root.join(rel)) {
            Ok(meta) => Ok(Some(self.entry_for(rel, &meta))),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    fn walk_subtree(&self, rel: &Path) -> io::Result<Vec<RawEntry>> {
        let mut out = Vec::new();
        let Some(root_entry) = self.stat_entry(rel)? else {
            return Ok(out);
        };
        let is_dir = root_entry.is_dir();
        out.push(root_entry);
        if !is_dir {
            return Ok(out);
        }
        let mut stack = vec![rel.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let read = match std::fs::read_dir(self.root.join(&dir)) {
                Ok(read) => read,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            for entry in read {
                let entry = entry?;
                let child_rel = dir.join(entry.file_name());
                let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                    continue; // vanished mid-walk: the next event re-dirties it
                };
                let raw = self.entry_for(&child_rel, &meta);
                let descend = raw.is_dir();
                out.push(raw);
                if descend {
                    stack.push(child_rel);
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn walk_all(source: &FsEntrySource) -> Vec<RawEntry> {
        let mut entries = Vec::new();
        for child in fs::read_dir(&source.root).unwrap() {
            let child = child.unwrap();
            entries.extend(source.walk_subtree(Path::new(&child.file_name())).unwrap());
        }
        entries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        entries
    }

    fn assert_matches_disk(tree: &TreeState, source: &FsEntrySource) {
        let walked = walk_all(source);
        let divergence = tree.divergence_from(&walked);
        assert_eq!(
            divergence,
            Vec::<PathBuf>::new(),
            "belief diverged from disk\nbelief: {:?}\ndisk: {:?}",
            tree.synthesized_entries()
                .iter()
                .map(|e| e.rel_path.display().to_string())
                .collect::<Vec<_>>(),
            walked
                .iter()
                .map(|e| e.rel_path.display().to_string())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn patch_applies_file_create_modify_delete() {
        let temp = tempfile::tempdir().unwrap();
        let source = FsEntrySource::new(temp.path());
        fs::create_dir(temp.path().join("d")).unwrap();
        fs::write(temp.path().join("d").join("a.txt"), b"one").unwrap();
        let mut tree = TreeState::default();
        tree.rebuild(&walk_all(&source));

        fs::write(temp.path().join("d").join("b.txt"), b"two").unwrap();
        tree.apply_dirty_paths(&source, &[PathBuf::from("d/b.txt")])
            .unwrap();
        assert_matches_disk(&tree, &source);

        fs::write(temp.path().join("d").join("a.txt"), b"one-more").unwrap();
        tree.apply_dirty_paths(&source, &[PathBuf::from("d/a.txt")])
            .unwrap();
        assert_matches_disk(&tree, &source);

        fs::remove_file(temp.path().join("d").join("b.txt")).unwrap();
        tree.apply_dirty_paths(&source, &[PathBuf::from("d/b.txt")])
            .unwrap();
        assert_matches_disk(&tree, &source);
    }

    #[test]
    fn dirty_dir_rescans_whole_subtree_and_reconciles_deletes() {
        let temp = tempfile::tempdir().unwrap();
        let source = FsEntrySource::new(temp.path());
        fs::create_dir_all(temp.path().join("x").join("y")).unwrap();
        fs::write(temp.path().join("x").join("y").join("old.txt"), b"o").unwrap();
        let mut tree = TreeState::default();
        tree.rebuild(&walk_all(&source));

        // Unevented interior churn (the fresh-dir/moved-tree race): a dirty
        // mark on the DIR alone must repair everything under it.
        fs::remove_file(temp.path().join("x").join("y").join("old.txt")).unwrap();
        fs::create_dir(temp.path().join("x").join("y").join("z")).unwrap();
        fs::write(
            temp.path().join("x").join("y").join("z").join("new.txt"),
            b"n",
        )
        .unwrap();
        tree.apply_dirty_paths(&source, &[PathBuf::from("x/y")])
            .unwrap();
        assert_matches_disk(&tree, &source);
    }

    #[test]
    fn vanished_dir_drops_its_subtree_from_belief() {
        let temp = tempfile::tempdir().unwrap();
        let source = FsEntrySource::new(temp.path());
        fs::create_dir_all(temp.path().join("gone").join("deep")).unwrap();
        fs::write(temp.path().join("gone").join("deep").join("f.txt"), b"f").unwrap();
        fs::write(temp.path().join("keep.txt"), b"k").unwrap();
        let mut tree = TreeState::default();
        tree.rebuild(&walk_all(&source));

        fs::remove_dir_all(temp.path().join("gone")).unwrap();
        tree.apply_dirty_paths(&source, &[PathBuf::from("gone")])
            .unwrap();
        assert_matches_disk(&tree, &source);
        assert_eq!(tree.synthesized_entries().len(), 1);
    }

    #[test]
    fn coalescing_skips_paths_under_dirty_dirs_and_ancestors_materialize() {
        let temp = tempfile::tempdir().unwrap();
        let source = FsEntrySource::new(temp.path());
        fs::write(temp.path().join("seed.txt"), b"s").unwrap();
        let mut tree = TreeState::default();
        tree.rebuild(&walk_all(&source));

        // A brand-new nested tree, dirtied by dir + interior paths: ancestors
        // of the deepest file must exist in the belief afterward even though
        // only the leaf was dirtied last.
        fs::create_dir_all(temp.path().join("n").join("m")).unwrap();
        fs::write(temp.path().join("n").join("m").join("leaf.txt"), b"l").unwrap();
        tree.apply_dirty_paths(
            &source,
            &[
                PathBuf::from("n"),
                PathBuf::from("n/m"),
                PathBuf::from("n/m/leaf.txt"),
            ],
        )
        .unwrap();
        assert_matches_disk(&tree, &source);
        // And leaf-only dirt on a previously unknown branch also heals via
        // ancestor refresh.
        fs::create_dir_all(temp.path().join("p").join("q")).unwrap();
        fs::write(temp.path().join("p").join("q").join("only.txt"), b"o").unwrap();
        tree.apply_dirty_paths(&source, &[PathBuf::from("p/q/only.txt")])
            .unwrap();
        assert_matches_disk(&tree, &source);
    }

    #[test]
    fn synthesized_entries_sort_parents_before_children() {
        let temp = tempfile::tempdir().unwrap();
        let source = FsEntrySource::new(temp.path());
        fs::create_dir_all(temp.path().join("a").join("b")).unwrap();
        fs::write(temp.path().join("a").join("b").join("c.txt"), b"c").unwrap();
        fs::write(temp.path().join("a.txt"), b"a").unwrap();
        let mut tree = TreeState::default();
        tree.rebuild(&walk_all(&source));
        let entries = tree.synthesized_entries();
        let paths: Vec<&Path> = entries.iter().map(|e| e.rel_path.as_path()).collect();
        let pos = |p: &str| paths.iter().position(|x| *x == Path::new(p)).unwrap();
        assert!(pos("a") < pos("a/b"));
        assert!(pos("a/b") < pos("a/b/c.txt"));
    }

    /// Randomized differential: apply random op batches, dirty exactly the
    /// paths the ops named (files) or created/renamed (dirs), patch, and the
    /// belief must equal a fresh walk after every batch. This is the engine
    /// half of the POC's fuzz (event delivery is exercised separately by the
    /// linux integration test with real inotify).
    #[test]
    fn randomized_ops_differential_against_full_walk() {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut seed: u64 = 0x5eed_cafe;
        let mut rand = move || {
            let mut hasher = DefaultHasher::new();
            seed.hash(&mut hasher);
            seed = hasher.finish();
            seed
        };
        let temp = tempfile::tempdir().unwrap();
        let source = FsEntrySource::new(temp.path());
        fs::create_dir(temp.path().join("base")).unwrap();
        fs::write(temp.path().join("base").join("s.txt"), b"s").unwrap();
        let mut tree = TreeState::default();
        tree.rebuild(&walk_all(&source));

        for _batch in 0..40 {
            let mut dirty: Vec<PathBuf> = Vec::new();
            for _op in 0..6 {
                match rand() % 5 {
                    0 => {
                        let dir = PathBuf::from(format!("d{}", rand() % 4));
                        let file = dir.join(format!("f{}.txt", rand() % 6));
                        fs::create_dir_all(temp.path().join(&dir)).unwrap();
                        fs::write(temp.path().join(&file), rand().to_le_bytes()).unwrap();
                        dirty.push(dir.clone());
                        dirty.push(file);
                    }
                    1 => {
                        let file = PathBuf::from(format!("d{}/f{}.txt", rand() % 4, rand() % 6));
                        if temp.path().join(&file).exists() {
                            fs::remove_file(temp.path().join(&file)).unwrap();
                            dirty.push(file);
                        }
                    }
                    2 => {
                        let dir = PathBuf::from(format!("d{}", rand() % 4));
                        if temp.path().join(&dir).exists() {
                            fs::remove_dir_all(temp.path().join(&dir)).unwrap();
                            dirty.push(dir);
                        }
                    }
                    3 => {
                        // mv a populated dir to a new name: both ends dirty
                        let src_dir = PathBuf::from(format!("d{}", rand() % 4));
                        let dst_dir = PathBuf::from(format!("moved{}", rand() % 3));
                        if temp.path().join(&src_dir).exists()
                            && !temp.path().join(&dst_dir).exists()
                        {
                            fs::rename(temp.path().join(&src_dir), temp.path().join(&dst_dir))
                                .unwrap();
                            dirty.push(src_dir);
                            dirty.push(dst_dir);
                        }
                    }
                    _ => {
                        let deep = PathBuf::from(format!("deep{}/a/b", rand() % 3));
                        let leaf = deep.join("leaf.txt");
                        fs::create_dir_all(temp.path().join(&deep)).unwrap();
                        fs::write(temp.path().join(&leaf), rand().to_le_bytes()).unwrap();
                        // only the TOP dir is dirtied — interior arrival raced
                        dirty.push(PathBuf::from(format!("deep{}", rand() % 3)));
                        dirty.push(leaf);
                    }
                }
            }
            tree.apply_dirty_paths(&source, &dirty).unwrap();
            assert_matches_disk(&tree, &source);
        }
    }
}
