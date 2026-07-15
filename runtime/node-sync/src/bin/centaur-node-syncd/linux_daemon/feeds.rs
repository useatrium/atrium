//! Remote feed polling and application for active and probe sessions.
//!
//! Keeps batch/legacy transport selection beside feed materialization.

use super::{apply_inbound_changes, write_profile_bundle_file};
use centaur_node_sync::batch::{
    BatchEndpointState, BatchFeeds, BatchHttpClient, BatchPollError, BatchRequestSession,
    BatchSessionOutcome,
};
use centaur_node_sync::daemon::config::GlobalConfig;
use centaur_node_sync::daemon::session::{
    PollTarget, ProbeSession, SessionConfig, scoped_atrium_root,
};
use centaur_node_sync::echo::EchoGuard;
use centaur_node_sync::eviction::SessionEvictionState;
use centaur_node_sync::feeds::{ArtifactFeed, AtriumFeed};
use centaur_node_sync::http_client::HttpAtriumClient;
use centaur_node_sync::materializer::{
    CONTEXT_READY_MARKER, materialize_changed_sessions, materialize_channel_docs,
};
use centaur_node_sync::quiesce::LeaseGate;
use centaur_node_sync::runtime::{HarnessTranscriptKind, materialize_profile_bundles_from_refs};
use centaur_node_sync::state::DaemonState;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Debug)]
pub(super) enum RemotePollOutcome {
    Found(RemoteFeeds),
    NotFound,
    Error,
}

#[derive(Debug)]
pub(super) struct RemoteFeeds {
    pub(super) profile_harness: HarnessTranscriptKind,
    pub(super) artifacts: Option<ArtifactFeed>,
    pub(super) atrium: Option<AtriumFeed>,
    pub(super) profile_bundles: Option<Vec<centaur_node_sync::runtime::BundleRef>>,
}

pub(super) fn apply_profile_feed(
    session: &SessionConfig,
    state: &mut DaemonState,
    client: &HttpAtriumClient,
    feeds: &RemoteFeeds,
) {
    let Some(bundles) = feeds.profile_bundles.clone() else {
        return;
    };
    let harness = feeds.profile_harness;
    let harness_home = if session.harness_home.is_empty() {
        PathBuf::from(harness.default_home_rel())
    } else {
        PathBuf::from(&session.harness_home)
    };
    let out = materialize_profile_bundles_from_refs(
        client,
        harness,
        &harness_home,
        &session.merged,
        &mut state.materialized_profile_bundles,
        bundles,
        write_profile_bundle_file,
    );
    if out.written > 0 {
        println!(
            "session {}: profile bundles: materialized {} files for {}",
            session.session,
            out.written,
            harness.atrium_harness()
        );
    }
    for (path, error) in &out.errors {
        eprintln!(
            "session {}: profile bundle materialize {path}: {error}",
            session.session
        );
    }
}

pub(super) fn apply_inbound_feed(
    session: &SessionConfig,
    state: &mut DaemonState,
    echo: &mut EchoGuard,
    lease: &LeaseGate,
    client: &mut HttpAtriumClient,
    feed: &ArtifactFeed,
) {
    if !feed.changes.is_empty() {
        apply_inbound_changes(session, state, echo, lease, client, &feed.changes);
    }
    state.cursor = feed.next_cursor.clone();
}

pub(super) fn apply_atrium_feed(
    global: &GlobalConfig,
    session: &SessionConfig,
    state: &mut DaemonState,
    client: &HttpAtriumClient,
    feed: &AtriumFeed,
    dirty_channel_ids: &[String],
    refresh_all_channels: bool,
) {
    let atrium_root = scoped_atrium_root(&global.atrium_root, &session.session);
    let refresh_all_channels =
        refresh_all_channels || !atrium_root.join(CONTEXT_READY_MARKER).is_file();
    if refresh_all_channels || !dirty_channel_ids.is_empty() {
        let only = if refresh_all_channels {
            None
        } else {
            Some(dirty_channel_ids)
        };
        if let Err(e) = materialize_channel_docs(client, &atrium_root, only, state) {
            eprintln!("atrium channel materializer: {e}");
        }
    }
    let cursor = state.atrium_cursor.clone();
    match materialize_changed_sessions(
        client,
        &atrium_root,
        &cursor,
        feed.session_ids.clone(),
        feed.next_cursor.clone(),
        state,
    ) {
        Ok(next) => {
            if next != state.atrium_cursor {
                println!("atrium materializer: cursor={next}");
            }
            state.atrium_cursor = next;
        }
        Err(e) => eprintln!("atrium materializer: {e}"),
    }
}

