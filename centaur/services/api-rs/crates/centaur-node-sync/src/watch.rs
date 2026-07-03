use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchMessage {
    Dirty(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AddSessionResult {
    pub attached: bool,
    pub always_scan: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DirtySessions {
    sessions: HashSet<String>,
}

impl DirtySessions {
    pub fn mark(&mut self, session: impl Into<String>) -> bool {
        self.sessions.insert(session.into())
    }

    pub fn contains(&self, session: &str) -> bool {
        self.sessions.contains(session)
    }

    pub fn clear_for_scan(&mut self, session: &str) -> bool {
        self.sessions.remove(session)
    }

    pub fn retain_sessions(&mut self, mut keep: impl FnMut(&str) -> bool) {
        self.sessions.retain(|session| keep(session));
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
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

pub fn kernel_supports_upper_data_events(release: &str) -> bool {
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
        kernel_supports_upper_data_events,
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

    pub struct UpperWatcher {
        inner: UpperWatcherInner,
    }

    enum UpperWatcherInner {
        Active {
            command_tx: mpsc::Sender<WatchCommand>,
            shared: Arc<Mutex<WatcherSharedState>>,
        },
        Disabled,
    }

    enum WatchCommand {
        Add {
            session_id: String,
            upper_root: PathBuf,
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
        session_wds: HashMap<String, Vec<WatchDescriptor>>,
        wd_dirs: HashMap<WatchDescriptor, WatchedDir>,
        session_roots: HashMap<String, PathBuf>,
    }

    impl UpperWatcher {
        pub fn from_env(dirty_tx: mpsc::Sender<WatchMessage>) -> Self {
            if !events_enabled_from_env_value(
                std::env::var("NODE_SYNC_EVENTS_ENABLED").ok().as_deref(),
            ) {
                eprintln!("node-sync upper inotify disabled by NODE_SYNC_EVENTS_ENABLED=0");
                return Self::disabled();
            }
            let release = match current_kernel_release() {
                Ok(release) => release,
                Err(error) => {
                    eprintln!(
                        "node-sync upper inotify disabled: could not read kernel release: {error}"
                    );
                    return Self::disabled();
                }
            };
            if !kernel_supports_upper_data_events(&release) {
                eprintln!(
                    "node-sync upper inotify disabled: kernel {release} is older than 6.5; falling back to scan-every-tick"
                );
                return Self::disabled();
            }
            match Self::start(dirty_tx) {
                Ok(watcher) => watcher,
                Err(error) => {
                    eprintln!(
                        "node-sync upper inotify disabled: inotify init failed: {error}; falling back to scan-every-tick"
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
                        session_wds: HashMap::new(),
                        wd_dirs: HashMap::new(),
                        session_roots: HashMap::new(),
                    },
                    command_rx,
                );
            });
            Ok(Self {
                inner: UpperWatcherInner::Active { command_tx, shared },
            })
        }

        fn disabled() -> Self {
            Self {
                inner: UpperWatcherInner::Disabled,
            }
        }

        pub fn is_enabled(&self) -> bool {
            matches!(self.inner, UpperWatcherInner::Active { .. })
        }

        pub fn is_always_scan(&self, session_id: &str) -> bool {
            match &self.inner {
                UpperWatcherInner::Active { shared, .. } => shared
                    .lock()
                    .map(|state| state.is_always_scan(session_id))
                    .unwrap_or(true),
                UpperWatcherInner::Disabled => true,
            }
        }

        pub fn add_session(
            &self,
            session_id: impl Into<String>,
            upper_root: impl AsRef<Path>,
        ) -> AddSessionResult {
            let session_id = session_id.into();
            let UpperWatcherInner::Active { command_tx, .. } = &self.inner else {
                return AddSessionResult {
                    attached: false,
                    always_scan: true,
                };
            };
            let (reply_tx, reply_rx) = mpsc::channel();
            if command_tx
                .send(WatchCommand::Add {
                    session_id,
                    upper_root: upper_root.as_ref().to_path_buf(),
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
            let UpperWatcherInner::Active { command_tx, .. } = &self.inner else {
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

    impl Drop for UpperWatcher {
        fn drop(&mut self) {
            if let UpperWatcherInner::Active { command_tx, .. } = &self.inner {
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
                    eprintln!("node-sync upper inotify read: {error}; marking all sessions dirty");
                    mark_all_dirty(&state);
                }
            }
        }
    }

    fn handle_command(state: &mut ReaderState, command: WatchCommand) -> bool {
        match command {
            WatchCommand::Add {
                session_id,
                upper_root,
                reply,
            } => {
                remove_session_watches(state, &session_id);
                state
                    .session_roots
                    .insert(session_id.clone(), upper_root.clone());
                let result = match add_session_watches(state, &session_id, &upper_root) {
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
                            "node-sync upper inotify add session={} root={}: {error}; falling back to scan-every-tick for this session",
                            session_id,
                            upper_root.display()
                        );
                        with_shared(state, |shared| shared.mark_always_scan(&session_id));
                        let _ = state.dirty_tx.send(WatchMessage::Dirty(session_id.clone()));
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
            eprintln!("node-sync upper inotify queue overflow; marking all sessions dirty");
            mark_all_dirty(state);
            return;
        }
        if mask.intersects(EventMask::IGNORED | EventMask::UNMOUNT) {
            // The wd_dirs entry is removed for IGNORED too (remove runs as the
            // first operand regardless of the UNMOUNT check).
            if let Some(watched) = state.wd_dirs.remove(&wd)
                && mask.contains(EventMask::UNMOUNT)
            {
                with_shared(state, |shared| shared.mark_always_scan(&watched.session_id));
                let _ = state
                    .dirty_tx
                    .send(WatchMessage::Dirty(watched.session_id.clone()));
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
        if mask.contains(EventMask::ISDIR)
            && mask.intersects(EventMask::CREATE | EventMask::MOVED_TO)
            && let Some(name) = name
        {
            let child = parent_path.join(name);
            if let Err(error) = add_dir_watch(state, &session_id, child) {
                eprintln!(
                    "node-sync upper inotify add new dir session={session_id}: {error}; falling back to scan-every-tick for this session"
                );
                with_shared(state, |shared| shared.mark_always_scan(&session_id));
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
        let _ = state.dirty_tx.send(WatchMessage::Dirty(session_id));
    }

    fn add_session_watches(
        state: &mut ReaderState,
        session_id: &str,
        upper_root: &Path,
    ) -> io::Result<()> {
        let mut stack = vec![upper_root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            add_dir_watch(state, session_id, dir.clone())?;
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                if entry.file_type()?.is_dir() {
                    stack.push(entry.path());
                }
            }
        }
        Ok(())
    }

    fn add_dir_watch(state: &mut ReaderState, session_id: &str, dir: PathBuf) -> io::Result<()> {
        let wd = state.inotify.watches().add(&dir, WATCH_MASK)?;
        state
            .session_wds
            .entry(session_id.to_string())
            .or_default()
            .push(wd.clone());
        state.wd_dirs.insert(
            wd,
            WatchedDir {
                session_id: session_id.to_string(),
                path: dir,
            },
        );
        Ok(())
    }

    fn remove_session_watches(state: &mut ReaderState, session_id: &str) {
        let Some(wds) = state.session_wds.remove(session_id) else {
            return;
        };
        let mut watches = state.inotify.watches();
        for wd in wds {
            state.wd_dirs.remove(&wd);
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
            let _ = state.dirty_tx.send(WatchMessage::Dirty(session));
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

    pub struct UpperWatcher;

    impl UpperWatcher {
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
            _upper_root: impl AsRef<Path>,
        ) -> AddSessionResult {
            AddSessionResult {
                attached: false,
                always_scan: true,
            }
        }

        pub fn remove_session(&self, _session_id: &str) {}
    }
}

pub use imp::UpperWatcher;

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
        assert!(kernel_supports_upper_data_events("7.0.0-prod"));
        assert!(kernel_supports_upper_data_events("6.5.0-101-generic"));
        assert!(!kernel_supports_upper_data_events("6.4.99"));
        assert!(!kernel_supports_upper_data_events("5.15.0"));
        assert!(!kernel_supports_upper_data_events("not-a-kernel"));
    }

    #[test]
    fn dirty_sessions_dedupes_and_clears_per_scan() {
        let mut dirty = DirtySessions::default();
        assert!(dirty.mark("s1"));
        assert!(!dirty.mark("s1"));
        assert!(dirty.contains("s1"));
        assert!(dirty.clear_for_scan("s1"));
        assert!(!dirty.contains("s1"));
        assert!(!dirty.clear_for_scan("s1"));
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
                    Ok(WatchMessage::Dirty(found)) if found == session => return,
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
            let watcher = UpperWatcher::start(tx).unwrap();
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
            let watcher = UpperWatcher::start(tx).unwrap();
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
            let watcher = UpperWatcher::start(tx).unwrap();
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

        #[test]
        fn remove_session_stops_future_events() {
            let temp = tempfile::tempdir().unwrap();
            let (tx, rx) = mpsc::channel();
            let watcher = UpperWatcher::start(tx).unwrap();
            assert!(watcher.add_session("s1", temp.path()).attached);
            watcher.remove_session("s1");
            while rx.try_recv().is_ok() {}

            fs::write(temp.path().join("ignored.txt"), b"ignored").unwrap();
            assert_no_dirty(&rx);
        }
    }
}
