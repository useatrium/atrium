use std::path::Path;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::overlay::{RawEntry, RawFileType};
use crate::runtime::{HarnessTranscriptKind, UpperReader};
use crate::secret;

pub const ADAPTER_VERSION: &str = "centaur-node-sync/profile-candidates/v1";
pub const PROFILE_BUNDLE_MAX_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone)]
pub struct ProfileBundleBlob {
    pub path: String,
    pub sha256: String,
    pub role: String,
    pub executable: bool,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct ProfileCandidateReport {
    pub provider: String,
    pub adapter_version: String,
    pub candidates: Vec<Value>,
    pub excluded: Vec<Value>,
    pub warnings: Vec<String>,
    pub bundles: Vec<ProfileBundleBlob>,
    pub manifest: Value,
    pub risk_summary: Value,
}

impl ProfileCandidateReport {
    pub fn into_payload(self) -> Value {
        let (settings, mcp_servers) = canonical_manifest_parts(&self.candidates);
        let source_hashes = self
            .manifest
            .get("source_file_hashes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| {
                let object = value.as_object()?;
                Some(json!({
                    "path": object.get("path")?.as_str()?,
                    "sha256": object.get("hash").and_then(Value::as_str).unwrap_or_default(),
                }))
            })
            .collect::<Vec<_>>();
        let blocked_secrets = self
            .risk_summary
            .get("blocked_secret_count")
            .or_else(|| self.risk_summary.get("redacted_value_count"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let executable_items = self
            .risk_summary
            .get("executable_item_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let unsupported_items = self
            .risk_summary
            .get("unsupported_item_count")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| self.excluded.len().saturating_sub(blocked_secrets as usize) as u64);
        let mut labels = vec!["safe"];
        if blocked_secrets > 0 {
            labels.push("needs-secret-ref");
        }
        if executable_items > 0 {
            labels.push("policy-capped");
        }
        if unsupported_items > 0 {
            labels.push("unsupported");
        }
        let mut manifest = Map::new();
        manifest.insert("provider".to_string(), Value::String(self.provider.clone()));
        manifest.insert(
            "adapterVersion".to_string(),
            Value::String(self.adapter_version.clone()),
        );
        if !settings.is_empty() {
            manifest.insert("settings".to_string(), Value::Object(settings));
        }
        if !mcp_servers.is_empty() {
            manifest.insert("mcpServers".to_string(), Value::Object(mcp_servers));
        }
        if !self.bundles.is_empty() {
            manifest.insert(
                "bundles".to_string(),
                Value::Array(
                    self.bundles
                        .iter()
                        .map(|bundle| {
                            json!({
                                "path": bundle.path,
                                "sha256": bundle.sha256,
                                "role": bundle.role,
                                "executable": bundle.executable,
                            })
                        })
                        .collect(),
                ),
            );
        }
        if !self.excluded.is_empty() {
            manifest.insert("excluded".to_string(), Value::Array(self.excluded.clone()));
        }
        if !self.warnings.is_empty() {
            manifest.insert(
                "warnings".to_string(),
                Value::Array(
                    self.warnings
                        .iter()
                        .map(|warning| Value::String(warning.clone()))
                        .collect(),
                ),
            );
        }
        json!({
            "provider": self.provider,
            "adapterVersion": self.adapter_version,
            "sourceHashes": source_hashes,
            "manifest": Value::Object(manifest),
            "riskSummary": {
                "labels": labels,
                "blockedSecrets": blocked_secrets,
                "executableItems": executable_items,
                "unsupportedItems": unsupported_items,
                "warnings": self.warnings,
            },
            "diagnostics": {
                "candidates": self.candidates,
                "excluded": self.excluded,
                "manifest": self.manifest,
                "risk_summary": self.risk_summary,
            }
        })
    }

    pub fn into_baseline_payload(self) -> Value {
        let adapter_version = self.adapter_version.clone();
        let payload = self.into_payload();
        json!({
            "adapterVersion": adapter_version,
            "manifest": payload.get("manifest").cloned().unwrap_or_else(|| json!({})),
        })
    }
}

fn canonical_manifest_parts(candidates: &[Value]) -> (Map<String, Value>, Map<String, Value>) {
    let mut settings = Map::new();
    let mut mcp_servers = Map::new();
    for candidate in candidates {
        let Some(config) = candidate.get("config").and_then(Value::as_object) else {
            continue;
        };
        for (key, value) in config {
            if key == "mcp_servers" || key == "mcpServers" {
                if let Some(servers) = value.as_object() {
                    for (name, server) in servers {
                        mcp_servers.insert(name.clone(), server.clone());
                    }
                }
            } else {
                settings.insert(key.clone(), value.clone());
            }
        }
    }
    (settings, mcp_servers)
}

#[derive(Debug, Default)]
struct BuildState {
    candidates: Vec<Value>,
    excluded: Vec<Value>,
    warnings: Vec<String>,
    source_hashes: Vec<Value>,
    source_count: usize,
    redacted_value_count: usize,
    denied_path_count: usize,
    blocked_secret_count: usize,
    unsupported_item_count: usize,
    executable_item_count: usize,
    bundles: Vec<ProfileBundleBlob>,
}

pub fn extract_profile_candidates(
    entries: &[RawEntry],
    reader: &dyn UpperReader,
    harness: HarnessTranscriptKind,
    harness_home: &Path,
) -> ProfileCandidateReport {
    let mut state = BuildState::default();
    for entry in entries {
        if entry.file_type != RawFileType::Regular {
            continue;
        }
        let source_kind = match harness {
            HarnessTranscriptKind::Codex => codex_source_kind(&entry.rel_path, harness_home),
            HarnessTranscriptKind::Claude => claude_source_kind(&entry.rel_path, harness_home),
        };
        let Some(source_kind) = source_kind else {
            maybe_record_functional_bundle(&mut state, entry, reader, harness_home);
            maybe_record_denied_candidate_path(&mut state, &entry.rel_path);
            continue;
        };
        if let Some(reason) = denied_source_path_reason(&entry.rel_path) {
            record_excluded_path(&mut state, &entry.rel_path, reason);
            continue;
        }
        if metadata_string_unsafe(&path_string(&entry.rel_path)) {
            record_excluded_path(&mut state, &entry.rel_path, "secret_metadata_path");
            continue;
        }
        let Some(bytes) = reader.read(&entry.rel_path) else {
            state.warnings.push(format!(
                "unreadable profile candidate source {}",
                entry.rel_path.display()
            ));
            continue;
        };
        state.source_count += 1;
        let hash = sha256_hex(&bytes);
        state.source_hashes.push(json!({
            "path": path_string(&entry.rel_path),
            "hash": hash,
        }));
        match harness {
            HarnessTranscriptKind::Codex => {
                extract_codex_source(&mut state, &entry.rel_path, source_kind, &bytes)
            }
            HarnessTranscriptKind::Claude => {
                extract_claude_source(&mut state, &entry.rel_path, source_kind, &bytes)
            }
        }
    }

    let provider = match harness {
        HarnessTranscriptKind::Claude => "claude-code",
        HarnessTranscriptKind::Codex => "codex",
    }
    .to_string();
    let candidate_count = state.candidates.len();
    let excluded_count = state.excluded.len();
    ProfileCandidateReport {
        provider,
        adapter_version: ADAPTER_VERSION.to_string(),
        candidates: state.candidates,
        excluded: state.excluded,
        warnings: state.warnings,
        bundles: state.bundles,
        manifest: json!({
            "adapter_version": ADAPTER_VERSION,
            "source_count": state.source_count,
            "candidate_count": candidate_count,
            "excluded_count": excluded_count,
            "source_file_hashes": state.source_hashes,
        }),
        risk_summary: json!({
            "credential_paths_denied_before_upload": true,
            "raw_secret_values_denied_before_upload": true,
            "denied_path_count": state.denied_path_count,
            "redacted_value_count": state.redacted_value_count,
            "blocked_secret_count": state.blocked_secret_count,
            "unsupported_item_count": state.unsupported_item_count,
            "executable_item_count": state.executable_item_count,
            "posted_raw_source_bytes": false,
        }),
    }
}

fn extract_codex_source(
    state: &mut BuildState,
    source_path: &Path,
    source_kind: &'static str,
    bytes: &[u8],
) {
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => {
            state.warnings.push(format!(
                "invalid utf-8 in codex source {}: {error}",
                source_path.display()
            ));
            return;
        }
    };
    let parsed = match text.parse::<toml::Value>() {
        Ok(value) => value,
        Err(error) => {
            state.warnings.push(format!(
                "invalid toml in codex source {}: {error}",
                source_path.display()
            ));
            return;
        }
    };
    let value = serde_json::to_value(parsed).unwrap_or(Value::Null);
    let config = sanitize_codex_config(state, source_path, &value);
    if !config.as_object().is_some_and(|object| object.is_empty()) {
        state.candidates.push(json!({
            "source_path": path_string(source_path),
            "source_kind": source_kind,
            "format": "toml",
            "config": config,
        }));
    }
}

fn extract_claude_source(
    state: &mut BuildState,
    source_path: &Path,
    source_kind: &'static str,
    bytes: &[u8],
) {
    let value = match serde_json::from_slice::<Value>(bytes) {
        Ok(value) => value,
        Err(error) => {
            state.warnings.push(format!(
                "invalid json in claude source {}: {error}",
                source_path.display()
            ));
            return;
        }
    };
    let config = sanitize_claude_config(state, source_path, source_kind, &value);
    if !config.as_object().is_some_and(|object| object.is_empty()) {
        state.candidates.push(json!({
            "source_path": path_string(source_path),
            "source_kind": source_kind,
            "format": "json",
            "config": config,
        }));
    }
}

fn sanitize_codex_config(state: &mut BuildState, source_path: &Path, value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        state.warnings.push(format!(
            "codex source {} is not a table",
            source_path.display()
        ));
        return json!({});
    };
    let mut out = Map::new();
    for (key, value) in object {
        match key.as_str() {
            "features" | "tools" => {
                if let Some(value) =
                    sanitize_safe_map(state, source_path, &[key.as_str()], value, true)
                {
                    out.insert(key.clone(), value);
                }
            }
            "model_providers" => {
                if let Some(value) = sanitize_named_servers(
                    state,
                    source_path,
                    &[key.as_str()],
                    value,
                    ServerShape::ModelProvider,
                ) {
                    out.insert(key.clone(), value);
                }
            }
            "mcp_servers" | "mcpServers" => {
                if let Some(value) = sanitize_named_servers(
                    state,
                    source_path,
                    &[key.as_str()],
                    value,
                    ServerShape::McpServer,
                ) {
                    out.insert("mcp_servers".to_string(), value);
                }
            }
            key if is_allowed_codex_preference(key) => {
                if let Some(value) =
                    sanitize_leaf_value(state, source_path, &[key], value, LeafMode::SafeScalar)
                {
                    out.insert(key.to_string(), value);
                }
            }
            key if key_is_literal_secret_field(key) => {
                record_excluded_value(state, source_path, &[key], "literal_secret_field");
            }
            _ => {}
        }
    }
    Value::Object(out)
}

