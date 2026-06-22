//! Per-session sidecar manifests for the node-sync daemon fan-out path.
//!
//! A privileged provisioner writes `<overlays-root>/.sessions/<session>.json`.
//! The per-node daemon scans direct child directories of `<overlays-root>` and
//! only runs sessions that have a readable sidecar manifest.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionManifest {
    pub session: String,
    pub merged: PathBuf,
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub harness_thread_id: String,
    #[serde(default)]
    pub harness_home: String,
    #[serde(default)]
    pub repo: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredSession {
    pub session: String,
    pub upper: PathBuf,
    pub state_file: PathBuf,
    pub manifest: SessionManifest,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SessionDiscovery {
    pub sessions: Vec<DiscoveredSession>,
    pub warnings: Vec<String>,
}

pub fn sessions_dir(overlays_root: &Path) -> PathBuf {
    overlays_root.join(".sessions")
}

pub fn manifest_path(overlays_root: &Path, session: &str) -> PathBuf {
    sessions_dir(overlays_root).join(format!("{session}.json"))
}

pub fn state_path(overlays_root: &Path, session: &str) -> PathBuf {
    sessions_dir(overlays_root).join(format!("{session}.state.json"))
}

pub fn normalize_harness(value: &str) -> Result<Option<String>, String> {
    match value.trim() {
        "" | "null" | "none" => Ok(None),
        "claude" | "claude-code" | "claudecode" => Ok(Some("claude".to_string())),
        "codex" => Ok(Some("codex".to_string())),
        other => Err(format!(
            "unsupported harness {other:?}; expected claude, codex, or null"
        )),
    }
}

pub fn read_manifest(overlays_root: &Path, session: &str) -> Result<SessionManifest, String> {
    let path = manifest_path(overlays_root, session);
    let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let manifest = serde_json::from_slice::<SessionManifest>(&bytes)
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    if manifest.session != session {
        return Err(format!(
            "manifest {} session mismatch: expected {session:?}, got {:?}",
            path.display(),
            manifest.session
        ));
    }
    if let Some(harness) = &manifest.harness {
        normalize_harness(harness)?;
    }
    Ok(manifest)
}

pub fn write_manifest(overlays_root: &Path, manifest: &SessionManifest) -> Result<(), String> {
    let dir = sessions_dir(overlays_root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = manifest_path(overlays_root, &manifest.session);
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), path.display()))
}

pub fn discover_sessions(overlays_root: &Path) -> Result<SessionDiscovery, String> {
    let mut out = SessionDiscovery::default();
    let entries = std::fs::read_dir(overlays_root)
        .map_err(|e| format!("read overlays root {}: {e}", overlays_root.display()))?;

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                out.warnings.push(format!("read overlays entry: {e}"));
                continue;
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            out.warnings.push(format!(
                "skip non-UTF-8 overlays entry {}",
                entry.path().display()
            ));
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(e) => {
                out.warnings.push(format!(
                    "session {name}: stat {}: {e}",
                    entry.path().display()
                ));
                continue;
            }
        };
        if !file_type.is_dir() {
            continue;
        }
        match read_manifest(overlays_root, name) {
            Ok(manifest) => out.sessions.push(DiscoveredSession {
                session: name.to_string(),
                upper: overlays_root.join(name),
                state_file: state_path(overlays_root, name),
                manifest,
            }),
            Err(e) => out.warnings.push(format!("session {name}: {e}")),
        }
    }

    out.sessions.sort_by(|a, b| a.session.cmp(&b.session));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_round_trips_with_expected_shape() {
        let manifest = SessionManifest {
            session: "sess-1".to_string(),
            merged: PathBuf::from("/run/centaur/merged/sess-1"),
            harness: Some("claude".to_string()),
            harness_thread_id: "thread-123".to_string(),
            harness_home: ".claude".to_string(),
            repo: "/workspace/repo".to_string(),
        };

        let value = serde_json::to_value(&manifest).unwrap();
        assert_eq!(value["session"], "sess-1");
        assert_eq!(value["merged"], "/run/centaur/merged/sess-1");
        assert_eq!(value["harness"], "claude");
        assert_eq!(value["harness_thread_id"], "thread-123");
        assert_eq!(value["harness_home"], ".claude");
        assert_eq!(value["repo"], "/workspace/repo");

        let round_trip: SessionManifest = serde_json::from_value(value).unwrap();
        assert_eq!(round_trip, manifest);
    }

    #[test]
    fn manifest_serializes_null_harness() {
        let manifest = SessionManifest {
            session: "sess-1".to_string(),
            merged: PathBuf::from("/run/centaur/merged/sess-1"),
            harness: None,
            harness_thread_id: String::new(),
            harness_home: String::new(),
            repo: String::new(),
        };

        let value = serde_json::to_value(&manifest).unwrap();
        assert!(value["harness"].is_null());
    }

    #[test]
    fn discovery_skips_dot_entries_and_requires_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".sessions")).unwrap();
        std::fs::create_dir_all(root.join("active")).unwrap();
        std::fs::create_dir_all(root.join("missing-manifest")).unwrap();
        std::fs::create_dir_all(root.join("bad-manifest")).unwrap();
        std::fs::create_dir_all(root.join(".dot-session")).unwrap();
        std::fs::write(root.join("plain-file"), b"not a dir").unwrap();

        write_manifest(
            root,
            &SessionManifest {
                session: "active".to_string(),
                merged: PathBuf::from("/run/centaur/merged/active"),
                harness: Some("codex".to_string()),
                harness_thread_id: String::new(),
                harness_home: String::new(),
                repo: String::new(),
            },
        )
        .unwrap();
        std::fs::write(manifest_path(root, "bad-manifest"), b"{not-json").unwrap();

        let discovery = discover_sessions(root).unwrap();

        assert_eq!(discovery.sessions.len(), 1);
        assert_eq!(discovery.sessions[0].session, "active");
        assert_eq!(discovery.sessions[0].upper, root.join("active"));
        assert_eq!(
            discovery.sessions[0].state_file,
            root.join(".sessions/active.state.json")
        );
        assert!(
            discovery
                .warnings
                .iter()
                .any(|warning| warning.contains("missing-manifest"))
        );
        assert!(
            discovery
                .warnings
                .iter()
                .any(|warning| warning.contains("bad-manifest"))
        );
        assert!(
            discovery
                .warnings
                .iter()
                .all(|warning| !warning.contains(".dot-session"))
        );
    }
}
