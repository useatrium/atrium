# Spec: harness-resume Centaur half (capture + restore + resume-trigger)

You implement the **Centaur half** of agent session resume. The **Atrium half is
DONE and on master** (durable per-session harness-transcript store + endpoints).
The POC PASSED: resume = capture the harness CLI's own transcript file, restore it
into a fresh container, trigger resume. NO new harness logic — the CLIs already
resume from the transcript (`claude -p --resume <id>` / codex `thread/resume`).

Work ONLY in this worktree (`~/Code/centaur-wt/harness-resume`, branch
`gb/harness-resume`, off `fork/gb/api-rs-artifact-capture`). Don't touch other
worktrees. Investigate the real code before relying on the seams below.

## The Atrium contract (already shipped — build against it)
Atrium internal endpoints, auth = header `x-api-key: <ATRIUM_CAPTURE_API_KEY>`:
- `PUT /api/internal/sessions/{sessionId}/harness-transcript?harness=<claude|codex>`
  — raw `.jsonl` body = the full transcript snapshot. Last-write-wins.
- `GET /api/internal/sessions/{sessionId}/harness-transcript?harness=<claude|codex>`
  — returns the `.jsonl` bytes, or 404 if none captured. (the restore fetch)
`sessionId` = the Atrium session id = the Centaur thread id (the harness already
uses it as the deterministic `--session-id`).

## Transcript source paths in the sandbox (deterministic)
- **Claude:** `$CLAUDE_CONFIG_DIR/projects/-home-agent-workspace/<thread-id>.jsonl`
  (cwd `/home/agent/workspace` → `-home-agent-workspace`; `<thread-id>` = the
  session id set via `--session-id`, captured by harness-server `server.rs:1019/1040`).
  Resume needs ONLY this file (no sqlite). CWD must match (it's fixed).
- **Codex:** `$CODEX_HOME/sessions/.../rollout-<id>.jsonl` (only this; no sqlite).

## Lane C1 — daemon capture (crate `services/api-rs/crates/centaur-node-sync`)
The node-sync daemon already reads the agent's overlay upper-dir node-side and
ships workspace artifacts to Atrium. Extend it to ALSO capture the **harness
transcript** (a separate, non-artifact path — it must NOT go through the artifact
ledger / Files surface; it uses the new `harness-transcript` endpoint).
- Each capture sweep (or a dedicated cadence), locate the harness home transcript
  in the sandbox FS (the harness home — `~/.claude` / `$CODEX_HOME` — is on the
  same overlay the daemon already reads; find the right subpath for the active
  harness + thread-id) and `PUT` its bytes to the Atrium harness-transcript
  endpoint. Last-write-wins; best-effort; NEVER block the agent.
- Determine the harness + thread-id for the session (from the runtime/session
  context the daemon already has, or env). Skip if the transcript is absent.

## Lane C2 — restore + resume-trigger (crate `services/api-rs/crates/centaur-session-runtime` + workload/entrypoint)
On a **resumed cold-start** (a fresh container for a session that has a prior
captured transcript):
1. **Per-session ephemeral home:** wire `CODEX_HOME` / `CLAUDE_CONFIG_DIR` to a
   per-session ephemeral dir (the `stateVolume` infra exists but `enabled:false` —
   wire it, or use an emptyDir + env). NOT a persistent PVC.
2. **Restore:** before the harness's first turn, fetch the transcript from Atrium
   (`GET …/harness-transcript?harness=…`) and write it to the deterministic path
   above. Cleanest options: a sandbox init step (entrypoint) OR a daemon inbound
   write (the daemon already does node-side inbound writes through `merged`) —
   pick the lower-friction one and document why. Must land BEFORE the first turn.
3. **Trigger resume:**
   - **Claude:** already wired — harness-server sets `harness_session_id` from
     app-server `thread/resume` (`server.rs:822`) → `claude -p --resume <id>`.
     Ensure the runtime drives `thread/resume` for a resumed session.
   - **Codex:** the workload spec deliberately OMITS `CODEX_CONTINUE_THREAD_ID` —
     guarded by `centaur-session-runtime/src/lib.rs:4307`
     (`codex_workload_does_not_inject_stale_continue_thread_id`). Make injection
     **CONDITIONAL on a resume-target**: inject `CODEX_CONTINUE_THREAD_ID=<thread-id>`
     ONLY when the session is being resumed (has a prior transcript), keep omitting
     it otherwise. Update that test → "omits when no resume-target; injects when set".
4. **Auth:** the model credential is already injected by iron-proxy — no work.

## Known seams (verify before relying)
- `crates/harness-server/src/claude.rs:218-248` — the `claude --print … (--resume
  <id> | --session-id <atrium-id>)` command. `server.rs:822` resume trigger.
- `crates/harness-server/src/codex.rs:~268-293` — `start_or_resume_thread` reads
  `CODEX_CONTINUE_THREAD_ID` → `thread/resume`.
- `services/api-rs/crates/centaur-session-runtime/src/lib.rs:4307` — the guard.
- The node-sync daemon: `services/api-rs/crates/centaur-node-sync` (capture sweep,
  http client, runtime). The Atrium capture-key env is `ATRIUM_CAPTURE_API_KEY`.

## Deliverables
- C1: daemon harness-transcript capture (code + unit tests for path resolution +
  the PUT call shape).
- C2: per-session home env wiring + restore step + conditional Codex resume
  injection (flip the 4307 guard, both directions tested) + ensure Claude
  thread/resume path is driven on resume.
- Keep the diff minimal + upstream-style. Run `cargo test` for the touched crates;
  report pass/fail. Write `HARNESS_RESUME_REPORT.md` (files changed, the restore
  mechanism choice + why, how to validate on the kind cluster, open risks). Do NOT
  git commit — leave changes for review.

## Constraints
- Best-effort capture; never block or crash the harness/agent.
- The transcript is internal harness state, NOT a user artifact — separate path.
- Centaur Rust workspace is under `services/api-rs/`; harness-server is at repo-root
  `crates/harness-server/`. Don't break the existing 47 node-sync + harness-server tests.