fn sanitize_claude_config(
    state: &mut BuildState,
    source_path: &Path,
    source_kind: &str,
    value: &Value,
) -> Value {
    let Some(object) = value.as_object() else {
        state.warnings.push(format!(
            "claude source {} is not an object",
            source_path.display()
        ));
        return json!({});
    };
    let mut out = Map::new();
    for (key, value) in object {
        if source_kind == "user_config" && key == "projects" {
            record_excluded_value(state, source_path, &[key], "project_state");
            continue;
        }
        if source_kind == "user_config" && is_claude_machine_user_cache_field(key) {
            record_excluded_value(state, source_path, &[key], "machine_user_cache_field");
            continue;
        }
        match key.as_str() {
            "hooks" | "statusLine" => {
                record_excluded_value(state, source_path, &[key], "executable_setting");
                state
                    .warnings
                    .push(format!("excluded executable Claude setting {key}"));
                continue;
            }
            "mcpServers" | "mcp_servers" => {
                if let Some(value) = sanitize_named_servers(
                    state,
                    source_path,
                    &[key.as_str()],
                    value,
                    ServerShape::McpServer,
                ) {
                    out.insert("mcpServers".to_string(), value);
                }
            }
            key if is_allowed_claude_setting(key) => {
                if let Some(value) = sanitize_safe_map(state, source_path, &[key], value, false)
                    .or_else(|| {
                        sanitize_leaf_value(state, source_path, &[key], value, LeafMode::SafeScalar)
                    })
                {
                    out.insert(key.to_string(), value);
                }
            }
            _ => {}
        }
    }
    Value::Object(out)
}

