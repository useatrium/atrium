use crate::feeds::{
    ArtifactFeed, AtriumFeed, parse_artifact_changes, parse_atrium_changes, parse_profile_bundles,
};
use crate::runtime::BundleRef;
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const MAX_BATCH_SESSIONS: usize = 200;
pub const BATCH_UNSUPPORTED_RETRY_SECS: u64 = 300;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct BatchRequestSession {
    pub key: String,
    #[serde(rename = "artifactsSince")]
    pub artifacts_since: String,
    #[serde(rename = "atriumSince")]
    pub atrium_since: String,
    #[serde(rename = "profileHarness")]
    pub profile_harness: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BatchSessionOutcome {
    Found(BatchFeeds),
    NotFound { key: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct BatchFeeds {
    pub key: String,
    pub profile_harness: String,
    pub artifacts: ArtifactFeed,
    pub atrium: AtriumFeed,
    pub profile_bundles: Vec<BundleRef>,
}

#[derive(Debug)]
pub enum BatchPollError {
    Unsupported(u16),
    Http(String),
    Parse(String),
}

impl std::fmt::Display for BatchPollError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported(status) => write!(f, "batch endpoint unsupported: status {status}"),
            Self::Http(error) | Self::Parse(error) => f.write_str(error),
        }
    }
}

impl std::error::Error for BatchPollError {}

#[derive(Debug, Default)]
pub struct BatchEndpointState {
    retry_after: Option<Instant>,
}

impl BatchEndpointState {
    pub fn should_try(&self, now: Instant) -> bool {
        self.retry_after
            .is_none_or(|retry_after| now >= retry_after)
    }

    pub fn record_success(&mut self) {
        self.retry_after = None;
    }

    pub fn record_unsupported(&mut self, now: Instant) {
        self.retry_after = Some(now + Duration::from_secs(BATCH_UNSUPPORTED_RETRY_SECS));
    }
}

pub struct BatchHttpClient {
    base_url: String,
    api_key: String,
    agent: ureq::Agent,
}

