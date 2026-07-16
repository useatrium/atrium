//! Per-session sidecar manifests for the node-sync daemon fan-out path.
//!
//! A manifest-writer init writes `<overlays-root>/.sessions/<session>.json`.
//! The per-node daemon scans direct child directories of `<overlays-root>` and
//! only runs sessions that have a readable sidecar manifest.

use crate::overlay_mount::{DEFAULT_AGENT_UID, READY_MARKER_FILE};
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
    #[serde(default, skip_serializing_if = "path_is_empty")]
    pub generic_home_lower: PathBuf,
    #[serde(default, skip_serializing_if = "path_is_empty")]
    pub context_source: PathBuf,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_path: Option<String>,
    /// Private target repos are never read from the shared node-global cache.
    #[serde(default, skip_serializing_if = "is_false")]
    pub private: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_scope: Option<RepoCacheScope>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RepoCacheScope {
    Shared,
    Principal { principal_id: String },
}

fn default_agent_uid() -> u32 {
    DEFAULT_AGENT_UID
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn path_is_empty(path: &Path) -> bool {
    path.as_os_str().is_empty()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredSession {
    pub session: String,
    pub atrium_session: String,
    pub manifest_atrium_session_empty: bool,
    pub upper: PathBuf,
    pub state_file: PathBuf,
    pub manifest: SessionManifest,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SessionDiscovery {
    pub sessions: Vec<DiscoveredSession>,
    pub warnings: Vec<String>,
}

pub const SESSIONS_DIR_NAME: &str = ".sessions";

pub fn sessions_dir(overlays_root: &Path) -> PathBuf {
    overlays_root.join(SESSIONS_DIR_NAME)
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
    validate_manifest_host_paths(overlays_root, session, &manifest)?;
    validate_repo_mounts(&manifest.repos)?;
    Ok(manifest)
}

fn validate_manifest_host_paths(
    overlays_root: &Path,
    session: &str,
    manifest: &SessionManifest,
) -> Result<(), String> {
    if !manifest.generic_home_lower.as_os_str().is_empty() {
        validate_absolute_clean_path("--generic-home-lower", &manifest.generic_home_lower)?;
        let expected = overlays_root.join(".warm-home-lower").join(session);
        if manifest.generic_home_lower != expected {
            return Err(format!(
                "--generic-home-lower {} must equal {}",
                manifest.generic_home_lower.display(),
                expected.display()
            ));
        }
    }
    if !manifest.context_source.as_os_str().is_empty() {
        validate_absolute_clean_path("--context-source", &manifest.context_source)?;
    }
    Ok(())
}

fn validate_absolute_clean_path(name: &str, path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("{name} must be absolute"));
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::CurDir | Component::ParentDir | Component::Prefix(_)
        )
    }) {
        return Err(format!("{name} must not contain relative path components"));
    }
    Ok(())
}

pub fn write_manifest(overlays_root: &Path, manifest: &SessionManifest) -> Result<(), String> {
    validate_repo_mounts(&manifest.repos)?;
    let dir = sessions_dir(overlays_root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = manifest_path(overlays_root, &manifest.session);
    let invalidate_ready = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<SessionManifest>(&bytes).map_or(true, |previous| {
            claim_identity(&previous) != claim_identity(manifest)
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), path.display()))?;
    if invalidate_ready {
        // A claim rewrites the manifest of an already-mounted warm sandbox.
        // Publish the claimed identity first, then invalidate the old readiness
        // handshake. node-sync recreates the marker only after per-claim
        // materialization. An unchanged post-mount canonicalization write must
        // leave the freshly-created marker alone.
        let ready_marker = overlays_root
            .join(&manifest.session)
            .join(READY_MARKER_FILE);
        match std::fs::remove_file(&ready_marker) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("remove {}: {error}", ready_marker.display())),
        }
    }
    Ok(())
}

