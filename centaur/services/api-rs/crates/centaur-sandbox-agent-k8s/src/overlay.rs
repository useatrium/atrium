//! Per-session overlay provisioning for agent sandboxes.
//!
//! Option A: the node-sync daemon owns the overlay mount on the node. The agent
//! pod only writes the session manifest, waits for the daemon's ready marker,
//! then receives the merged workspace mount with HostToContainer propagation.

use std::path::{Path, PathBuf};

use centaur_sandbox_core::SandboxSpec;
use serde_json::{Value, json};

const DEFAULT_OVERLAYS_ROOT: &str = "/var/lib/centaur/overlays";
const DEFAULT_MERGED_ROOT: &str = "/run/centaur/merged";
const DEFAULT_ATRIUM_ROOT: &str = "/var/lib/centaur/atrium";
const DEFAULT_WORKSPACE_MOUNT_PATH: &str = "/workspace";
pub(crate) const DEFAULT_HOME_MOUNT_PATH: &str = "/home/agent";
pub(crate) const DEFAULT_HOME_PARENT_MOUNT_PATH: &str = "/home";
const DEFAULT_ATRIUM_MOUNT_PATH: &str = "/atrium";
const DEFAULT_CONTEXT_MOUNT_PATH: &str = "/home/agent/context";
const DEFAULT_AGENT_UID: u32 = 1001;
const READY_MARKER_FILE: &str = ".centaur-workspace-ready";
const READINESS_TIMEOUT_SECS: u64 = 120;
const CENTAUR_WARM_RESOLVED_REPOS_JSON_ENV: &str = "CENTAUR_WARM_RESOLVED_REPOS_JSON";

const SESSION_UPPER_VOLUME: &str = "session-upper";
const WORKSPACE_VOLUME: &str = "workspace";
const ATRIUM_CONTEXT_VOLUME: &str = "atrium-context";

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
    /// Mount the merged workspace as the agent's HOME with context underneath it.
    pub flat_home: bool,
}

