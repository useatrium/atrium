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

#[derive(Debug, Default, PartialEq)]
struct Args {
    session: Option<String>,
    repos_json: Option<String>,
    repo_cache_root: Option<PathBuf>,
    depcache_root: Option<PathBuf>,
    cas_dir: Option<PathBuf>,
    atrium_url: Option<String>,
    atrium_key: Option<String>,
    toolchain_id: Option<String>,
}

fn parse_args<I: IntoIterator<Item = String>>(argv: I) -> Result<Args, String> {
    let mut parsed = Args::default();
    let mut args = argv.into_iter();
    while let Some(a) = args.next() {
        let mut take = || args.next().ok_or_else(|| format!("{a} requires a value"));
        match a.as_str() {
            "--session" => parsed.session = Some(take()?),
            "--repos-json" => parsed.repos_json = Some(take()?),
            "--repo-cache-root" => parsed.repo_cache_root = Some(PathBuf::from(take()?)),
            "--depcache-root" => parsed.depcache_root = Some(PathBuf::from(take()?)),
            "--cas-dir" => parsed.cas_dir = Some(PathBuf::from(take()?)),
            "--atrium-url" => parsed.atrium_url = Some(take()?),
            "--atrium-key" => parsed.atrium_key = Some(take()?),
            "--toolchain-id" => parsed.toolchain_id = Some(take()?),
            other => return Err(format!("unknown arg {other}")),
        }
    }
    Ok(parsed)
}

fn run() -> Result<(), String> {
    let parsed = parse_args(std::env::args().skip(1))?;
    let repos_json = parsed.repos_json;
    let repo_cache_root = parsed
        .repo_cache_root
        .unwrap_or_else(|| PathBuf::from("/var/lib/centaur/repos"));
    let depcache_root = parsed
        .depcache_root
        .unwrap_or_else(|| PathBuf::from("/var/lib/centaur/depcache"));
    let cas_dir = parsed
        .cas_dir
        .unwrap_or_else(|| PathBuf::from("/var/lib/centaur/cas"));

    let session = parsed.session.ok_or("--session is required")?;
    let env_nonempty = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let url = parsed
        .atrium_url
        .or_else(|| env_nonempty(seam::ENV_ATRIUM_URL))
        .or_else(|| env_nonempty(seam::ENV_ATRIUM_BASE_URL))
        .ok_or("--atrium-url / ATRIUM_URL / ATRIUM_BASE_URL is required")?;
    let key = parsed
        .atrium_key
        .or_else(|| env_nonempty(seam::ENV_ARTIFACT_CAPTURE_API_KEY))
        .or_else(|| env_nonempty(seam::ENV_ATRIUM_CAPTURE_API_KEY))
        .ok_or("--atrium-key / ARTIFACT_CAPTURE_API_KEY / ATRIUM_CAPTURE_API_KEY is required")?;
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

    /// The exact argv centaur-sandbox-agent-k8s emits into the init container
    /// (pinned in contract/fixtures/warmcache-hydrate-argv.json) must keep parsing.
    #[test]
    fn parses_the_contract_argv_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../contract/fixtures/warmcache-hydrate-argv.json"
        ))
        .expect("argv fixture must be valid JSON");
        let argv: Vec<String> = fixture["init_container"]
            .as_array()
            .expect("init_container must be an array")
            .iter()
            .map(|v| v.as_str().expect("argv items are strings").to_string())
            .collect();

        let parsed = parse_args(argv).expect("contract argv must parse");
        assert_eq!(parsed.session.as_deref(), Some("sess-1"));
        assert_eq!(parsed.repo_cache_root, Some(PathBuf::from("/cache")));
        assert_eq!(
            parsed.depcache_root,
            Some(PathBuf::from("/var/cache/centaur/depcache"))
        );
        assert_eq!(parsed.cas_dir, Some(PathBuf::from("/var/lib/centaur/cas")));
        assert_eq!(parsed.toolchain_id.as_deref(), Some("tc-1"));
    }
}
