# Harness-resume build plan (rollout-JSONL project)

> POC PASSED (2026-06-21). Resume = capture+restore of the harness transcript
> file (Codex + Claude), NOT new harness logic. See memory
> [[agent-session-resume-storage]] for the POC findings + decisions.

## Decisions (Gary, 2026-06-21)
- Scope: **Codex + Claude together** in v1.
- Home model: **Atrium-canonical** — daemon captures the transcript to Atrium each
  turn; sandbox stays stateless/disposable; cold-start restores it. No per-session PVC.
- Teardown: **resume-foundation-first** — keep disposable sandboxes; warm-sleep later.

## The transcript is NOT a user artifact
Internal harness state captured for restore. It must NOT go through the artifact
ledger (would pollute the Files surface + change-feed + conflict logic — only the
daemon ever writes it). → dedicated lightweight store, not user-visible.

## Seam contract (both repos build against this)
Atrium internal endpoints (x-api-key = `ARTIFACT_CAPTURE_API_KEY`, daemon-trusted,
mirrors the existing `/api/internal/sessions/:id/artifacts/*`):
- `PUT /api/internal/sessions/:id/harness-transcript?harness=<claude|codex>`
  — raw `.jsonl` body → store (S3 `harness/<sessionId>/<harness>.jsonl`) + upsert a
  metadata row. Last-write-wins (the transcript is a full snapshot each turn).
- `GET /api/internal/sessions/:id/harness-transcript?harness=<claude|codex>`
  — returns the `.jsonl` bytes, or 404. (the daemon's restore fetch)

Transcript source paths in the sandbox (deterministic):
- Claude: `$CLAUDE_CONFIG_DIR/projects/-home-agent-workspace/<thread-id>.jsonl`
  (cwd `/home/agent/workspace` → `-home-agent-workspace`; thread-id = the Atrium
  session/thread id, set via `--session-id`).
- Codex: `$CODEX_HOME/sessions/.../rollout-<id>.jsonl`.

## Phases / lanes
- **A (Atrium, me):** mig `harness_transcripts(session_id, harness, s3_key, size_bytes,
  sha256, updated_at, PK(session_id,harness))`; the PUT+GET internal endpoints; S3
  store via the existing `uploadObject`/`getObjectBytes`; server tests. Mergeable alone.
- **C1 (Centaur daemon, codex):** `centaur-node-sync` captures the harness-home
  transcript each sweep → `PUT` to Atrium. The harness home is OUTSIDE the overlay
  artifact allow-list → a dedicated read path (host-side mount of the harness home,
  or read via the sandbox FS). Best-effort, never blocks the agent.
- **C2 (Centaur runtime, codex):** on a **resumed cold-start** (fresh container, a
  session with a prior transcript): (a) wire the per-session ephemeral home env
  (`CODEX_HOME` / `CLAUDE_CONFIG_DIR`); (b) `GET` the transcript from Atrium + write
  it to the deterministic path BEFORE the first turn; (c) trigger resume — Claude via
  app-server `thread/resume` (already wired, `server.rs:822`), Codex via conditional
  `CODEX_CONTINUE_THREAD_ID` (flip the `centaur-session-runtime/src/lib.rs:4307` guard
  to inject only when a resume-target is present). Same workspace cwd (already fixed).
- **Auth:** iron-proxy already injects the model credential into the sandbox — no work.

## Done = e2e
Cluster e2e: spawn a session → terminal → sandbox released (60s) → send a steer →
fresh container restores the transcript + resumes → the agent recalls prior context.
Dev-browser: the session pane shows the resumed turn answering with full memory.

## Risks / notes
- Centaur deploy-merge to `atrium/integration` is fragile (drops the crate) — careful
  manual pass each time; canonical = `gb/api-rs-artifact-capture`.
- The transcript can grow large over a long session → reuse the same size cap /
  multipart thinking as artifacts if needed (H8). v1: cap + last-write-wins.
