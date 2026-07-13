//! The daemon's side of the sandbox/API seam, named in one place.
//!
//! Every constant here is part of the contract with the centaur sandbox
//! runtime and the Atrium server, pinned by `contract/contract.toml` and
//! asserted by `tests/contract.rs`. The binaries read env through these names
//! so the tested constants are the ones actually in use.
//!
//! Canonical spelling first; each reader also accepts the other component's
//! historical spelling so a mixed deployment (old chart, new daemon, or the
//! reverse) can't strand a component on a missing env var.

/// Canonical: the Atrium server base URL for the daemon.
pub const ENV_ATRIUM_BASE_URL: &str = "ATRIUM_BASE_URL";
/// Canonical: the internal-API key for the daemon.
pub const ENV_ATRIUM_CAPTURE_API_KEY: &str = "ATRIUM_CAPTURE_API_KEY";
/// Historical spelling emitted into the warmcache-hydrate init container.
pub const ENV_ATRIUM_URL: &str = "ATRIUM_URL";
/// Historical spelling; also what the Atrium server itself reads.
pub const ENV_ARTIFACT_CAPTURE_API_KEY: &str = "ARTIFACT_CAPTURE_API_KEY";

/// First non-empty value among `names`, or empty string. Mirrors the daemon's
/// lenient `env()` convention (missing == empty).
pub fn env_first(names: &[&str]) -> String {
    names
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}
