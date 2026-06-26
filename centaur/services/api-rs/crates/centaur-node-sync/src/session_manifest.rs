//! Per-session sidecar manifests for the node-sync daemon fan-out path.
//!
//! A manifest-writer init writes `<overlays-root>/.sessions/<session>.json`.
//! The per-node daemon scans direct child directories of `<overlays-root>` and
//! only runs sessions that have a readable sidecar manifest.

use crate::overlay_mount::DEFAULT_AGENT_UID;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionManifest {
    pub session: String,
    #[serde(default)]
    pub atrium_session: String,
    pub merged: PathBuf,
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub harness_thread_id: String,
    #[serde(default)]
    pub harness_home: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub flat_home: bool,
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub repos: Vec<RepoMount>,
    #[serde(default = "default_agent_uid")]
    pub agent_uid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RepoMount {
    pub repo: String,
    #[serde(default, rename = "ref")]
    pub r#ref: Option<String>,
    #[serde(default)]
    pub subdir: Option<String>,
}

fn default_agent_uid() -> u32 {
    DEFAULT_AGENT_UID
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredSession {
    pub session: String,
    pub atrium_session: String,
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
    validate_repo_mounts(&manifest.repos)?;
    Ok(manifest)
}

pub fn write_manifest(overlays_root: &Path, manifest: &SessionManifest) -> Result<(), String> {
    validate_repo_mounts(&manifest.repos)?;
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
        if name.starts_with('.') || name == "artifact-lower" || name == "cas" {
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
            Ok(manifest) => {
                let atrium_session = if manifest.atrium_session.trim().is_empty() {
                    name.to_string()
                } else {
                    manifest.atrium_session.trim().to_string()
                };
                out.sessions.push(DiscoveredSession {
                    session: name.to_string(),
                    atrium_session,
                    upper: overlays_root.join(name),
                    state_file: state_path(overlays_root, name),
                    manifest,
                });
            }
            Err(e) => out.warnings.push(format!("session {name}: {e}")),
        }
    }

    out.sessions.sort_by(|a, b| a.session.cmp(&b.session));
    Ok(out)
}

pub fn validate_repo_mounts(repos: &[RepoMount]) -> Result<(), String> {
    for repo in repos {
        validate_repo_mount(repo)?;
    }
    Ok(())
}

pub fn validate_repo_mount(repo: &RepoMount) -> Result<(), String> {
    validate_repo_cache_path_syntax(&repo.repo)?;
    if let Some(subdir) = &repo.subdir {
        validate_repo_subdir_syntax(subdir)?;
    }
    if let Some(git_ref) = &repo.r#ref {
        if git_ref.contains('\0') {
            return Err("repo ref must not contain NUL bytes".to_string());
        }
        if git_ref.trim().is_empty() {
            return Err("repo ref must not be empty".to_string());
        }
    }
    Ok(())
}

pub fn validate_repo_cache_path_syntax(repo: &str) -> Result<(), String> {
    if repo.contains('\0') {
        return Err("repo must not contain NUL bytes".to_string());
    }
    if repo.trim().is_empty() {
        return Err("repo must name a directory".to_string());
    }
    if repo.trim() != repo {
        return Err("repo must not contain leading or trailing whitespace".to_string());
    }

    let path = Path::new(repo);
    let mut normal_components = 0usize;
    for component in path.components() {
        match component {
            Component::Normal(_) => normal_components += 1,
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err("repo must be a relative path without . or .. components".to_string());
            }
        }
    }
    if normal_components == 0 {
        return Err("repo must name a directory".to_string());
    }
    Ok(())
}

