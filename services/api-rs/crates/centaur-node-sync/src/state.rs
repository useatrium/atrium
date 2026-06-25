//! Daemon-persisted state (F1 — the spine). The node-sync loop is now STATEFUL:
//! it remembers, per session, the per-path sync-state (`base_seq`/`base_sha`/
//! `upper_sha`/`applied_remote_seq` — the §8B #2 "one root") and the change-feed
//! cursor, in a node-local JSON file (atomic temp+rename). This is what makes
//! capture BASE-AWARE: a modify to an existing shared artifact is POSTed with its
//! real `base_seq`, so Atrium's OCC/diff3 runs and cross-agent conflicts are
//! actually detected — instead of the stateless 409 base_required.
//!
//! Atrium's `artifact_sync_state` is the durable authority; this is the node's
//! fast local mirror, reconstructable by draining the feed (hydration).

use std::collections::HashMap;
use std::path::Path;

use crate::adopt::LocalState;

fn default_cursor() -> String {
    "0.0".to_string()
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct DaemonState {
    /// path → the agent's working-copy sync-state for that artifact.
    #[serde(default)]
    pub paths: HashMap<String, LocalState>,
    /// the gap-free change-feed cursor ("<xid>.<id>").
    #[serde(default = "default_cursor")]
    pub cursor: String,
    /// the session-level Atrium materializer change-feed cursor ("<xid>.<id>").
    #[serde(default = "default_cursor")]
    pub atrium_cursor: String,
    /// whether we've reconstructed base_seqs from the feed yet.
    #[serde(default)]
    pub hydrated: bool,
    /// repo_key -> scratch WIP snapshot id we already attempted to restore in
    /// this container state. This keeps periodic capture from re-applying the
    /// session's own latest snapshot after the working tree has moved on.
    #[serde(default)]
    pub wip_restore_attempted: HashMap<String, String>,
    /// harness -> sha256 of the provider credential file last sent to Atrium's
    /// dedicated credential-refresh endpoint.
    #[serde(default)]
    pub provider_credential_hashes: HashMap<String, String>,
    /// harness -> whether the first sanitized profile baseline was sent.
    #[serde(default)]
    pub profile_baseline_sent: HashMap<String, bool>,
    /// profile bundle path -> sha256 last materialized into this session's
    /// harness overlay.
    #[serde(default)]
    pub materialized_profile_bundles: HashMap<String, String>,
}

impl Default for DaemonState {
    fn default() -> Self {
        Self {
            paths: HashMap::new(),
            cursor: default_cursor(),
            atrium_cursor: default_cursor(),
            hydrated: false,
            wip_restore_attempted: HashMap::new(),
            provider_credential_hashes: HashMap::new(),
            profile_baseline_sent: HashMap::new(),
            materialized_profile_bundles: HashMap::new(),
        }
    }
}

impl DaemonState {
    /// Load from `file`, or a fresh state (cursor "0.0", not hydrated).
    pub fn load(file: &Path) -> Self {
        std::fs::read(file)
            .ok()
            .and_then(|b| serde_json::from_slice::<DaemonState>(&b).ok())
            .unwrap_or_default()
    }

    /// Persist atomically (temp + rename) so a crash never leaves a torn file.
    pub fn save(&self, file: &Path) -> std::io::Result<()> {
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = file.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, file)
    }

    /// The base_seq map capture passes to Atrium for OCC.
    pub fn base_seqs(&self) -> HashMap<String, u64> {
        self.paths
            .iter()
            .map(|(p, s)| (p.clone(), s.base_seq))
            .collect()
    }

    pub fn locals(&self) -> &HashMap<String, LocalState> {
        &self.paths
    }

    /// Hydration: a feed row says `path` reached `seq` (sha `sha`). Advance the
    /// base to the newest seen — this reconstructs "what version the lower holds".
    pub fn note_hydrated_version(&mut self, path: &str, seq: u64, sha: Option<String>) {
        let e = self.paths.entry(path.to_string()).or_default();
        if seq >= e.base_seq {
            e.base_seq = seq;
            e.base_sha = sha.clone();
            // hydration means the working copy == the ledger latest (unedited).
            e.upper_sha = sha;
        }
    }

    /// After the node syncs the working copy to a version (a clean capture of an
    /// edit, OR an adopt of a remote) the working copy now matches that version:
    /// base advances + upper == base (unedited until the agent edits again).
    pub fn sync_to(&mut self, path: &str, seq: u64, sha: Option<String>, from_remote: bool) {
        let e = self.paths.entry(path.to_string()).or_default();
        e.base_seq = seq;
        e.base_sha = sha.clone();
        e.upper_sha = sha;
        if from_remote {
            e.applied_remote_seq = Some(seq); // echo gate (§8B #2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("dstate-{tag}-{}.json", std::process::id()))
    }

    #[test]
    fn round_trips_and_derives_base_seqs() {
        let f = tmp("rt");
        let _ = std::fs::remove_file(&f);
        let mut s = DaemonState::load(&f);
        assert_eq!(s.cursor, "0.0");
        assert_eq!(s.atrium_cursor, "0.0");
        s.note_hydrated_version("proj-x/a.md", 5, Some("sha5".into()));
        s.cursor = "100.5".into();
        s.atrium_cursor = "200.9".into();
        s.hydrated = true;
        s.save(&f).unwrap();

        let r = DaemonState::load(&f);
        assert_eq!(r.cursor, "100.5");
        assert_eq!(r.atrium_cursor, "200.9");
        assert!(r.hydrated);
        assert_eq!(r.base_seqs().get("proj-x/a.md"), Some(&5));
        let _ = std::fs::remove_file(&f);
    }

    #[test]
    fn sync_to_advances_base_and_marks_unedited() {
        let mut s = DaemonState::default();
        s.note_hydrated_version("p", 5, Some("sha5".into()));
        // agent edited → (in the real loop upper_sha would diverge); capture syncs to 6
        s.sync_to("p", 6, Some("sha6".into()), false);
        let ls = s.locals().get("p").unwrap();
        assert_eq!(ls.base_seq, 6);
        assert_eq!(ls.base_sha.as_deref(), Some("sha6"));
        assert_eq!(ls.upper_sha.as_deref(), Some("sha6")); // unedited vs the new base
        assert_eq!(ls.applied_remote_seq, None);

        s.sync_to("p", 7, Some("sha7".into()), true); // an adopt
        let ls = s.locals().get("p").unwrap();
        assert_eq!(ls.applied_remote_seq, Some(7)); // echo gate set
    }

    #[test]
    fn note_hydrated_keeps_the_newest() {
        let mut s = DaemonState::default();
        s.note_hydrated_version("p", 3, Some("a".into()));
        s.note_hydrated_version("p", 7, Some("b".into()));
        s.note_hydrated_version("p", 5, Some("c".into())); // older — ignored
        assert_eq!(s.base_seqs().get("p"), Some(&7));
    }
}