#[derive(Clone, Copy)]
enum ServerShape {
    ModelProvider,
    McpServer,
}

fn sanitize_named_servers(
    state: &mut BuildState,
    source_path: &Path,
    key_path: &[&str],
    value: &Value,
    shape: ServerShape,
) -> Option<Value> {
    let object = value.as_object()?;
    let mut out = Map::new();
    for (name, server) in object {
        if metadata_string_unsafe(name) {
            record_excluded_value(
                state,
                source_path,
                &[key_path[0], name],
                "secret_metadata_key",
            );
            continue;
        }
        let Some(server_object) = server.as_object() else {
            record_excluded_value(state, source_path, &[key_path[0], name], "not_an_object");
            continue;
        };
        let mut sanitized = Map::new();
        for (key, value) in server_object {
            let field_path = [key_path[0], name.as_str(), key.as_str()];
            if key == "env" {
                if let Some(names) = sanitized_env_names(state, source_path, &field_path, value) {
                    sanitized.insert("env_names".to_string(), names);
                }
                continue;
            }
            if key == "headers" || key == "http_headers" || key == "customHeaders" {
                if let Some(names) = sanitized_header_names(state, source_path, &field_path, value)
                {
                    sanitized.insert("header_names".to_string(), names);
                }
                continue;
            }
            if key == "args" {
                record_excluded_value(state, source_path, &field_path, "unsupported_arg_vector");
                continue;
            }
            if key_allows_env_var_name(key) {
                if let Some(value) = sanitize_leaf_value(
                    state,
                    source_path,
                    &field_path,
                    value,
                    LeafMode::EnvVarName,
                ) {
                    sanitized.insert(key.clone(), value);
                }
                continue;
            }
            if metadata_key_unsafe(key) {
                record_excluded_value(state, source_path, &field_path, "secret_metadata_key");
                continue;
            }
            if !server_field_allowed(shape, key) {
                if key_is_literal_secret_field(key) {
                    record_excluded_value(state, source_path, &field_path, "literal_secret_field");
                }
                continue;
            }
            if let Some(value) = sanitize_safe_map(state, source_path, &field_path, value, false)
                .or_else(|| {
                    sanitize_leaf_value(
                        state,
                        source_path,
                        &field_path,
                        value,
                        LeafMode::SafeScalar,
                    )
                })
            {
                sanitized.insert(key.clone(), value);
            }
        }
        if !sanitized.is_empty() {
            out.insert(name.clone(), Value::Object(sanitized));
        }
    }
    Some(Value::Object(out))
        .filter(|value| value.as_object().is_some_and(|object| !object.is_empty()))
}

