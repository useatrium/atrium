pub mod client;
mod error;
mod routes;
pub mod types;

pub use centaur_session_runtime::{SandboxRuntime, SessionRuntime};
pub use error::ApiError;
pub use routes::{
    build_router_with_runtime, build_router_with_session_and_workflow_runtime,
    build_router_with_session_runtime,
};

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicU64, Ordering},
        },
        time::{SystemTime, UNIX_EPOCH},
    };

    use async_trait::async_trait;
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode, header},
    };
    use centaur_sandbox_core::{
        ObservedSandbox, SandboxBackend, SandboxError, SandboxHandle, SandboxId, SandboxIo,
        SandboxResult, SandboxSpec, SandboxStatus,
    };
    use centaur_session_core::{HarnessType, ThreadKey};
    use centaur_session_runtime::SandboxRuntime;
    use centaur_session_sqlx::PgSessionStore;
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use sqlx::PgPool;
    use tower::ServiceExt;

    use super::build_router_with_runtime;

    #[tokio::test]
    async fn router_builds() {
        let pool =
            PgPool::connect_lazy("postgres://postgres:postgres@localhost/centaur_test").unwrap();
        let _router = build_router_with_runtime(
            PgSessionStore::new(pool),
            SandboxRuntime::backend(Arc::new(TestBackend::default()), SandboxSpec::new("test")),
        );
    }

    #[tokio::test]
    async fn metrics_endpoint_renders_http_request_metrics() {
        let pool =
            PgPool::connect_lazy("postgres://postgres:postgres@localhost/centaur_test").unwrap();
        let app = build_router_with_runtime(
            PgSessionStore::new(pool),
            SandboxRuntime::backend(Arc::new(TestBackend::default()), SandboxSpec::new("test")),
        );

        let app = app
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(app.status(), StatusCode::OK);

        let pool =
            PgPool::connect_lazy("postgres://postgres:postgres@localhost/centaur_test").unwrap();
        let app = build_router_with_runtime(
            PgSessionStore::new(pool),
            SandboxRuntime::backend(Arc::new(TestBackend::default()), SandboxSpec::new("test")),
        );
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/metrics")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        assert!(
            body.contains(
                r#"http_server_requests_total{method="GET",route="/healthz",status="200"}"#
            )
        );
    }

    #[tokio::test]
    async fn append_messages_does_not_apply_a_session_body_limit() {
        let pool =
            PgPool::connect_lazy("postgres://postgres:postgres@localhost/centaur_test").unwrap();
        let app = build_router_with_runtime(
            PgSessionStore::new(pool),
            SandboxRuntime::backend(Arc::new(TestBackend::default()), SandboxSpec::new("test")),
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session/slack%3AC123%3A123.456/messages")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::CONTENT_LENGTH, (256 * 1024 * 1024 + 1).to_string())
                    .body(Body::from(r#"{"messages":"not-an-array"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_ne!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn execute_does_not_apply_a_session_body_limit() {
        let pool =
            PgPool::connect_lazy("postgres://postgres:postgres@localhost/centaur_test").unwrap();
        let app = build_router_with_runtime(
            PgSessionStore::new(pool),
            SandboxRuntime::backend(Arc::new(TestBackend::default()), SandboxSpec::new("test")),
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session/slack%3AC123%3A123.456/execute")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::CONTENT_LENGTH, (256 * 1024 * 1024 + 1).to_string())
                    .body(Body::from(r#"{"input_lines":"not-an-array"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_ne!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn artifact_upload_appends_stores_and_is_idempotent() {
        let Some((store, app, thread_key, execution_id)) = artifact_test_app().await else {
            return;
        };
        set_artifact_test_key();
        let body = b"hello artifact".to_vec();
        let sha256 = sha256_hex(&body);
        let request = artifact_upload_request(
            &execution_id,
            thread_key.as_str(),
            "test-artifact-key",
            &sha256,
            Some(&body),
        );

        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = app
            .oneshot(artifact_upload_request(
                &execution_id,
                thread_key.as_str(),
                "test-artifact-key",
                &sha256,
                Some(&body),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let events = store
            .list_events_after(&thread_key, 0, Some(&execution_id), 100)
            .await
            .unwrap();
        let artifact_events = events
            .iter()
            .filter(|event| event.event_type == "artifact.captured")
            .collect::<Vec<_>>();
        assert_eq!(artifact_events.len(), 1);
        assert_eq!(artifact_events[0].payload["artifact_id"], sha256[..16]);
        assert_eq!(artifact_events[0].payload["ref"], sha256);

        let blob = store
            .get_artifact_blob(&execution_id, &sha256)
            .await
            .unwrap()
            .expect("artifact blob");
        assert_eq!(blob.data, body);
        assert_eq!(blob.mime, "text/plain");
    }

    #[tokio::test]
    async fn artifact_fetch_streams_staged_bytes() {
        let Some((_store, app, thread_key, execution_id)) = artifact_test_app().await else {
            return;
        };
        set_artifact_test_key();
        let body = b"hello artifact".to_vec();
        let sha256 = sha256_hex(&body);
        let response = app
            .clone()
            .oneshot(artifact_upload_request(
                &execution_id,
                thread_key.as_str(),
                "test-artifact-key",
                &sha256,
                Some(&body),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!(
                        "/agent/executions/{execution_id}/artifacts/{sha256}"
                    ))
                    .header(header::AUTHORIZATION, "Bearer test-artifact-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/plain"
        );
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(bytes.as_ref(), body);
    }

    #[tokio::test]
    async fn artifact_upload_rejects_wrong_token() {
        let Some((_store, app, thread_key, execution_id)) = artifact_test_app().await else {
            return;
        };
        set_artifact_test_key();
        let body = b"hello artifact".to_vec();
        let sha256 = sha256_hex(&body);
        let response = app
            .oneshot(artifact_upload_request(
                &execution_id,
                thread_key.as_str(),
                "wrong-key",
                &sha256,
                Some(&body),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn artifact_manifest_only_appends_without_staging_bytes() {
        let Some((store, app, thread_key, execution_id)) = artifact_test_app().await else {
            return;
        };
        set_artifact_test_key();
        let sha256 = sha256_hex(b"large artifact");
        let response = app
            .oneshot(artifact_upload_request(
                &execution_id,
                thread_key.as_str(),
                "test-artifact-key",
                &sha256,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let payload = json_body(response).await;
        assert_eq!(payload["artifact"]["ref"], Value::Null);

        let events = store
            .list_events_after(&thread_key, 0, Some(&execution_id), 100)
            .await
            .unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.event_type == "artifact.captured")
                .count(),
            1
        );
        assert!(
            store
                .get_artifact_blob(&execution_id, &sha256)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn artifact_upload_rejects_sha256_mismatch() {
        let Some((store, app, thread_key, execution_id)) = artifact_test_app().await else {
            return;
        };
        set_artifact_test_key();
        let body = b"hello artifact".to_vec();
        // Valid 64-hex digest that does NOT match the uploaded bytes.
        let wrong_sha256 = sha256_hex(b"different content");
        let response = app
            .oneshot(artifact_upload_request(
                &execution_id,
                thread_key.as_str(),
                "test-artifact-key",
                &wrong_sha256,
                Some(&body),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let events = store
            .list_events_after(&thread_key, 0, Some(&execution_id), 100)
            .await
            .unwrap();
        assert!(
            events
                .iter()
                .all(|event| event.event_type != "artifact.captured")
        );
    }

    async fn artifact_test_app() -> Option<(PgSessionStore, axum::Router, ThreadKey, String)> {
        let Ok(url) = std::env::var("SESSION_RUNTIME_TEST_DATABASE_URL") else {
            eprintln!("skipping: SESSION_RUNTIME_TEST_DATABASE_URL not set");
            return None;
        };
        let store = PgSessionStore::connect(&url)
            .await
            .expect("connect test db");
        store.run_migrations().await.expect("run migrations");
        let app = build_router_with_runtime(
            store.clone(),
            SandboxRuntime::backend(Arc::new(TestBackend::default()), SandboxSpec::new("test")),
        );
        let thread_key = ThreadKey::parse(format!("test:artifact-{}", unique_test_id())).unwrap();
        store
            .create_or_get_session(&thread_key, &HarnessType::Codex, None, json!({}))
            .await
            .unwrap();
        let execution = store
            .create_execution(&thread_key, None, json!({}))
            .await
            .unwrap()
            .execution;
        Some((store, app, thread_key, execution.execution_id))
    }

    fn artifact_upload_request(
        execution_id: &str,
        thread_key: &str,
        api_key: &str,
        sha256: &str,
        bytes: Option<&[u8]>,
    ) -> Request<Body> {
        let boundary = "centaur-artifact-test-boundary";
        let mut body = Vec::new();
        let size_bytes = bytes.map(|bytes| bytes.len()).unwrap_or(99).to_string();
        let fields = [
            ("path", "/home/agent/workspace/out/chart.txt".to_owned()),
            ("kind", "created".to_owned()),
            ("mime", "text/plain".to_owned()),
            ("size_bytes", size_bytes),
            ("sha256", sha256.to_owned()),
        ];
        for (name, value) in fields {
            body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
            body.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
            );
            body.extend_from_slice(value.as_bytes());
            body.extend_from_slice(b"\r\n");
        }
        if let Some(bytes) = bytes {
            body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
            body.extend_from_slice(
                b"Content-Disposition: form-data; name=\"bytes\"; filename=\"chart.txt\"\r\n",
            );
            body.extend_from_slice(b"Content-Type: text/plain\r\n\r\n");
            body.extend_from_slice(bytes);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

        Request::builder()
            .method("POST")
            .uri(format!("/agent/executions/{execution_id}/artifacts"))
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .header("x-api-key", api_key)
            .header("x-centaur-thread-key", thread_key)
            .body(Body::from(body))
            .unwrap()
    }

    async fn json_body(response: axum::response::Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn unique_test_id() -> String {
        static NEXT_ID: AtomicU64 = AtomicU64::new(1);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!(
            "{}-{}-{}",
            std::process::id(),
            nanos,
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn set_artifact_test_key() {
        unsafe {
            std::env::set_var("ARTIFACT_CAPTURE_API_KEY", "test-artifact-key");
        }
    }

    #[derive(Default)]
    struct TestBackend {
        next_id: AtomicU64,
    }

    #[async_trait]
    impl SandboxBackend for TestBackend {
        fn name(&self) -> &'static str {
            "test"
        }

        async fn create(&self, _spec: SandboxSpec) -> SandboxResult<SandboxHandle> {
            let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
            Ok(SandboxHandle::new(
                SandboxId::new(format!("test-{id}")),
                self.name(),
            ))
        }

        async fn open_io(&self, _id: &SandboxId) -> SandboxResult<SandboxIo> {
            unreachable!("router construction should not open sandbox I/O")
        }

        async fn status(&self, _id: &SandboxId) -> SandboxResult<SandboxStatus> {
            Ok(SandboxStatus::Running)
        }

        async fn observe(&self, id: &SandboxId) -> SandboxResult<ObservedSandbox> {
            Ok(ObservedSandbox::new(
                id.clone(),
                self.name(),
                SandboxStatus::Running,
            ))
        }

        async fn list_observed(&self) -> SandboxResult<Vec<ObservedSandbox>> {
            Ok(Vec::new())
        }

        async fn stop(&self, _id: &SandboxId) -> SandboxResult<()> {
            Ok(())
        }

        async fn pause(&self, _id: &SandboxId) -> SandboxResult<()> {
            Err(SandboxError::Unsupported {
                backend: self.name(),
                operation: "pause",
            })
        }

        async fn resume(&self, _id: &SandboxId) -> SandboxResult<()> {
            Err(SandboxError::Unsupported {
                backend: self.name(),
                operation: "resume",
            })
        }
    }
}
