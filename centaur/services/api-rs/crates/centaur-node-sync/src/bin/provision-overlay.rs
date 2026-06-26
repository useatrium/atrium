//! provision-overlay — per-session overlay setup for C4 e2e pods and production.
//!
//! Contract:
//! `provision-overlay --session <id> [--manifest-only]
//!   [--overlays-root /var/lib/centaur/overlays] [--merged-root /run/centaur/merged]
//!   [--lower <dir>] [--harness <kind>] [--harness-thread-id <id>]
//!   [--harness-home <path>] [--flat-home] [--repo <path>] [--repos-json <json>] [--agent-uid <uid>]
//!   [--hydrate-artifacts] [--atrium-url <url>] [--atrium-key <key>] [--cas-dir <dir>]`
//!
//! Default mode preserves the legacy privileged provisioner path: prepare the
//! host-backed upper, create the fixture lower when no repo is provided, mount
//! the merged workspace, and write the node-sync sidecar manifest.
//!
//! `--manifest-only` is the Option-A agent-pod path. It creates the session
//! upper directory, writes `<overlays-root>/.sessions/<session>.json`, then exits
//! without mounting or chowning anything.
//!
//! Lower precedence:
//! - Non-empty `--repo <path>` wins and is mounted as the read-only lowerdir.
//! - Without `--repo`, `--lower <dir>` is the fixture lower override.
//! - Without either, the fixture lower is `<host-root>/overlay-lower/<session>`.

use centaur_node_sync::cas::hydrate_artifact_lower_into_plan;
use centaur_node_sync::http_client::HttpAtriumClient;
use centaur_node_sync::overlay_mount::{
    DEFAULT_AGENT_UID, LowerKind, OverlayMountPlan, mount_overlay, plan_overlay_mount,
};
use centaur_node_sync::session_manifest::{
    RepoMount, SessionManifest, normalize_harness, write_manifest,
};
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