fn sanitize_safe_map(
    state: &mut BuildState,
    source_path: &Path,
    key_path: &[&str],
    value: &Value,
    bool_only: bool,
) -> Option<Value> {
    match value {
        Value::Object(object) => {
            let mut out = Map::new();
            for (key, value) in object {
                let mut nested_path = key_path.to_vec();
                nested_path.push(key);
                if metadata_key_unsafe(key) {
                    record_excluded_value(state, source_path, &nested_path, "secret_metadata_key");
                    continue;
                }
                if key == "env" {
                    if let Some(names) =
                        sanitized_env_names(state, source_path, &nested_path, value)
                    {
                        out.insert("env_names".to_string(), names);
                    }
                    continue;
                }
                if key == "headers" || key == "http_headers" || key == "customHeaders" {
                    if let Some(names) =
                        sanitized_header_names(state, source_path, &nested_path, value)
                    {
                        out.insert("header_names".to_string(), names);
                    }
                    continue;
                }
                let mode = if key_allows_env_var_name(key) {
                    LeafMode::EnvVarName
                } else {
                    LeafMode::SafeScalar
                };
                let sanitized =
                    sanitize_safe_map(state, source_path, &nested_path, value, bool_only).or_else(
                        || sanitize_leaf_value(state, source_path, &nested_path, value, mode),
                    );
                if let Some(value) = sanitized {
                    if bool_only && !value.is_boolean() {
                        record_excluded_value(
                            state,
                            source_path,
                            &nested_path,
                            "non_boolean_feature",
                        );
                        continue;
                    }
                    out.insert(key.clone(), value);
                }
            }
            Some(Value::Object(out))
                .filter(|value| value.as_object().is_some_and(|object| !object.is_empty()))
        }
        Value::Array(values) if !bool_only => {
            let mut out = Vec::new();
            for (index, item) in values.iter().enumerate() {
                let index_string = index.to_string();
                let mut nested_path = key_path.to_vec();
                nested_path.push(index_string.as_str());
                if let Some(value) =
                    sanitize_safe_map(state, source_path, &nested_path, item, false).or_else(|| {
                        sanitize_leaf_value(
                            state,
                            source_path,
                            &nested_path,
                            item,
                            LeafMode::SafeScalar,
                        )
                    })
                {
                    out.push(value);
                }
            }
            (!out.is_empty()).then_some(Value::Array(out))
        }
        _ => None,
    }
}

#[derive(Clone, Copy)]
enum LeafMode {
    SafeScalar,
    EnvVarName,
}

fn sanitize_leaf_value(
    state: &mut BuildState,
    source_path: &Path,
    key_path: &[&str],
    value: &Value,
    mode: LeafMode,
) -> Option<Value> {
    match value {
        Value::String(value) => {
            if matches!(mode, LeafMode::EnvVarName) {
                if looks_like_env_var_name(value) {
                    return Some(Value::String(value.clone()));
                }
                record_excluded_value(state, source_path, key_path, "not_an_env_var_name");
                return None;
            }
            if key_path.iter().any(|key| key_is_literal_secret_field(key)) {
                record_excluded_value(state, source_path, key_path, "literal_secret_field");
                return None;
            }
            if string_looks_secret(value) {
                record_excluded_value(state, source_path, key_path, "literal_secret_value");
                return None;
            }
            if string_looks_credential_path(value) {
                record_excluded_value(state, source_path, key_path, "credential_shaped_path_value");
                return None;
            }
            Some(Value::String(value.clone()))
        }
        Value::Bool(_) | Value::Number(_) | Value::Null => {
            if key_path.iter().any(|key| key_is_literal_secret_field(key)) {
                record_excluded_value(state, source_path, key_path, "literal_secret_field");
                None
            } else {
                Some(value.clone())
            }
        }
        _ => None,
    }
}

fn sanitized_env_names(
    state: &mut BuildState,
    source_path: &Path,
    key_path: &[&str],
    value: &Value,
) -> Option<Value> {
    let object = value.as_object()?;
    let mut names = Vec::new();
    for (name, value) in object {
        let mut nested_path = key_path.to_vec();
        nested_path.push(name);
        if !looks_like_env_var_name(name) || metadata_string_unsafe(name) {
            record_excluded_value(state, source_path, &nested_path, "invalid_env_name");
            continue;
        }
        names.push(Value::String(name.clone()));
        if value.as_str().is_some_and(looks_like_env_var_name) {
            continue;
        }
        record_excluded_value(state, source_path, &nested_path, "literal_env_value");
    }
    (!names.is_empty()).then_some(Value::Array(names))
}

fn sanitized_header_names(
    state: &mut BuildState,
    source_path: &Path,
    key_path: &[&str],
    value: &Value,
) -> Option<Value> {
    let object = value.as_object()?;
    let mut names = Vec::new();
    for (name, _value) in object {
        let mut nested_path = key_path.to_vec();
        nested_path.push(name);
        if !looks_like_header_name(name) || metadata_string_unsafe(name) {
            record_excluded_value(state, source_path, &nested_path, "invalid_header_name");
            continue;
        }
        names.push(Value::String(name.clone()));
        record_excluded_value(state, source_path, &nested_path, "literal_header_value");
    }
    (!names.is_empty()).then_some(Value::Array(names))
}

