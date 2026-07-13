//! warmcache-hydrate — init-container entry point for the warm-cache READ path.
//!
//! Runs as a sandbox **init container**, BEFORE the agent. k8s init-container
//! ordering is the barrier: the agent's main container (and its `pnpm install`)
//! cannot start until this exits, so the node depcache is warm by the time the
//! agent installs. For each repo in the session it reads the lockfiles at the
//! target ref from the node repo-cache (no checkout) and reflinks the matching
//! dependency stores from Atrium CAS into Phase-1's node depcache.
//!
//! Best-effort by design: a cache miss or any error is logged and skipped, and the
//! process still exits 0 — a failed hydrate must NOT block the agent. The agent's
//! install then runs normally over the network (cache-backed, never forced
//! `--offline`), so a cold/partial cache degrades to "slower", never "broken".
//!
//! Contract:
//! `warmcache-hydrate --session <id> --repos-json <json>
//!   [--repo-cache-root /var/lib/centaur/repos] [--depcache-root /var/lib/centaur/depcache]
//!   [--cas-dir /var/lib/centaur/cas] [--atrium-url <url>] [--atrium-key <key>]
//!   [--toolchain-id <id>]`
//! (atrium-url / atrium-key fall back to ATRIUM_URL / ARTIFACT_CAPTURE_API_KEY,
//! then to the canonical ATRIUM_BASE_URL / ATRIUM_CAPTURE_API_KEY — see
//! src/seam.rs; toolchain-id falls back to WARMCACHE_TOOLCHAIN_ID.)

use centaur_node_sync::http_client::HttpAtriumClient;
use centaur_node_sync::seam;
use centaur_node_sync::session_manifest::RepoMount;
use centaur_node_sync::warmcache::{
    DEFAULT_KINDS, WarmcacheReceipt, WarmcacheReceiptEntry, hydrate_depcache,
    write_warmcache_receipt,
};
use std::path::PathBuf;

fn main() {
    // Never fail the pod: log and exit 0 so the agent always proceeds.
    if let Err(e) = run() {
        eprintln!("warmcache-hydrate: {e}");
    }
}

#[derive(Debug)]
struct Args {
    session: Option<String>,
    repos_json: Option<String>,
    repo_cache_root: PathBuf,
    depcache_root: PathBuf,
    cas_dir: PathBuf,
    atrium_url: Option<String>,
    atrium_key: Option<String>,
    toolchain_id: Option<String>,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            session: None,
            repos_json: None,
            repo_cache_root: PathBuf::from("/var/lib/centaur/repos"),
            depcache_root: PathBuf::from("/var/lib/centaur/depcache"),
            cas_dir: PathBuf::from("/var/lib/centaur/cas"),
            atrium_url: None,
            atrium_key: None,
            toolchain_id: None,
        }
    }
}

fn parse_args<I: IntoIterator<Item = String>>(argv: I) -> Result<Args, String> {
    let mut parsed = Args::default();
    let mut args = argv.into_iter();
    while let Some(a) = args.next() {
        let mut take = || args.next().ok_or_else(|| format!("{a} requires a value"));
        match a.as_str() {
            "--session" => parsed.session = Some(take()?),
            "--repos-json" => parsed.repos_json = Some(take()?),
            "--repo-cache-root" => parsed.repo_cache_root = PathBuf::from(take()?),
            "--depcache-root" => parsed.depcache_root = PathBuf::from(take()?),
            "--cas-dir" => parsed.cas_dir = PathBuf::from(take()?),
            "--atrium-url" => parsed.atrium_url = Some(take()?),
            "--atrium-key" => parsed.atrium_key = Some(take()?),
            "--toolchain-id" => parsed.toolchain_id = Some(take()?),
            other => return Err(format!("unknown arg {other}")),
        }
    }
    Ok(parsed)
}

