use crate::backpressure::Budget;
use crate::daemon::session::{SessionConfig, repo_worktrees};
use crate::runtime::HarnessTranscriptKind;
use crate::seam;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Default)]
pub struct DaemonArgs {
    pub once: bool,
    pub interval_secs: Option<u64>,
    pub overlays_root: Option<PathBuf>,
}

pub struct GlobalConfig {
    pub base_url: String,
    pub api_key: String,
    pub atrium_root: PathBuf,
    pub hydrate_artifacts: bool,
    pub scoped_scan: bool,
    pub cas_dir: PathBuf,
    pub depcache_root: PathBuf,
    pub depcache_max_bytes: u64,
    pub depcache_evict_enabled: bool,
    pub depcache_evict_every_n_ticks: u64,
    pub budget: Budget,
    pub large_threshold: u64,
    pub evict_heartbeat_stale: Duration,
    pub evict_no_heartbeat_grace: Duration,
    pub evict_grace: Duration,
    pub evict_recheck: Duration,
    pub gc_dirs: bool,
    pub stream_enabled: bool,
    pub reconcile_interval: Duration,
}

pub fn parse_args(argv: impl IntoIterator<Item = String>) -> Result<DaemonArgs, String> {
    let mut parsed = DaemonArgs::default();
    let mut args = argv.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--once" => parsed.once = true,
            "--interval" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--interval requires a seconds value".to_string())?;
                parsed.interval_secs = Some(value.parse::<u64>().map_err(|_| {
                    format!("--interval requires an unsigned integer seconds value, got {value}")
                })?);
            }
            "--overlays-root" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--overlays-root requires a path value".to_string())?;
                if value.trim().is_empty() {
                    return Err("--overlays-root requires a non-empty path value".to_string());
                }
                parsed.overlays_root = Some(PathBuf::from(value));
            }
            _ => {
                return Err(format!(
                    "unknown argument {arg}; supported flags: --once, --interval <secs>, --overlays-root <path>"
                ));
            }
        }
    }
    Ok(parsed)
}

/// Canonical spelling wins; the historical spelling is accepted with a log
/// line so an operator can tell which env var actually configured the
/// daemon (a stale historical value silently masking an empty canonical
/// one is otherwise hard to trace).
pub fn env_with_fallback(canonical: &str, fallback: &str) -> String {
    if let Some(value) = seam::env_first(&[canonical]) {
        return value;
    }
    match seam::env_first(&[fallback]) {
        Some(value) => {
            eprintln!(
                "centaur-node-syncd: {canonical} is unset/empty; using historical {fallback}"
            );
            value
        }
        None => String::new(),
    }
}

pub fn require_global_config(global: &GlobalConfig, mode: &str) {
    let mut missing = Vec::new();
    if global.base_url.is_empty() {
        missing.push("ATRIUM_BASE_URL (or ATRIUM_URL)".to_string());
    }
    if global.api_key.is_empty() {
        missing.push("ATRIUM_CAPTURE_API_KEY (or ARTIFACT_CAPTURE_API_KEY)".to_string());
    }
    if !missing.is_empty() {
        fail_config(&missing, mode);
    }
}

pub fn fail_config(missing: &[String], mode: &str) -> ! {
    eprintln!(
        "centaur-node-syncd configuration error: missing {}. {mode}.",
        missing.join(", ")
    );
    std::process::exit(2);
}

pub fn non_empty_path(value: &str, default: &str) -> PathBuf {
    if value.is_empty() {
        PathBuf::from(default)
    } else {
        PathBuf::from(value)
    }
}

pub fn non_empty_pathbuf(value: &str, default: PathBuf) -> PathBuf {
    if value.is_empty() {
        default
    } else {
        PathBuf::from(value)
    }
}

pub fn env_truthy(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true")
}

pub fn single_session_config(global: &GlobalConfig) -> Result<SessionConfig, Vec<String>> {
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    let session = env("NODE_SYNC_SESSION");
    let upper_env = env("NODE_SYNC_UPPER");
    let merged_env = env("NODE_SYNC_MERGED");
    let mut missing = Vec::new();
    if global.base_url.is_empty() {
        missing.push("ATRIUM_BASE_URL".to_string());
    }
    if global.api_key.is_empty() {
        missing.push("ATRIUM_CAPTURE_API_KEY".to_string());
    }
    if session.is_empty() {
        missing.push("NODE_SYNC_SESSION".to_string());
    }
    if upper_env.is_empty() {
        missing.push("NODE_SYNC_UPPER".to_string());
    }
    if merged_env.is_empty() {
        missing.push("NODE_SYNC_MERGED".to_string());
    }
    if !missing.is_empty() {
        return Err(missing);
    }

    let state_file = {
        let configured = env("NODE_SYNC_STATE");
        if configured.is_empty() {
            PathBuf::from(format!("/var/lib/centaur/sync-state/{session}.json"))
        } else {
            PathBuf::from(configured)
        }
    };
    let repo = env("NODE_SYNC_REPO");
    let merged = PathBuf::from(merged_env);
    Ok(SessionConfig {
        atrium_session: session.clone(),
        manifest_atrium_session_empty: false,
        session,
        upper: PathBuf::from(upper_env),
        merged: merged.clone(),
        harness: HarnessTranscriptKind::parse(&env("NODE_SYNC_HARNESS")),
        harness_thread_id: env("NODE_SYNC_HARNESS_THREAD_ID"),
        harness_home: env("NODE_SYNC_HARNESS_HOME"),
        flat_home: false,
        repo_worktrees: repo_worktrees(&repo, &[], &merged),
        repo_subdirs: Vec::new(),
        state_file,
    })
}

#[cfg(test)]
mod cli_contract_tests {
    use super::parse_args;

    /// Every flag declared in contract.toml [cli.daemon] must keep
    /// parsing. The emitter is the Helm chart's DaemonSet args, which no
    /// test lane can execute — this pins the parser side.
    #[test]
    fn accepts_every_declared_daemon_flag() {
        let contract: toml::Value = toml::from_str(include_str!("../../contract/contract.toml"))
            .expect("contract.toml must parse");
        let declared: Vec<&str> = contract["cli"]["daemon"]["flags"]
            .as_array()
            .expect("cli.daemon.flags array")
            .iter()
            .map(|v| v.as_str().expect("flags are strings"))
            .collect();
        let mut argv: Vec<String> = Vec::new();
        for flag in &declared {
            argv.push((*flag).to_string());
            match *flag {
                "--interval" => argv.push("2".to_string()),
                "--overlays-root" => argv.push("/var/lib/centaur/overlays".to_string()),
                "--once" => {}
                other => panic!("new daemon flag {other} needs a sample value in this test"),
            }
        }
        let parsed = parse_args(argv).expect("declared daemon argv must parse");
        assert!(parsed.once);
        assert_eq!(parsed.interval_secs, Some(2));
    }
}