fn codex_source_kind(path: &Path, harness_home: &Path) -> Option<&'static str> {
    if path == harness_home.join("config.toml") {
        return Some("config");
    }
    if path.parent() == Some(harness_home)
        && path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().ends_with(".config.toml"))
    {
        return Some("profile_config");
    }
    if path
        .extension()
        .is_some_and(|extension| extension == "toml")
        && path.starts_with(harness_home)
        && path_has_profile_layer_component(path)
    {
        return Some("profile_layer");
    }
    None
}

fn claude_source_kind(path: &Path, harness_home: &Path) -> Option<&'static str> {
    if path == harness_home.join("settings.json") {
        return Some("settings");
    }
    if path == Path::new(".claude.json") || path == harness_home.join(".claude.json") {
        return Some("user_config");
    }
    None
}

fn path_has_profile_layer_component(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        matches!(
            name.as_str(),
            "profile"
                | "profiles"
                | "profile-layer"
                | "profile-layers"
                | "profile_layer"
                | "profile_layers"
                | "layers"
        )
    })
}

fn maybe_record_denied_candidate_path(state: &mut BuildState, path: &Path) {
    let lower = path_string(path).to_ascii_lowercase();
    let config_like = lower.ends_with(".json") || lower.ends_with(".toml");
    if config_like && let Some(reason) = denied_source_path_reason(path) {
        record_excluded_path(state, path, reason);
    }
}

fn denied_source_path_reason(path: &Path) -> Option<&'static str> {
    let normalized = path_string(path).replace('\\', "/").to_ascii_lowercase();
    if normalized.contains("/sessions/")
        || normalized.contains("/history/")
        || normalized.contains("/logs/")
        || normalized.contains("/log/")
        || normalized.contains("/cache/")
    {
        return Some("volatile_harness_state_path");
    }
    let components = normalized
        .split('/')
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>();
    if components.iter().any(|component| {
        *component == ".ssh"
            || *component == ".aws"
            || *component == ".git"
            || component.contains("credential")
            || component.contains("secret")
    }) {
        return Some("credential_shaped_path");
    }
    let file_name = components.last().copied().unwrap_or_default();
    if matches!(
        file_name,
        "auth.json"
            | ".netrc"
            | ".git-credentials"
            | "id_rsa"
            | "id_dsa"
            | "id_ecdsa"
            | "id_ed25519"
    ) || file_name.ends_with(".pem")
        || file_name.ends_with(".key")
    {
        return Some("credential_shaped_path");
    }
    None
}

fn maybe_record_functional_bundle(
    state: &mut BuildState,
    entry: &RawEntry,
    reader: &dyn UpperReader,
    harness_home: &Path,
) {
    let Some((role, executable)) = functional_bundle_role(&entry.rel_path, harness_home) else {
        return;
    };
    if entry.size > PROFILE_BUNDLE_MAX_BYTES {
        record_excluded_path(state, &entry.rel_path, "profile_bundle_too_large");
        return;
    }
    if let Some(reason) = denied_source_path_reason(&entry.rel_path) {
        record_excluded_path(state, &entry.rel_path, reason);
        return;
    }
    if metadata_string_unsafe(&path_string(&entry.rel_path)) {
        record_excluded_path(state, &entry.rel_path, "secret_metadata_path");
        return;
    }
    let Some(bytes) = reader.read(&entry.rel_path) else {
        state.warnings.push(format!(
            "unreadable profile bundle source {}",
            entry.rel_path.display()
        ));
        return;
    };
    if bytes.len() as u64 > PROFILE_BUNDLE_MAX_BYTES {
        record_excluded_path(state, &entry.rel_path, "profile_bundle_too_large");
        return;
    }
    let sample_len = bytes.len().min(secret::SECRET_SCAN_BYTES);
    if secret::is_secret(&entry.rel_path, &bytes[..sample_len]) {
        record_excluded_path(state, &entry.rel_path, "literal_secret_value");
        return;
    }
    let sha256 = sha256_hex(&bytes);
    state.bundles.push(ProfileBundleBlob {
        path: path_string(&entry.rel_path),
        sha256,
        role: role.to_string(),
        executable,
        bytes,
    });
}

