//! Daemon-side enforcement of contract/contract.toml + contract/fixtures/.
//!
//! The contract directory is the single source of truth for the seam between
//! this daemon, the centaur sandbox runtime, and the Atrium server (see
//! CONTRACT.md). This suite fails if the daemon's constants or parsers drift
//! from it. The centaur side and the Atrium server run their own mirrors of
//! these assertions against the same files.

use centaur_node_sync::cas::WarmcacheManifestEntry;
use centaur_node_sync::eviction::HEARTBEAT_FILE;
use centaur_node_sync::feeds::{
    parse_artifact_changes, parse_atrium_changes, parse_profile_bundles,
};
use centaur_node_sync::http_client::{
    AUTH_HEADER, HEADER_EPOCH, HEADER_MODE, HEADER_NEXT_EVENT_ID, HEADER_NEXT_SEQ, QUERY_EPOCH,
    QUERY_SINCE_EVENT_ID, QUERY_SINCE_SEQ, SESSION_PREFIX,
};
use centaur_node_sync::materializer::CONTEXT_READY_MARKER;
use centaur_node_sync::overlay_mount::{
    DEFAULT_REPO_CACHE_ROOT, OVERLAY_SIGNATURE_FILE, READY_MARKER_FILE,
};
use centaur_node_sync::runtime::AtriumChannel;
use centaur_node_sync::seam;
use centaur_node_sync::session_manifest::SESSIONS_DIR_NAME;

const CONTRACT: &str = include_str!("../contract/contract.toml");

fn contract() -> toml::Value {
    toml::from_str(CONTRACT).expect("contract.toml must be valid TOML")
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

fn get_flags(value: &toml::Value, path: &str) -> Vec<String> {
    get(value, path)
        .as_array()
        .unwrap_or_else(|| panic!("contract.toml {path} must be an array"))
        .iter()
        .map(|v| v.as_str().expect("flags are strings").to_string())
        .collect()
}

#[test]
fn markers_match_the_contract() {
    let c = contract();
    assert_eq!(get_str(&c, "markers.workspace_ready"), READY_MARKER_FILE);
    assert_eq!(
        get_str(&c, "markers.overlay_signature"),
        OVERLAY_SIGNATURE_FILE
    );
    assert_eq!(get_str(&c, "markers.context_ready"), CONTEXT_READY_MARKER);
    assert_eq!(get_str(&c, "markers.heartbeat"), HEARTBEAT_FILE);
    assert_eq!(get_str(&c, "markers.sessions_dir"), SESSIONS_DIR_NAME);
}

#[test]
fn host_paths_match_the_contract() {
    let c = contract();
    assert_eq!(
        get_str(&c, "host_paths.repo_cache_mount"),
        DEFAULT_REPO_CACHE_ROOT
    );
}

#[test]
fn env_names_match_the_contract() {
    let c = contract();
    assert_eq!(
        get_str(&c, "env.daemon.base_url"),
        seam::ENV_ATRIUM_BASE_URL
    );
    assert_eq!(
        get_str(&c, "env.daemon.api_key"),
        seam::ENV_ATRIUM_CAPTURE_API_KEY
    );
    assert_eq!(
        get_str(&c, "env.daemon.base_url_fallback"),
        seam::ENV_ATRIUM_URL
    );
    assert_eq!(
        get_str(&c, "env.daemon.api_key_fallback"),
        seam::ENV_ARTIFACT_CAPTURE_API_KEY
    );
    // The hydrate init's canonical/fallback pair is the same four names crossed.
    assert_eq!(
        get_str(&c, "env.warmcache_hydrate.url"),
        seam::ENV_ATRIUM_URL
    );
    assert_eq!(
        get_str(&c, "env.warmcache_hydrate.key"),
        seam::ENV_ARTIFACT_CAPTURE_API_KEY
    );
    // The Atrium server reads the historical spelling; both sides list it.
    assert_eq!(
        get_str(&c, "env.server.api_key"),
        seam::ENV_ARTIFACT_CAPTURE_API_KEY
    );
}

/// The argv fixtures and the declared flag inventories must span each other
/// exactly: every fixture flag is declared (no undeclared emissions sneak in),
/// and every declared flag appears in some fixture entry (so the in-bin parse
/// tests give declared-⊆-accepted, closing the rename-and-forward hole).
#[test]
fn argv_fixtures_and_declared_flags_span_each_other() {
    let c = contract();
    let cases = [
        (
            include_str!("../contract/fixtures/provision-overlay-argv.json"),
            get_flags(&c, "cli.provision_overlay.flags"),
        ),
        (
            include_str!("../contract/fixtures/warmcache-hydrate-argv.json"),
            get_flags(&c, "cli.warmcache_hydrate.flags"),
        ),
    ];
    for (fixture, declared) in cases {
        let fixture: serde_json::Value = serde_json::from_str(fixture).unwrap();
        let mut used = std::collections::BTreeSet::new();
        for argv in fixture.as_object().unwrap().values() {
            // Fixture files also carry _comment strings and env maps.
            let Some(argv) = argv.as_array() else {
                continue;
            };
            for token in argv {
                let token = token.as_str().unwrap();
                if token.starts_with("--") {
                    assert!(
                        declared.iter().any(|flag| flag == token),
                        "fixture flag {token} is not declared in contract.toml"
                    );
                    used.insert(token.to_string());
                }
            }
        }
        for flag in &declared {
            assert!(
                used.contains(flag),
                "declared flag {flag} is exercised by no argv fixture entry — add it \
                 to a parser_coverage entry so the parser keeps accepting it"
            );
        }
    }
}

#[test]
fn artifact_changes_fixture_parses() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../contract/fixtures/artifacts-changes.json")).unwrap();
    let feed = parse_artifact_changes(&fixture, "0.0", "sess-1");
    assert_eq!(feed.next_cursor, "731.42");
    // activePrefix projection: the canonical path materializes both bare and
    // prefixed for the active channel.
    let paths: Vec<&str> = feed.changes.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(
        paths,
        vec!["report.md", "shared/channels/channel-1/report.md"]
    );
    let (_, change) = &feed.changes[0];
    assert_eq!(change.seq, 4);
    assert_eq!(
        change.sha.as_deref(),
        Some("aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11")
    );
}