impl OverlayConfig {
    pub fn new(image: impl Into<String>) -> Self {
        Self {
            image: image.into(),
            overlays_root: PathBuf::from(DEFAULT_OVERLAYS_ROOT),
            merged_root: PathBuf::from(DEFAULT_MERGED_ROOT),
            agent_uid: DEFAULT_AGENT_UID,
            workspace_mount_path: DEFAULT_WORKSPACE_MOUNT_PATH.to_owned(),
            flat_home: false,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct OverlayMetadata {
    pub(crate) agent_uid: u32,
    pub(crate) atrium_session: Option<String>,
    pub(crate) harness: Option<String>,
    pub(crate) harness_thread_id: Option<String>,
    pub(crate) harness_home: Option<String>,
    pub(crate) repo: Option<String>,
    pub(crate) repos_json: Option<String>,
    pub(crate) resolved_repos_json: Option<String>,
    pub(crate) warm_sandbox: bool,
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
            atrium_session: env_value(spec, "CENTAUR_THREAD_KEY").map(str::to_owned),
            harness,
            harness_thread_id: env_value(spec, "CENTAUR_RESUME_THREAD_ID")
                .or_else(|| env_value(spec, "CODEX_CONTINUE_THREAD_ID"))
                .map(str::to_owned),
            harness_home,
            repo: env_value(spec, "AGENT_REPO").map(str::to_owned),
            repos_json: env_value(spec, "AGENT_REPOS_JSON").map(str::to_owned),
            resolved_repos_json: env_value(spec, CENTAUR_WARM_RESOLVED_REPOS_JSON_ENV)
                .map(str::to_owned),
            warm_sandbox: env_value(spec, "CENTAUR_WARM_SANDBOX").is_some_and(truthy_env_value),
        }
    }
}

pub(crate) fn overlay_manifest_init_container_json(
    overlay: &OverlayConfig,
    session: &str,
    metadata: &OverlayMetadata,
) -> Value {
    let mut args = vec![
        "--manifest-only".to_owned(),
        "--session".to_owned(),
        session.to_owned(),
        "--overlays-root".to_owned(),
        path_string(&overlay.overlays_root),
        "--merged-root".to_owned(),
        path_string(&overlay.merged_root),
        "--agent-uid".to_owned(),
        metadata.agent_uid.to_string(),
    ];
    if warm_flat_home_claim_slot(overlay, metadata) {
        args.push("--merged-path".to_owned());
        args.push(warm_flat_home_path(overlay, session));
        args.push("--context-source".to_owned());
        args.push(atrium_context_host_path(session));
    }
    push_optional_arg(
        &mut args,
        "--atrium-session",
        metadata.atrium_session.as_deref(),
    );
    if overlay.flat_home {
        args.push("--flat-home".to_owned());
    }
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
    let manifest_repos_json = if metadata.warm_sandbox {
        metadata
            .resolved_repos_json
            .as_deref()
            .or(metadata.repos_json.as_deref())
    } else {
        metadata.repos_json.as_deref()
    };
    push_optional_arg(&mut args, "--repos-json", manifest_repos_json);

    json!({
        "name": "overlay-manifest-writer",
        "image": overlay.image,
        // Mirror the node-sync DaemonSet's pull policy (IfNotPresent). Without an
        // explicit policy, k8s defaults to Always for a `:latest` tag and the kubelet
        // fails on a locally-loaded image (no registry to pull from).
        "imagePullPolicy": "IfNotPresent",
        "command": ["/usr/local/bin/provision-overlay"],
        "args": args,
        "securityContext": {
            "privileged": false,
            "allowPrivilegeEscalation": false,
            "capabilities": {
                "drop": ["ALL"],
            },
            "seccompProfile": {
                "type": "RuntimeDefault",
            },
        },
        "volumeMounts": [
            {
                "name": SESSION_UPPER_VOLUME,
                "mountPath": path_string(&overlay.overlays_root),
            },
        ],
    })
}

pub(crate) fn overlay_readiness_init_container_json(
    overlay: &OverlayConfig,
    session: &str,
    metadata: &OverlayMetadata,
) -> Value {
    let ready_path = if warm_flat_home_claim_slot(overlay, metadata) {
        warm_flat_home_path(overlay, session)
    } else {
        merged_session_path(overlay, session)
    };
    json!({
        "name": "overlay-readiness-wait",
        "image": overlay.image,
        "imagePullPolicy": "IfNotPresent",
        "command": ["/bin/sh", "-ceu", readiness_wait_script(&ready_path)],
        "securityContext": {
            "privileged": false,
            "allowPrivilegeEscalation": false,
            "capabilities": {
                "drop": ["ALL"],
            },
            "seccompProfile": {
                "type": "RuntimeDefault",
            },
        },
        "volumeMounts": [
            {
                "name": WORKSPACE_VOLUME,
                "mountPath": merged_session_path(overlay, session),
                "mountPropagation": "HostToContainer",
            },
        ],
    })
}

pub(crate) fn warm_flat_home_init_container_json(
    overlay: &OverlayConfig,
    session: &str,
    metadata: &OverlayMetadata,
) -> Value {
    let home = warm_flat_home_path(overlay, session);
    json!({
        "name": "warm-home-placeholder",
        "image": overlay.image,
        "imagePullPolicy": "IfNotPresent",
        "command": [
            "/bin/sh",
            "-ceu",
            format!(
                "home={home:?}\nmkdir -p \"$home\"\nchown {uid}:{uid} \"$home\"\nchmod 0755 \"$home\"",
                uid = metadata.agent_uid,
            ),
        ],
        "securityContext": {
            "privileged": false,
            "allowPrivilegeEscalation": false,
            "runAsUser": 0,
            "capabilities": {
                "drop": ["ALL"],
                "add": ["CHOWN", "FOWNER"],
            },
            "seccompProfile": {
                "type": "RuntimeDefault",
            },
        },
        "volumeMounts": [
            {
                "name": WORKSPACE_VOLUME,
                "mountPath": merged_session_path(overlay, session),
            },
        ],
    })
}

pub(crate) struct WarmcacheHydrateInitContainer<'a> {
    pub(crate) session: &'a str,
    pub(crate) repos_json: &'a str,
    pub(crate) repo_cache_root: &'a str,
    pub(crate) depcache_root: &'a str,
    pub(crate) cas_dir: &'a str,
    pub(crate) repo_cache_volume: &'a str,
    pub(crate) depcache_volume: &'a str,
    pub(crate) cas_volume: &'a str,
    pub(crate) atrium_url: Option<&'a str>,
    pub(crate) atrium_key: Option<&'a str>,
    pub(crate) toolchain_id: Option<&'a str>,
}

