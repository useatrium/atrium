# Agent Session Resume and Storage Plan

Draft: 2026-06-16

This note lays out how Codex/Claude resume actually works, what a Centaur
container needs for that resume to work, and how Atrium should split durable
product state from short-lived execution state. It also folds in the earlier
runtime/container research found through `cass`.

## Working Position

Atrium should own the durable product record: transcript mirror, turn metadata,
decisions, file-change summary, and artifact/blob ledger. Centaur should own
agent execution, sandbox lifecycle, and harness-specific local state needed to
keep a live or sleeping agent efficient.

The important distinction:

- Product resume: the Atrium user can reopen a session and see the durable
  record.
- Harness resume: Codex or Claude can continue the same local conversation ID.
- Workspace restore: the next container sees the files the agent expects.

These are related, but they are not the same durability boundary.

## What We Know About Codex Resume

Local checks were against `codex-cli 0.140.0`. The Codex manual was fetched with
the `openai-docs` helper on 2026-06-16.

Codex resume is local-state based. The manual says Codex stores session
transcripts under `$CODEX_HOME/sessions` by default, with archived sessions under
`$CODEX_HOME/archived_sessions`. `codex resume` can resume by picker, `--last`,
or a session id copied from `/status` or from files under `~/.codex/sessions`.
The app-server API also has `thread/start`, `thread/resume`, and `thread/fork`.

For a Codex session to resume in a new container, the container should have:

- A stable `CODEX_HOME`, or a restored equivalent.
- At minimum, the relevant transcript under `$CODEX_HOME/sessions`.
- `CODEX_SQLITE_HOME` state if the app-server path uses SQLite-backed thread
  metadata for lookup.
- Codex auth/config/skills/plugins needed for the session's behavior:
  `auth.json`, `config.toml`, skills, MCP config, package metadata, etc. These
  may need to be injected from secrets/config rather than copied blindly.
- The original session/thread id.
- A compatible working directory. CLI resume can override with `--cd`; app-server
  `thread/resume` also includes `cwd`.
- A workspace whose files roughly match the conversation transcript's
  assumptions.

Implication: Codex is not relying only on provider-side history. For our
container model, exact harness resume requires preserving or reconstructing
local Codex state, not just storing the Centaur/Atrium event stream.

## What We Know About Claude Resume

Local checks were against Claude Code `2.1.178`. Official docs confirm that
Claude Code stores sessions continuously in local transcript files and resumes
from them.

Useful documented facts:

- `claude --continue` resumes the most recent session in the current directory.
- `claude --resume` opens the picker; `claude --resume <session-id>` resumes an
  existing session id.
- Session id lookup is scoped to the project directory and its git worktrees.
- Transcripts live at `~/.claude/projects/<project>/<session-id>.jsonl`, where
  `<project>` is derived from the working directory path.
- `CLAUDE_CONFIG_DIR` can move Claude's session storage away from `~/.claude`.
- `--no-session-persistence`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, or SDK
  `persistSession: false` disables transcript writes and breaks resume.
- Local session transcripts are plaintext and cleaned up after 30 days by
  default, configurable with `cleanupPeriodDays`.
- Claude Agent SDK has a `SessionStore` adapter for mirroring transcripts to S3,
  Redis, or a database so another host can resume a session.

For a Claude Code session to resume in a new container, the container should
have:

- Stable `~/.claude` or `CLAUDE_CONFIG_DIR`.
- The relevant project transcript at
  `projects/<project>/<session-id>.jsonl`.
- Subagent transcript sidecars if subagents were used.
- Per-session supporting state if we want all features, especially `tasks/`,
  `file-history/`, `session-env/`, `debug/`, paste/image cache, etc.
- Settings/auth/plugin config needed for the run, with secrets handled as
  injected configuration rather than raw shared home copying.
- The same project directory mapping, or a deliberate migration story.
- No `--no-session-persistence` and no `CLAUDE_CODE_SKIP_PROMPT_HISTORY`.

Implication: Claude CLI resume is also local-transcript based. Claude's SDK
explicitly supports the architecture we are describing: local transcript writes
plus an external store so any host can load the session. The CLI appears to use
local files directly; if we want the same property with the CLI, we need a
mounted/restored Claude config directory or a wrapper that syncs those files.

## What Centaur Currently Provides

Current Centaur source checked under `~/Code/centaur`.

Centaur has three relevant pieces already:

- The session DB has `sessions.harness_thread_id`.
- The Rust runtime extracts a harness thread id from `thread.started` output and
  persists it.
- Agent-k8s supports sandbox pause/resume. Pause scales the sandbox to zero;
  resume scales it back to one and recreates proxy plumbing.

Centaur also has idle pause machinery:

- `idle_timeout_ms` is accepted in the API/runtime.
- Terminal executions schedule `record_idle_pause`.
- `record_idle_pause` pauses the sandbox after the latest terminal execution on
  the same sandbox.

The gap: the current Rust path does not appear to inject `harness_thread_id`
into a fresh replacement sandbox. There is even a regression test asserting the
workload spec does not set stale `CODEX_CONTINUE_THREAD_ID` or
`AMP_CONTINUE_THREAD_ID`.

So the current practical behavior is:

- Same sandbox paused and resumed: supported at the sandbox lifecycle layer.
- Same Centaur session in a brand-new sandbox after the old one is gone: not
  proven as exact Codex/Claude harness resume.
- Centaur records enough identity to wire this, but the fresh-container restore
  path still needs a design/POC.

Chart defaults are also relevant:

- `sandboxWarmPoolSize: 3`
- `sandboxIdleStopTtlSecs: 10800` (3 hours)
- `sandboxMaxLifetimeSecs: 259200` (3 days)
- `sandbox.stateVolume.enabled: false`

That means we should treat current Centaur local harness state as execution
state, not durable product state.

## What Atrium Currently Provides

Atrium already has the right durable mirror direction.

Current implementation facts:

- `surface/centaur-client/src/client.ts` supports `idleTimeoutMs` and
  `maxDurationMs`.
- `surface/server/src/session-runs.ts` calls `centaur.execute(...)` without
  passing `idleTimeoutMs` today.
- Atrium mirrors frames into `session_events(session_id, centaur_event_id,
  event_kind, frame)` and replays from that mirror.
- Atrium schedules a Centaur `release` after terminal idle, which is different
  from putting the sandbox to sleep between turns.
- File-change rendering exists from Centaur frames.
- Artifact frame/client types exist, but actual artifact byte capture/storage is
  still the planned Centaur sidecar/wrapper work.

So Atrium is already moving in the right direction: mirror the stream before
Centaur retention matters, then make Atrium the durable product source of truth.

## Comparison Table

This table is based on the earlier `cass` research session plus spot checks
during this pass. Pricing/cold-start numbers from the older research should be
revalidated before procurement; the architectural fit is the useful part here.

| Option | Runtime/container fit | Resume/sleep story | Persistence/artifact story | Fit for Atrium |
| --- | --- | --- | --- | --- |
| Centaur | Best fit for our current control plane: harness adapters, event stream, HITL/control-plane hooks, k8s sandbox backend. | Supports pause/resume of the same sandbox. Fresh-container harness resume needs wiring plus persisted harness home. | Event stream in Centaur DB; local harness state in container unless we add state volume/sync. Artifact bytes need sidecar work. | Keep as runtime orchestrator. Do not make its DB the product database. |
| E2B | Strong agent sandbox API, microVM isolation, agent-native SDKs. | Designed around ephemeral sandboxes. | Files need to be copied out or backed by external storage before teardown. | Plausible future sandbox backend, but does not remove Atrium's durable layer. |
| Daytona | Fast container sandbox/dev-environment platform; good agent SDK story. | Better for fast provisioning than durable conversation semantics. | Has volume/dotfile concepts and integrations, but artifact/product model is still ours. | Candidate sandbox backend if we want managed speed/GUI, not a product-store replacement. |
| Modal | Strong serverless/GPU/Python compute. | More function/batch oriented; cold starts/spin-down are normal. | Outputs must be explicitly persisted to external stores. | Useful for batch/gpu workloads, not ideal as the main interactive agent runtime. |
| Cloudflare Sandbox/Workers | Good for Workers-native apps and JS/edge workflows; secure bindings are attractive. | Worker-side model is stateless; container sandbox is newer. | R2/object storage can be the durable layer, but the agent session model is custom. | Interesting for edge tools and stateless execution, not a direct Centaur replacement today. |
| Vercel/CodeSandbox SDK | Web/dev-preview oriented sandbox environments. | Snapshot/fork concepts exist in some SDKs, but session resume is not Codex/Claude-specific. | Still needs external artifact/product storage. | Useful for prototype hosting; not enough as the orchestration layer. |
| Sprites/Fly Machines | Stateful microVMs with persistent root filesystem/checkpoint flavor. | Closer to "agents should not start fresh every time." | Stronger workspace persistence than purely ephemeral sandboxes. | Worth watching if we want stateful managed machines, but it shifts more state into runtime infra. |
| Blaxel | Agent-specific standby/hibernate model from prior research. | Strong sleep/resume positioning. | Managed runtime still needs product artifact semantics. | Interesting benchmark for our sleep UX; managed-only risk. |
| Archil | Not primarily an agent runtime; it is a POSIX-ish filesystem/data layer backed by object storage, with container/Kubernetes mounting and `disk.exec`/`disk.grep`. | Does not resume Codex/Claude conversations. It can let many short-lived containers see the same files. | Very relevant for "single mounted artifact/data volume agents can grep." S3-backed, shareable, file-shaped. | Useful as inspiration or possible backend for artifact/data mounts, not as replacement for Centaur. |
| Fast.io / artifact-bus style layer | Human/agent file workspace rather than sandbox runtime. | Not a runtime resume mechanism. | Closest product pattern for organized, browsable, shareable agent outputs. | Aligns with Atrium's artifact surface. We likely build our own integrated version. |

