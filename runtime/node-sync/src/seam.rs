//! The daemon's side of the sandbox/API seam, named in one place.
//!
//! Every constant here is part of the contract with the centaur sandbox
//! runtime and the Atrium server, pinned by `contract/contract.toml` and
//! asserted by `tests/contract.rs`. The binaries read env through these names
//! so the tested constants are the ones actually in use.
//!
//! Each reader prefers the spelling it has historically documented, and also
//! accepts the other components' spellings, so a mixed deployment (old chart,
//! new daemon, or the reverse) can't strand a component on a missing env var:
//! the daemon reads `ATRIUM_BASE_URL`/`ATRIUM_CAPTURE_API_KEY` first, while
//! the warmcache-hydrate init container reads `ATRIUM_URL`/
//! `ARTIFACT_CAPTURE_API_KEY` first (that's what centaur injects into it).
//! The canonical pair for NEW configuration is `ATRIUM_BASE_URL` +
//! `ATRIUM_CAPTURE_API_KEY`.

/// Canonical: the Atrium server base URL for the daemon.
pub const ENV_ATRIUM_BASE_URL: &str = "ATRIUM_BASE_URL";
/// Canonical: the internal-API key for the daemon.
pub const ENV_ATRIUM_CAPTURE_API_KEY: &str = "ATRIUM_CAPTURE_API_KEY";
/// Historical spelling emitted into the warmcache-hydrate init container.
pub const ENV_ATRIUM_URL: &str = "ATRIUM_URL";
/// Historical spelling; also what the Atrium server itself reads.
pub const ENV_ARTIFACT_CAPTURE_API_KEY: &str = "ARTIFACT_CAPTURE_API_KEY";

/// First non-empty value among `names`, resolved through `lookup` (injected so
/// callers can test resolution without touching process env).
pub fn first_non_empty(names: &[&str], lookup: impl Fn(&str) -> Option<String>) -> Option<String> {
    names
        .iter()
        .filter_map(|name| lookup(name))
        .find(|value| !value.is_empty())
}

/// First non-empty process-env value among `names`.
pub fn env_first(names: &[&str]) -> Option<String> {
    first_non_empty(names, |name| std::env::var(name).ok())
}
