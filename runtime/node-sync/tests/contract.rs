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
use centaur_node_sync::materializer::CONTEXT_READY_MARKER;
use centaur_node_sync::overlay_mount::{
    DEFAULT_REPO_CACHE_ROOT, OVERLAY_SIGNATURE_FILE, READY_MARKER_FILE,
};
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

/// Every flag used by an argv fixture must be declared in the contract's flag
/// list — keeps the fixtures and the flag inventory from drifting apart.
#[test]
fn argv_fixtures_only_use_declared_flags() {
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
        for argv in fixture.as_object().unwrap().values() {
            for token in argv.as_array().unwrap() {
                let token = token.as_str().unwrap();
                if token.starts_with("--") {
                    assert!(
                        declared.iter().any(|flag| flag == token),
                        "fixture flag {token} is not declared in contract.toml"
                    );
                }
            }
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