pub(crate) struct PrivateRepoHydrateInitContainer<'a> {
    pub(crate) repos_json: &'a str,
    pub(crate) repo_cache_root: &'a str,
    pub(crate) repo_cache_volume: &'a str,
    pub(crate) https_proxy: &'a str,
    pub(crate) git_ca_info: &'a str,
    pub(crate) ca_volume_mount: Value,
}

pub(crate) fn private_repo_hydrate_init_container_json(
    overlay: &OverlayConfig,
    init: PrivateRepoHydrateInitContainer<'_>,
) -> Value {
    json!({
        "name": "private-repo-cache-hydrate",
        "image": overlay.image,
        "imagePullPolicy": "IfNotPresent",
        "command": ["/usr/local/bin/provision-overlay"],
        "args": [
            "--hydrate-private-repos",
            "--repos-json",
            init.repos_json,
            "--repo-cache-root",
            init.repo_cache_root,
            "--https-proxy",
            init.https_proxy,
            "--git-ca-info",
            init.git_ca_info,
        ],
        "securityContext": {
            "privileged": false,
            "allowPrivilegeEscalation": false,
            "capabilities": {
                "drop": ["ALL"],
            },
            "seccompProfile": {
                "type": "RuntimeDefault",
            },
        },
        "volumeMounts": [
            {
                "name": init.repo_cache_volume,
                "mountPath": init.repo_cache_root,
            },
            init.ca_volume_mount,
        ],
    })
}

pub(crate) fn warmcache_hydrate_init_container_json(
    overlay: &OverlayConfig,
    init: WarmcacheHydrateInitContainer<'_>,
) -> Value {
    let mut env = Vec::new();
    if let Some(atrium_url) = init.atrium_url {
        env.push(json!({ "name": "ATRIUM_URL", "value": atrium_url }));
    }
    if let Some(atrium_key) = init.atrium_key {
        env.push(json!({ "name": "ARTIFACT_CAPTURE_API_KEY", "value": atrium_key }));
    }
    let toolchain_id = init
        .toolchain_id
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let mut container = json!({
        "name": "warmcache-hydrate",
        "image": overlay.image,
        "imagePullPolicy": "IfNotPresent",
        "command": ["/usr/local/bin/warmcache-hydrate"],
        "args": [
            "--session",
            init.session,
            "--repos-json",
            init.repos_json,
            "--repo-cache-root",
            init.repo_cache_root,
            "--depcache-root",
            init.depcache_root,
            "--cas-dir",
            init.cas_dir,
        ],
        "securityContext": {
            "privileged": false,
            "allowPrivilegeEscalation": false,
            "capabilities": {
                "drop": ["ALL"],
            },
            "seccompProfile": {
                "type": "RuntimeDefault",
            },
        },
        "volumeMounts": [
            {
                "name": init.repo_cache_volume,
                "mountPath": init.repo_cache_root,
                "readOnly": true,
            },
            {
                "name": init.depcache_volume,
                "mountPath": init.depcache_root,
            },
            {
                "name": init.cas_volume,
                "mountPath": init.cas_dir,
            },
        ],
    });
    if !env.is_empty() {
        container["env"] = json!(env);
    }
    if let Some(toolchain_id) = toolchain_id {
        let args = container["args"]
            .as_array_mut()
            .expect("warmcache hydrate args must be an array");
        args.push(json!("--toolchain-id"));
        args.push(json!(toolchain_id));
    }
    container
}

pub(crate) fn overlay_volumes_json(overlay: &OverlayConfig, session: &str) -> Vec<Value> {
    let workspace_host_path = if overlay.flat_home {
        path_string(&overlay.merged_root.join(session))
    } else {
        merged_session_path(overlay, session)
    };
    vec![
        json!({
            "name": SESSION_UPPER_VOLUME,
            "hostPath": {
                "path": path_string(&overlay.overlays_root),
                "type": "DirectoryOrCreate",
            },
        }),
        json!({
            "name": WORKSPACE_VOLUME,
            "hostPath": {
                "path": workspace_host_path,
                "type": "DirectoryOrCreate",
            },
        }),
    ]
}