fn functional_bundle_role(path: &Path, harness_home: &Path) -> Option<(&'static str, bool)> {
    let rel = path.strip_prefix(harness_home).ok()?;
    let components = rel
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => {
                Some(value.to_string_lossy().to_ascii_lowercase())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    let first = components.first()?.as_str();
    let file_name = components.last().map(String::as_str).unwrap_or_default();
    match first {
        "skills" | ".agents" if file_name == "skill.md" || file_name.ends_with(".md") => {
            Some(("skill", false))
        }
        "plugins" => Some(("plugin", false)),
        "commands" => Some(("command", true)),
        "agents" => Some(("agent", false)),
        _ if file_name.eq_ignore_ascii_case("agents.md") => Some(("agent_prompt", false)),
        _ => None,
    }
}

fn is_allowed_codex_preference(key: &str) -> bool {
    matches!(
        key,
        "model"
            | "model_provider"
            | "model_reasoning_effort"
            | "model_reasoning_summary"
            | "model_verbosity"
            | "service_tier"
            | "personality"
            | "approval_policy"
            | "sandbox_mode"
            | "sandbox_workspace_write"
            | "hide_agent_reasoning"
            | "show_raw_agent_reasoning"
            | "disable_response_storage"
            | "suppress_unstable_features_warning"
            | "preferred_auth_method"
    )
}

fn is_allowed_claude_setting(key: &str) -> bool {
    matches!(
        key,
        "model"
            | "permissions"
            | "includeCoAuthoredBy"
            | "cleanupPeriodDays"
            | "viewMode"
            | "theme"
            | "editorMode"
            | "forceLoginMethod"
    )
}

fn is_claude_machine_user_cache_field(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("machine") || lower.contains("userid") || lower.contains("cache")
}

fn server_field_allowed(shape: ServerShape, key: &str) -> bool {
    match shape {
        ServerShape::ModelProvider => matches!(
            key,
            "name"
                | "base_url"
                | "wire_api"
                | "env_key"
                | "env_var"
                | "bearer_token_env_var"
                | "requires_openai_auth"
                | "aws"
                | "region"
                | "endpoint"
        ),
        ServerShape::McpServer => matches!(
            key,
            "type"
                | "command"
                | "url"
                | "disabled"
                | "timeout"
                | "transport"
                | "env_var"
                | "env_key"
                | "bearer_token_env_var"
        ),
    }
}

fn key_allows_env_var_name(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.ends_with("_env_var")
        || lower.ends_with("_env")
        || lower.ends_with("_env_key")
        || lower == "env_key"
        || lower == "env_var"
}

fn key_is_literal_secret_field(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    !key_allows_env_var_name(key)
        && (lower.contains("api_key")
            || lower.contains("apikey")
            || lower.contains("token")
            || lower.contains("secret")
            || lower.contains("password")
            || lower.contains("credential")
            || lower == "authorization"
            || lower == "x-api-key")
}

fn looks_like_env_var_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_uppercase())
        && chars.all(|c| c == '_' || c.is_ascii_uppercase() || c.is_ascii_digit())
        && value.len() <= 128
}

fn looks_like_header_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    '!' | '#'
                        | '$'
                        | '%'
                        | '&'
                        | '\''
                        | '*'
                        | '+'
                        | '-'
                        | '.'
                        | '^'
                        | '_'
                        | '`'
                        | '|'
                        | '~'
                )
        })
}

fn metadata_key_unsafe(value: &str) -> bool {
    metadata_string_unsafe(value) || key_is_literal_secret_field(value)
}

fn metadata_string_unsafe(value: &str) -> bool {
    string_looks_secret(value)
}

fn string_looks_secret(value: &str) -> bool {
    secret::is_secret(Path::new("profile-value.txt"), value.as_bytes())
        || value.contains("-----BEGIN ")
        || value.to_ascii_lowercase().contains("bearer ")
}

fn string_looks_credential_path(value: &str) -> bool {
    value.contains('/')
        && denied_source_path_reason(Path::new(value.trim_start_matches('/'))).is_some()
}

fn record_excluded_path(state: &mut BuildState, path: &Path, reason: &str) {
    state.denied_path_count += 1;
    bump_exclusion_counts(state, reason);
    let source_path = path_string(path);
    state.excluded.push(json!({
        "source_path": if metadata_string_unsafe(&source_path) { "[redacted-path]".to_string() } else { source_path },
        "reason": reason,
    }));
}

fn record_excluded_value(
    state: &mut BuildState,
    source_path: &Path,
    key_path: &[&str],
    reason: &str,
) {
    state.redacted_value_count += 1;
    bump_exclusion_counts(state, reason);
    let source_path = path_string(source_path);
    state.excluded.push(json!({
        "source_path": if metadata_string_unsafe(&source_path) { "[redacted-path]".to_string() } else { source_path },
        "key_path": sanitized_key_path(key_path),
        "reason": reason,
    }));
}

fn sanitized_key_path(key_path: &[&str]) -> String {
    key_path
        .iter()
        .map(|key| {
            if metadata_string_unsafe(key) {
                "[redacted-key]"
            } else {
                *key
            }
        })
        .collect::<Vec<_>>()
        .join(".")
}

