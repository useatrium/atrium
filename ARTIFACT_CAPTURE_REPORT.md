# Artifact Capture Report

## Files changed

- `services/api-rs/crates/centaur-session-sqlx/migrations/0019_artifact_blobs.sql`
- `services/api-rs/crates/centaur-session-sqlx/src/lib.rs`
- `services/api-rs/crates/centaur-session-runtime/src/lib.rs`
- `services/api-rs/crates/centaur-api-server/src/{args.rs,error.rs,lib.rs,routes.rs,types.rs}`
- `services/api-rs/crates/centaur-sandbox-{core,manager}/src/*`
- `services/api-rs/crates/centaur-sandbox-agent-k8s/src/lib.rs`
- `services/sandbox/{Dockerfile,entrypoint.sh,artifact_capture.py}`
- `services/sandbox/tests/test_artifact_capture.py`
- `services/api-rs/Cargo.lock`, `services/api-rs/crates/centaur-api-server/Cargo.toml`

## Implementation notes

This checkout uses the Rust `api-rs` session runtime, not the older Python `agent_execution_events` seam referenced in the spec. The implementation therefore stages bytes in `artifact_blobs`, appends `artifact.captured` rows to `session_events`, and exposes the required compatibility routes at:

- `POST /agent/executions/{execution_id}/artifacts`
- `GET /agent/executions/{execution_id}/artifacts/{artifact_ref}`
- `GET /agent/threads/{thread_key}/events` as an alias over the current session SSE stream

The capture worker is an entrypoint-launched background process in the sandbox container, not a second Kubernetes container. That is the lower-friction choice for the local kind image because it sees the real workspace and container `/tmp` directly, avoids chart-level sidecar wiring, and keeps harness stdout clean by logging to `/tmp/artifact-capture.log`.

Warm sandboxes are handled by patching runtime context annotations on the Pod for each execution. A downward API volume exposes `thread_key` and `execution_id` at `/etc/centaur/runtime-context`, so the capture worker can follow warm-pool execution changes instead of relying only on immutable env vars.

## Tail verification

The atrium-facing tail is the API session SSE path. `SessionSseEvent` preserves unknown event names through `SessionEventName::Other(String)` and serializes them as the SSE event name, so there is no outbound allow-list dropping `artifact.captured`. I added `types::tests::artifact_captured_is_forwarded_as_its_event_kind` to lock this down.

## Running in the local kind/k3s stack

From the repo root:

```bash
just build-one api-rs
just build-one sandbox
just deploy
```

For the k3s local-registry flow, push the rebuilt images before deploy:

```bash
just build-one api-rs
just build-one sandbox
just _push-registry
just deploy
```

Then run a normal agent turn that creates an allowed artifact under `/home/agent/workspace`, `/tmp`, `/home/agent/outputs`, or `/var/tmp`. Tail the compatibility endpoint and expect an `artifact.captured` event:

```bash
kubectl exec -n centaur deploy/centaur-centaur-api-rs -- \
  curl -N "http://localhost:8000/agent/threads/${THREAD_KEY}/events?execution_id=${EXECUTION_ID}"
```

If the event has a non-null `ref`, fetch the staged bytes with a valid server API key:

```bash
curl -H "x-api-key: ${API_KEY}" \
  "http://localhost:8000/agent/executions/${EXECUTION_ID}/artifacts/${REF}"
```

## Tests run

- `uvx pytest services/sandbox/tests/test_artifact_capture.py -q` - passed, 4 tests.
- `SESSION_RUNTIME_TEST_DATABASE_URL=postgres://tempo:tempo_dev_change_me@localhost:55432/centaur_test cargo test -p centaur-api-server -- --nocapture` - passed, 17 lib tests and 24 main tests.
- `cargo test -p centaur-sandbox-agent-k8s -- --nocapture` - passed, 23 tests.
- `cargo test -p centaur-session-runtime workload -- --nocapture` - passed, 5 filtered workload tests.

## Open risks

- The Rust API server does not currently have the older Python sandbox-token auth helpers, so the new routes use narrow route-local API-key validation plus `x-centaur-thread-key` upload scoping.
- Capture is polling-based and best-effort. If the runtime context annotation patch fails for a warm Pod, the worker waits instead of submitting artifacts for the wrong execution.
- Over-cap files are manifest-only by design and cannot be fetched through the byte route.