pub(super) fn poll_remote_targets(
    global: &GlobalConfig,
    batch_client: &BatchHttpClient,
    batch_endpoint: &mut BatchEndpointState,
    now: Instant,
    targets: &[PollTarget],
) -> HashMap<String, RemotePollOutcome> {
    if targets.is_empty() {
        return HashMap::new();
    }
    if batch_endpoint.should_try(now) {
        match poll_batch_targets(batch_client, targets) {
            Ok(outcomes) => {
                batch_endpoint.record_success();
                return outcomes;
            }
            Err(BatchPollError::Unsupported(_)) => {
                batch_endpoint.record_unsupported(now);
                eprintln!(
                    "node-sync batch changes endpoint unsupported; falling back to legacy GETs"
                );
            }
            Err(error) => {
                eprintln!("node-sync batch poll: {error}");
                return targets
                    .iter()
                    .map(|target| (target.atrium_session.clone(), RemotePollOutcome::Error))
                    .collect();
            }
        }
    }
    poll_legacy_targets(global, targets)
}

fn poll_batch_targets(
    batch_client: &BatchHttpClient,
    targets: &[PollTarget],
) -> Result<HashMap<String, RemotePollOutcome>, BatchPollError> {
    let requests = targets
        .iter()
        .map(|target| BatchRequestSession {
            key: target.atrium_session.clone(),
            artifacts_since: target.artifacts_since.clone(),
            atrium_since: target.atrium_since.clone(),
            profile_harness: target.profile_harness.atrium_harness().to_string(),
        })
        .collect::<Vec<_>>();
    let mut out = HashMap::new();
    for outcome in batch_client.poll(&requests)? {
        match outcome {
            BatchSessionOutcome::Found(feeds) => {
                out.insert(
                    feeds.key.clone(),
                    RemotePollOutcome::Found(batch_feeds(feeds)),
                );
            }
            BatchSessionOutcome::NotFound { key } => {
                out.insert(key, RemotePollOutcome::NotFound);
            }
        }
    }
    Ok(out)
}

fn batch_feeds(feeds: BatchFeeds) -> RemoteFeeds {
    RemoteFeeds {
        profile_harness: HarnessTranscriptKind::parse(&feeds.profile_harness)
            .unwrap_or(HarnessTranscriptKind::Codex),
        artifacts: Some(feeds.artifacts),
        atrium: Some(feeds.atrium),
        profile_bundles: Some(feeds.profile_bundles),
    }
}

fn poll_legacy_targets(
    global: &GlobalConfig,
    targets: &[PollTarget],
) -> HashMap<String, RemotePollOutcome> {
    let mut out = HashMap::new();
    for target in targets {
        out.insert(
            target.atrium_session.clone(),
            poll_legacy_target(global, target),
        );
    }
    out
}

fn poll_legacy_target(global: &GlobalConfig, target: &PollTarget) -> RemotePollOutcome {
    let mut client =
        HttpAtriumClient::new(&global.base_url, &global.api_key, &target.atrium_session);
    let mut not_found = 0usize;
    let mut successes = 0usize;

    let artifacts = match client.poll_changes_feed(&target.artifacts_since) {
        Ok(feed) => {
            successes += 1;
            Some(feed)
        }
        Err(error) if error.is_not_found() => {
            not_found += 1;
            None
        }
        Err(error) => {
            eprintln!("session {}: poll: {error}", target.session);
            None
        }
    };
    let atrium = match client.atrium_changes_feed(&target.atrium_since) {
        Ok(feed) => {
            successes += 1;
            Some(feed)
        }
        Err(error) if error.is_not_found() => {
            not_found += 1;
            None
        }
        Err(error) => {
            eprintln!("session {}: atrium changes: {error}", target.session);
            None
        }
    };
    let profile_bundles =
        match client.get_profile_bundles_feed(target.profile_harness.atrium_harness()) {
            Ok(feed) => {
                successes += 1;
                Some(feed)
            }
            Err(error) if error.is_not_found() => {
                not_found += 1;
                None
            }
            Err(error) => {
                eprintln!("session {}: profile bundles: {error}", target.session);
                None
            }
        };

    if not_found == 3 {
        RemotePollOutcome::NotFound
    } else if successes > 0 {
        RemotePollOutcome::Found(RemoteFeeds {
            profile_harness: target.profile_harness,
            artifacts,
            atrium,
            profile_bundles,
        })
    } else {
        RemotePollOutcome::Error
    }
}

pub(super) fn apply_probe_outcome(
    probe: &ProbeSession,
    outcome: Option<&RemotePollOutcome>,
    eviction: &mut SessionEvictionState,
) {
    match outcome {
        Some(RemotePollOutcome::Found(_)) => {
            if eviction.record_found() {
                eprintln!(
                    "event=node_sync_un_evict session={} reason=server_found",
                    probe.session
                );
            }
        }
        Some(RemotePollOutcome::NotFound) => {
            eviction.record_not_found();
        }
        Some(RemotePollOutcome::Error) | None => {}
    }
}
