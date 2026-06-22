//! provision-overlay — per-session overlay setup for C4 e2e pods and production.
//!
//! Contract:
//! `provision-overlay --session <id> [--manifest-only]
//!   [--overlays-root /var/lib/centaur/overlays] [--merged-root /run/centaur/merged]
//!   [--lower <dir>] [--harness <kind>] [--harness-thread-id <id>]
//!   [--harness-home <path>] [--repo <path>] [--agent-uid <uid>]`
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

use centaur_node_sync::overlay_mount::{
    DEFAULT_AGENT_UID, LowerKind, mount_overlay, plan_overlay_mount,
};
use centaur_node_sync::session_manifest::{SessionManifest, normalize_harness, write_manifest};
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

#[derive(Debug)]
struct Config {
    session: String,
    manifest_only: bool,
    overlays_root: PathBuf,
    merged_root: PathBuf,
    lower: Option<PathBuf>,
    harness: Option<String>,
    harness_thread_id: String,
    harness_home: String,
    repo: String,
    agent_uid: Option<u32>,
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
        LowerKind::Fixture => cfg.repo.clone(),
    };
    write_manifest(
        &cfg.overlays_root,
        &SessionManifest {
            session: cfg.session.clone(),
            merged: merged.clone(),
            harness: cfg.harness.clone(),
            harness_thread_id: cfg.harness_thread_id.clone(),
            harness_home: cfg.harness_home.clone(),
            repo: manifest_repo,
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

    let mounted = mount_overlay(plan, cfg.agent_uid)?;
    if mounted.lower.kind == LowerKind::Repo {
        write_manifest(
            &cfg.overlays_root,
            &SessionManifest {
                session: cfg.session.clone(),
                merged: mounted.merged.clone(),
                harness: cfg.harness.clone(),
                harness_thread_id: cfg.harness_thread_id.clone(),
                harness_home: cfg.harness_home.clone(),
                repo: mounted.lower.path.to_string_lossy().into_owned(),
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

fn parse_args<I>(args: I) -> Result<Config, String>
where
    I: IntoIterator<Item = OsString>,
{
    let mut session = None;
    let mut manifest_only = false;
    let mut overlays_root = PathBuf::from("/var/lib/centaur/overlays");
    let mut merged_root = PathBuf::from("/run/centaur/merged");
    let mut lower = None;
    let mut harness = None;
    let mut harness_thread_id = String::new();
    let mut harness_home = String::new();
    let mut repo = String::new();
    let mut agent_uid = None;

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
            "--repo" => {
                repo = next_value(&mut iter, "--repo")?;
            }
            "--agent-uid" => {
                let value = next_value(&mut iter, "--agent-uid")?;
                agent_uid = Some(value.parse::<u32>().map_err(|_| {
                    format!("--agent-uid requires an unsigned integer, got {value:?}")
                })?);
            }
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            _ => return Err(format!("unknown argument {arg:?}")),
        }
    }

    Ok(Config {
        session: session.ok_or_else(|| "--session <ID> is required".to_string())?,
        manifest_only,
        overlays_root,
        merged_root,
        lower,
        harness,
        harness_thread_id,
        harness_home,
        repo,
        agent_uid,
    })
}

fn next_value(iter: &mut impl Iterator<Item = OsString>, flag: &str) -> Result<String, String> {
    iter.next()
        .ok_or_else(|| format!("{flag} requires a value"))?
        .into_string()
        .map_err(|_| format!("{flag} value must be valid UTF-8"))
}

fn print_help() {
    println!(
        "usage: provision-overlay --session <ID> [--manifest-only] [--overlays-root PATH] [--merged-root PATH] [--lower PATH] [--harness claude|codex|null] [--harness-thread-id ID] [--harness-home PATH] [--repo PATH] [--agent-uid UID]"
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
    }
}