#[derive(Debug)]
struct Config {
    session: String,
    atrium_session: String,
    manifest_only: bool,
    overlays_root: PathBuf,
    merged_root: PathBuf,
    lower: Option<PathBuf>,
    harness: Option<String>,
    harness_thread_id: String,
    harness_home: String,
    flat_home: bool,
    repo: String,
    repos: Vec<RepoMount>,
    agent_uid: Option<u32>,
    hydrate_artifacts: bool,
    atrium_url: Option<String>,
    atrium_key: Option<String>,
    cas_dir: PathBuf,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("provision-overlay: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let cfg = parse_args(std::env::args_os().skip(1))?;
    validate_session(&cfg.session)?;

    let merged = cfg.merged_root.join(&cfg.session);
    let mut plan = plan_overlay_mount(
        &cfg.overlays_root,
        &cfg.session,
        &merged,
        &cfg.repo,
        &cfg.repos,
        cfg.lower.as_deref(),
    )?;

    if !cfg.manifest_only && plan.lower.kind == LowerKind::Repo {
        let metadata = std::fs::metadata(&plan.lower.path)
            .map_err(|e| format!("--repo {}: {e}", plan.lower.path.display()))?;
        if !metadata.is_dir() {
            return Err(format!(
                "--repo must be an existing directory, got {}",
                plan.lower.path.display()
            ));
        }
        plan.lower.path = plan
            .lower
            .path
            .canonicalize()
            .map_err(|e| format!("canonicalize --repo {}: {e}", plan.lower.path.display()))?;
    }

    if cfg.manifest_only {
        std::fs::create_dir_all(&plan.upper)
            .map_err(|e| format!("create upper {}: {e}", plan.upper.display()))?;
    }

    let manifest_repo = match plan.lower.kind {
        LowerKind::Repo => plan.lower.path.to_string_lossy().into_owned(),
        LowerKind::Fixture | LowerKind::ComposedRepos => cfg.repo.clone(),
    };
    write_manifest(
        &cfg.overlays_root,
        &SessionManifest {
            session: cfg.session.clone(),
            atrium_session: cfg.atrium_session.clone(),
            merged: merged.clone(),
            harness: cfg.harness.clone(),
            harness_thread_id: cfg.harness_thread_id.clone(),
            harness_home: cfg.harness_home.clone(),
            flat_home: cfg.flat_home,
            repo: manifest_repo,
            repos: cfg.repos.clone(),
            agent_uid: cfg.agent_uid.unwrap_or(DEFAULT_AGENT_UID),
        },
    )?;

    if cfg.manifest_only {
        println!(
            "provision-overlay: wrote manifest for session {} at {}",
            cfg.session,
            centaur_node_sync::session_manifest::manifest_path(&cfg.overlays_root, &cfg.session)
                .display()
        );
        return Ok(());
    }

    hydrate_artifacts_if_enabled(&cfg, &mut plan)?;
    let mounted = mount_overlay(plan, cfg.agent_uid)?;
    if mounted.lower.kind == LowerKind::Repo {
        write_manifest(
            &cfg.overlays_root,
            &SessionManifest {
                session: cfg.session.clone(),
                atrium_session: cfg.atrium_session.clone(),
                merged: mounted.merged.clone(),
                harness: cfg.harness.clone(),
                harness_thread_id: cfg.harness_thread_id.clone(),
                harness_home: cfg.harness_home.clone(),
                flat_home: cfg.flat_home,
                repo: mounted.lower.path.to_string_lossy().into_owned(),
                repos: cfg.repos.clone(),
                agent_uid: cfg.agent_uid.unwrap_or(DEFAULT_AGENT_UID),
            },
        )?;
    }
    println!(
        "provision-overlay: mounted session {} upper={} lower={} work={} merged={}",
        cfg.session,
        mounted.upper.display(),
        mounted.lower.path.display(),
        mounted.work.display(),
        mounted.merged.display()
    );
    Ok(())
}

fn hydrate_artifacts_if_enabled(cfg: &Config, plan: &mut OverlayMountPlan) -> Result<(), String> {
    if !cfg.hydrate_artifacts {
        return Ok(());
    }
    let (Some(atrium_url), Some(atrium_key)) =
        (cfg.atrium_url.as_deref(), cfg.atrium_key.as_deref())
    else {
        eprintln!("provision-overlay: hydrate: skipped (missing --atrium-url/--atrium-key)");
        return Ok(());
    };

    let mut client = HttpAtriumClient::new(atrium_url, atrium_key, &cfg.atrium_session);
    let outcome = hydrate_artifact_lower_into_plan(
        &mut client,
        &cfg.cas_dir,
        &cfg.overlays_root,
        &cfg.session,
        plan,
    )?;
    println!(
        "provision-overlay: hydrate: {} reflinked, {} fetched, {} errors",
        outcome.reflinked,
        outcome.fetched,
        outcome.errors.len()
    );
    Ok(())
}

fn parse_args<I>(args: I) -> Result<Config, String>
where
    I: IntoIterator<Item = OsString>,
{
    let mut session = None;
    let mut atrium_session = String::new();
    let mut manifest_only = false;
    let mut overlays_root = PathBuf::from("/var/lib/centaur/overlays");
    let mut merged_root = PathBuf::from("/run/centaur/merged");
    let mut lower = None;
    let mut harness = None;
    let mut harness_thread_id = String::new();
    let mut harness_home = String::new();
    let mut flat_home = false;
    let mut repo = String::new();
    let mut repos = Vec::new();
    let mut agent_uid = None;
    let mut hydrate_artifacts =
        env_bool_any(&["PROVISION_OVERLAY_HYDRATE_ARTIFACTS", "HYDRATE_ARTIFACTS"])?
            .unwrap_or(false);
    let mut atrium_url = env_non_empty_any(&[
        "PROVISION_OVERLAY_ATRIUM_URL",
        "ATRIUM_URL",
        "ATRIUM_BASE_URL",
    ])?;
    let mut atrium_key = env_non_empty_any(&[
        "PROVISION_OVERLAY_ATRIUM_KEY",
        "ATRIUM_KEY",
        "ATRIUM_CAPTURE_API_KEY",
    ])?;
    let mut cas_dir = env_path_any(&["PROVISION_OVERLAY_CAS_DIR", "CAS_DIR"])?;

    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let arg = arg
            .into_string()
            .map_err(|_| "arguments must be valid UTF-8".to_string())?;
        match arg.as_str() {
            "--manifest-only" => {
                manifest_only = true;
            }
            "--session" => {
                session = Some(next_value(&mut iter, "--session")?);
            }
            "--atrium-session" => {
                atrium_session = next_value(&mut iter, "--atrium-session")?;
            }
            "--overlays-root" => {
                overlays_root = PathBuf::from(next_value(&mut iter, "--overlays-root")?);
            }
            "--merged-root" => {
                merged_root = PathBuf::from(next_value(&mut iter, "--merged-root")?);
            }
            "--lower" => {
                lower = Some(PathBuf::from(next_value(&mut iter, "--lower")?));
            }
            "--harness" => {
                let value = next_value(&mut iter, "--harness")?;
                harness = normalize_harness(&value)?;
            }
            "--harness-thread-id" => {
                harness_thread_id = next_value(&mut iter, "--harness-thread-id")?;
            }
            "--harness-home" => {
                harness_home = next_value(&mut iter, "--harness-home")?;
            }
            "--flat-home" => {
                flat_home = true;
            }
            "--repo" => {
                repo = next_value(&mut iter, "--repo")?;
            }
            "--repos-json" => {
                let value = next_value(&mut iter, "--repos-json")?;
                repos = serde_json::from_str::<Vec<RepoMount>>(&value)
                    .map_err(|e| format!("--repos-json must be a JSON array of repo specs: {e}"))?;
            }
            "--agent-uid" => {
                let value = next_value(&mut iter, "--agent-uid")?;
                agent_uid = Some(value.parse::<u32>().map_err(|_| {
                    format!("--agent-uid requires an unsigned integer, got {value:?}")
                })?);
            }
            "--hydrate-artifacts" => {
                hydrate_artifacts = true;
            }
            "--atrium-url" => {
                atrium_url = non_empty_value(next_value(&mut iter, "--atrium-url")?);
            }
            "--atrium-key" => {
                atrium_key = non_empty_value(next_value(&mut iter, "--atrium-key")?);
            }
            "--cas-dir" => {
                cas_dir = Some(PathBuf::from(next_value(&mut iter, "--cas-dir")?));
            }
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            _ => return Err(format!("unknown argument {arg:?}")),
        }
    }

