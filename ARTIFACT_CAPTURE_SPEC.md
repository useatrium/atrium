# Spec: Sandbox artifact capture (Centaur producer half)

You are implementing the **Centaur producer half** of an "artifact capture" feature.
The **atrium consumer half is already built and merged** — it listens for an
`artifact.captured` event and renders a gallery, fetching bytes from atrium's own
S3. Your job: capture work-product files the agent writes inside the sandbox,
stage their bytes, and emit `artifact.captured` events that atrium's event tail
already picks up.

Work in THIS worktree only (`~/Code/centaur-wt/artifacts`, branch
`wt-artifact-capture`, off origin/main). Do NOT touch other worktrees/branches.
This is a **local, upstream-shaped** change (clean/minimal like an upstream PR,
but we are NOT submitting it to paradigmxyz right now).

## Architecture (dedicated byte channel — DECIDED, do not change)

1. A **capture sidecar** runs alongside the harness in the sandbox. It polls an
   allow-list of output dirs, detects new/changed files, applies an
   artifact-vs-junk filter, and for each qualifying file calls a Centaur HTTP
   route (sandbox-token auth) — it does NOT go through the harness stdout NDJSON.
2. **`POST /agent/executions/{execution_id}/artifacts`** (sandbox-token auth):
   receives file metadata + bytes (bytes only when under the size cap), stores
   bytes in a staging table keyed by `ref`, and appends an `artifact.captured`
   event to `agent_execution_events`. Over-cap / junk-but-surfaced =
   manifest-only: no bytes, `ref = null`.
3. **`GET /agent/executions/{execution_id}/artifacts/{ref}`** (normal API-key
   auth, called by atrium server-to-server): streams the staged bytes.
4. Atrium's event tail already surfaces the `artifact.captured` event_kind →
   no atrium change needed IF the outbound tail forwards arbitrary event_kinds
   (VERIFY this — see deliverable F).

## The event contract (MUST match atrium exactly)

`append_execution_event(..., event_kind="artifact.captured", event_json=...)`
where `event_json` is:

```json
{
  "artifact_id": "<sha256 hex, first 16 chars>",
  "path": "/home/agent/workspace/out/chart.png",
  "kind": "created" | "modified" | "deleted",
  "mime": "image/png",
  "size_bytes": 48210,
  "sha256": "<full sha256 hex>",
  "ref": "<staging key>"        // null = manifest-only (over-cap / junk-surfaced)
}
```

- `artifact_id` = `sha256[:16]` (atrium dedups on this — same content = same id).
- `ref` = the staging-table key (use the full sha256, or a uuid; must round-trip
  to the GET route). `null` when no bytes were staged.
- `path` stays absolute (atrium strips the sandbox prefix for display).

## Known seams (from a prior investigation — verify before relying)

- **Event append**: `append_execution_event(pool, *, thread_key, execution_id,
  event_kind, event_json)` at `services/api/api/runtime_control.py:~1147`. Table
  `agent_execution_events` (BIGSERIAL event_id), migration
  `services/api/db/migrations/008_agent_runtime_control_plane.sql`.
- **Sandbox-token auth**: `mint_sandbox_token` / `verify_sandbox_token` /
  `enforce_sandbox_thread_scope` in `services/api/api/deps.py:~50-200`. Sandbox
  gets `CENTAUR_API_URL`, `CENTAUR_API_KEY` (sandbox token), `CENTAUR_THREAD_KEY`
  as env (`services/api/api/sandbox/config.py:~167-256`); submits `x-api-key`.
- **Upload route precedent**: `services/api/api/routers/attachments.py:~50-107`
  (`/agent/attachments/upload`) — mirror its auth + multipart handling.
- **Sandbox image**: `services/sandbox/Dockerfile` (ubuntu:24.04, user `agent`
  uid 1001, workspace `/home/agent/workspace`, entrypoint `/entrypoint.sh`, CMD
  `codex-app-wrapper`). `/tmp`, `/home/agent/outputs`, `/var/tmp` are normal
  writable paths in the same container.
- **Sidecar precedent**: the tool-server sidecar in
  `services/api/api/sandbox/kubernetes.py:~442-598` (`_build_tool_server_container`)
  shows how to add a second container sharing the workspace volume + sandbox
  token. Decide: separate sidecar container vs. a background process the
  entrypoint launches — pick the LOWER-FRICTION option for the local kind image
  and document why.
- **Wrappers**: `services/sandbox/claude-app-wrapper.py`, codex wrapper — for
  reference on env/context, not necessarily modified.

## Deliverables