#[test]
fn atrium_changes_fixture_parses() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../contract/fixtures/atrium-changes.json")).unwrap();
    let feed = parse_atrium_changes(&fixture, "0.0");
    assert_eq!(feed.session_ids, vec!["sess-2"]);
    assert_eq!(feed.next_cursor, "731.44");
}

#[test]
fn atrium_channels_fixture_parses_with_event_watermark() {
    let channels: Vec<AtriumChannel> =
        serde_json::from_str(include_str!("../contract/fixtures/atrium-channels.json")).unwrap();
    assert_eq!(channels.len(), 1);
    assert_eq!(channels[0].id, "chan-1");
    assert_eq!(channels[0].last_event_id, 8842);
}

#[test]
fn profile_bundles_fixture_parses() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../contract/fixtures/profile-bundles.json")).unwrap();
    let bundles = parse_profile_bundles(&fixture, "codex").expect("bundles fixture must parse");
    assert_eq!(bundles.len(), 1);
    assert_eq!(bundles[0].path, ".codex/skills/example/SKILL.md");
    assert_eq!(
        bundles[0].sha256,
        "dd44ee55dd44ee55dd44ee55dd44ee55dd44ee55dd44ee55dd44ee55dd44ee55"
    );
    assert_eq!(bundles[0].role, "skill");
    assert!(!bundles[0].executable);
}

#[test]
fn warmcache_hydration_fixture_parses() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../contract/fixtures/warmcache-hydration.json"
    ))
    .unwrap();
    let entries: Vec<WarmcacheManifestEntry> =
        serde_json::from_value(fixture["entries"].clone()).expect("entries must deserialize");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].sha256,
        "cc33dd44cc33dd44cc33dd44cc33dd44cc33dd44cc33dd44cc33dd44cc33dd44"
    );
    assert_eq!(entries[0].size_bytes, 1024);
}

