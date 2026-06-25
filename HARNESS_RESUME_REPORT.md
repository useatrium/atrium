# Harness Resume Report

## Summary

Implemented the Centaur-side harness transcript capture/restore path and the follow-up
security fix:

- Lane C1: `centaur-node-sync` locates Claude/Codex transcript files in the sandbox
  overlay upper dir and PUTs raw JSONL bytes to Atrium's `harness-transcript` endpoint
  outside the artifact ledger. The daemon still holds the Atrium capture key only
  node-side.
- Lane C2: session sandboxes get ephemeral harness homes on an `emptyDir`, restore
  transcript bytes before harness startup, and only inject Codex resume env when a
  persisted resume target exists.
- Security fix: sandbox restore now calls Centaur with its scoped sandbox token.
  api-rs verifies the token is scoped to the requested thread, then proxies to
  Atrium with `ATRIUM_CAPTURE_API_KEY` held server-side. No Atrium URL or capture
  key is read by the sandbox entrypoint.
- Artifact capture is node-side via `centaur-node-sync`; Centaur does not stage
  artifact bytes for Atrium.

## Files Changed

- `services/api-rs/crates/centaur-session-core/{Cargo.toml,src/lib.rs,src/sandbox_token.rs}`
- `services/api-rs/crates/centaur-session-runtime/src/lib.rs`
- `services/api-rs/crates/centaur-api-server/src/{args.rs,error.rs,lib.rs,routes.rs}`
- `services/api-rs/crates/centaur-node-sync/src/{runtime.rs,http_client.rs,bin/centaur-node-syncd.rs}`
- `crates/harness-server/src/server.rs`
- `services/sandbox/entrypoint.sh`
- `contrib/chart/templates/apirs.yaml`
- `contrib/chart/values.yaml`

## Restore Mechanism

The sandbox entrypoint still performs restore pre-harness. On a cold resume target
(`session.harness_thread_id` present), the runtime injects:

- `CENTAUR_HARNESS_TRANSCRIPT_RESTORE=1`
- `CENTAUR_RESUME_THREAD_ID=<id>`
- `CENTAUR_API_KEY=<scoped sandbox token>`

Codex additionally gets `CODEX_CONTINUE_THREAD_ID=<id>`; non-resume starts still
omit it.

The entrypoint calls:

```text
GET ${CENTAUR_API_URL}/agent/threads/{thread_key}/harness-transcript?harness=<claude|codex>
x-api-key: ${CENTAUR_API_KEY}
```

api-rs verifies the sandbox token using `SANDBOX_SIGNING_KEY`, enforces that the
token's `thread_key` matches the path thread, and proxies server-side to:

```text
GET ${ATRIUM_BASE_URL}/api/internal/sessions/{thread_key}/harness-transcript?harness=<claude|codex>
x-api-key: ${ATRIUM_CAPTURE_API_KEY}
```

200 responses are returned as JSONL bytes. 404 remains a best-effort restore skip.
Other upstream failures are returned as 502.

## C1 Daemon Wiring

C1 capture remains node-side and still legitimately holds `ATRIUM_CAPTURE_API_KEY`.
The daemon no longer requires manual `NODE_SYNC_HARNESS` or
`NODE_SYNC_HARNESS_THREAD_ID` for transcript capture:

- If `NODE_SYNC_HARNESS` is unset, it scans both default homes: `.claude` and `.codex`.
- If `NODE_SYNC_HARNESS_THREAD_ID` is unset, it auto-detects the transcript file
  already present under the harness home.

This addresses the prior open risk around manual harness/id wiring without
changing the node-side Atrium client.

## Validation

Passed:

- `cargo test -p centaur-session-core` — 8 passed
- `cargo test -p centaur-session-runtime` — 43 passed
- `cargo test -p centaur-api-server` — 52 passed across lib/main targets
- `cargo test -p centaur-node-sync` — 53 passed
- `cargo test --manifest-path crates/harness-server/Cargo.toml` — 48 passed, 4 ignored
- `git diff --check`

Also verified with `rg` that `services/sandbox/entrypoint.sh` no longer references
`ATRIUM_CAPTURE_API_KEY` or `ATRIUM_BASE_URL`.

Helm render check was attempted with `helm template centaur contrib/chart`, but
this checkout is still missing the chart dependency `connect` under
`contrib/chart/charts`. I did not run `helm dependency build` because that would
add generated dependency artifacts.

## Kind Validation Plan

1. Build affected images locally: `just build-one api-rs`, `just build-one sandbox`,
   and the node-sync image if that DaemonSet is enabled in the target values.
2. Deploy locally with `just deploy`.
3. Start a Claude and Codex session, run one real turn, and confirm the runtime
   persists a `harness_thread_id`.
4. Confirm node-sync logs `harness transcript: captured ...`.
5. Stop/delete the session sandbox, execute the same thread again, and confirm
   sandbox logs show `harness transcript restored ...`.
6. Confirm api-rs, not the sandbox, is the caller to Atrium by checking the sandbox
   environment does not contain Atrium URL/capture-key variables.
7. For Claude, verify the resumed run uses prior context through the existing
   `--resume` command path. For Codex, verify `CODEX_CONTINUE_THREAD_ID` is present
   only on the cold resume sandbox.

## Open Risks

- The Codex restore path follows the documented `CODEX_HOME/sessions/.../rollout-<id>.jsonl`
  shape by writing under the current UTC date. Validate this against the exact
  Codex version baked into the sandbox image.
- Warm sandboxes boot before a thread-scoped token exists. Restore cold-starts do
  not use warm sandboxes.