    let cas_dir = cas_dir.unwrap_or_else(|| overlays_root.join("cas"));
    let session = session.ok_or_else(|| "--session <ID> is required".to_string())?;
    if atrium_session.trim().is_empty() {
        atrium_session = session.clone();
    }

    Ok(Config {
        session,
        atrium_session,
        manifest_only,
        overlays_root,
        merged_root,
        lower,
        harness,
        harness_thread_id,
        harness_home,
        flat_home,
        repo,
        repos,
        agent_uid,
        hydrate_artifacts,
        atrium_url,
        atrium_key,
        cas_dir,
    })
}

fn next_value(iter: &mut impl Iterator<Item = OsString>, flag: &str) -> Result<String, String> {
    iter.next()
        .ok_or_else(|| format!("{flag} requires a value"))?
        .into_string()
        .map_err(|_| format!("{flag} value must be valid UTF-8"))
}

fn non_empty_value(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

fn env_non_empty_any(names: &[&str]) -> Result<Option<String>, String> {
    for name in names {
        match std::env::var(name) {
            Ok(value) => {
                if !value.trim().is_empty() {
                    return Ok(Some(value));
                }
            }
            Err(std::env::VarError::NotPresent) => {}
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err(format!("{name} must be valid UTF-8"));
            }
        }
    }
    Ok(None)
}

fn env_path_any(names: &[&str]) -> Result<Option<PathBuf>, String> {
    Ok(env_non_empty_any(names)?.map(PathBuf::from))
}