The comparison confirms the earlier conclusion: sandbox vendors solve execution.
They do not remove the need for Atrium to own durable session records and
team-visible artifacts.

## Archil Read

Archil is useful for one specific part of this design: expose durable,
object-backed data as a real filesystem to containers, and let agents use normal
tools like `grep`, `find`, `python`, and shell scripts.

It is not a direct answer to "how does Codex/Claude resume a session?" because
conversation resume is tied to Codex/Claude transcript/config state. But Archil
is a good reference for:

- An artifact/data volume mounted read-only or read-mostly into any future
  sandbox.
- A team-shared searchable file tree for session outputs.
- Running small `disk.exec` or `disk.grep` jobs against stored artifacts without
  warming a full Centaur sandbox.
- S3/object storage as the system of record with a filesystem-shaped interface
  for agents.

I would not use a single shared writable Archil-style volume as the canonical
workspace for every active agent. That invites locking, accidental overwrite,
secret exposure, and confusing ownership. The safer pattern is:

- Per-session writable workspace/state volume for live/sleeping execution.
- Atrium artifact/object store as canonical durable output store.
- Optional shared read-only or delegated-write filesystem view over selected
  artifacts/data.

## Proposed Architecture Lines

### 1. Keep Atrium as Canonical Product State

Atrium should continue mirroring every Centaur frame into `session_events` and
should own the durable session replay. Centaur logs can be retained for
operational debugging and exact harness-level replay only while useful.

Centaur DB duplication into Atrium is not weird if the DBs have different
purposes:

- Centaur DB: runtime control plane, execution event log, sandbox/session
  bookkeeping, retention allowed.
- Atrium DB: product record, team-visible transcript, permissions, comments,
  artifacts, long retention.

The mirror becomes weird only if Atrium starts treating Centaur as the canonical
long-lived product database. We should not do that.

### 2. Add Sleep Between Turns

Atrium already has a client field for `idleTimeoutMs`. We can start passing it
on executions and expose the environment state as:

- `warm`: sandbox running and ready for a steer.
- `sleeping`: sandbox paused/scaled to zero, same sandbox id expected to resume.
- `rebuilt`: old sandbox gone; a new sandbox was created.
- `expired`: exact harness/workspace resume is no longer promised.

First version can use Centaur's existing idle pause. This gets us lower idle
cost without solving fresh-container exact resume yet.

### 3. Add Per-Session Harness State

To resume Codex/Claude in a new container, we need a per-session harness home.
Options:

- Kubernetes PVC mounted at `CODEX_HOME` or `CLAUDE_CONFIG_DIR`.
- Object-store-backed sync of selected harness state at turn boundaries.
- Archil-style mounted disk for selected session state, if its consistency and
  security model fit.

PVC is the most direct first implementation. It matches the CLI tools' local-file
expectations. Object sync is more portable, but we need to prove exact file sets
for each harness.

Suggested mount layout:

```text
/home/agent/workspace          repo/workspace checkout
/home/agent/.atrium-harness    per-session harness home
/home/agent/artifacts          writable artifact drop area
/mnt/atrium-artifacts          optional read-only shared artifact/data mount
```