pub(crate) fn overlay_agent_volume_mount_json(
    overlay: &OverlayConfig,
    _session: &str,
    metadata: &OverlayMetadata,
) -> Value {
    let mount_path = if overlay.flat_home {
        if warm_flat_home_claim_slot(overlay, metadata) {
            DEFAULT_HOME_PARENT_MOUNT_PATH
        } else {
            DEFAULT_HOME_MOUNT_PATH
        }
    } else {
        overlay.workspace_mount_path.as_str()
    };

    json!({
        "name": WORKSPACE_VOLUME,
        "mountPath": mount_path,
        "mountPropagation": "HostToContainer",
    })
}

pub(crate) fn atrium_agent_volume_mount_json(overlay: &OverlayConfig) -> Value {
    let mount_path = if overlay.flat_home {
        DEFAULT_CONTEXT_MOUNT_PATH
    } else {
        DEFAULT_ATRIUM_MOUNT_PATH
    };

    json!({
        "name": ATRIUM_CONTEXT_VOLUME,
        "mountPath": mount_path,
        "readOnly": true,
    })
}

pub(crate) fn atrium_volume_json(session: &str) -> Value {
    json!({
        "name": ATRIUM_CONTEXT_VOLUME,
        "hostPath": {
            "path": atrium_session_path(session),
            "type": "DirectoryOrCreate",
        },
    })
}

pub(crate) fn atrium_context_host_path(session: &str) -> String {
    atrium_session_path(session)
}

