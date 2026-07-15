use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchMessage {
    /// A watched session changed. `path` names the changed entry (a file, or a
    /// directory whose subtree must be treated as dirty) when the event carried
    /// one; `None` means the whole session must be rescanned (overflow, unmount,
    /// watch failure).
    Dirty {
        session: String,
        path: Option<PathBuf>,
    },
}

/// Dependency/build trees that are never watched or capture-scanned: they are
/// reproducible from lockfiles and are junk the permanent artifact ledger must
/// not retain. Keeping them pruned also keeps per-session watch counts low
/// instead of node_modules-sized (measured: one pnpm install adds ~15.5k dirs).
pub const UNWATCHED_DIR_NAMES: &[&str] = &[
    "node_modules",
    ".pnpm",
    ".git",
    "target",
    ".venv",
    "__pycache__",
    ".cache",
    ".turbo",
    ".mypy_cache",
    ".pytest_cache",
];

pub fn is_unwatched_dir_name(name: &std::ffi::OsStr) -> bool {
    UNWATCHED_DIR_NAMES
        .iter()
        .any(|skip| std::ffi::OsStr::new(skip) == name)
}

/// Whether any normal component of a capture-side path names a dependency or
/// build tree pruned by the watcher. This is deliberately the same exact,
/// case-sensitive name predicate used during watch registration.
pub fn is_unwatched_path(path: &std::path::Path) -> bool {
    path.components()
        .any(|component| is_unwatched_dir_name(component.as_os_str()))
}

/// Per-session cap on tracked dirty paths. A busy build dirties more distinct
/// paths than a scoped scan could visit cheaper than a full walk, so past the
/// cap the session degrades to whole-session dirty (today's behavior).
pub const DIRTY_PATH_CAP: usize = 4096;

/// What one scan drained from the dirty set: either "scan everything" or the
/// specific paths that changed since the last drain.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DrainedDirt {
    pub full: bool,
    pub paths: Vec<PathBuf>,
}