Then set:

```text
CODEX_HOME=/home/agent/.atrium-harness/codex
CODEX_SQLITE_HOME=/home/agent/.atrium-harness/codex
CLAUDE_CONFIG_DIR=/home/agent/.atrium-harness/claude
```

Secrets should still be injected by Centaur/Atrium at runtime. We should avoid
making a shared filesystem full of auth blobs the access-control boundary.

### 4. Wire Fresh-Container Harness Resume

Centaur already persists `harness_thread_id`. The missing piece is to use it
when a new sandbox is created for an existing session.

Likely Codex path:

- Preserve/restore `CODEX_HOME`.
- Start app-server/harness with the stored Codex thread id.
- For the harness-server path, either set `CODEX_CONTINUE_THREAD_ID` only when
  intentionally resuming, or call app-server `thread/resume` with the id.
- Keep the regression protection against stale env ids by tying resume injection
  to the current session row and generation.

Likely Claude path:

- Preserve/restore `CLAUDE_CONFIG_DIR`.
- Start with `claude --resume <harness_thread_id>` once the transcript exists.
- Otherwise create with `claude --session-id <state.id>` for the first turn.
- Keep cwd/project-key stable enough that Claude can find the transcript.

This needs a small POC per harness before we call it supported.

### 5. Treat Workspace Durability Separately

For team use, code should mostly be repo tracked:

- Bind a session to repo/branch/worktree at spawn.
- Warm clones/deps/caches in containers or base images.
- Use git diffs/commits/PRs for source-code durability.

For non-code outputs, use Atrium artifacts:

- Sidecar/wrapper watches configured output scopes.
- It emits `artifact.captured` and `rollout.segment`.
- Atrium mirrors those frames and copies bytes to its object store.
- The session artifact ledger records path, sha256, size, content type, turn,
  permissions, and preview metadata.

Avoid making "full root filesystem snapshot" the product feature. It is useful
for short warm/sleep windows and debugging, but not as the team artifact model.

### 6. Add an Artifact/Data Filesystem View

This is the Archil-style line:

- Atrium object store remains canonical.
- We expose selected artifacts/data as a mounted filesystem for future
  containers.
- Default is read-only.
- Writes go to a session-owned drop area and become new artifact versions.
- Search can be implemented with normal shell tools, a server-side `grep`
  primitive, or a later Archil-style backend.

This gives agents a "single volume they can mount and grep" without making that
volume the only copy of the team record.

### 7. Cleanup and Retention

Recommended cleanup policy:

- Atrium `session_events`: durable product retention.
- Atrium artifacts: durable object retention with org/session policy.
- Centaur runtime events: can be pruned/redacted after Atrium mirror watermark
  and artifact copy are confirmed.
- Per-session harness home/PVC: keep while active, warm, sleeping, or inside an
  exact-resume window. After that, prune unless the user explicitly asks for
  exact harness replay.
- Workspace caches: disposable; rebuild from repo/dependency cache.

The key product message: after the exact-resume window expires, the session is
still viewable and artifacts are still available, but the next agent turn may be
a rebuilt environment with replay/context injection rather than the exact same
Codex/Claude local session.

## POCs To Run

### Codex POC

Goal: prove the minimum files needed for `codex resume` and app-server
`thread/resume` across containers.

Steps:

1. Start with a throwaway `CODEX_HOME` and temp repo.
2. Create a session; record session id and generated files.
3. Resume with the same `CODEX_HOME`.
4. Copy only `$CODEX_HOME/sessions` into a fresh home; test resume.
5. Add `CODEX_SQLITE_HOME` state; test app-server `thread/resume`.
6. Test cwd changes with `--cd` or app-server `cwd`.
7. Confirm what fails when session file or SQLite state is missing.

### Claude POC

Goal: prove the minimum files needed for `claude --resume <id>` across
containers/paths.

Steps:

1. Start with a throwaway `CLAUDE_CONFIG_DIR` and temp repo.
2. Create a print-mode or interactive session with a known `--session-id`.
3. Resume from the same directory with the same config dir.
4. Copy only `projects/<project>/<session-id>.jsonl` into a fresh config dir;
   test resume.
5. Add subagent/file-history/tasks/session-env state; test feature completeness.
6. Test project path changes and git worktree behavior.
7. Verify `CLAUDE_CODE_SKIP_PROMPT_HISTORY` and `--no-session-persistence`
   break resume as expected.
