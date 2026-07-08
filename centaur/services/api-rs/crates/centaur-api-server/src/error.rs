use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use centaur_session_core::ThreadKeyError;
use centaur_session_runtime::SessionRuntimeError;
use centaur_session_sqlx::SessionStoreError;
use centaur_workflows::WorkflowRuntimeError;
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{message}")]
    Conflict { code: &'static str, message: String },
    #[error("{0}")]
    MethodNotAllowed(String),
    #[error("{0}")]
    PayloadTooLarge(String),
    #[error("{0}")]
    ServiceUnavailable(String),
    #[error("{0}")]
    BadGateway(String),
    /// Server-side misconfiguration or invariant failure. The message is
    /// logged but never returned to the client.
    #[error("{0}")]
    Internal(String),
    #[error(transparent)]
    Runtime(#[from] SessionRuntimeError),
    #[error(transparent)]
    Workflow(#[from] WorkflowRuntimeError),
    #[error(transparent)]
    Serialize(#[from] serde_json::Error),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
}

impl From<ThreadKeyError> for ApiError {
    fn from(error: ThreadKeyError) -> Self {
        Self::BadRequest(error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match &self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict { .. } => StatusCode::CONFLICT,
            Self::MethodNotAllowed(_) => StatusCode::METHOD_NOT_ALLOWED,
            Self::PayloadTooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            Self::ServiceUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::BadGateway(_) => StatusCode::BAD_GATEWAY,
            Self::Runtime(SessionRuntimeError::BadRequest(_)) => StatusCode::BAD_REQUEST,
            Self::Runtime(SessionRuntimeError::Store(SessionStoreError::NotFound { .. })) => {
                StatusCode::NOT_FOUND
            }
            Self::Runtime(SessionRuntimeError::Store(SessionStoreError::ExecutionNotFound {
                ..
            })) => StatusCode::NOT_FOUND,
            Self::Runtime(SessionRuntimeError::Store(SessionStoreError::HarnessConflict {
                ..
            })) => StatusCode::CONFLICT,
            Self::Runtime(SessionRuntimeError::Store(SessionStoreError::PersonaConflict {
                ..
            })) => StatusCode::CONFLICT,
            Self::Runtime(SessionRuntimeError::Store(
                SessionStoreError::ExecutionAlreadyActive { .. },
            )) => StatusCode::CONFLICT,
            Self::Workflow(WorkflowRuntimeError::BadRequest(_)) => StatusCode::BAD_REQUEST,
            Self::Workflow(WorkflowRuntimeError::Disabled(_)) => StatusCode::FORBIDDEN,
            Self::Workflow(WorkflowRuntimeError::NotFound(_)) => StatusCode::NOT_FOUND,
            Self::Workflow(WorkflowRuntimeError::Upstream(_)) => StatusCode::BAD_GATEWAY,
            Self::Internal(_)
            | Self::Runtime(_)
            | Self::Workflow(_)
            | Self::Serialize(_)
            | Self::Sqlx(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        // 5xx error details are server-side faults: log them for operators but
        // never echo internals (SQL text, hostnames, config refs) to clients.
        let message = if status.is_server_error() {
            tracing::error!(
                status = status.as_u16(),
                error = %error_chain(&self),
                "API request failed"
            );
            "internal server error".to_owned()
        } else {
            self.to_string()
        };
        let mut body = json!({
            "ok": false,
            "error": message,
        });
        // Structured conflict details let clients (e.g. the slackbot) recover by
        // retrying with the session's existing harness instead of parsing the
        // human-readable message.
        if let Self::Conflict { code, .. } = &self {
            body["code"] = json!(code);
        }
        if let Self::Runtime(SessionRuntimeError::Store(SessionStoreError::HarnessConflict {
            existing,
            requested,
            ..
        })) = &self
        {
            body["code"] = json!("harness_conflict");
            body["existing_harness"] = json!(existing);
            body["requested_harness"] = json!(requested);
        }
        if let Self::Runtime(SessionRuntimeError::Store(
            SessionStoreError::ExecutionAlreadyActive { .. },
        )) = &self
        {
            body["code"] = json!("execution_already_active");
        }
        (status, Json(body)).into_response()
    }
}

/// Render an error and its full `source()` chain as a single string. Causes
/// already rendered into an ancestor's message are skipped.
pub(crate) fn error_chain(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let rendered = cause.to_string();
        if !message.contains(&rendered) {
            message.push_str(": ");
            message.push_str(&rendered);
        }
        source = cause.source();
    }
    message
}

#[cfg(test)]
mod tests {
    use axum::{body::to_bytes, response::IntoResponse};
    use centaur_session_runtime::SessionRuntimeError;
    use centaur_session_sqlx::SessionStoreError;
    use serde_json::Value;

    use super::*;

    #[tokio::test]
    async fn execution_already_active_maps_to_structured_409() {
        let response = ApiError::Runtime(SessionRuntimeError::Store(
            SessionStoreError::ExecutionAlreadyActive {
                thread_key: "web:t1".to_string(),
            },
        ))
        .into_response();

        assert_eq!(response.status(), StatusCode::CONFLICT);

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();

        assert_eq!(body["ok"], false);
        assert_eq!(body["code"], "execution_already_active");
        assert_eq!(
            body["error"],
            "execution already active for thread_key web:t1"
        );
    }
}
