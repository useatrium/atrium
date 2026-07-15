//! Portable tick-loop state for local filesystem dirtiness.
//! Linux watch adapters emit events; this module owns how the daemon retains
//! and drains those events between scans.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