fn env_bool_any(names: &[&str]) -> Result<Option<bool>, String> {
    for name in names {
        match std::env::var(name) {
            Ok(value) => {
                if value.trim().is_empty() {
                    continue;
                }
                return parse_bool(name, &value).map(Some);
            }
            Err(std::env::VarError::NotPresent) => {}
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err(format!("{name} must be valid UTF-8"));
            }
        }
    }
    Ok(None)
}

fn parse_bool(name: &str, value: &str) -> Result<bool, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(format!(
            "{name} must be a boolean (true/false/1/0/yes/no/on/off), got {value:?}"
        )),
    }
}

fn print_help() {
    println!(
        "usage: provision-overlay --session <ID> [--atrium-session ID] [--manifest-only] [--overlays-root PATH] [--merged-root PATH] [--lower PATH] [--harness claude|codex|null] [--harness-thread-id ID] [--harness-home PATH] [--flat-home] [--repo PATH] [--repos-json JSON] [--agent-uid UID] [--hydrate-artifacts] [--atrium-url URL] [--atrium-key KEY] [--cas-dir PATH]"
    );
}

fn validate_session(session: &str) -> Result<(), String> {
    if session.is_empty() {
        return Err("--session must not be empty".to_string());
    }
    let path = Path::new(session);
    if path.components().any(|c| {
        matches!(
            c,
            Component::RootDir | Component::CurDir | Component::ParentDir | Component::Prefix(_)
        )
    }) {
        return Err("--session must be a single path segment".to_string());
    }
    if session.contains('/') || session.contains('\0') {
        return Err("--session must be a single path segment".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_manifest_only_flag() {
        let cfg = parse_args([
            OsString::from("--manifest-only"),
            OsString::from("--session"),
            OsString::from("sess-1"),
            OsString::from("--agent-uid"),
            OsString::from("4242"),
        ])
        .unwrap();

        assert!(cfg.manifest_only);
        assert_eq!(cfg.session, "sess-1");
        assert_eq!(cfg.agent_uid, Some(4242));
        assert!(!cfg.flat_home);
    }

    #[test]
    fn parse_flat_home_flag() {
        let cfg = parse_args([
            OsString::from("--manifest-only"),
            OsString::from("--session"),
            OsString::from("sess-1"),
            OsString::from("--flat-home"),
        ])
        .unwrap();

        assert!(cfg.flat_home);
    }

    #[test]
    fn parse_hydration_flags() {
        let cfg = parse_args([
            OsString::from("--session"),
            OsString::from("sess-1"),
            OsString::from("--hydrate-artifacts"),
            OsString::from("--atrium-url"),
            OsString::from("http://atrium"),
            OsString::from("--atrium-key"),
            OsString::from("key"),
            OsString::from("--cas-dir"),
            OsString::from("/cache/cas"),
        ])
        .unwrap();

        assert!(cfg.hydrate_artifacts);
        assert_eq!(cfg.atrium_url.as_deref(), Some("http://atrium"));
        assert_eq!(cfg.atrium_key.as_deref(), Some("key"));
        assert_eq!(cfg.cas_dir, PathBuf::from("/cache/cas"));
    }

    #[test]
    fn parse_repos_json() {
        let cfg = parse_args([
            OsString::from("--manifest-only"),
            OsString::from("--session"),
            OsString::from("sess-1"),
            OsString::from("--repos-json"),
            OsString::from(
                r#"[{"repo":"acme/foo","ref":"main"},{"repo":"acme/bar","subdir":"bar"}]"#,
            ),
        ])
        .unwrap();

        assert_eq!(
            cfg.repos,
            vec![
                RepoMount {
                    repo: "acme/foo".to_string(),
                    r#ref: Some("main".to_string()),
                    subdir: None,
                },
                RepoMount {
                    repo: "acme/bar".to_string(),
                    r#ref: None,
                    subdir: Some("bar".to_string()),
                },
            ]
        );
    }
}