fn claim_identity(manifest: &SessionManifest) -> (&str, Option<&str>, &str, &str, bool) {
    (
        &manifest.atrium_session,
        manifest.harness.as_deref(),
        &manifest.harness_thread_id,
        &manifest.harness_home,
        manifest.flat_home,
    )
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
                // Unclaimed = no real Atrium key. provision-overlay defaults an
                // omitted --atrium-session to the sandbox/dir name, so a
                // self-referential value is just as unresolvable as an empty one
                // (real thread keys are `:`-namespaced; sandbox names never are).
                let trimmed = manifest.atrium_session.trim();
                let manifest_atrium_session_empty = trimmed.is_empty() || trimmed == name;
                let atrium_session = if trimmed.is_empty() {
                    name.to_string()
                } else {
                    trimmed.to_string()
                };
                out.sessions.push(DiscoveredSession {
                    session: name.to_string(),
                    atrium_session,
                    manifest_atrium_session_empty,
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
    if let Some(cache_path) = &repo.cache_path {
        validate_repo_cache_snapshot_path_syntax(cache_path)?;
    }
    if repo.private {
        if repo.cache_path.is_some() {
            return Err("private repo must not use an explicit shared cache path".to_string());
        }
        match repo.cache_scope.as_ref() {
            Some(RepoCacheScope::Principal { principal_id }) => {
                validate_principal_cache_scope(principal_id)?;
            }
            Some(RepoCacheScope::Shared) => {
                return Err("private repo must not use the shared repo cache".to_string());
            }
            None => {
                return Err("private repo requires a principal cache scope".to_string());
            }
        }
    }
    if let Some(git_ref) = &repo.r#ref {
        if git_ref.contains('\0') {
            return Err("repo ref must not contain NUL bytes".to_string());
        }
        if git_ref.trim().is_empty() {
            return Err("repo ref must not be empty".to_string());
        }
    }
    if let Some(resolved_sha) = &repo.resolved_sha {
        if resolved_sha.contains('\0') {
            return Err("resolved repo sha must not contain NUL bytes".to_string());
        }
        if resolved_sha.trim().is_empty() {
            return Err("resolved repo sha must not be empty".to_string());
        }
        if resolved_sha.trim() != resolved_sha {
            return Err(
                "resolved repo sha must not contain leading or trailing whitespace".to_string(),
            );
        }
    }
    Ok(())
}

pub fn validate_principal_cache_scope(principal_id: &str) -> Result<(), String> {
    if principal_id.contains('\0') {
        return Err("principal cache scope must not contain NUL bytes".to_string());
    }
    if principal_id.trim().is_empty() {
        return Err("principal cache scope must not be empty".to_string());
    }
    if principal_id.trim() != principal_id {
        return Err(
            "principal cache scope must not contain leading or trailing whitespace".to_string(),
        );
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

pub fn validate_repo_cache_snapshot_path_syntax(cache_path: &str) -> Result<(), String> {
    validate_repo_cache_path_syntax(cache_path)?;
    let mut components = Path::new(cache_path).components();
    match components.next() {
        Some(Component::Normal(name)) if name == std::ffi::OsStr::new(".snapshots") => Ok(()),
        _ => Err("repo cache path must be under .snapshots".to_string()),
    }
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
            generic_home_lower: PathBuf::from("/var/lib/centaur/overlays/.warm-home-lower/sess-1"),
            context_source: PathBuf::from("/var/lib/centaur/atrium/sess-1"),
            repo: "/workspace/repo".to_string(),
            repos: vec![RepoMount {
                repo: "acme/foo".to_string(),
                r#ref: Some("main".to_string()),
                subdir: Some("foo".to_string()),
                resolved_sha: None,
                cache_path: None,
                private: false,
                cache_scope: None,
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
        assert_eq!(
            value["generic_home_lower"],
            "/var/lib/centaur/overlays/.warm-home-lower/sess-1"
        );
        assert_eq!(value["context_source"], "/var/lib/centaur/atrium/sess-1");
        assert_eq!(value["repo"], "/workspace/repo");
        assert_eq!(value["repos"][0]["repo"], "acme/foo");
        assert_eq!(value["repos"][0]["ref"], "main");
        assert_eq!(value["repos"][0]["subdir"], "foo");
        assert_eq!(value["agent_uid"], 1001);

        let round_trip: SessionManifest = serde_json::from_value(value).unwrap();
        assert_eq!(round_trip, manifest);
    }

    #[test]
    fn manifest_publication_invalidates_existing_ready_marker() {
        let temp = tempfile::tempdir().unwrap();
        let upper = temp.path().join("sess-1");
        std::fs::create_dir_all(&upper).unwrap();
        let mut manifest = SessionManifest {
            session: "sess-1".to_string(),
            atrium_session: "sess-1".to_string(),
            merged: temp.path().join("merged/sess-1"),
            harness: None,
            harness_thread_id: String::new(),
            harness_home: String::new(),
            flat_home: true,
            generic_home_lower: PathBuf::new(),
            context_source: PathBuf::new(),
            repo: String::new(),
            repos: Vec::new(),
            agent_uid: 1001,
        };
        write_manifest(temp.path(), &manifest).unwrap();
        let ready = upper.join(READY_MARKER_FILE);
        std::fs::write(&ready, b"ready\n").unwrap();
        manifest.atrium_session = "surface:sess-1".to_string();
        manifest.harness = Some("claude".to_string());
        manifest.harness_thread_id = "thread-123".to_string();
        manifest.harness_home = ".claude".to_string();

        write_manifest(temp.path(), &manifest).unwrap();

        assert!(!ready.exists());
        assert_eq!(read_manifest(temp.path(), "sess-1").unwrap(), manifest);
    }

    #[test]
    fn unchanged_manifest_write_preserves_ready_marker() {
        let temp = tempfile::tempdir().unwrap();
        let upper = temp.path().join("sess-1");
        std::fs::create_dir_all(&upper).unwrap();
        let manifest = SessionManifest {
            session: "sess-1".to_string(),
            atrium_session: "surface:sess-1".to_string(),
            merged: temp.path().join("merged/sess-1"),
            harness: Some("claude".to_string()),
            harness_thread_id: "thread-123".to_string(),
            harness_home: ".claude".to_string(),
            flat_home: true,
            generic_home_lower: PathBuf::new(),
            context_source: PathBuf::new(),
            repo: String::new(),
            repos: Vec::new(),
            agent_uid: 1001,
        };
        write_manifest(temp.path(), &manifest).unwrap();
        let ready = upper.join(READY_MARKER_FILE);
        std::fs::write(&ready, b"ready\n").unwrap();

        write_manifest(temp.path(), &manifest).unwrap();

        assert!(ready.is_file());
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
        assert!(manifest.generic_home_lower.as_os_str().is_empty());
        assert!(manifest.context_source.as_os_str().is_empty());
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
        assert!(manifest.generic_home_lower.as_os_str().is_empty());
        assert!(manifest.context_source.as_os_str().is_empty());
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
            generic_home_lower: PathBuf::new(),
            context_source: PathBuf::new(),
            repo: String::new(),
            repos: Vec::new(),
            agent_uid: 1001,
        };

        let value = serde_json::to_value(&manifest).unwrap();
        assert!(value["harness"].is_null());
        assert!(value.get("flat_home").is_none());
        assert!(value.get("generic_home_lower").is_none());
        assert!(value.get("context_source").is_none());
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
                generic_home_lower: PathBuf::new(),
                context_source: PathBuf::new(),
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
        assert!(!discovery.sessions[0].manifest_atrium_session_empty);
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
    fn discovery_flags_empty_manifest_atrium_session_before_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".sessions")).unwrap();
        std::fs::create_dir_all(root.join("blank")).unwrap();
        std::fs::create_dir_all(root.join("claimed")).unwrap();
        std::fs::create_dir_all(root.join("selfref")).unwrap();

        write_manifest(
            root,
            &SessionManifest {
                session: "selfref".to_string(),
                // provision-overlay defaults an omitted --atrium-session to the
                // sandbox name — the prod shape of an unclaimed warm pod.
                atrium_session: "selfref".to_string(),
                merged: PathBuf::from("/run/centaur/merged/selfref"),
                harness: None,
                harness_thread_id: String::new(),
                harness_home: String::new(),
                flat_home: false,
                generic_home_lower: PathBuf::new(),
                context_source: PathBuf::new(),
                repo: String::new(),
                repos: Vec::new(),
                agent_uid: 1001,
            },
        )
        .unwrap();
        write_manifest(
            root,
            &SessionManifest {
                session: "blank".to_string(),
                atrium_session: "  ".to_string(),
                merged: PathBuf::from("/run/centaur/merged/blank"),
                harness: None,
                harness_thread_id: String::new(),
                harness_home: String::new(),
                flat_home: false,
                generic_home_lower: PathBuf::new(),
                context_source: PathBuf::new(),
                repo: String::new(),
                repos: Vec::new(),
                agent_uid: 1001,
            },
        )
        .unwrap();
        write_manifest(
            root,
            &SessionManifest {
                session: "claimed".to_string(),
                atrium_session: "surface:claimed".to_string(),
                merged: PathBuf::from("/run/centaur/merged/claimed"),
                harness: None,
                harness_thread_id: String::new(),
                harness_home: String::new(),
                flat_home: false,
                generic_home_lower: PathBuf::new(),
                context_source: PathBuf::new(),
                repo: String::new(),
                repos: Vec::new(),
                agent_uid: 1001,
            },
        )
        .unwrap();

        let discovery = discover_sessions(root).unwrap();

        assert_eq!(discovery.sessions.len(), 3);
        let blank = discovery
            .sessions
            .iter()
            .find(|session| session.session == "blank")
            .unwrap();
        assert_eq!(blank.atrium_session, "blank");
        assert!(blank.manifest_atrium_session_empty);
        let selfref = discovery
            .sessions
            .iter()
            .find(|session| session.session == "selfref")
            .unwrap();
        assert_eq!(selfref.atrium_session, "selfref");
        assert!(selfref.manifest_atrium_session_empty);
        let claimed = discovery
            .sessions
            .iter()
            .find(|session| session.session == "claimed")
            .unwrap();
        assert_eq!(claimed.atrium_session, "surface:claimed");
        assert!(!claimed.manifest_atrium_session_empty);
    }

    #[test]
    fn read_manifest_rejects_generic_home_lower_outside_session_path() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".sessions")).unwrap();
        write_manifest(
            root,
            &SessionManifest {
                session: "sess-1".to_string(),
                atrium_session: String::new(),
                merged: PathBuf::from("/run/centaur/merged/sess-1"),
                harness: None,
                harness_thread_id: String::new(),
                harness_home: String::new(),
                flat_home: true,
                generic_home_lower: root.join(".warm-home-lower/other"),
                context_source: PathBuf::new(),
                repo: String::new(),
                repos: Vec::new(),
                agent_uid: 1001,
            },
        )
        .unwrap();

        let err = read_manifest(root, "sess-1").unwrap_err();
        assert!(err.contains("--generic-home-lower"));
        assert!(err.contains(".warm-home-lower/sess-1"));
    }

    #[test]
    fn read_manifest_rejects_relative_context_source() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".sessions")).unwrap();
        write_manifest(
            root,
            &SessionManifest {
                session: "sess-1".to_string(),
                atrium_session: String::new(),
                merged: PathBuf::from("/run/centaur/merged/sess-1"),
                harness: None,
                harness_thread_id: String::new(),
                harness_home: String::new(),
                flat_home: true,
                generic_home_lower: PathBuf::new(),
                context_source: PathBuf::from("relative/context"),
                repo: String::new(),
                repos: Vec::new(),
                agent_uid: 1001,
            },
        )
        .unwrap();

        let err = read_manifest(root, "sess-1").unwrap_err();
        assert!(err.contains("--context-source must be absolute"));
    }

    #[test]
    fn repo_mount_validation_rejects_traversal() {
        let err = validate_repo_mount(&RepoMount {
            repo: "../secret".to_string(),
            r#ref: None,
            subdir: Some("ok".to_string()),
            resolved_sha: None,
            cache_path: None,
            private: false,
            cache_scope: None,
        })
        .unwrap_err();
        assert!(err.contains("relative path"));

        let err = validate_repo_mount(&RepoMount {
            repo: "acme/foo".to_string(),
            r#ref: None,
            subdir: Some("../secret".to_string()),
            resolved_sha: None,
            cache_path: None,
            private: false,
            cache_scope: None,
        })
        .unwrap_err();
        assert!(err.contains("single path segment"));
    }

    #[test]
    fn private_repo_mount_requires_principal_scope() {
        let err = validate_repo_mount(&RepoMount {
            repo: "acme/private".to_string(),
            r#ref: None,
            subdir: None,
            resolved_sha: None,
            cache_path: None,
            private: true,
            cache_scope: None,
        })
        .unwrap_err();
        assert!(err.contains("principal cache scope"));

        let err = validate_repo_mount(&RepoMount {
            repo: "acme/private".to_string(),
            r#ref: None,
            subdir: None,
            resolved_sha: None,
            cache_path: None,
            private: true,
            cache_scope: Some(RepoCacheScope::Shared),
        })
        .unwrap_err();
        assert!(err.contains("shared repo cache"));
    }

    #[test]
    fn repo_mount_cache_path_must_target_snapshot_namespace() {
        let err = validate_repo_mount(&RepoMount {
            repo: "acme/private".to_string(),
            r#ref: None,
            subdir: None,
            resolved_sha: Some("abc123".to_string()),
            cache_path: Some("principals/principal-user/acme/private".to_string()),
            private: false,
            cache_scope: None,
        })
        .unwrap_err();

        assert!(err.contains(".snapshots"));

        validate_repo_mount(&RepoMount {
            repo: "acme/widget".to_string(),
            r#ref: Some("main".to_string()),
            subdir: None,
            resolved_sha: Some("abc123".to_string()),
            cache_path: Some(".snapshots/acme/widget/abc123".to_string()),
            private: false,
            cache_scope: None,
        })
        .unwrap();
    }
}