fn bump_exclusion_counts(state: &mut BuildState, reason: &str) {
    if matches!(
        reason,
        "literal_secret_field"
            | "literal_secret_value"
            | "credential_shaped_path_value"
            | "credential_shaped_path"
            | "literal_env_value"
            | "literal_header_value"
            | "invalid_env_name"
            | "invalid_header_name"
            | "secret_metadata_key"
            | "secret_metadata_path"
    ) {
        state.blocked_secret_count += 1;
    } else if reason == "executable_setting" {
        state.executable_item_count += 1;
    } else {
        state.unsupported_item_count += 1;
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    struct MapReader(HashMap<PathBuf, Vec<u8>>);
    impl UpperReader for MapReader {
        fn read(&self, path: &Path) -> Option<Vec<u8>> {
            self.0.get(path).cloned()
        }
    }

    fn reg(path: &str) -> RawEntry {
        RawEntry {
            rel_path: PathBuf::from(path),
            file_type: RawFileType::Regular,
            rdev: 0,
            size: 1,
            xattrs: vec![],
        }
    }

    #[test]
    fn codex_extracts_safe_config_and_redacts_literals() {
        let path = PathBuf::from(".codex/config.toml");
        let mut files = HashMap::new();
        files.insert(
            path.clone(),
            br#"
model = "gpt-5"
approval_policy = "never"
api_key = "sk-live-secretsecretsecretsecret"

[features]
fast_mode = true
label = "not allowed"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
api_key = "sk-live-secretsecretsecretsecret"

[mcp_servers.search]
command = "search"
args = ["--mode", "fast"]
env = { SEARCH_TOKEN = "sk-live-secretsecretsecretsecret" }
headers = { Authorization = "Bearer secret" }
"#
            .to_vec(),
        );
        let reader = MapReader(files);
        let report = extract_profile_candidates(
            &[reg(".codex/config.toml")],
            &reader,
            HarnessTranscriptKind::Codex,
            Path::new(".codex"),
        );
        let payload = report.into_payload();
        let serialized = serde_json::to_string(&payload).unwrap();

        assert!(serialized.contains("\"model\":\"gpt-5\""));
        assert!(serialized.contains("OPENROUTER_API_KEY"));
        assert!(serialized.contains("env_names"));
        assert!(serialized.contains("header_names"));
        assert!(!serialized.contains("sk-live-secret"));
        assert!(!serialized.contains("Bearer secret"));
        assert!(serialized.contains("literal_secret_field"));
        assert!(serialized.contains("literal_env_value"));
        assert!(serialized.contains("literal_header_value"));
    }

    #[test]
    fn codex_includes_profile_layer_toml_candidates() {
        let mut files = HashMap::new();
        files.insert(
            PathBuf::from(".codex/profile-layers/team/config.toml"),
            b"model = \"gpt-5\"\n[features]\nfast_mode = true\n".to_vec(),
        );
        let reader = MapReader(files);
        let report = extract_profile_candidates(
            &[reg(".codex/profile-layers/team/config.toml")],
            &reader,
            HarnessTranscriptKind::Codex,
            Path::new(".codex"),
        );

        assert_eq!(report.candidates.len(), 1);
        assert_eq!(
            report.candidates[0]["source_kind"],
            Value::String("profile_layer".to_string())
        );
    }

    #[test]
    fn codex_includes_root_profile_config_candidates() {
        let mut files = HashMap::new();
        files.insert(
            PathBuf::from(".codex/team.config.toml"),
            b"model = \"gpt-5\"\n[features]\nfast_mode = true\n".to_vec(),
        );
        let reader = MapReader(files);
        let report = extract_profile_candidates(
            &[reg(".codex/team.config.toml")],
            &reader,
            HarnessTranscriptKind::Codex,
            Path::new(".codex"),
        );

        assert_eq!(report.candidates.len(), 1);
        assert_eq!(
            report.candidates[0]["source_kind"],
            Value::String("profile_config".to_string())
        );
    }

    #[test]
    fn codex_redacts_secret_metadata_and_drops_mcp_args() {
        let secret = "sk-live-secretsecretsecretsecret";
        let mut files = HashMap::new();
        files.insert(
            PathBuf::from(".codex/config.toml"),
            format!(
                r#"
model = "gpt-5"

[mcp_servers."{secret}"]
command = "bad"

[mcp_servers.safe]
command = "mcp-safe"
args = ["--token", "abc123"]
env = {{ SAFE_TOKEN = "{secret}", "{secret}" = "SAFE_TOKEN" }}
headers = {{ Authorization = "Bearer {secret}", "X-{secret}" = "value" }}
"#
            )
            .into_bytes(),
        );
        let reader = MapReader(files);
        let report = extract_profile_candidates(
            &[reg(".codex/config.toml")],
            &reader,
            HarnessTranscriptKind::Codex,
            Path::new(".codex"),
        );
        let payload = report.into_payload();
        let serialized = serde_json::to_string(&payload).unwrap();

        assert!(serialized.contains("SAFE_TOKEN"));
        assert!(serialized.contains("unsupported_arg_vector"));
        assert!(serialized.contains("secret_metadata_key"));
        assert!(!serialized.contains(secret));
        assert!(!serialized.contains("--token"));
        assert!(!serialized.contains("abc123"));
    }

    #[test]
    fn denied_paths_are_excluded_before_reading() {
        let reader = MapReader(HashMap::new());
        let report = extract_profile_candidates(
            &[
                reg(".codex/auth.json"),
                reg(".codex/sessions/2026/rollout.json"),
                reg(".claude/.credentials.json"),
            ],
            &reader,
            HarnessTranscriptKind::Codex,
            Path::new(".codex"),
        );
        let payload = report.into_payload();
        let serialized = serde_json::to_string(&payload).unwrap();

        assert!(serialized.contains("credential_shaped_path"));
        assert!(serialized.contains("volatile_harness_state_path"));
        assert_eq!(payload["sourceHashes"].as_array().unwrap().len(), 0);
        assert_eq!(payload["diagnostics"]["manifest"]["source_count"], 0);
    }

    #[test]
    fn functional_bundles_include_sha_and_bytes_but_payload_only_has_manifest_refs() {
        let bytes = b"# Demo skill\nUse this skill.\n".to_vec();
        let mut files = HashMap::new();
        files.insert(PathBuf::from(".codex/skills/demo/SKILL.md"), bytes.clone());
        let reader = MapReader(files);

        let report = extract_profile_candidates(
            &[reg(".codex/skills/demo/SKILL.md")],
            &reader,
            HarnessTranscriptKind::Codex,
            Path::new(".codex"),
        );

        assert_eq!(report.bundles.len(), 1);
        assert_eq!(report.bundles[0].path, ".codex/skills/demo/SKILL.md");
        assert_eq!(report.bundles[0].sha256, sha256_hex(&bytes));
        assert_eq!(report.bundles[0].bytes, bytes);
        let payload = report.into_payload();
        assert_eq!(
            payload["manifest"]["bundles"][0]["sha256"],
            sha256_hex(b"# Demo skill\nUse this skill.\n")
        );
        let serialized = serde_json::to_string(&payload).unwrap();
        assert!(!serialized.contains("Use this skill."));
    }

    #[test]
    fn functional_bundle_skips_denied_secret_and_oversize_paths() {
        let mut files = HashMap::new();
        files.insert(
            PathBuf::from(".codex/skills/leaky/SKILL.md"),
            b"OPENAI_API_KEY=sk-secretsecretsecretsecretsecret".to_vec(),
        );
        files.insert(
            PathBuf::from(".codex/skills/too-big/SKILL.md"),
            vec![b'x'; PROFILE_BUNDLE_MAX_BYTES as usize + 1],
        );
        let reader = MapReader(files);

        let report = extract_profile_candidates(
            &[
                RawEntry {
                    rel_path: PathBuf::from(".codex/skills/leaky/SKILL.md"),
                    file_type: RawFileType::Regular,
                    rdev: 0,
                    size: 44,
                    xattrs: vec![],
                },
                RawEntry {
                    rel_path: PathBuf::from(".codex/skills/too-big/SKILL.md"),
                    file_type: RawFileType::Regular,
                    rdev: 0,
                    size: PROFILE_BUNDLE_MAX_BYTES + 1,
                    xattrs: vec![],
                },
                reg(".codex/skills/credentials/SKILL.md"),
            ],
            &reader,
            HarnessTranscriptKind::Codex,
            Path::new(".codex"),
        );

        assert!(report.bundles.is_empty());
        let payload = report.into_payload();
        let serialized = serde_json::to_string(&payload).unwrap();
        assert!(serialized.contains("literal_secret_value"));
        assert!(serialized.contains("profile_bundle_too_large"));
        assert!(serialized.contains("credential_shaped_path"));
        assert!(!serialized.contains("sk-secret"));
    }

    #[test]
    fn claude_extracts_settings_and_user_mcp_without_projects() {
        let mut files = HashMap::new();
        files.insert(
            PathBuf::from(".claude/settings.json"),
            br#"{
  "model": "claude-opus-4-8",
  "permissions": {
    "defaultMode": "bypassPermissions",
    "additionalDirectories": ["/home/agent/workspace", "/home/agent/.ssh"]
  },
  "includeCoAuthoredBy": false,
  "statusLine": { "type": "command", "command": "cat ~/.ssh/id_rsa" },
  "hooks": { "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "echo hi" }] }] }
}"#
            .to_vec(),
        );
        files.insert(
            PathBuf::from(".claude.json"),
            br#"{
  "numStartups": 4,
  "userID": "local-user",
  "projects": {"/home/agent/workspace": {"allowedTools": []}},
  "mcpServers": {
    "github": {
      "command": "mcp-github",
      "env": {"GITHUB_TOKEN": "ghp_secretsecretsecretsecretsecret"},
      "headers": {"Authorization": "Bearer secret"}
    }
  }
}"#
            .to_vec(),
        );
        let reader = MapReader(files);
        let report = extract_profile_candidates(
            &[reg(".claude/settings.json"), reg(".claude.json")],
            &reader,
            HarnessTranscriptKind::Claude,
            Path::new(".claude"),
        );
        let payload = report.into_payload();
        let serialized = serde_json::to_string(&payload).unwrap();

        assert!(serialized.contains("claude-opus-4-8"));
        assert!(serialized.contains("mcpServers"));
        assert!(serialized.contains("GITHUB_TOKEN"));
        assert!(!serialized.contains("ghp_secret"));
        assert!(!serialized.contains("Bearer secret"));
        assert!(!serialized.contains("local-user"));
        assert!(!serialized.contains("cat ~/.ssh/id_rsa"));
        assert!(!serialized.contains("echo hi"));
        assert!(!serialized.contains("allowedTools"));
        assert!(serialized.contains("project_state"));
        assert!(serialized.contains("machine_user_cache_field"));
        assert!(serialized.contains("credential_shaped_path_value"));
        assert!(serialized.contains("executable_setting"));
        assert_eq!(payload["riskSummary"]["executableItems"], 2);
        assert!(
            payload["riskSummary"]["labels"]
                .as_array()
                .unwrap()
                .contains(&Value::String("policy-capped".to_string()))
        );
    }
}