8. Evaluate SDK `SessionStore` as a cleaner long-term path if we can use the SDK
   instead of raw CLI.

### Centaur/Atrium POC

Goal: prove sleep and fresh-container resume in the actual stack.

Steps:

1. Pass `idleTimeoutMs` from Atrium to Centaur in one dev-only path.
2. Verify sandbox enters paused state after a terminal turn.
3. Steer again and verify same sandbox resumes.
4. Force sandbox replacement with preserved harness home.
5. Verify `harness_thread_id` is used only for intentional resume.
6. Verify Codex and Claude produce continuous conversation behavior.
7. Verify Atrium transcript replay still comes entirely from `session_events`.

## Open Questions

- ~~Does Codex app-server `thread/resume` require SQLite state, JSONL transcripts,
  or both?~~ **RESOLVED (POC 2026-06-18, codex-cli 0.140.0):** only the rollout
  JSONL (`$CODEX_HOME/sessions/.../rollout-<id>.jsonl`) is required. A fresh
  `CODEX_HOME` with the JSONL copied (no `state_5.sqlite`/other sqlite) resumes
  and recalls prior context; with no JSONL, `thread/resume` hard-errors `no
  rollout found for thread id (code -32600)` — confirming resume is
  local-transcript-based, not server-side, on the same app-server path the
  Centaur harness-server uses. Implication: fresh-container Codex resume requires
  BOTH injecting `CODEX_CONTINUE_THREAD_ID` AND restoring the per-session harness
  home (the JSONL); the id alone is insufficient. (Claude path still unverified.)
- Does Claude CLI resume require only the main JSONL transcript for basic
  conversation, or do checkpoints/tasks/subagent state matter for our default UX?
- How stable is Claude's project-key mapping if the container checkout path
  changes?
- Should we set a longer Claude `cleanupPeriodDays` in containers, or rely on
  Atrium copying the harness home before cleanup can run?
- What is the minimum safe retention for per-session harness homes?
- Should exact harness resume be a user-visible guarantee or merely an
  optimization while the environment is warm/sleeping?
- How do we lock a per-session state volume so two containers do not write the
  same Codex/Claude transcript concurrently?
- If we mount shared artifacts read-write, what delegation/versioning model
  prevents accidental overwrite?

## Recommendation

Build the product around Atrium-owned durable records, repo-tracked code, and
Atrium-owned artifacts. Add Centaur sleep soon because the client/runtime hooks
are already close. Then add exact fresh-container resume as a bounded capability
by preserving per-session harness homes and wiring `harness_thread_id` into
intentional resume paths.

Archil is useful as a model or backend for a mounted artifact/data filesystem,
especially for grep/search over stored outputs. It should not be the primary
conversation-resume mechanism and should not replace Atrium's database/object
store as the canonical team record.

## Sources Checked

- `cass search`: prior research sessions on AI agent sandbox runtimes and the
  sandbox-to-storage gap, including E2B, Daytona, Modal, Cloudflare, Vercel,
  CodeSandbox, Sprites, Blaxel, and artifact-bus patterns.
- Codex local CLI help: `codex resume --help`, `codex app-server --help`.
- Codex manual fetched via the `openai-docs` helper on 2026-06-16.
- Claude local CLI help: `claude --help`, `claude -p --help`,
  `claude project --help`.
- Claude docs: session management
  (`https://code.claude.com/docs/en/sessions`), `.claude` directory
  (`https://code.claude.com/docs/en/claude-directory`), data usage
  (`https://code.claude.com/docs/en/data-usage`), and Agent SDK session storage
  (`https://code.claude.com/docs/en/agent-sdk/session-storage`).
- Archil docs: container mounts
  (`https://docs.archil.com/mounting/containers`), serverless execution
  (`https://docs.archil.com/compute/serverless-execution`), TypeScript SDK
  `Disk.grep` (`https://docs.archil.com/sdks/typescript`), and YC company
  profile (`https://www.ycombinator.com/companies/archil`).
- Atrium source: `surface/centaur-client/src/client.ts`,
  `surface/server/src/session-runs.ts`, `surface/server/migrations/027_session_events.sql`.
- Centaur source: `services/api-rs`, `crates/harness-server`, and
  `contrib/chart/values.yaml`.