impl DrainedDirt {
    pub fn any(&self) -> bool {
        self.full || !self.paths.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AddSessionResult {
    pub attached: bool,
    pub always_scan: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DirtySessions {
    /// Sessions needing a whole-session rescan (overflow/unmount/cap/legacy).
    full: HashSet<String>,
    /// Per-session changed paths (absolute, under the watch root).
    paths: HashMap<String, HashSet<PathBuf>>,
}

impl DirtySessions {
    /// Mark a session dirty. `path=None` marks the whole session; a path marks
    /// just that entry. Past [`DIRTY_PATH_CAP`] the session degrades to full.
    pub fn mark(&mut self, session: impl Into<String>, path: Option<PathBuf>) -> bool {
        let session = session.into();
        match path {
            None => {
                self.paths.remove(&session);
                self.full.insert(session)
            }
            Some(path) => {
                if self.full.contains(&session) {
                    return false;
                }
                let paths = self.paths.entry(session.clone()).or_default();
                let inserted = paths.insert(path);
                if paths.len() > DIRTY_PATH_CAP {
                    self.paths.remove(&session);
                    self.full.insert(session);
                }
                inserted
            }
        }
    }

    pub fn contains(&self, session: &str) -> bool {
        self.full.contains(session) || self.paths.contains_key(session)
    }

    pub fn clear_for_scan(&mut self, session: &str) -> DrainedDirt {
        let full = self.full.remove(session);
        let paths = if full {
            Vec::new()
        } else {
            self.paths
                .remove(session)
                .map(|set| set.into_iter().collect())
                .unwrap_or_default()
        };
        DrainedDirt { full, paths }
    }

    pub fn retain_sessions(&mut self, mut keep: impl FnMut(&str) -> bool) {
        self.full.retain(|session| keep(session));
        self.paths.retain(|session, _| keep(session));
    }

    pub fn is_empty(&self) -> bool {
        self.full.is_empty() && self.paths.is_empty()
    }
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Default)]
struct WatcherSharedState {
    always_scan: HashSet<String>,
    active_sessions: HashSet<String>,
}

#[cfg(any(target_os = "linux", test))]
impl WatcherSharedState {
    fn mark_active(&mut self, session: &str) {
        self.active_sessions.insert(session.to_string());
    }

    fn mark_attached(&mut self, session: &str) {
        self.mark_active(session);
        self.always_scan.remove(session);
    }

    fn mark_always_scan(&mut self, session: &str) {
        self.mark_active(session);
        self.always_scan.insert(session.to_string());
    }

    fn remove_session(&mut self, session: &str) {
        self.active_sessions.remove(session);
        self.always_scan.remove(session);
    }

    #[cfg(target_os = "linux")]
    fn active_sessions(&self) -> Vec<String> {
        self.active_sessions.iter().cloned().collect()
    }

    fn is_always_scan(&self, session: &str) -> bool {
        self.always_scan.contains(session)
    }
}

pub fn events_enabled_from_env_value(value: Option<&str>) -> bool {
    value.is_none_or(|value| value.trim() != "0")
}

/// Whether this kernel has been validated for merged-directory overlayfs
/// watching. That strategy is simply untested below 6.5, so older or unknown
/// kernels conservatively fall back to `always_scan`. A pre-6.5 POC could
/// later relax this gate.
pub fn kernel_validated_for_merged_watch(release: &str) -> bool {
    let Some((major, minor)) = parse_kernel_major_minor(release) else {
        return false;
    };
    major > 6 || (major == 6 && minor >= 5)
}

fn parse_kernel_major_minor(release: &str) -> Option<(u64, u64)> {
    let mut parts = release.split(|ch: char| !ch.is_ascii_digit());
    let major = parts.find(|part| !part.is_empty())?.parse().ok()?;
    let minor = parts.find(|part| !part.is_empty())?.parse().ok()?;
    Some((major, minor))
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{
        AddSessionResult, WatchMessage, WatcherSharedState, events_enabled_from_env_value,
        kernel_validated_for_merged_watch,
    };
    use crate::overlay_mount::{OVERLAY_SIGNATURE_FILE, READY_MARKER_FILE};
    use inotify::{EventMask, Inotify, WatchDescriptor, WatchMask};
    use std::collections::HashMap;
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;

    const WATCH_MASK: WatchMask = WatchMask::CREATE
        .union(WatchMask::DELETE)
        .union(WatchMask::CLOSE_WRITE)
        .union(WatchMask::MOVED_FROM)
        .union(WatchMask::MOVED_TO)
        .union(WatchMask::ATTRIB)
        .union(WatchMask::MODIFY)
        .union(WatchMask::DONT_FOLLOW);

    pub struct MergedTreeWatcher {
        inner: MergedTreeWatcherInner,
    }

    enum MergedTreeWatcherInner {
        Active {
            command_tx: mpsc::Sender<WatchCommand>,
            shared: Arc<Mutex<WatcherSharedState>>,
        },
        Disabled,
    }

    enum WatchCommand {
        Add {
            session_id: String,
            watch_root: PathBuf,
            reply: mpsc::Sender<AddSessionResult>,
        },
        Remove {
            session_id: String,
            reply: mpsc::Sender<()>,
        },
        Shutdown,
    }

    struct WatchedDir {
        session_id: String,
        path: PathBuf,
    }

    struct ReaderState {
        inotify: Inotify,
        shared: Arc<Mutex<WatcherSharedState>>,
        dirty_tx: mpsc::Sender<WatchMessage>,
        /// Distinct directories watched across all sessions, against `watch_budget`.
        total_watches: usize,
        /// 80% of fs.inotify.max_user_watches at startup: sessions that would
        /// push past this attach as always_scan instead of failing at random
        /// depths mid-registration.
        watch_budget: usize,
        session_wds: HashMap<String, Vec<WatchDescriptor>>,
        wd_dirs: HashMap<WatchDescriptor, WatchedDir>,
        session_roots: HashMap<String, PathBuf>,
    }

    impl MergedTreeWatcher {
        pub fn from_env(dirty_tx: mpsc::Sender<WatchMessage>) -> Self {
            if !events_enabled_from_env_value(
                std::env::var("NODE_SYNC_EVENTS_ENABLED").ok().as_deref(),
            ) {
                eprintln!("node-sync merged inotify disabled by NODE_SYNC_EVENTS_ENABLED=0");
                return Self::disabled();
            }
            let release = match current_kernel_release() {
                Ok(release) => release,
                Err(error) => {
                    eprintln!(
                        "node-sync merged inotify disabled: could not read kernel release: {error}"
                    );
                    return Self::disabled();
                }
            };
            if !kernel_validated_for_merged_watch(&release) {
                eprintln!(
                    "node-sync merged inotify disabled: kernel {release} is older than 6.5; falling back to scan-every-tick"
                );
                return Self::disabled();
            }
            match Self::start(dirty_tx) {
                Ok(watcher) => watcher,
                Err(error) => {
                    eprintln!(
                        "node-sync merged inotify disabled: inotify init failed: {error}; falling back to scan-every-tick"
                    );
                    Self::disabled()
                }
            }
        }

        pub fn start(dirty_tx: mpsc::Sender<WatchMessage>) -> io::Result<Self> {
            let inotify = Inotify::init()?;
            let (command_tx, command_rx) = mpsc::channel();
            let shared = Arc::new(Mutex::new(WatcherSharedState::default()));
            let reader_shared = Arc::clone(&shared);
            std::thread::spawn(move || {
                reader_loop(
                    ReaderState {
                        inotify,
                        shared: reader_shared,
                        dirty_tx,
                        total_watches: 0,
                        watch_budget: watch_budget_from_sysctl(),
                        session_wds: HashMap::new(),
                        wd_dirs: HashMap::new(),
                        session_roots: HashMap::new(),
                    },
                    command_rx,
                );
            });
            Ok(Self {
                inner: MergedTreeWatcherInner::Active { command_tx, shared },
            })
        }

        fn disabled() -> Self {
            Self {
                inner: MergedTreeWatcherInner::Disabled,
            }
        }

        pub fn is_enabled(&self) -> bool {
            matches!(self.inner, MergedTreeWatcherInner::Active { .. })
        }

        pub fn is_always_scan(&self, session_id: &str) -> bool {
            match &self.inner {
                MergedTreeWatcherInner::Active { shared, .. } => shared
                    .lock()
                    .map(|state| state.is_always_scan(session_id))
                    .unwrap_or(true),
                MergedTreeWatcherInner::Disabled => true,
            }
        }

        pub fn add_session(
            &self,
            session_id: impl Into<String>,
            watch_root: impl AsRef<Path>,
        ) -> AddSessionResult {
            let session_id = session_id.into();
            let MergedTreeWatcherInner::Active { command_tx, .. } = &self.inner else {
                return AddSessionResult {
                    attached: false,
                    always_scan: true,
                };
            };
            let (reply_tx, reply_rx) = mpsc::channel();
            if command_tx
                .send(WatchCommand::Add {
                    session_id,
                    watch_root: watch_root.as_ref().to_path_buf(),
                    reply: reply_tx,
                })
                .is_err()
            {
                return AddSessionResult {
                    attached: false,
                    always_scan: true,
                };
            }
            reply_rx.recv().unwrap_or(AddSessionResult {
                attached: false,
                always_scan: true,
            })
        }

        pub fn remove_session(&self, session_id: &str) {
            let MergedTreeWatcherInner::Active { command_tx, .. } = &self.inner else {
                return;
            };
            let (reply_tx, reply_rx) = mpsc::channel();
            if command_tx
                .send(WatchCommand::Remove {
                    session_id: session_id.to_string(),
                    reply: reply_tx,
                })
                .is_ok()
            {
                let _ = reply_rx.recv();
            }
        }
    }

    impl Drop for MergedTreeWatcher {
        fn drop(&mut self) {
            if let MergedTreeWatcherInner::Active { command_tx, .. } = &self.inner {
                let _ = command_tx.send(WatchCommand::Shutdown);
            }
        }
    }

    fn current_kernel_release() -> Result<String, String> {
        let output = std::process::Command::new("uname")
            .arg("-r")
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(format!("uname -r exited with {}", output.status));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn reader_loop(mut state: ReaderState, command_rx: mpsc::Receiver<WatchCommand>) {
        let mut buffer = vec![0; 64 * 1024];
        loop {
            while let Ok(command) = command_rx.try_recv() {
                if handle_command(&mut state, command) {
                    return;
                }
            }
            match state.inotify.read_events(&mut buffer) {
                Ok(events) => {
                    let events = events
                        .map(|event| (event.wd, event.mask, event.name.map(PathBuf::from)))
                        .collect::<Vec<_>>();
                    for (wd, mask, name) in events {
                        handle_event(&mut state, wd, mask, name.as_deref());
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    match command_rx.recv_timeout(Duration::from_millis(10)) {
                        Ok(command) => {
                            if handle_command(&mut state, command) {
                                return;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                Err(error) => {
                    eprintln!("node-sync merged inotify read: {error}; marking all sessions dirty");
                    mark_all_dirty(&state);
                }
            }
        }
    }

    fn handle_command(state: &mut ReaderState, command: WatchCommand) -> bool {
        match command {
            WatchCommand::Add {
                session_id,
                watch_root,
                reply,
            } => {
                remove_session_watches(state, &session_id);
                state
                    .session_roots
                    .insert(session_id.clone(), watch_root.clone());
                let result = match add_session_watches(state, &session_id, &watch_root) {
                    Ok(()) => {
                        with_shared(state, |shared| shared.mark_attached(&session_id));
                        AddSessionResult {
                            attached: true,
                            always_scan: false,
                        }
                    }
                    Err(error) => {
                        remove_session_watches(state, &session_id);
                        eprintln!(
                            "node-sync merged inotify add session={} root={}: {error}; falling back to scan-every-tick for this session",
                            session_id,
                            watch_root.display()
                        );
                        with_shared(state, |shared| shared.mark_always_scan(&session_id));
                        let _ = state.dirty_tx.send(WatchMessage::Dirty {
                            session: session_id.clone(),
                            path: None,
                        });
                        AddSessionResult {
                            attached: false,
                            always_scan: true,
                        }
                    }
                };
                let _ = reply.send(result);
                false
            }
            WatchCommand::Remove { session_id, reply } => {
                remove_session_watches(state, &session_id);
                state.session_roots.remove(&session_id);
                with_shared(state, |shared| shared.remove_session(&session_id));
                let _ = reply.send(());
                false
            }
            WatchCommand::Shutdown => true,
        }
    }

    fn handle_event(
        state: &mut ReaderState,
        wd: WatchDescriptor,
        mask: EventMask,
        name: Option<&Path>,
    ) {
        if mask.contains(EventMask::Q_OVERFLOW) {
            eprintln!("node-sync merged inotify queue overflow; marking all sessions dirty");
            mark_all_dirty(state);
            return;
        }
        if mask.intersects(EventMask::IGNORED | EventMask::UNMOUNT) {
            // The wd_dirs entry is removed for IGNORED too (remove runs as the
            // first operand regardless of the UNMOUNT check).
            if let Some(watched) = state.wd_dirs.remove(&wd) {
                state.total_watches = state.total_watches.saturating_sub(1);
                if mask.contains(EventMask::UNMOUNT) {
                    with_shared(state, |shared| shared.mark_always_scan(&watched.session_id));
                    let _ = state.dirty_tx.send(WatchMessage::Dirty {
                        session: watched.session_id.clone(),
                        path: None,
                    });
                }
            }
            return;
        }
        let Some((session_id, parent_path)) = state
            .wd_dirs
            .get(&wd)
            .map(|watched| (watched.session_id.clone(), watched.path.clone()))
        else {
            return;
        };
        if let Some(name) = name
            && super::is_unwatched_dir_name(name.as_os_str())
            && mask.contains(EventMask::ISDIR)
        {
            // A dep/build tree appeared (or churned): never watch it and never
            // path-dirty it — backstop full scans own these subtrees.
            return;
        }
        if mask.contains(EventMask::ISDIR)
            && mask.intersects(EventMask::CREATE | EventMask::MOVED_TO)
            && let Some(name) = name
        {
            // Recursive: a moved-in or freshly created tree can already have
            // interior directories whose own creation was never evented (POC:
            // per-dir watch registration races are real and intermittent). The
            // kernel returns the SAME wd for an already-watched inode, so
            // re-registering after a rename also heals stale wd->path mappings.
            let child = parent_path.join(name);
            if let Err(error) = add_tree_watches(state, &session_id, &child) {
                eprintln!(
                    "node-sync merged inotify add new dir session={session_id}: {error}; falling back to scan-every-tick for this session"
                );
                with_shared(state, |shared| shared.mark_always_scan(&session_id));
                let _ = state.dirty_tx.send(WatchMessage::Dirty {
                    session: session_id,
                    path: None,
                });
                return;
            }
        }
        // The daemon itself rewrites the ready marker into merged root every
        // tick (and the overlay signature on mounts); both land in the upper.
        // Without this filter every tick re-dirties every session and the loop
        // wakes itself at the pacer floor forever (observed live: 250ms-paced
        // full scans, ~18% CPU). Only root-level entries with these exact
        // names are daemon-authored; the same names deeper down are agent files.
        let at_session_root =
            state.session_roots.get(&session_id).map(PathBuf::as_path) == Some(&parent_path);
        if let Some(name) = name
            && at_session_root
            && (name == Path::new(READY_MARKER_FILE) || name == Path::new(OVERLAY_SIGNATURE_FILE))
        {
            return;
        }
        // A name-less ATTRIB on the session root is the daemon's own per-tick
        // chown/utimes of the merged root — the second self-dirty source
        // observed live (the marker filter alone left the loop running). Root
        // dir attributes are never captured content; child events still dirty.
        if name.is_none() && at_session_root && mask.contains(EventMask::ATTRIB) {
            return;
        }
        let path = match name {
            Some(name) => parent_path.join(name),
            None => parent_path,
        };
        let _ = state.dirty_tx.send(WatchMessage::Dirty {
            session: session_id,
            path: Some(path),
        });
    }

    /// Sysctl-derived watch budget: 80% of fs.inotify.max_user_watches, so a
    /// too-big session degrades to always_scan up front instead of eating the
    /// node's whole allowance and failing other sessions' adds at random depths.
    fn watch_budget_from_sysctl() -> usize {
        const FALLBACK: usize = 52_000; // 80% of the common 65536 default
        std::fs::read_to_string("/proc/sys/fs/inotify/max_user_watches")
            .ok()
            .and_then(|value| value.trim().parse::<usize>().ok())
            .map(|limit| limit / 5 * 4)
            .unwrap_or(FALLBACK)
    }

    fn add_session_watches(
        state: &mut ReaderState,
        session_id: &str,
        watch_root: &Path,
    ) -> io::Result<()> {
        add_tree_watches(state, session_id, watch_root)
    }

    /// Watch `root` and every non-pruned directory under it.
    fn add_tree_watches(state: &mut ReaderState, session_id: &str, root: &Path) -> io::Result<()> {
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            add_dir_watch(state, session_id, dir.clone())?;
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                if entry.file_type()?.is_dir() && !super::is_unwatched_dir_name(&entry.file_name())
                {
                    stack.push(entry.path());
                }
            }
        }
        Ok(())
    }

    fn add_dir_watch(state: &mut ReaderState, session_id: &str, dir: PathBuf) -> io::Result<()> {
        if state.total_watches >= state.watch_budget {
            return Err(io::Error::other(format!(
                "watch budget exhausted ({} of {} watches in use)",
                state.total_watches, state.watch_budget
            )));
        }
        let wd = state.inotify.watches().add(&dir, WATCH_MASK)?;
        // Same-inode re-adds return the same wd: refresh the path mapping (this
        // is what heals stale paths after a directory rename) and don't count
        // the watch twice.
        let already_watched = state
            .wd_dirs
            .insert(
                wd.clone(),
                WatchedDir {
                    session_id: session_id.to_string(),
                    path: dir,
                },
            )
            .is_some();
        if already_watched {
            return Ok(());
        }
        state.total_watches += 1;
        state
            .session_wds
            .entry(session_id.to_string())
            .or_default()
            .push(wd);
        Ok(())
    }

    fn remove_session_watches(state: &mut ReaderState, session_id: &str) {
        let Some(wds) = state.session_wds.remove(session_id) else {
            return;
        };
        let mut watches = state.inotify.watches();
        for wd in wds {
            if state.wd_dirs.remove(&wd).is_some() {
                state.total_watches = state.total_watches.saturating_sub(1);
            }
            let _ = watches.remove(wd);
        }
    }

    fn mark_all_dirty(state: &ReaderState) {
        let sessions = state
            .shared
            .lock()
            .map(|shared| shared.active_sessions())
            .unwrap_or_default();
        for session in sessions {
            let _ = state.dirty_tx.send(WatchMessage::Dirty {
                session,
                path: None,
            });
        }
    }

    fn with_shared(state: &ReaderState, f: impl FnOnce(&mut WatcherSharedState)) {
        if let Ok(mut shared) = state.shared.lock() {
            f(&mut shared);
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::{AddSessionResult, WatchMessage};
    use std::path::Path;
    use std::sync::mpsc;

    pub struct MergedTreeWatcher;

    impl MergedTreeWatcher {
        pub fn from_env(_dirty_tx: mpsc::Sender<WatchMessage>) -> Self {
            Self
        }

        pub fn start(_dirty_tx: mpsc::Sender<WatchMessage>) -> std::io::Result<Self> {
            Ok(Self)
        }

        pub fn is_enabled(&self) -> bool {
            false
        }

        pub fn is_always_scan(&self, _session_id: &str) -> bool {
            true
        }

        pub fn add_session(
            &self,
            _session_id: impl Into<String>,
            _watch_root: impl AsRef<Path>,
        ) -> AddSessionResult {
            AddSessionResult {
                attached: false,
                always_scan: true,
            }
        }

        pub fn remove_session(&self, _session_id: &str) {}
    }
}

pub use imp::MergedTreeWatcher;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_enabled_defaults_on_and_only_zero_disables() {
        assert!(events_enabled_from_env_value(None));
        assert!(events_enabled_from_env_value(Some("")));
        assert!(events_enabled_from_env_value(Some("false")));
        assert!(events_enabled_from_env_value(Some("1")));
        assert!(!events_enabled_from_env_value(Some("0")));
        assert!(!events_enabled_from_env_value(Some(" 0 ")));
    }

    #[test]
    fn kernel_version_gate_parses_major_minor() {
        assert!(kernel_validated_for_merged_watch("7.0.0-prod"));
        assert!(kernel_validated_for_merged_watch("6.5.0-101-generic"));
        assert!(!kernel_validated_for_merged_watch("6.4.99"));
        assert!(!kernel_validated_for_merged_watch("5.15.0"));
        assert!(!kernel_validated_for_merged_watch("not-a-kernel"));
    }

    #[test]
    fn dirty_sessions_dedupes_and_clears_per_scan() {
        let mut dirty = DirtySessions::default();
        assert!(dirty.mark("s1", None));
        assert!(!dirty.mark("s1", None));
        assert!(dirty.contains("s1"));
        assert!(dirty.clear_for_scan("s1").any());
        assert!(!dirty.contains("s1"));
        assert!(!dirty.clear_for_scan("s1").any());
    }

    #[test]
    fn dirty_paths_collect_and_full_dirty_absorbs_them() {
        let mut dirty = DirtySessions::default();
        assert!(dirty.mark("s1", Some(PathBuf::from("/m/a.txt"))));
        assert!(!dirty.mark("s1", Some(PathBuf::from("/m/a.txt"))));
        assert!(dirty.mark("s1", Some(PathBuf::from("/m/b/c.txt"))));
        assert!(dirty.contains("s1"));
        let drained = dirty.clear_for_scan("s1");
        assert!(!drained.full);
        assert_eq!(drained.paths.len(), 2);
        // Full dirt swallows path dirt and drains as full.
        dirty.mark("s1", Some(PathBuf::from("/m/a.txt")));
        dirty.mark("s1", None);
        dirty.mark("s1", Some(PathBuf::from("/m/late.txt")));
        let drained = dirty.clear_for_scan("s1");
        assert!(drained.full);
        assert!(drained.paths.is_empty());
    }

    #[test]
    fn dirty_path_cap_degrades_to_full() {
        let mut dirty = DirtySessions::default();
        for i in 0..=DIRTY_PATH_CAP {
            dirty.mark("s1", Some(PathBuf::from(format!("/m/f{i}"))));
        }
        let drained = dirty.clear_for_scan("s1");
        assert!(drained.full, "cap overflow must degrade to a full rescan");
        assert!(drained.paths.is_empty());
    }

    #[test]
    fn unwatched_dir_names_match_exactly() {
        use std::ffi::OsStr;
        assert!(is_unwatched_dir_name(OsStr::new("node_modules")));
        assert!(is_unwatched_dir_name(OsStr::new("target")));
        assert!(!is_unwatched_dir_name(OsStr::new("node_modules2")));
        assert!(!is_unwatched_dir_name(OsStr::new("src")));
        assert!(is_unwatched_path(std::path::Path::new(
            "a/node_modules/b/c.js"
        )));
        assert!(!is_unwatched_path(std::path::Path::new(
            "a/node_modules2/b/c.js"
        )));
    }

    #[test]
    fn always_scan_state_is_per_session() {
        let mut state = WatcherSharedState::default();
        state.mark_always_scan("s1");
        state.mark_attached("s2");
        assert!(state.is_always_scan("s1"));
        assert!(!state.is_always_scan("s2"));
        state.mark_attached("s1");
        assert!(!state.is_always_scan("s1"));
        state.remove_session("s1");
        assert!(!state.is_always_scan("s1"));
    }

    #[cfg(target_os = "linux")]
    mod linux {
        use super::*;
        use std::fs;
        use std::io::Write;
        use std::sync::mpsc;
        use std::time::Duration;

        fn recv_dirty(rx: &mpsc::Receiver<WatchMessage>, session: &str) {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            loop {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                match rx.recv_timeout(remaining) {
                    Ok(WatchMessage::Dirty { session: found, .. }) if found == session => return,
                    Ok(_) => continue,
                    Err(error) => panic!("timed out waiting for dirty {session}: {error}"),
                }
            }
        }

        fn assert_no_dirty(rx: &mpsc::Receiver<WatchMessage>) {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                other => panic!("expected no dirty message, got {other:?}"),
            }
        }

        #[test]
        fn watcher_reports_file_create_modify_rename_and_delete() {
            let temp = tempfile::tempdir().unwrap();
            let (tx, rx) = mpsc::channel();
            let watcher = MergedTreeWatcher::start(tx).unwrap();
            let result = watcher.add_session("s1", temp.path());
            assert!(result.attached);

            let file = temp.path().join("a.txt");
            fs::write(&file, b"one").unwrap();
            recv_dirty(&rx, "s1");

            let mut opened = fs::OpenOptions::new().append(true).open(&file).unwrap();
            writeln!(opened, "two").unwrap();
            drop(opened);
            recv_dirty(&rx, "s1");

            let renamed = temp.path().join("b.txt");
            fs::rename(&file, &renamed).unwrap();
            recv_dirty(&rx, "s1");

            fs::remove_file(renamed).unwrap();
            recv_dirty(&rx, "s1");
        }

        #[test]
        fn watcher_adds_new_directory_before_marking_dirty() {
            let temp = tempfile::tempdir().unwrap();
            let (tx, rx) = mpsc::channel();
            let watcher = MergedTreeWatcher::start(tx).unwrap();
            assert!(watcher.add_session("s1", temp.path()).attached);

            let dir = temp.path().join("new");
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("first.txt"), b"first").unwrap();
            recv_dirty(&rx, "s1");

            fs::write(dir.join("later.txt"), b"later").unwrap();
            recv_dirty(&rx, "s1");
        }

        #[test]
        fn daemon_authored_root_markers_do_not_dirty() {
            let temp = tempfile::tempdir().unwrap();
            let (tx, rx) = mpsc::channel();
            let watcher = MergedTreeWatcher::start(tx).unwrap();
            watcher.add_session("sess-markers", temp.path());

            // Daemon-authored marker files at the session ROOT must not dirty
            // (the daemon rewrites the ready marker every tick — regression pin
            // for the self-dirty wake loop observed live).
            std::fs::write(temp.path().join(".centaur-workspace-ready"), b"ready").unwrap();
            std::fs::write(temp.path().join(".centaur-overlay-signature"), b"sig").unwrap();
            assert_no_dirty(&rx);

            // The same names in a SUBDIR are agent files and must dirty.
            std::fs::create_dir(temp.path().join("sub")).unwrap();
            recv_dirty(&rx, "sess-markers");
            std::fs::write(
                temp.path().join("sub").join(".centaur-workspace-ready"),
                b"agent-file",
            )
            .unwrap();
            recv_dirty(&rx, "sess-markers");

            // Drain the extra dirty messages from the multi-event write above
            // (CREATE + MODIFY + CLOSE_WRITE each send one) before asserting quiet.
            while rx.recv_timeout(Duration::from_millis(200)).is_ok() {}

            // A name-less ATTRIB on the root itself (the daemon's per-tick
            // chown/utimes of merged root) must not dirty either.
            let now = std::time::SystemTime::now();
            let f = std::fs::File::open(temp.path()).unwrap();
            f.set_times(
                std::fs::FileTimes::new()
                    .set_accessed(now)
                    .set_modified(now),
            )
            .unwrap();
            drop(f);
            assert_no_dirty(&rx);

            // And a normal root file still dirties.
            std::fs::write(temp.path().join("real.txt"), b"x").unwrap();
            recv_dirty(&rx, "sess-markers");
        }

        fn recv_dirty_path(rx: &mpsc::Receiver<WatchMessage>, session: &str) -> PathBuf {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            loop {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                match rx.recv_timeout(remaining) {
                    Ok(WatchMessage::Dirty {
                        session: found,
                        path: Some(path),
                    }) if found == session => return path,
                    Ok(_) => continue,
                    Err(error) => panic!("timed out waiting for dirty path {session}: {error}"),
                }
            }
        }

        #[test]
        fn dirty_messages_carry_the_changed_path() {
            let temp = tempfile::tempdir().unwrap();
            let (tx, rx) = mpsc::channel();
            let watcher = MergedTreeWatcher::start(tx).unwrap();
            assert!(watcher.add_session("s1", temp.path()).attached);

            let file = temp.path().join("carried.txt");
            fs::write(&file, b"x").unwrap();
            let mut saw_file = false;
            for _ in 0..4 {
                if recv_dirty_path(&rx, "s1") == file {
                    saw_file = true;
                    break;
                }
            }
            assert!(saw_file, "no dirty message named {}", file.display());
        }

        #[test]
        fn unwatched_dep_trees_neither_watch_nor_dirty() {
            let temp = tempfile::tempdir().unwrap();
            // Pre-existing dep tree at attach time: never watched.
            fs::create_dir_all(temp.path().join("node_modules").join("pkg")).unwrap();
            let (tx, rx) = mpsc::channel();
            let watcher = MergedTreeWatcher::start(tx).unwrap();
            assert!(watcher.add_session("s1", temp.path()).attached);

            fs::write(
                temp.path().join("node_modules").join("pkg").join("i.js"),
                b"x",
            )
            .unwrap();
            assert_no_dirty(&rx);

            // A dep tree appearing mid-session: the ISDIR event is swallowed.
            fs::create_dir(temp.path().join("target")).unwrap();
            assert_no_dirty(&rx);

            // Normal dirs still work.
            fs::write(temp.path().join("kept.txt"), b"x").unwrap();
            recv_dirty(&rx, "s1");
        }

        #[test]
        fn moved_in_tree_is_watched_recursively() {
            // POC-pinned race: a preexisting tree moved into the watch root got
            // only its top dir watched, so interior writes were never evented.
            let temp = tempfile::tempdir().unwrap();
            let staging = tempfile::tempdir_in(temp.path().parent().unwrap()).unwrap();
            let src = staging.path().join("tree");
            fs::create_dir_all(src.join("deep").join("deeper")).unwrap();
            fs::write(src.join("deep").join("deeper").join("seed.txt"), b"s").unwrap();

            let (tx, rx) = mpsc::channel();
            let watcher = MergedTreeWatcher::start(tx).unwrap();
            assert!(watcher.add_session("s1", temp.path()).attached);

            let dst = temp.path().join("tree");
            fs::rename(&src, &dst).unwrap();
            recv_dirty(&rx, "s1"); // the MOVED_TO itself
            while rx.recv_timeout(Duration::from_millis(200)).is_ok() {}

            // Interior write must event — requires the recursive registration.
            let interior = dst.join("deep").join("deeper").join("late.txt");
            fs::write(&interior, b"late").unwrap();
            let mut saw = false;
            for _ in 0..4 {
                if recv_dirty_path(&rx, "s1") == interior {
                    saw = true;
                    break;
                }
            }
            assert!(saw, "interior write after mv was not evented");
        }

        #[test]
        fn remove_session_stops_future_events() {
            let temp = tempfile::tempdir().unwrap();
            let (tx, rx) = mpsc::channel();
            let watcher = MergedTreeWatcher::start(tx).unwrap();
            assert!(watcher.add_session("s1", temp.path()).attached);
            watcher.remove_session("s1");
            while rx.try_recv().is_ok() {}

            fs::write(temp.path().join("ignored.txt"), b"ignored").unwrap();
            assert_no_dirty(&rx);
        }
    }
}
