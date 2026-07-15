//! End-to-end differential for scoped scanning: real filesystem ops → real
//! inotify events through `MergedTreeWatcher` → `DirtySessions` → `TreeState`
//! patches — after quiescence the belief must equal a fresh full walk.
//!
//! This is the crate-resident port of the POC harness that originally proved
//! the naive path-scoped design loses files (1,319 across 24 rounds) and that
//! the recursive-dir policy loses none. Linux-only: inotify.
#![cfg(target_os = "linux")]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use centaur_node_sync::daemon::loop_state::DirtySessions;
use centaur_node_sync::scoped::{EntrySource, FsEntrySource, TreeState};
use centaur_node_sync::watch::{MergedTreeWatcher, WatchMessage};

struct Harness {
    _temp: tempfile::TempDir,
    root: PathBuf,
    _watcher: MergedTreeWatcher,
    rx: mpsc::Receiver<WatchMessage>,
    dirty: DirtySessions,
    tree: TreeState,
}

impl Harness {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        fs::create_dir_all(root.join("pre").join("two")).unwrap();
        fs::write(root.join("pre").join("base.txt"), b"base").unwrap();
        let (tx, rx) = mpsc::channel();
        let watcher = MergedTreeWatcher::start(tx).unwrap();
        assert!(watcher.add_session("s1", &root).attached);
        let mut tree = TreeState::default();
        tree.rebuild(&walk_all(&root));
        Self {
            _temp: temp,
            root,
            _watcher: watcher,
            rx,
            dirty: DirtySessions::default(),
            tree,
        }
    }

    /// Drain events until the stream stays quiet for `settle`.
    fn quiesce(&mut self, settle: Duration) {
        let mut last = Instant::now();
        loop {
            match self.rx.recv_timeout(Duration::from_millis(25)) {
                Ok(WatchMessage::Dirty { session, path }) => {
                    self.dirty.mark(session, path);
                    last = Instant::now();
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if last.elapsed() >= settle {
                        return;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    /// One scoped-scan round: drain dirt, patch the belief, compare to disk.
    /// Returns whether the drained dirt had degraded to a full rescan.
    fn scan_and_assert(&mut self, context: &str) -> bool {
        self.quiesce(Duration::from_millis(300));
        let drained = self.dirty.clear_for_scan("s1");
        let source = FsEntrySource::new(&self.root);
        let full = drained.full;
        if full {
            self.tree.rebuild(&walk_all(&self.root));
        } else {
            let rels: Vec<PathBuf> = drained
                .paths
                .iter()
                .filter_map(|p| p.strip_prefix(&self.root).ok().map(Path::to_path_buf))
                .collect();
            self.tree.apply_dirty_paths(&source, &rels).unwrap();
        }
        let walked = walk_all(&self.root);
        assert_eq!(
            self.tree.divergence_from(&walked),
            Vec::<PathBuf>::new(),
            "{context}: scoped belief diverged from disk (full={full})"
        );
        full
    }
}

fn walk_all(root: &Path) -> Vec<centaur_node_sync::overlay::RawEntry> {
    let source = FsEntrySource::new(root);
    let mut out = Vec::new();
    for child in fs::read_dir(root).unwrap() {
        let child = child.unwrap();
        out.extend(source.walk_subtree(Path::new(&child.file_name())).unwrap());
    }
    out
}

#[test]
fn fresh_dir_chain_with_immediate_writes() {
    let mut h = Harness::new();
    fs::create_dir_all(h.root.join("chain").join("a").join("b")).unwrap();
    fs::write(h.root.join("chain").join("f0.txt"), b"0").unwrap();
    fs::write(h.root.join("chain").join("a").join("f1.txt"), b"1").unwrap();
    fs::write(
        h.root.join("chain").join("a").join("b").join("f2.txt"),
        b"2",
    )
    .unwrap();
    h.scan_and_assert("fresh-dir chain");
}

#[test]
fn preexisting_tree_moved_in_then_written() {
    let mut h = Harness::new();
    let staging = tempfile::tempdir().unwrap();
    // Same filesystem => rename(2): one MOVED_TO for the top of the tree.
    let src = staging.path().join("tree");
    fs::create_dir_all(src.join("p").join("q")).unwrap();
    fs::write(src.join("p").join("q").join("seed.txt"), b"s").unwrap();
    let dst = h.root.join("tree");
    match fs::rename(&src, &dst) {
        Ok(()) => {}
        // Cross-device tempdirs: fall back to a copy (still exercises the
        // fresh-tree arrival path, just with CREATE events instead).
        Err(_) => {
            fs::create_dir_all(dst.join("p").join("q")).unwrap();
            fs::write(dst.join("p").join("q").join("seed.txt"), b"s").unwrap();
        }
    }
    std::thread::sleep(Duration::from_millis(50));
    fs::write(dst.join("p").join("q").join("late.txt"), b"late").unwrap();
    h.scan_and_assert("moved-in tree + late interior write");
}

#[test]
fn rename_within_root_then_write_into_moved_dir() {
    let mut h = Harness::new();
    let src = h.root.join("ren");
    fs::create_dir_all(src.join("inner")).unwrap();
    fs::write(src.join("inner").join("a.txt"), b"a").unwrap();
    h.quiesce(Duration::from_millis(200)); // let inner get watched
    let dst = h.root.join("ren-moved");
    fs::rename(&src, &dst).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    fs::write(dst.join("inner").join("post.txt"), b"p").unwrap();
    h.scan_and_assert("rename within root + post-rename interior write");
}

#[test]
fn build_like_burst_stays_convergent() {
    let mut h = Harness::new();
    for i in 0..400 {
        let dir = h.root.join("burst").join(format!("d{}", i % 23));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("o{i}.obj")), b"obj").unwrap();
    }
    h.scan_and_assert("400-file burst");
}

#[test]
fn delete_heavy_churn_reconciles() {
    let mut h = Harness::new();
    for i in 0..30 {
        fs::write(h.root.join("pre").join(format!("v{i}.txt")), b"v").unwrap();
    }
    h.scan_and_assert("seed 30 files");
    for i in 0..30 {
        if i % 2 == 0 {
            fs::remove_file(h.root.join("pre").join(format!("v{i}.txt"))).unwrap();
        }
    }
    fs::remove_dir_all(h.root.join("pre").join("two")).unwrap();
    h.scan_and_assert("interleaved deletes + rmdir");
}

#[test]
fn burst_beyond_cap_stays_convergent() {
    // More files than DIRTY_PATH_CAP (4096). Depending on machine speed the
    // dirt either exceeds the cap (degrade to full rescan — cap semantics are
    // unit-tested in watch.rs) or most file events lose the watch-registration
    // race and the recursive-dir rule carries the round. Either path must
    // converge; which one ran is machine-dependent, so it is not asserted.
    let mut h = Harness::new();
    for i in 0..4300 {
        let dir = h.root.join("big").join(format!("d{}", i % 61));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("f{i}.txt")), b"x").unwrap();
    }
    h.scan_and_assert("post-burst scan");
}

#[test]
fn multi_round_session_stays_convergent() {
    let mut h = Harness::new();
    for round in 0..8 {
        fs::create_dir_all(h.root.join(format!("r{round}")).join("sub")).unwrap();
        fs::write(
            h.root.join(format!("r{round}")).join("sub").join("w.txt"),
            round.to_string(),
        )
        .unwrap();
        if round % 3 == 2 {
            fs::remove_dir_all(h.root.join(format!("r{}", round - 1))).unwrap();
        }
        h.scan_and_assert(&format!("round {round}"));
    }
}
