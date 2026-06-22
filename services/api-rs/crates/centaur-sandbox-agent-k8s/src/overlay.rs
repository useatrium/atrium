//! Per-session overlay provisioning for agent sandboxes.
//!
//! The privileged init container runs the node-sync image's `provision-overlay`
//! binary. It mounts the host root that owns the session upper/work/lower trees
//! with Bidirectional propagation, then the hardened agent receives the merged
//! workspace mount with HostToContainer propagation.

use std::path::{Path, PathBuf};

use centaur_sandbox_core::SandboxSpec;
use serde_json::{Value, json};

const DEFAULT_OVERLAYS_ROOT: &str = "/var/lib/centaur/overlays";
const DEFAULT_MERGED_ROOT: &str = "/run/centaur/merged";
const DEFAULT_WORKSPACE_MOUNT_PATH: &str = "/workspace";
const DEFAULT_AGENT_UID: u32 = 1001;

const SESSION_UPPER_VOLUME: &str = "session-upper";
const WORKSPACE_VOLUME: &str = "workspace";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OverlayConfig {
    /// Image containing `/usr/local/bin/provision-overlay`.
    pub image: String,
    /// Host root whose children are per-session uppers.
    pub overlays_root: PathBuf,
    /// Host root whose children are per-session merged overlay mounts.
    pub merged_root: PathBuf,
    /// UID that owns the writable upper when the agent container has no
    /// explicit `runAsUser`.
    pub agent_uid: u32,
    /// Path where the agent receives the already-mounted merged workspace.
    pub workspace_mount_path: String,
}

impl OverlayConfig {
    pub fn new(image: impl Into<String>) -> Self {
        Self {
            image: image.into(),
            overlays_root: PathBuf::from(DEFAULT_OVERLAYS_ROOT),
            merged_root: PathBuf::from(DEFAULT_MERGED_ROOT),
            agent_uid: DEFAULT_AGENT_UID,
            workspace_mount_path: DEFAULT_WORKSPACE_MOUNT_PATH.to_owned(),
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct OverlayMetadata {
    pub(crate) agent_uid: u32,
    pub(crate) harness: Option<String>,
    pub(crate) harness_thread_id: Option<String>,
    pub(crate) harness_home: Option<String>,
    pub(crate) repo: Option<String>,
}

impl OverlayMetadata {
    pub(crate) fn from_sandbox_spec(spec: &SandboxSpec, agent_uid: u32) -> Self {
        let harness = spec
            .labels
            .get("centaur.ai/harness")
            .map(String::as_str)
            .or_else(|| env_value(spec, "CENTAUR_HARNESS_TYPE"))
            .and_then(supported_provisioner_harness);

        let harness_home = env_value(spec, "CENTAUR_HARNESS_HOME")
            .map(str::to_owned)
            .or_else(|| match harness.as_deref() {
                Some("codex") => env_value(spec, "CODEX_HOME").map(str::to_owned),
                Some("claude" | "claude-code" | "claudecode") => {
                    env_value(spec, "CLAUDE_CONFIG_DIR").map(str::to_owned)
                }
                _ => None,
            });

        Self {
            agent_uid,
            harness,
            harness_thread_id: env_value(spec, "CENTAUR_RESUME_THREAD_ID")
                .or_else(|| env_value(spec, "CODEX_CONTINUE_THREAD_ID"))
                .map(str::to_owned),
            harness_home,
            repo: env_value(spec, "AGENT_REPO").map(str::to_owned),
        }
    }
}

pub(crate) fn overlay_init_container_json(
    overlay: &OverlayConfig,
    session: &str,
    metadata: &OverlayMetadata,
) -> Value {
    let mut args = vec![
        "--session".to_owned(),
        session.to_owned(),
        "--overlays-root".to_owned(),
        path_string(&overlay.overlays_root),
        "--merged-root".to_owned(),
        path_string(&overlay.merged_root),
        "--agent-uid".to_owned(),
        metadata.agent_uid.to_string(),
    ];
    push_optional_arg(&mut args, "--harness", metadata.harness.as_deref());
    push_optional_arg(
        &mut args,
        "--harness-thread-id",
        metadata.harness_thread_id.as_deref(),
    );
    push_optional_arg(
        &mut args,
        "--harness-home",
        metadata.harness_home.as_deref(),
    );
    push_optional_arg(&mut args, "--repo", metadata.repo.as_deref());

    json!({
        "name": "overlay-setup",
        "image": overlay.image,
        "command": ["/usr/local/bin/provision-overlay"],
        "args": args,
        "securityContext": {
            "privileged": true,
        },
        "volumeMounts": [
            {
                "name": SESSION_UPPER_VOLUME,
                "mountPath": overlays_host_root(overlay),
                "mountPropagation": "Bidirectional",
            },
            {
                "name": WORKSPACE_VOLUME,
                "mountPath": merged_session_path(overlay, session),
                "mountPropagation": "Bidirectional",
            },
        ],
    })
}

pub(crate) fn overlay_volumes_json(overlay: &OverlayConfig, session: &str) -> Vec<Value> {
    vec![
        json!({
            "name": SESSION_UPPER_VOLUME,
            "hostPath": {
                "path": overlays_host_root(overlay),
                "type": "DirectoryOrCreate",
            },
        }),
        json!({
            "name": WORKSPACE_VOLUME,
            "hostPath": {
                "path": merged_session_path(overlay, session),
                "type": "DirectoryOrCreate",
            },
        }),
    ]
}

pub(crate) fn overlay_agent_volume_mount_json(overlay: &OverlayConfig, _session: &str) -> Value {
    json!({
        "name": WORKSPACE_VOLUME,
        "mountPath": overlay.workspace_mount_path,
        "mountPropagation": "HostToContainer",
    })
}

fn push_optional_arg(args: &mut Vec<String>, flag: &str, value: Option<&str>) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        args.push(flag.to_owned());
        args.push(value.to_owned());
    }
}

fn env_value<'a>(spec: &'a SandboxSpec, name: &str) -> Option<&'a str> {
    spec.env
        .iter()
        .find(|env| env.name == name)
        .map(|env| env.value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn supported_provisioner_harness(value: &str) -> Option<String> {
    match value.trim() {
        "codex" | "claude" | "claude-code" | "claudecode" => Some(value.trim().to_owned()),
        _ => None,
    }
}

fn overlays_host_root(overlay: &OverlayConfig) -> String {
    overlay
        .overlays_root
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(&overlay.overlays_root)
        .display()
        .to_string()
}

fn merged_session_path(overlay: &OverlayConfig, session: &str) -> String {
    path_string(&overlay.merged_root.join(session))
}

fn path_string(path: &Path) -> String {
    path.display().to_string()
}