A. **Migration**: new numbered migration adding `artifact_blobs(execution_id
   text, ref text, mime text, size_bytes bigint, sha256 text, data bytea,
   created_at timestamptz default now(), primary key (execution_id, ref))` (or
   equivalent). Follow the existing migration conventions.

B. **Routes** (new router or extend runtime_control router):
   - `POST /agent/executions/{execution_id}/artifacts` — sandbox-token auth +
     `enforce_sandbox_thread_scope(write=True)`. Body: metadata (path, kind, mime,
     size_bytes, sha256) + optional bytes (multipart, bytes omitted when
     manifest-only). Behavior: if bytes present, upsert into `artifact_blobs`
     keyed by `ref`; then `append_execution_event(event_kind="artifact.captured",
     event_json=<contract>)`. Idempotent on (execution_id, ref) — a replayed
     capture must not double-append (dedup on ref OR on artifact_id).
   - `GET /agent/executions/{execution_id}/artifacts/{ref}` — normal API-key auth.
     Streams the staged bytes with the stored mime as Content-Type; 404 if absent.

C. **Capture sidecar** (`services/sandbox/artifact_capture.py` or similar):
   - Env: `CENTAUR_API_URL`, `CENTAUR_API_KEY`, `CENTAUR_EXECUTION_ID` (or derive),
     `ARTIFACT_CAPTURE_DIRS` (default
     `/home/agent/workspace:/tmp:/home/agent/outputs:/var/tmp`),
     `ARTIFACT_CAPTURE_MAX_BYTES` (default 1_048_576),
     `ARTIFACT_CAPTURE_INTERVAL_S` (default 2.5).
   - Poll the dirs; track seen files by (path → (mtime, size)); on new/changed,
     read + sha256; dedup by sha256 (skip if already sent).
   - **Artifact-vs-junk filter** (axis is artifact-vs-junk, NOT binary-vs-text —
     most artifacts are binary):
     - type allow-list by extension/mime: images (png/jpg/jpeg/gif/webp/svg),
       docs (pdf/csv/tsv/json/yaml/md/txt/html/xml), media (mp4/mp3/wav) — extend
       sensibly. Exclude build junk: .o/.obj/.pyc/.pyo/.class/.so/.dylib/.a/.whl/
       .node/.map.
     - path deny substrings: node_modules, .git, dist, build, target, __pycache__,
       .venv, venv, .cache, site-packages, .next, .pytest_cache, and `*.lock`.
     - secret detector (own axis, not type): name deny (.env, *.pem, *.key,
       id_rsa, .netrc, .aws/credentials, *.p8) + a light content scan for obvious
       secret patterns. Secrets are NEVER staged or surfaced.
     - size cap: bytes only when `size <= ARTIFACT_CAPTURE_MAX_BYTES`; over-cap =
       manifest-only POST (no bytes, ref=null in the resulting event).
   - `kind`: first-seen path = "created", later content change = "modified".
     (deletion tracking optional; skip for v0.)
   - Best-effort: every error is caught + logged; the sidecar must NEVER crash or
     block the harness.

D. **Pod spec / launch**: wire the sidecar into the sandbox so it runs for every
   execution, sharing the workspace + seeing /tmp etc., with the env above. Gate
   behind `ARTIFACT_CAPTURE_ENABLED` (default ON for the local image). Follow the
   tool-server sidecar pattern OR an entrypoint-launched background process —
   whichever is cleaner; document the choice.

E. **Image**: ensure the sidecar script ships in the sandbox image
   (Dockerfile COPY) and is started.

F. **VERIFY the atrium-facing event tail forwards `artifact.captured`.** Find how
   atrium tails Centaur events (the SSE / stream endpoint or the
   agent_execution_events read path the atrium server consumes) and confirm a new
   `event_kind` is forwarded, not dropped by an outbound allow-list. If there IS
   an allow-list, add `artifact.captured`. Report what you found.

G. **Tests**: pytest for the routes (upload → append + store + idempotency, fetch
   streams bytes, auth rejects wrong token, manifest-only path) and unit tests for
   the sidecar filter (artifact-vs-junk classification, size cap → manifest-only,
   sha dedup, secret rejection).

## Process

- Investigate the real code first (the seams above are pointers, verify them).
- Keep the diff minimal and upstream-style.
- Run the test suite you add; report pass/fail.
- When done, write a short `ARTIFACT_CAPTURE_REPORT.md` in the worktree root
  covering: files changed, the sidecar-vs-container decision + why, the tail
  verification result (deliverable F), how to run it in the kind cluster, and any
  open risks. Do NOT commit unless everything passes; leave changes staged/unstaged
  for review.
