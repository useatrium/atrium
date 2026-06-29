use axum::response::sse::Event;
use centaur_session_core::{HarnessType, Session, SessionEvent, SessionMessageInput, ThreadKey};
use centaur_session_runtime::SESSION_OUTPUT_LINE_EVENT;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use thiserror::Error;

pub const SESSION_REPOS_METADATA_KEY: &str = "centaur_session_repos";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CreateSessionRequest {
    pub harness_type: HarnessType,
    pub persona_id: Option<String>,
    pub metadata: Option<Value>,
    #[serde(default)]
    pub repos: Vec<RepoSpec>,
    /// What to do when the session already exists on a different harness.
    /// Omitted or `reject`: fail with 409. `restart`: stop the old sandbox and
    /// restart the thread on the requested harness (the new harness starts
    /// with no conversational memory).
    #[serde(default)]
    pub on_harness_conflict: Option<OnHarnessConflict>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RepoSpec {
    pub repo: String,
    #[serde(default, rename = "ref")]
    pub r#ref: Option<String>,
    #[serde(default)]
    pub subdir: Option<String>,
    /// Private target repos must be resolved with the session's user principal
    /// and must not use the node-global shared repo cache.
    #[serde(default, skip_serializing_if = "is_false")]
    pub private: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OnHarnessConflict {
    Reject,
    Restart,
}

#[derive(Clone, Debug, Serialize)]
pub struct CreateSessionResponse {
    #[serde(flatten)]
    pub session: Session,
    /// True when this request restarted the thread onto a different harness.
    pub harness_switched: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct SessionContextResponse {
    pub thread_key: ThreadKey,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slack: Option<SlackThreadContext>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SlackThreadContext {
    pub channel_id: String,
    pub thread_ts: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AppendMessagesRequest {
    pub messages: Vec<SessionMessageInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AppendMessagesResponse {
    pub ok: bool,
    pub message_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExecuteSessionRequest {
    pub idempotency_key: Option<String>,
    pub metadata: Option<Value>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub input_lines: Vec<String>,
    pub idle_timeout_ms: Option<u64>,
    pub max_duration_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExecuteSessionResponse {
    pub ok: bool,
    pub execution_id: String,
    pub thread_key: ThreadKey,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AnswerQuestionRequest {
    pub question_id: String,
    #[serde(default)]
    pub answers: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AnswerQuestionResponse {
    pub ok: bool,
    pub execution_id: String,
    pub thread_key: ThreadKey,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CancelSessionResponse {
    pub ok: bool,
    pub cancelled: bool,
    pub execution_id: Option<String>,
    pub stopped_sandbox_id: Option<String>,
    pub stop_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct EventsQuery {
    pub after_event_id: Option<i64>,
    pub execution_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct ListWorkflowRunsQuery {
    pub limit: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EmitWorkflowEventRequest {
    pub event_name: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionEventName {
    OutputLine,
    ExecutionStarted,
    ExecutionCompleted,
    ExecutionFailed,
    ExecutionCancelled,
    StreamError,
    Other(String),
}

impl SessionEventName {
    pub fn as_str(&self) -> &str {
        match self {
            Self::OutputLine => SESSION_OUTPUT_LINE_EVENT,
            Self::ExecutionStarted => "session.execution_started",
            Self::ExecutionCompleted => "session.execution_completed",
            Self::ExecutionFailed => "session.execution_failed",
            Self::ExecutionCancelled => "session.execution_cancelled",
            Self::StreamError => "session.stream_error",
            Self::Other(value) => value.as_str(),
        }
    }
}

impl From<String> for SessionEventName {
    fn from(value: String) -> Self {
        match value.as_str() {
            SESSION_OUTPUT_LINE_EVENT => Self::OutputLine,
            "session.execution_started" => Self::ExecutionStarted,
            "session.execution_completed" => Self::ExecutionCompleted,
            "session.execution_failed" => Self::ExecutionFailed,
            "session.execution_cancelled" => Self::ExecutionCancelled,
            "session.stream_error" => Self::StreamError,
            _ => Self::Other(value),
        }
    }
}

impl From<&str> for SessionEventName {
    fn from(value: &str) -> Self {
        Self::from(value.to_owned())
    }
}

pub struct SessionSseEvent(Event);

impl TryFrom<SessionEvent> for SessionSseEvent {
    type Error = SessionEventConversionError;

    fn try_from(event: SessionEvent) -> Result<Self, Self::Error> {
        let event_id = event.event_id;
        let event_name = SessionEventName::from(event.event_type);
        let sse = Event::default()
            .id(event_id.to_string())
            .event(event_name.as_str());

        let sse = match event_name {
            SessionEventName::OutputLine => {
                let Some(line) = event.payload.as_str() else {
                    return Err(SessionEventConversionError::OutputLinePayload { event_id });
                };
                sse.data(line)
            }
            _ => sse
                .json_data(event.payload)
                .map_err(|source| SessionEventConversionError::JsonData { event_id, source })?,
        };

        Ok(Self(sse))
    }
}

impl From<SessionSseEvent> for Event {
    fn from(value: SessionSseEvent) -> Self {
        value.0
    }
}

pub fn stream_error_sse(message: impl Into<String>) -> Event {
    Event::default()
        .event(SessionEventName::StreamError.as_str())
        .json_data(serde_json::json!({ "error": message.into() }))
        .unwrap_or_else(|_| {
            Event::default()
                .event(SessionEventName::StreamError.as_str())
                .data("{}")
        })
}

pub fn metadata_with_repos(
    metadata: Option<Value>,
    repos: &[RepoSpec],
) -> Result<Option<Value>, String> {
    if repos.is_empty() {
        return Ok(metadata);
    }
    validate_repo_specs(repos)?;

    let mut object = match metadata {
        Some(Value::Object(object)) => object,
        Some(_) => {
            return Err("metadata must be a JSON object when repos are provided".to_string());
        }
        None => Map::new(),
    };
    object.insert(
        SESSION_REPOS_METADATA_KEY.to_string(),
        serde_json::to_value(repos).map_err(|e| e.to_string())?,
    );
    Ok(Some(Value::Object(object)))
}

fn validate_repo_specs(repos: &[RepoSpec]) -> Result<(), String> {
    for spec in repos {
        validate_relative_repo(&spec.repo)?;
        if let Some(subdir) = &spec.subdir {
            validate_single_segment("repo subdir", subdir)?;
        }
        if let Some(git_ref) = &spec.r#ref
            && (git_ref.contains('\0') || git_ref.trim().is_empty())
        {
            return Err("repo ref must not be empty or contain NUL bytes".to_string());
        }
    }
    Ok(())
}

fn validate_relative_repo(repo: &str) -> Result<(), String> {
    if repo.contains('\0') || repo.trim().is_empty() {
        return Err("repo must not be empty or contain NUL bytes".to_string());
    }
    if repo.trim() != repo {
        return Err("repo must not contain leading or trailing whitespace".to_string());
    }
    let path = std::path::Path::new(repo);
    if path.components().any(|component| {
        matches!(
            component,
            std::path::Component::RootDir
                | std::path::Component::CurDir
                | std::path::Component::ParentDir
                | std::path::Component::Prefix(_)
        )
    }) {
        return Err("repo must be a relative path without . or .. components".to_string());
    }
    Ok(())
}

fn validate_single_segment(label: &str, value: &str) -> Result<(), String> {
    if value.contains('\0') || value.trim().is_empty() {
        return Err(format!("{label} must not be empty or contain NUL bytes"));
    }
    if value.trim() != value {
        return Err(format!(
            "{label} must not contain leading or trailing whitespace"
        ));
    }
    let mut components = std::path::Path::new(value).components();
    match (components.next(), components.next()) {
        (Some(std::path::Component::Normal(name)), None) if name == std::ffi::OsStr::new(value) => {
            Ok(())
        }
        _ => Err(format!("{label} must be a single path segment")),
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Error)]
pub enum SessionEventConversionError {
    #[error("session.output.line event {event_id} payload must be a string")]
    OutputLinePayload { event_id: i64 },
    #[error("failed to serialize session event {event_id} payload as SSE JSON: {source}")]
    JsonData { event_id: i64, source: axum::Error },
}

#[cfg(test)]
mod tests {
    use centaur_session_core::HarnessType;

    use super::{
        CreateSessionRequest, RepoSpec, SESSION_REPOS_METADATA_KEY, SessionEventName,
        metadata_with_repos,
    };

    #[test]
    fn artifact_captured_is_forwarded_as_its_event_kind() {
        let event = SessionEventName::from("artifact.captured");
        assert_eq!(event.as_str(), "artifact.captured");
    }

    #[test]
    fn create_session_request_repos_default_empty_for_back_compat() {
        let request: CreateSessionRequest =
            serde_json::from_str(r#"{"harness_type":"codex","persona_id":null,"metadata":null}"#)
                .unwrap();

        assert!(request.repos.is_empty());
    }

    #[test]
    fn create_session_request_round_trips_repos() {
        let request = CreateSessionRequest {
            harness_type: HarnessType::Codex,
            persona_id: None,
            metadata: Some(serde_json::json!({"source":"test"})),
            repos: vec![RepoSpec {
                repo: "acme/foo".to_string(),
                r#ref: Some("main".to_string()),
                subdir: Some("foo".to_string()),
                private: false,
            }],
            on_harness_conflict: None,
        };

        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["repos"][0]["repo"], "acme/foo");
        assert_eq!(value["repos"][0]["ref"], "main");
        assert_eq!(value["repos"][0]["subdir"], "foo");

        let round_trip: CreateSessionRequest = serde_json::from_value(value).unwrap();
        assert_eq!(round_trip.repos, request.repos);
    }

    #[test]
    fn metadata_with_repos_threads_specs_under_internal_key() {
        let metadata = metadata_with_repos(
            Some(serde_json::json!({"source":"test"})),
            &[RepoSpec {
                repo: "acme/foo".to_string(),
                r#ref: None,
                subdir: Some("foo".to_string()),
                private: true,
            }],
        )
        .unwrap()
        .unwrap();

        assert_eq!(metadata["source"], "test");
        assert_eq!(metadata[SESSION_REPOS_METADATA_KEY][0]["repo"], "acme/foo");
        assert_eq!(metadata[SESSION_REPOS_METADATA_KEY][0]["subdir"], "foo");
        assert_eq!(metadata[SESSION_REPOS_METADATA_KEY][0]["private"], true);
    }
}