impl BatchHttpClient {
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            agent: ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(30))
                .build(),
        }
    }

    pub fn poll(
        &self,
        sessions: &[BatchRequestSession],
    ) -> Result<Vec<BatchSessionOutcome>, BatchPollError> {
        let mut out = Vec::new();
        for chunk in sessions.chunks(MAX_BATCH_SESSIONS) {
            out.extend(self.poll_chunk(chunk)?);
        }
        Ok(out)
    }

    fn poll_chunk(
        &self,
        sessions: &[BatchRequestSession],
    ) -> Result<Vec<BatchSessionOutcome>, BatchPollError> {
        let body = BatchRequest {
            sessions: sessions.to_vec(),
        };
        let response = self
            .agent
            .post(&format!(
                "{}/api/internal/sessions/changes/batch",
                self.base_url
            ))
            .set("x-api-key", &self.api_key)
            .set("content-type", "application/json")
            .send_json(
                serde_json::to_value(&body)
                    .map_err(|error| BatchPollError::Parse(error.to_string()))?,
            )
            .map_err(batch_http_error)?;
        let value: serde_json::Value = response
            .into_json()
            .map_err(|error| BatchPollError::Parse(error.to_string()))?;
        parse_batch_response(sessions, value)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
struct BatchRequest {
    sessions: Vec<BatchRequestSession>,
}

#[derive(Debug, serde::Deserialize)]
struct BatchResponse {
    #[serde(default)]
    sessions: Vec<BatchResponseSession>,
}

#[derive(Debug, serde::Deserialize)]
struct BatchResponseSession {
    key: String,
    found: bool,
    #[serde(default)]
    artifacts: Option<serde_json::Value>,
    #[serde(default)]
    atrium: Option<serde_json::Value>,
    #[serde(default, rename = "profileBundles")]
    profile_bundles: Option<serde_json::Value>,
}

pub fn parse_batch_response(
    requests: &[BatchRequestSession],
    value: serde_json::Value,
) -> Result<Vec<BatchSessionOutcome>, BatchPollError> {
    let response = serde_json::from_value::<BatchResponse>(value)
        .map_err(|error| BatchPollError::Parse(format!("parse batch response: {error}")))?;
    let request_by_key = requests
        .iter()
        .map(|request| (request.key.as_str(), request))
        .collect::<HashMap<_, _>>();
    let mut out = Vec::new();
    for session in response.sessions {
        let Some(request) = request_by_key.get(session.key.as_str()) else {
            return Err(BatchPollError::Parse(format!(
                "batch response included unexpected session key {}",
                session.key
            )));
        };
        if !session.found {
            out.push(BatchSessionOutcome::NotFound { key: session.key });
            continue;
        }
        let artifacts_value = session
            .artifacts
            .unwrap_or_else(|| serde_json::json!({ "rows": [] }));
        let atrium_value = session
            .atrium
            .unwrap_or_else(|| serde_json::json!({ "rows": [] }));
        let profile_value = session
            .profile_bundles
            .unwrap_or_else(|| serde_json::json!({ "bundles": [] }));
        let artifacts =
            parse_artifact_changes(&artifacts_value, &request.artifacts_since, &session.key);
        let atrium = parse_atrium_changes(&atrium_value, &request.atrium_since);
        let profile_bundles = parse_profile_bundles(&profile_value, &request.profile_harness)
            .map_err(BatchPollError::Parse)?;
        out.push(BatchSessionOutcome::Found(BatchFeeds {
            key: session.key,
            profile_harness: request.profile_harness.clone(),
            artifacts,
            atrium,
            profile_bundles,
        }));
    }
    Ok(out)
}

fn batch_http_error(error: ureq::Error) -> BatchPollError {
    match error {
        ureq::Error::Status(status, response) if status == 404 || status == 405 => {
            let _ = response.into_string();
            BatchPollError::Unsupported(status)
        }
        ureq::Error::Status(status, response) => {
            let body = response.into_string().unwrap_or_default();
            BatchPollError::Http(format!("batch poll status {status}: {body}"))
        }
        ureq::Error::Transport(error) => BatchPollError::Http(format!("batch poll: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(key: &str) -> BatchRequestSession {
        BatchRequestSession {
            key: key.to_string(),
            artifacts_since: "1.0".to_string(),
            atrium_since: "2.0".to_string(),
            profile_harness: "codex".to_string(),
        }
    }

    #[test]
    fn parse_batch_response_dispatches_found_and_not_found() {
        let parsed = parse_batch_response(
            &[request("s1"), request("s2")],
            serde_json::json!({
                "sessions": [
                    {
                        "key": "s1",
                        "found": true,
                        "artifacts": {
                            "next_cursor": "1.1",
                            "rows": [{"path": "a.txt", "seq": 4, "sha": "aa"}]
                        },
                        "atrium": {
                            "next_cursor": "2.1",
                            "rows": [{"sessionId": "thread-1"}]
                        },
                        "profileBundles": {
                            "bundles": [{
                                "path": "config.toml",
                                "sha256": "abc",
                                "role": "config"
                            }]
                        }
                    },
                    {"key": "s2", "found": false}
                ]
            }),
        )
        .unwrap();

        assert_eq!(parsed.len(), 2);
        match &parsed[0] {
            BatchSessionOutcome::Found(feeds) => {
                assert_eq!(feeds.key, "s1");
                assert_eq!(feeds.artifacts.next_cursor, "1.1");
                assert_eq!(feeds.artifacts.changes.len(), 1);
                assert_eq!(feeds.atrium.next_cursor, "2.1");
                assert_eq!(feeds.atrium.session_ids, vec!["thread-1".to_string()]);
                assert_eq!(feeds.profile_bundles.len(), 1);
            }
            BatchSessionOutcome::NotFound { .. } => panic!("expected found"),
        }
        assert_eq!(
            parsed[1],
            BatchSessionOutcome::NotFound {
                key: "s2".to_string()
            }
        );
    }

    #[test]
    fn unsupported_batch_flip_retries_after_backoff() {
        let now = Instant::now();
        let mut state = BatchEndpointState::default();

        assert!(state.should_try(now));
        state.record_unsupported(now);
        assert!(!state.should_try(now + Duration::from_secs(BATCH_UNSUPPORTED_RETRY_SECS - 1)));
        assert!(state.should_try(now + Duration::from_secs(BATCH_UNSUPPORTED_RETRY_SECS)));
        state.record_success();
        assert!(state.should_try(now + Duration::from_secs(1)));
    }
}