pub fn validate_repo_subdir_syntax(subdir: &str) -> Result<(), String> {
    if subdir.contains('\0') {
        return Err("repo subdir must not contain NUL bytes".to_string());
    }
    if subdir.trim().is_empty() {
        return Err("repo subdir must not be empty".to_string());
    }
    if subdir.trim() != subdir {
        return Err("repo subdir must not contain leading or trailing whitespace".to_string());
    }
    let mut components = Path::new(subdir).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(name)), None) if name == std::ffi::OsStr::new(subdir) => Ok(()),
        _ => Err("repo subdir must be a single path segment".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_round_trips_with_expected_shape() {
        let manifest = SessionManifest {
            session: "sess-1".to_string(),
            atrium_session: "surface:sess-1".to_string(),
            merged: PathBuf::from("/run/centaur/merged/sess-1"),
            harness: Some("claude".to_string()),
            harness_thread_id: "thread-123".to_string(),
            harness_home: ".claude".to_string(),
            flat_home: true,
            repo: "/workspace/repo".to_string(),
            repos: vec![RepoMount {
                repo: "acme/foo".to_string(),
                r#ref: Some("main".to_string()),
                subdir: Some("foo".to_string()),
            }],
            agent_uid: 1001,
        };

        let value = serde_json::to_value(&manifest).unwrap();
        assert_eq!(value["session"], "sess-1");
        assert_eq!(value["atrium_session"], "surface:sess-1");
        assert_eq!(value["merged"], "/run/centaur/merged/sess-1");
        assert_eq!(value["harness"], "claude");
        assert_eq!(value["harness_thread_id"], "thread-123");
        assert_eq!(value["harness_home"], ".claude");
        assert_eq!(value["flat_home"], true);
        assert_eq!(value["repo"], "/workspace/repo");
        assert_eq!(value["repos"][0]["repo"], "acme/foo");
        assert_eq!(value["repos"][0]["ref"], "main");
        assert_eq!(value["repos"][0]["subdir"], "foo");
        assert_eq!(value["agent_uid"], 1001);

        let round_trip: SessionManifest = serde_json::from_value(value).unwrap();
        assert_eq!(round_trip, manifest);
    }

    #[test]
    fn missing_repos_deserializes_as_empty_for_back_compat() {
        let manifest: SessionManifest = serde_json::from_value(serde_json::json!({
            "session": "sess-1",
            "merged": "/run/centaur/merged/sess-1",
            "repo": "/workspace/repo"
        }))
        .unwrap();

        assert!(manifest.repos.is_empty());
        assert!(manifest.atrium_session.is_empty());
        assert_eq!(manifest.repo, "/workspace/repo");
        assert_eq!(manifest.agent_uid, DEFAULT_AGENT_UID);
    }

    #[test]
    fn missing_flat_home_deserializes_as_false_for_back_compat() {
        let manifest: SessionManifest = serde_json::from_value(serde_json::json!({
            "session": "sess-1",
            "merged": "/run/centaur/merged/sess-1",
            "harness": "claude",
            "harness_thread_id": "thread-123",
            "harness_home": ".claude",
            "repo": "/workspace/repo"
        }))
        .unwrap();

        assert!(!manifest.flat_home);
    }

    #[test]
    fn manifest_serializes_null_harness() {
        let manifest = SessionManifest {
            session: "sess-1".to_string(),
            atrium_session: String::new(),
            merged: PathBuf::from("/run/centaur/merged/sess-1"),
            harness: None,
            harness_thread_id: String::new(),
            harness_home: String::new(),
            flat_home: false,
            repo: String::new(),
            repos: Vec::new(),
            agent_uid: 1001,
        };

        let value = serde_json::to_value(&manifest).unwrap();
        assert!(value["harness"].is_null());
        assert!(value.get("flat_home").is_none());
    }

    #[test]
    fn discovery_skips_dot_entries_and_requires_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".sessions")).unwrap();
        std::fs::create_dir_all(root.join("active")).unwrap();
        std::fs::create_dir_all(root.join("missing-manifest")).unwrap();
        std::fs::create_dir_all(root.join("bad-manifest")).unwrap();
        std::fs::create_dir_all(root.join("artifact-lower/active")).unwrap();
        std::fs::create_dir_all(root.join(".dot-session")).unwrap();
        std::fs::write(root.join("plain-file"), b"not a dir").unwrap();

        write_manifest(
            root,
            &SessionManifest {
                session: "active".to_string(),
                atrium_session: "surface:active".to_string(),
                merged: PathBuf::from("/run/centaur/merged/active"),
                harness: Some("codex".to_string()),
                harness_thread_id: String::new(),
                harness_home: String::new(),
                flat_home: false,
                repo: String::new(),
                repos: Vec::new(),
                agent_uid: 1001,
            },
        )
        .unwrap();
        std::fs::write(manifest_path(root, "bad-manifest"), b"{not-json").unwrap();

        let discovery = discover_sessions(root).unwrap();

        assert_eq!(discovery.sessions.len(), 1);
        assert_eq!(discovery.sessions[0].session, "active");
        assert_eq!(discovery.sessions[0].atrium_session, "surface:active");
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
        assert!(
            discovery
                .warnings
                .iter()
                .all(|warning| !warning.contains("artifact-lower"))
        );
    }

    #[test]
    fn repo_mount_validation_rejects_traversal() {
        let err = validate_repo_mount(&RepoMount {
            repo: "../secret".to_string(),
            r#ref: None,
            subdir: Some("ok".to_string()),
        })
        .unwrap_err();
        assert!(err.contains("relative path"));

        let err = validate_repo_mount(&RepoMount {
            repo: "acme/foo".to_string(),
            r#ref: None,
            subdir: Some("../secret".to_string()),
        })
        .unwrap_err();
        assert!(err.contains("single path segment"));
    }
}