#[test]
fn capture_response_fixture_has_seq() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../contract/fixtures/capture-response.json")).unwrap();
    // The daemon's capture/delete paths only rely on `seq` (http_client.rs).
    assert!(
        fixture["seq"].is_u64(),
        "capture response must carry a u64 seq"
    );
}

#[test]
fn env_fallback_names_match_the_contract() {
    let c = contract();
    assert_eq!(
        get_str(&c, "env.warmcache_hydrate.url_fallback"),
        seam::ENV_ATRIUM_BASE_URL
    );
    assert_eq!(
        get_str(&c, "env.warmcache_hydrate.key_fallback"),
        seam::ENV_ATRIUM_CAPTURE_API_KEY
    );
    assert_eq!(
        get_str(&c, "env.server.api_key_fallback"),
        seam::ENV_ATRIUM_CAPTURE_API_KEY
    );
}

#[test]
fn http_constants_match_the_contract() {
    let c = contract();
    assert_eq!(get_str(&c, "http.auth_header"), AUTH_HEADER);
    assert_eq!(get_str(&c, "http.session_prefix"), SESSION_PREFIX);
    assert_eq!(get_str(&c, "atrium_delta.query_since_seq"), QUERY_SINCE_SEQ);
    assert_eq!(
        get_str(&c, "atrium_delta.query_since_event_id"),
        QUERY_SINCE_EVENT_ID
    );
    assert_eq!(get_str(&c, "atrium_delta.query_epoch"), QUERY_EPOCH);
    assert_eq!(get_str(&c, "atrium_delta.header_epoch"), HEADER_EPOCH);
    assert_eq!(get_str(&c, "atrium_delta.header_mode"), HEADER_MODE);
    assert_eq!(get_str(&c, "atrium_delta.header_next_seq"), HEADER_NEXT_SEQ);
    assert_eq!(
        get_str(&c, "atrium_delta.header_next_event_id"),
        HEADER_NEXT_EVENT_ID
    );
}

/// The daemon binary path is consumed by the image ENTRYPOINT (this crate's
/// Dockerfile) and the chart's DaemonSet; pin the Dockerfile side.
#[test]
fn dockerfile_installs_the_contract_binaries() {
    let c = contract();
    let dockerfile = include_str!("../Dockerfile");
    for key in [
        "image.binaries.daemon",
        "image.binaries.provision_overlay",
        "image.binaries.warmcache_hydrate",
    ] {
        let path = get_str(&c, key);
        assert!(
            dockerfile.contains(path),
            "Dockerfile no longer installs {path} ({key})"
        );
    }
    assert!(
        dockerfile.contains(&format!(
            "ENTRYPOINT [\"{}\"]",
            get_str(&c, "image.binaries.daemon")
        )),
        "Dockerfile ENTRYPOINT must be the daemon binary"
    );
}

/// Two seam participants live where no test lane can hook them: the heartbeat
/// WRITER is a `touch` in centaur's sandbox entrypoint.sh (shell), and the
/// context-ready READER is harness-server (a separate cargo workspace). Pin
/// their literals by content so a marker rename can't leave them behind.
/// These are deliberate grep-tripwires — the exception, not the pattern.
#[test]
fn unhookable_seam_participants_use_the_contract_markers() {
    let c = contract();
    let read = |rel: &str| {
        let path = format!("{}/{rel}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
    };

    let entrypoint = read("../../centaur/services/sandbox/entrypoint.sh");
    assert!(
        entrypoint.contains(get_str(&c, "markers.heartbeat")),
        "entrypoint.sh no longer touches the contract heartbeat marker"
    );

    let harness_server = read("../../centaur/crates/harness-server/src/server.rs");
    assert!(
        harness_server.contains(get_str(&c, "markers.context_ready")),
        "harness-server no longer waits on the contract context-ready marker"
    );
}