fn readiness_wait_script(ready_path: &str) -> String {
    let marker = Path::new(ready_path).join(READY_MARKER_FILE);
    format!(
        "marker={marker:?}\n\
         deadline=$(( $(date +%s) + {READINESS_TIMEOUT_SECS} ))\n\
         while [ ! -f \"$marker\" ]; do\n\
         \tif [ \"$(date +%s)\" -ge \"$deadline\" ]; then\n\
         \t\techo \"timed out waiting for $marker\" >&2\n\
         \t\texit 1\n\
         \tfi\n\
         \tsleep 1\n\
         done\n"
    )
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

fn truthy_env_value(value: &str) -> bool {
    matches!(value.trim(), "1" | "true" | "True" | "TRUE" | "yes" | "on")
}

fn merged_session_path(overlay: &OverlayConfig, session: &str) -> String {
    path_string(&overlay.merged_root.join(session))
}

fn warm_flat_home_claim_slot(overlay: &OverlayConfig, metadata: &OverlayMetadata) -> bool {
    overlay.flat_home && metadata.warm_sandbox
}

fn warm_flat_home_path(overlay: &OverlayConfig, session: &str) -> String {
    path_string(&overlay.merged_root.join(session).join("agent"))
}

fn atrium_session_path(session: &str) -> String {
    path_string(&Path::new(DEFAULT_ATRIUM_ROOT).join(session))
}

fn path_string(path: &Path) -> String {
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn agent_mount_json_defaults_to_workspace_and_atrium() {
        let overlay = OverlayConfig::new("centaur-node-sync:test");
        let metadata = OverlayMetadata::default();

        assert_eq!(
            overlay_agent_volume_mount_json(&overlay, "asbx-test", &metadata),
            json!({
                "name": WORKSPACE_VOLUME,
                "mountPath": "/workspace",
                "mountPropagation": "HostToContainer",
            })
        );
        assert_eq!(
            atrium_agent_volume_mount_json(&overlay),
            json!({
                "name": ATRIUM_CONTEXT_VOLUME,
                "mountPath": "/atrium",
                "readOnly": true,
            })
        );
    }

    #[test]
    fn agent_mount_json_uses_flat_home_paths_when_enabled() {
        let mut overlay = OverlayConfig::new("centaur-node-sync:test");
        overlay.flat_home = true;
        let metadata = OverlayMetadata {
            atrium_session: Some("thread-1".to_owned()),
            ..OverlayMetadata::default()
        };

        assert_eq!(
            overlay_agent_volume_mount_json(&overlay, "asbx-test", &metadata),
            json!({
                "name": WORKSPACE_VOLUME,
                "mountPath": "/home/agent",
                "mountPropagation": "HostToContainer",
            })
        );
        assert_eq!(
            atrium_agent_volume_mount_json(&overlay),
            json!({
                "name": ATRIUM_CONTEXT_VOLUME,
                "mountPath": "/home/agent/context",
                "readOnly": true,
            })
        );
    }

    #[test]
    fn agent_mount_json_uses_home_parent_for_warm_flat_home() {
        let mut overlay = OverlayConfig::new("centaur-node-sync:test");
        overlay.flat_home = true;
        let metadata = OverlayMetadata {
            warm_sandbox: true,
            ..OverlayMetadata::default()
        };

        assert_eq!(
            overlay_agent_volume_mount_json(&overlay, "asbx-test", &metadata),
            json!({
                "name": WORKSPACE_VOLUME,
                "mountPath": "/home",
                "mountPropagation": "HostToContainer",
            })
        );
    }

    #[test]
    fn manifest_init_args_include_flat_home_iff_enabled() {
        for flat_home in [false, true] {
            let mut overlay = OverlayConfig::new("centaur-node-sync:test");
            overlay.flat_home = flat_home;
            let metadata = OverlayMetadata {
                agent_uid: 4242,
                ..OverlayMetadata::default()
            };

            let init = overlay_manifest_init_container_json(&overlay, "asbx-test", &metadata);
            let args = init["args"].as_array().unwrap();
            assert_eq!(
                args.iter().any(|arg| arg.as_str() == Some("--flat-home")),
                flat_home,
                "flat_home={flat_home}"
            );
        }
    }

    #[test]
    fn warm_manifest_prefers_resolved_repos_json() {
        let overlay = OverlayConfig::new("centaur-node-sync:test");
        let logical = r#"[{"repo":"acme/widget","ref":"main"}]"#;
        let resolved = r#"[{"repo":"acme/widget","ref":"main","resolved_sha":"abc","cache_path":".snapshots/acme/widget/abc"}]"#;

        for (warm_sandbox, expected) in [(false, logical), (true, resolved)] {
            let metadata = OverlayMetadata {
                repos_json: Some(logical.to_owned()),
                resolved_repos_json: Some(resolved.to_owned()),
                warm_sandbox,
                ..OverlayMetadata::default()
            };
            let init = overlay_manifest_init_container_json(&overlay, "asbx-test", &metadata);
            let args = init["args"].as_array().unwrap();
            assert!(
                args.windows(2)
                    .any(|pair| pair[0] == "--repos-json" && pair[1] == expected),
                "warm_sandbox={warm_sandbox}"
            );
        }
    }
}

// Asserts this crate's side of the node-sync seam against the contract data at
// runtime/node-sync/contract/contract.toml (see runtime/node-sync/CONTRACT.md).
// Test-time file read only — the AGPL daemon crate is never linked.
#[cfg(test)]
mod contract_tests {
    use super::*;
    use centaur_sandbox_core::EnvVar;

    fn contract() -> toml::Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../../runtime/node-sync/contract/contract.toml"
        );
        let raw = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("read node-sync contract at {path}: {e}"));
        toml::from_str(&raw).expect("contract.toml must be valid TOML")
    }

    fn get<'a>(value: &'a toml::Value, path: &str) -> &'a toml::Value {
        let mut current = value;
        for key in path.split('.') {
            current = current
                .get(key)
                .unwrap_or_else(|| panic!("contract.toml is missing key {path}"));
        }
        current
    }

    fn get_str<'a>(value: &'a toml::Value, path: &str) -> &'a str {
        get(value, path)
            .as_str()
            .unwrap_or_else(|| panic!("contract.toml {path} must be a string"))
    }

    fn assert_args_declared(container: &Value, contract: &toml::Value, flags_path: &str) {
        let declared: Vec<&str> = get(contract, flags_path)
            .as_array()
            .expect("flags must be an array")
            .iter()
            .map(|v| v.as_str().expect("flags are strings"))
            .collect();
        for arg in container["args"].as_array().expect("args array") {
            let arg = arg.as_str().expect("args are strings");
            if arg.starts_with("--") {
                assert!(
                    declared.contains(&arg),
                    "emitted flag {arg} is not declared in contract {flags_path}"
                );
            }
        }
    }

    fn full_metadata() -> OverlayMetadata {
        OverlayMetadata {
            agent_uid: 1001,
            atrium_session: Some("slack:C1:1.2".to_owned()),
            harness: Some("codex".to_owned()),
            harness_thread_id: Some("thread-1".to_owned()),
            harness_home: Some("/home/agent/.codex".to_owned()),
            repo: Some("acme/widget".to_owned()),
            repos_json: Some("[]".to_owned()),
            resolved_repos_json: Some("[]".to_owned()),
            warm_sandbox: true,
        }
    }

    #[test]
    fn host_paths_and_marker_match_the_contract() {
        let c = contract();
        assert_eq!(
            get_str(&c, "host_paths.overlays_root"),
            DEFAULT_OVERLAYS_ROOT
        );
        assert_eq!(get_str(&c, "host_paths.merged_root"), DEFAULT_MERGED_ROOT);
        assert_eq!(get_str(&c, "host_paths.atrium_root"), DEFAULT_ATRIUM_ROOT);
        assert_eq!(
            get_str(&c, "host_paths.workspace_mount"),
            DEFAULT_WORKSPACE_MOUNT_PATH
        );
        assert_eq!(
            get_str(&c, "host_paths.home_mount"),
            DEFAULT_HOME_MOUNT_PATH
        );
        assert_eq!(
            get_str(&c, "host_paths.context_mount"),
            DEFAULT_CONTEXT_MOUNT_PATH
        );
        assert_eq!(
            get_str(&c, "host_paths.atrium_mount"),
            DEFAULT_ATRIUM_MOUNT_PATH
        );
        assert_eq!(get_str(&c, "markers.workspace_ready"), READY_MARKER_FILE);
    }

    #[test]
    fn volume_label_and_container_names_match_the_contract() {
        let c = contract();
        assert_eq!(
            get_str(&c, "k8s.volumes.session_upper"),
            SESSION_UPPER_VOLUME
        );
        assert_eq!(get_str(&c, "k8s.volumes.workspace"), WORKSPACE_VOLUME);
        assert_eq!(
            get_str(&c, "k8s.volumes.atrium_context"),
            ATRIUM_CONTEXT_VOLUME
        );
        assert_eq!(
            get_str(&c, "k8s.volumes.warmcache_cas"),
            crate::WARMCACHE_CAS_VOLUME
        );
        assert_eq!(
            get_str(&c, "k8s.component_label"),
            crate::NODE_SYNC_COMPONENT_LABEL
        );
        assert_eq!(
            get_str(&c, "k8s.component_value"),
            crate::NODE_SYNC_COMPONENT_VALUE
        );
        assert_eq!(
            get_str(&c, "k8s.daemon_container"),
            crate::NODE_SYNC_CONTAINER_NAME
        );
        assert_eq!(
            get_str(&c, "k8s.claimed_home_helper_container"),
            crate::CLAIMED_HOME_HELPER_CONTAINER
        );
    }

    #[test]
    fn manifest_writer_container_matches_the_contract() {
        let c = contract();
        let mut overlay = OverlayConfig::new("centaur-node-sync:test");
        overlay.flat_home = true;
        let container = overlay_manifest_init_container_json(&overlay, "sess-1", &full_metadata());

        assert_eq!(
            container["name"],
            get_str(&c, "k8s.init_containers.manifest_writer")
        );
        assert_eq!(
            container["command"][0],
            get_str(&c, "image.binaries.provision_overlay")
        );
        assert_args_declared(&container, &c, "cli.provision_overlay.flags");
    }

    #[test]
    fn readiness_and_warm_home_container_names_match_the_contract() {
        let c = contract();
        let mut overlay = OverlayConfig::new("centaur-node-sync:test");
        overlay.flat_home = true;
        let metadata = full_metadata();

        let readiness = overlay_readiness_init_container_json(&overlay, "sess-1", &metadata);
        assert_eq!(
            readiness["name"],
            get_str(&c, "k8s.init_containers.readiness_wait")
        );

        let placeholder = warm_flat_home_init_container_json(&overlay, "sess-1", &metadata);
        assert_eq!(
            placeholder["name"],
            get_str(&c, "k8s.init_containers.warm_home_placeholder")
        );
    }

    #[test]
    fn private_repo_hydrate_container_matches_the_contract() {
        let c = contract();
        let overlay = OverlayConfig::new("centaur-node-sync:test");
        let container = private_repo_hydrate_init_container_json(
            &overlay,
            PrivateRepoHydrateInitContainer {
                repos_json: "[]",
                repo_cache_root: "/cache",
                repo_cache_volume: "repo-cache",
                https_proxy: "http://iron-proxy:8080",
                git_ca_info: "/etc/centaur/ca/proxy-ca.crt",
                ca_volume_mount: serde_json::json!({"name": "ca", "mountPath": "/etc/centaur/ca"}),
            },
        );
        assert_eq!(
            container["name"],
            get_str(&c, "k8s.init_containers.private_repo_hydrate")
        );
        assert_eq!(
            container["command"][0],
            get_str(&c, "image.binaries.provision_overlay")
        );
        assert_args_declared(&container, &c, "cli.provision_overlay.flags");
    }

    #[test]
    fn warmcache_container_matches_the_contract() {
        let c = contract();
        let overlay = OverlayConfig::new("centaur-node-sync:test");
        let container = warmcache_hydrate_init_container_json(
            &overlay,
            WarmcacheHydrateInitContainer {
                session: "sess-1",
                repos_json: "[]",
                repo_cache_root: "/cache",
                depcache_root: "/var/cache/centaur/depcache",
                cas_dir: "/var/lib/centaur/cas",
                repo_cache_volume: "repo-cache",
                depcache_volume: "depcache",
                cas_volume: "warmcache-cas",
                atrium_url: Some("http://atrium:8080"),
                atrium_key: Some("key"),
                toolchain_id: Some("tc-1"),
            },
        );
        assert_eq!(
            container["name"],
            get_str(&c, "k8s.init_containers.warmcache_hydrate")
        );
        assert_eq!(
            container["command"][0],
            get_str(&c, "image.binaries.warmcache_hydrate")
        );
        assert_args_declared(&container, &c, "cli.warmcache_hydrate.flags");
        let env_names: Vec<&str> = container["env"]
            .as_array()
            .expect("warmcache env array")
            .iter()
            .map(|e| e["name"].as_str().expect("env name"))
            .collect();
        assert!(env_names.contains(&get_str(&c, "env.warmcache_hydrate.url")));
        assert!(env_names.contains(&get_str(&c, "env.warmcache_hydrate.key")));
    }

    /// The sandbox-spec env keys the contract declares must actually populate
    /// the provisioner metadata — pins the names behaviorally without hoisting
    /// every literal.
    #[test]
    fn sandbox_spec_env_keys_populate_metadata() {
        let c = contract();
        let declared: Vec<&str> = get(&c, "env.sandbox_spec.keys")
            .as_array()
            .expect("keys array")
            .iter()
            .map(|v| v.as_str().expect("keys are strings"))
            .collect();
        for key in [
            "CENTAUR_THREAD_KEY",
            "CENTAUR_HARNESS_TYPE",
            "CENTAUR_HARNESS_HOME",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "CENTAUR_RESUME_THREAD_ID",
            "CODEX_CONTINUE_THREAD_ID",
            "AGENT_REPO",
            "AGENT_REPOS_JSON",
            CENTAUR_WARM_RESOLVED_REPOS_JSON_ENV,
            "CENTAUR_WARM_SANDBOX",
        ] {
            assert!(
                declared.contains(&key),
                "sandbox-spec key {key} is not declared in contract.toml"
            );
        }
        assert_eq!(
            get_str(&c, "env.sandbox_spec.harness_label"),
            "centaur.ai/harness"
        );

        let mut spec = centaur_sandbox_core::SandboxSpec::new("centaur-agent:test");
        for (name, value) in [
            ("CENTAUR_THREAD_KEY", "slack:C1:1.2"),
            ("CENTAUR_HARNESS_TYPE", "codex"),
            ("CODEX_HOME", "/home/agent/.codex"),
            ("CENTAUR_RESUME_THREAD_ID", "thread-1"),
            ("AGENT_REPO", "acme/widget"),
            ("AGENT_REPOS_JSON", "[]"),
            ("CENTAUR_WARM_SANDBOX", "1"),
        ] {
            spec.env.push(EnvVar {
                name: name.to_owned(),
                value: value.to_owned(),
            });
        }
        let metadata = OverlayMetadata::from_sandbox_spec(&spec, 1001);
        assert_eq!(metadata.atrium_session.as_deref(), Some("slack:C1:1.2"));
        assert_eq!(metadata.harness.as_deref(), Some("codex"));
        assert_eq!(metadata.harness_home.as_deref(), Some("/home/agent/.codex"));
        assert_eq!(metadata.harness_thread_id.as_deref(), Some("thread-1"));
        assert_eq!(metadata.repo.as_deref(), Some("acme/widget"));
        assert_eq!(metadata.repos_json.as_deref(), Some("[]"));
        assert!(metadata.warm_sandbox);
    }
}