/// Resolve the Atrium endpoint from flags-then-env. In production centaur
/// passes NO url/key flags and injects ATRIUM_URL / ARTIFACT_CAPTURE_API_KEY
/// into the init container (contract/fixtures/warmcache-hydrate-argv.json),
/// so the env path is the load-bearing one; the canonical spellings are
/// accepted as fallbacks (seam.rs). `lookup` is injected so tests cover
/// resolution without touching process env.
fn resolve_atrium_endpoint(
    atrium_url: Option<String>,
    atrium_key: Option<String>,
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<(String, String), String> {
    let url = atrium_url
        .filter(|value| !value.is_empty())
        .or_else(|| {
            seam::first_non_empty(&[seam::ENV_ATRIUM_URL, seam::ENV_ATRIUM_BASE_URL], &lookup)
        })
        .ok_or("--atrium-url / ATRIUM_URL / ATRIUM_BASE_URL is required")?;
    let key = atrium_key
        .filter(|value| !value.is_empty())
        .or_else(|| {
            seam::first_non_empty(
                &[
                    seam::ENV_ARTIFACT_CAPTURE_API_KEY,
                    seam::ENV_ATRIUM_CAPTURE_API_KEY,
                ],
                &lookup,
            )
        })
        .ok_or("--atrium-key / ARTIFACT_CAPTURE_API_KEY / ATRIUM_CAPTURE_API_KEY is required")?;
    Ok((url, key))
}

fn run() -> Result<(), String> {
    let parsed = parse_args(std::env::args().skip(1))?;
    let repos_json = parsed.repos_json;
    let repo_cache_root = parsed.repo_cache_root;
    let depcache_root = parsed.depcache_root;
    let cas_dir = parsed.cas_dir;

    let session = parsed.session.ok_or("--session is required")?;
    let (url, key) = resolve_atrium_endpoint(parsed.atrium_url, parsed.atrium_key, |name| {
        std::env::var(name).ok()
    })?;
    let toolchain_id = parsed
        .toolchain_id
        .or_else(|| std::env::var("WARMCACHE_TOOLCHAIN_ID").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let repos: Vec<RepoMount> = match repos_json {
        Some(j) if !j.trim().is_empty() => {
            serde_json::from_str(&j).map_err(|e| format!("bad --repos-json: {e}"))?
        }
        _ => return Ok(()), // no repos = nothing to hydrate
    };

    let mut client = HttpAtriumClient::new(url, key, session.clone());
    let mut receipt_entries = Vec::new();
    for repo in &repos {
        if repo.private {
            eprintln!(
                "event=warmcache_hydrate_skip session={} repo={} reason=private_repo",
                session, repo.repo
            );
            continue;
        }
        let git_ref = repo.r#ref.as_deref().unwrap_or("HEAD");
        let stats = hydrate_depcache(
            &mut client,
            &repo_cache_root,
            &repo.repo,
            git_ref,
            &depcache_root,
            &cas_dir,
            DEFAULT_KINDS,
            toolchain_id.as_deref(),
        );
        for k in &stats.kinds {
            let hit = k.entries > 0;
            let toolchain_log = toolchain_id
                .as_deref()
                .map(|id| format!(" toolchain_id={id}"))
                .unwrap_or_default();
            eprintln!(
                "event=warmcache_hydrate session={} repo={} kind={} hit={} lockfile_hash={}{} entries={} reflinked={} fetched={} errors={}{}",
                session,
                repo.repo,
                k.kind,
                hit,
                k.lockfile_hash,
                toolchain_log,
                k.entries,
                k.reflinked,
                k.fetched,
                k.errors,
                k.error
                    .as_deref()
                    .map(|e| format!(" error={e}"))
                    .unwrap_or_default(),
            );
            receipt_entries.push(WarmcacheReceiptEntry {
                repo: repo.repo.clone(),
                git_ref: git_ref.to_string(),
                kind: k.kind.clone(),
                dest_subdir: k.dest_subdir.clone(),
                lockfile_hash: k.lockfile_hash.clone(),
                hit,
                errors: k.errors,
            });
        }
    }
    if !receipt_entries.is_empty()
        && let Err(e) = write_warmcache_receipt(
            &depcache_root,
            &WarmcacheReceipt {
                session,
                entries: receipt_entries,
            },
        )
    {
        eprintln!("warmcache-hydrate: receipt write: {e}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../contract/fixtures/warmcache-hydrate-argv.json"
        ))
        .expect("argv fixture must be valid JSON")
    }

    fn argv(fixture: &serde_json::Value, key: &str) -> Vec<String> {
        fixture[key]
            .as_array()
            .unwrap_or_else(|| panic!("fixture key {key} must be an array"))
            .iter()
            .map(|v| v.as_str().expect("argv items are strings").to_string())
            .collect()
    }

    /// The exact argv centaur emits into the init container (pinned by the
    /// emitted-==-fixture test on the centaur side) must keep parsing, and the
    /// env vars centaur injects must resolve the endpoint — env is the
    /// load-bearing channel in production (centaur passes no url/key flags).
    #[test]
    fn parses_the_emitted_argv_and_resolves_via_fixture_env() {
        let fixture = fixture();
        let parsed = parse_args(argv(&fixture, "init_container")).expect("emitted argv must parse");
        assert_eq!(parsed.session.as_deref(), Some("sess-1"));
        assert_eq!(parsed.repo_cache_root, PathBuf::from("/cache"));
        assert_eq!(
            parsed.depcache_root,
            PathBuf::from("/var/cache/centaur/depcache")
        );
        assert_eq!(parsed.cas_dir, PathBuf::from("/var/lib/centaur/cas"));
        assert_eq!(parsed.toolchain_id.as_deref(), Some("tc-1"));
        assert_eq!(
            parsed.atrium_url, None,
            "centaur passes url via env, not flags"
        );
        assert_eq!(
            parsed.atrium_key, None,
            "centaur passes key via env, not flags"
        );

        let env = fixture["env"].as_object().expect("fixture env map").clone();
        let (url, key) = resolve_atrium_endpoint(parsed.atrium_url, parsed.atrium_key, |name| {
            env.get(name).and_then(|v| v.as_str()).map(str::to_string)
        })
        .expect("fixture env must resolve the endpoint");
        assert_eq!(url, "http://atrium-server.atrium.svc:8080");
        assert_eq!(key, "test-key");
    }

    /// Every declared flag (contract.toml cli.warmcache_hydrate) must keep
    /// parsing — covered by the parser_coverage fixture entry, which the
    /// contract suite asserts spans the full declared list.
    #[test]
    fn parses_the_full_declared_flag_set() {
        let fixture = fixture();
        let parsed =
            parse_args(argv(&fixture, "parser_coverage")).expect("declared argv must parse");
        assert_eq!(parsed.atrium_url.as_deref(), Some("http://atrium:8080"));
        assert_eq!(parsed.atrium_key.as_deref(), Some("flag-key"));
    }

    /// Canonical spellings are accepted when the historical ones are unset,
    /// and empty values fall through instead of being used verbatim.
    #[test]
    fn endpoint_resolution_accepts_canonical_spellings_and_skips_empties() {
        let lookup = |name: &str| match name {
            "ATRIUM_URL" => Some(String::new()),
            "ATRIUM_BASE_URL" => Some("http://canonical:8080".to_string()),
            "ATRIUM_CAPTURE_API_KEY" => Some("canonical-key".to_string()),
            _ => None,
        };
        let (url, key) =
            resolve_atrium_endpoint(None, None, lookup).expect("canonical env must resolve");
        assert_eq!(url, "http://canonical:8080");
        assert_eq!(key, "canonical-key");

        let err = resolve_atrium_endpoint(None, None, |_| None).unwrap_err();
        assert!(
            err.contains("ATRIUM_BASE_URL"),
            "error names every knob: {err}"
        );
    }
}
