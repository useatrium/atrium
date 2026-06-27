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
//!   [--cas-dir /var/lib/centaur/cas] [--atrium-url <url>] [--atrium-key <key>]`
//! (atrium-url / atrium-key fall back to ATRIUM_URL / ARTIFACT_CAPTURE_API_KEY.)

use centaur_node_sync::http_client::HttpAtriumClient;
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

fn run() -> Result<(), String> {
    let mut session: Option<String> = None;
    let mut repos_json: Option<String> = None;
    let mut repo_cache_root = PathBuf::from("/var/lib/centaur/repos");
    let mut depcache_root = PathBuf::from("/var/lib/centaur/depcache");
    let mut cas_dir = PathBuf::from("/var/lib/centaur/cas");
    let mut atrium_url: Option<String> = None;
    let mut atrium_key: Option<String> = None;

    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut take = || args.next().ok_or_else(|| format!("{a} requires a value"));
        match a.as_str() {
            "--session" => session = Some(take()?),
            "--repos-json" => repos_json = Some(take()?),
            "--repo-cache-root" => repo_cache_root = PathBuf::from(take()?),
            "--depcache-root" => depcache_root = PathBuf::from(take()?),
            "--cas-dir" => cas_dir = PathBuf::from(take()?),
            "--atrium-url" => atrium_url = Some(take()?),
            "--atrium-key" => atrium_key = Some(take()?),
            other => return Err(format!("unknown arg {other}")),
        }
    }

    let session = session.ok_or("--session is required")?;
    let url = atrium_url
        .or_else(|| std::env::var("ATRIUM_URL").ok())
        .ok_or("--atrium-url / ATRIUM_URL is required")?;
    let key = atrium_key
        .or_else(|| std::env::var("ARTIFACT_CAPTURE_API_KEY").ok())
        .ok_or("--atrium-key / ARTIFACT_CAPTURE_API_KEY is required")?;

    let repos: Vec<RepoMount> = match repos_json {
        Some(j) if !j.trim().is_empty() => {
            serde_json::from_str(&j).map_err(|e| format!("bad --repos-json: {e}"))?
        }
        _ => return Ok(()), // no repos = nothing to hydrate
    };

    let mut client = HttpAtriumClient::new(url, key, session.clone());
    let mut receipt_entries = Vec::new();
    for repo in &repos {
        let git_ref = repo.r#ref.as_deref().unwrap_or("HEAD");
        let stats = hydrate_depcache(
            &mut client,
            &repo_cache_root,
            &repo.repo,
            git_ref,
            &depcache_root,
            &cas_dir,
            DEFAULT_KINDS,
        );
        for k in &stats.kinds {
            let hit = k.entries > 0;
            eprintln!(
                "event=warmcache_hydrate session={} repo={} kind={} hit={} lockfile_hash={} entries={} reflinked={} fetched={} errors={}{}",
                session,
                repo.repo,
                k.kind,
                hit,
                k.lockfile_hash,
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
